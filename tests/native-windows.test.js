import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// 用真实 Windows 内存边界复现跨页失败，同时验收完整终止符和白名单。
test('Windows 原生桥按可读区域读取 UTF-16 环境块', { skip: process.platform !== 'win32', timeout: 15000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-environment-boundary-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const executable = path.join(temp, 'boundary.exe');
  const csc = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const build = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`,
    path.join(root, 'tests/fixtures/EnvironmentBoundaryFixture.cs')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(build.status, 0, build.stderr || build.stdout || build.error?.message);
  const result = spawnSync(executable, [path.join(root, 'native/bin/dragongirl-native.exe')], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
});

// 用真实 Win32 窗口检查目录隔离、敏感字段过滤、最小化与聚焦恢复。
test('Windows 原生桥读取窗口并仅公开环境白名单', { skip: process.platform !== 'win32', timeout: 40000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘 窗口测试-'));
  const executable = path.join(temp, 'Codex.exe');
  const csc = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const build = spawnSync(csc, ['/nologo', '/target:winexe', '/platform:x64', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', `/out:${executable}`, path.join(root, 'tests/fixtures/WindowFixture.cs')], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const home = path.join(temp, '自定义账户');
  await fs.mkdir(home);
  const ready = path.join(temp, 'ready');
  const child = spawn(executable, ['--minimized'], { env: { ...process.env, CODEX_HOME: home, DRAGONGIRL_SECRET_TEST: 'do-not-publish-this', HTTPS_PROXY: 'http://localhost:12345', DRAGONGIRL_FIXTURE_READY: ready }, stdio: 'ignore' });
  const children = [child];
  t.after(async () => {
    await Promise.all(children.map(async (fixture) => {
      if (fixture.exitCode !== null || fixture.signalCode !== null) return;
      const exited = new Promise((resolve) => fixture.once('exit', resolve));
      fixture.kill();
      await exited;
    }));
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
  const startupProbe = spawnSync(path.join(root, 'native/bin/dragongirl-startup.exe'), ['--probe'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(startupProbe.status, 0, startupProbe.stderr);
  assert.ok(JSON.parse(startupProbe.stdout).hosts.some((host) => host.startsWith(`${child.pid}:`)), '启动助手未识别最小化的桌面宿主');
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
  // 静止窗口也必须收到重复快照，使原生排序偶尔未生效时仍有下一次恢复机会。
  const stream = spawn(bridge, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    if (stream.exitCode !== null || stream.signalCode !== null) return;
    const exited = new Promise((resolve) => stream.once('exit', resolve));
    stream.kill();
    await exited;
  });
  let buffer = '', previous = null, heartbeat = false;
  stream.stdout.setEncoding('utf8');
  stream.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line === previous) heartbeat = true;
      previous = line;
    }
  });
  const heartbeatDeadline = Date.now() + 8000;
  while (!heartbeat && stream.exitCode === null && Date.now() < heartbeatDeadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(heartbeat, '窗口静止后原生桥没有补发恢复心跳');

  // 两个进程同时可见时，同一桌面快照必须把实际句柄和对应的账户分别归回自己的宿主。
  const otherHome = path.join(temp, '第二个账户');
  await fs.mkdir(otherHome);
  const other = spawn(executable, ['--controlled', otherHome], {
    env: { ...process.env, CODEX_HOME: otherHome }, stdio: 'ignore',
  });
  children.push(other);
  const otherReady = path.join(otherHome, 'ready.json');
  const untilReady = Date.now() + 6000;
  let otherId;
  while (!otherId && Date.now() < untilReady) {
    try { otherId = JSON.parse(await fs.readFile(otherReady, 'utf8')).window; }
    catch { await new Promise((resolve) => setTimeout(resolve, 80)); }
  }
  assert.ok(otherId, '第二个真实宿主窗口未就绪');
  const both = spawnSync(bridge, ['--once'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(both.status, 0, both.stderr);
  const hosts = JSON.parse(both.stdout).processes;
  const peer = hosts.find(({ pid }) => pid === other.pid);
  assert.deepEqual(hosts.find(({ pid }) => pid === child.pid)?.windows.map(w => w.id), [restored.windows[0].id]);
  assert.deepEqual(peer?.windows.map(w => w.id), [otherId]);
  assert.equal((await fs.realpath(peer.home)).toLowerCase(), (await fs.realpath(otherHome)).toLowerCase());
});
