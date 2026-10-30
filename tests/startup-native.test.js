import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readStartupJson, writeStartupJson } from '../src/core/startup-registration.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = process.env.DRAGONGIRL_TEST_STARTUP_BINARY || path.join(root, 'native/bin', process.platform === 'win32' ? 'dragongirl-startup.exe' : 'dragongirl-startup');
const runner = process.env.DRAGONGIRL_TEST_STARTUP_RUNNER;

// 等待外部进程的真实状态变化，超时提供具体失败场景。
async function until(check, message, timeout = 22000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

// 原生进程与主程序控制器在隔离目录通信，覆盖开关机以外的完整日常生命期。
test('原生启动助手：等待、去重、主动退出暂停、多实例、重开及更新交接', { skip: !['darwin', 'win32'].includes(process.platform), timeout: 120000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘 联动-'));
  const startup = path.join(directory, 'startup');
  const configFile = path.join(startup, 'config.json');
  const hostsFile = path.join(directory, 'hosts.json');
  const children = [];
  let commandId = 0;
  // 所有测试启动都带显式测试标记，不识别用户的真实 Codex。
  const launchHelper = () => {
    const args = [helper, '--config', configFile, '--test-hosts', hostsFile];
    const child = spawn(runner || args.shift(), args, { env: { ...process.env, DRAGONGIRL_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child.errors = '';
    child.stderr.on('data', (data) => { child.errors += data; });
    children.push(child);
    return child;
  };
  // 清理仅面向测试创建的进程句柄和已记录的测试客户端。
  t.after(async () => {
    await writeStartupJson(configFile, { ...config, mode: 'manual', revision: randomUUID() }).catch(() => {});
    await writeStartupJson(path.join(directory, 'command.json'), { id: ++commandId, action: 'quit' }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 800));
    for (const child of children) if (child.exitCode === null) child.kill();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const config = { version: 1, revision: randomUUID(), mode: 'codex', executable: process.execPath,
    arguments: [path.join(root, 'tests/fixtures/startup-client.mjs'), directory] };
  await writeStartupJson(configFile, config);
  await writeStartupJson(hostsFile, { hosts: [] });
  const first = launchHelper();
  const status = () => readStartupJson(path.join(startup, 'status.json')).catch(() => null);
  const runtime = () => readStartupJson(path.join(startup, 'runtime.json')).catch(() => null);
  const launches = async () => (await fs.readFile(path.join(directory, 'launches.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const command = (action) => writeStartupJson(path.join(directory, 'command.json'), { id: ++commandId, action });
  await until(async () => (await status())?.phase === 'waiting', '助手没有等待 Codex：' + first.errors);
  assert.equal((await launches()).length, 0);
  await writeStartupJson(hostsFile, { hosts: ['100:1'] });
  await until(async () => (await launches()).length === 1 && await runtime(), 'Codex 打开后未启动龙娘');
  const duplicate = launchHelper();
  await until(() => duplicate.exitCode !== null, '重复助手没有退出');
  assert.equal((await launches()).length, 1);
  await command('quit');
  await until(async () => (await status())?.phase === 'paused' && !(await runtime()), '主动退出后没有暂停');
  await writeStartupJson(hostsFile, { hosts: ['100:1', '200:1'] });
  await until(async () => (await status())?.hosts.length === 2, '没有发现第二个宿主');
  assert.equal((await status()).phase, 'paused');
  assert.equal((await launches()).length, 1);
  // 原宿主全部结束后新宿主可以恢复，退出与重开很快也不会误继承暂停。
  await writeStartupJson(hostsFile, { hosts: ['200:1'] });
  await until(async () => (await launches()).length === 2 && await runtime(), '新宿主未恢复联动');
  await writeStartupJson(hostsFile, { hosts: [] });
  await until(async () => !(await runtime()), '最后一个宿主退出后龙娘未退出');
  assert.equal(await readStartupJson(path.join(startup, 'pause.json')), null);
  await writeStartupJson(hostsFile, { hosts: ['300:1'] });
  await until(async () => (await launches()).length === 3 && await runtime(), '再次打开 Codex 未重新启动');
  await command('retain');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await writeStartupJson(hostsFile, { hosts: [] });
  await until(async () => (await status())?.hosts.length === 0, '没有接收到宿主退出');
  await new Promise((resolve) => setTimeout(resolve, 4500));
  assert.ok(await runtime(), '手动打开后仍被宿主退出打断');
  config.revision = randomUUID();
  await writeStartupJson(configFile, config);
  const replacement = launchHelper();
  await until(() => first.exitCode !== null, '旧助手没有响应配置更新');
  await until(async () => (await status())?.revision === config.revision && (await status())?.pid === replacement.pid, '新助手没有接管');
  assert.equal((await launches()).length, 3);
  await command('quit');
  await until(async () => !(await runtime()), '测试客户端没有正常保存退出');
});

// 程序缺失时必须停止自动重试，后台助手不能不断创建失败进程或打扰用户。
test('原生启动失败有限重试并保留可读错误', { skip: !['darwin', 'win32'].includes(process.platform), timeout: 70000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-startup-failure-'));
  const configFile = path.join(directory, 'config.json');
  const hostsFile = path.join(directory, 'hosts.json');
  await writeStartupJson(configFile, { version: 1, revision: 'failure', mode: 'codex', executable: path.join(directory, 'missing-app'), arguments: [] });
  await writeStartupJson(hostsFile, { hosts: ['fixture:failure'] });
  const args = [helper, '--config', configFile, '--test-hosts', hostsFile];
  const child = spawn(runner || args.shift(), args, { env: { ...process.env, DRAGONGIRL_TEST: '1' }, stdio: 'ignore', windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const status = () => readStartupJson(path.join(directory, 'status.json')).catch(() => null);
  await until(async () => (await status())?.phase === 'error', '失败重试没有停止', 38000);
  assert.equal((await status()).attempts, 3);
  assert.ok((await status()).message);
  await new Promise((resolve) => setTimeout(resolve, 16000));
  assert.equal((await status()).attempts, 3);
  assert.equal((await status()).phase, 'error');
  assert.ok(Date.now() - (await status()).updatedAt < 3000, '助手意外停止而非主动限制重试');
});
