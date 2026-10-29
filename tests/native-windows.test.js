import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// 用真实 Win32 窗口检查目录隔离、敏感字段过滤、最小化与聚焦恢复。
test('Windows 原生桥读取窗口并仅公开环境白名单', { skip: process.platform !== 'win32', timeout: 40000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘 窗口测试-'));
  const executable = path.join(temp, 'Codex.exe');
  const csc = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const build = spawnSync(csc, ['/nologo', '/target:winexe', '/platform:x64', '/reference:System.Windows.Forms.dll', `/out:${executable}`, path.join(root, 'tests/fixtures/WindowFixture.cs')], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const home = path.join(temp, '自定义账户');
  await fs.mkdir(home);
  const ready = path.join(temp, 'ready');
  const child = spawn(executable, ['--minimized'], { env: { ...process.env, CODEX_HOME: home, DRAGONGIRL_SECRET_TEST: 'do-not-publish-this', HTTPS_PROXY: 'http://localhost:12345', DRAGONGIRL_FIXTURE_READY: ready }, stdio: 'ignore' });
  t.after(async () => {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const bridge = path.join(root, 'native/bin/dragongirl-native.exe');
  let row, snapshot;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!(await fs.stat(ready).catch(() => null))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    const result = spawnSync(bridge, ['--once'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    snapshot = result.stdout;
    row = JSON.parse(snapshot).processes.find((process) => process.pid === child.pid);
    if (row) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(row, '未发现测试进程');
  // Windows 可能展开 8.3 短路径，按实际目录比较账户归属。
  assert.equal((await fs.realpath(row.home)).toLowerCase(), (await fs.realpath(home)).toLowerCase());
  assert.equal(row.coordinateSpace, 'physical');
  assert.equal(row.networkEnv.HTTPS_PROXY, 'http://localhost:12345');
  assert.ok(!snapshot.includes('do-not-publish-this'));
  assert.equal(row.windows.length, 0, '最小化窗口应隐藏角色');
  // 系统可能拒绝抢占前台，但用户入口仍应先恢复最小化窗口。
  spawnSync(bridge, ['--focus', String(child.pid)], { timeout: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const restored = JSON.parse(spawnSync(bridge, ['--once'], { encoding: 'utf8' }).stdout).processes.find((process) => process.pid === child.pid);
  assert.ok(restored.windows.some((window) => window.width >= 400 && window.height >= 300));
});
