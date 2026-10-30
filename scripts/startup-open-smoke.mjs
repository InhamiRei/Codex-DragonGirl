import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeStartupJson, readStartupJson } from '../src/core/startup-registration.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = await fs.realpath(process.env.DRAGONGIRL_TEST_EXECUTABLE || path.join(root, 'output/Codex 龙娘.app/Contents/MacOS/CodexDragonGirl'));
const bundle = path.resolve(executable, '../../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-system-open-'));
const data = path.join(directory, 'data');
const revision = randomUUID();
const run = promisify(execFile);
let timer, launched, hosts = ['fixture:1'];

// 生命周期检查只读取本次临时目录，绝不向已有龙娘或 Codex 发送退出信号。
async function until(check, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

// 给系统启动的隔离应用提供持续的新鲜助手快照。
async function publish() {
  await writeStartupJson(path.join(data, 'startup/status.json'), { revision, updatedAt: Date.now(), hosts, phase: 'running' });
}

try {
  await fs.mkdir(path.join(directory, 'user/.codex/sessions'), { recursive: true });
  await writeStartupJson(path.join(data, 'settings.json'), { startupMode: 'codex', mode: 'follow' });
  await writeStartupJson(path.join(data, 'startup/config.json'), { version: 1, revision, mode: 'codex' });
  await publish();
  timer = setInterval(() => void publish().catch(() => {}), 300);
  // 显式传入全部测试环境，新实例不复用用户已经打开的应用。
  const environment = { DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1', DRAGONGIRL_DATA_DIR: data,
    DRAGONGIRL_FIXTURE_HOME: path.join(directory, 'user') };
  const launcherEnvironment = { ...process.env };
  delete launcherEnvironment.ELECTRON_RUN_AS_NODE;
  await run('/usr/bin/open', ['-n', '-g', '-a', bundle,
    ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--args', '--dg-startup=codex', `--dg-startup-revision=${revision}`], { env: launcherEnvironment });
  await until(async () => {
    launched = await readStartupJson(path.join(data, 'startup/runtime.json'));
    return launched;
  }, '系统后台打开没有启动隔离应用');
  assert.equal(launched.executable, executable);
  // 若系统的启动激活事件错误地改成手动模式，宿主退出后应用就不会结束。
  hosts = [];
  await publish();
  await until(async () => !(await readStartupJson(path.join(data, 'startup/runtime.json'))), '系统后台启动错误地脱离了 Codex 生命周期');
  await until(() => {
    try { process.kill(launched.pid, 0); return false; } catch { return true; }
  }, '退出后仍遗留自动启动的进程');
  launched = null;
  console.log('macOS 系统后台打开成品、自动生命周期与进程清理验证通过。');
} finally {
  clearInterval(timer);
  // 异常时仅清理本次成功核对过路径的测试进程。
  if (launched?.executable === executable) { try { process.kill(launched.pid); } catch {} }
  await fs.rm(directory, { recursive: true, force: true });
}
