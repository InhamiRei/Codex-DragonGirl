import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { followWindowFrame } from '../src/shared/follow-window.js';

const root = fileURLToPath(new URL('../', import.meta.url));

// 真实系统文件面板验证原生桥与跟随选择的连接，避免只用手写模态标记掩盖识别失败。
test('macOS 文件夹面板隐藏跟随，关闭、移动及最小化后正确恢复', { skip: process.platform !== 'darwin', timeout: 60000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-mac-window-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const contents = path.join(directory, 'Codex.app/Contents');
  const executable = path.join(contents, 'MacOS/WindowFixture');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>WindowFixture</string><key>CFBundleIdentifier</key><string>com.inhamirei.dragongirl.window-fixture</string><key>CFBundleName</key><string>DragonGirl Window Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', path.join(os.tmpdir(), 'dragongirl-swift-cache'), path.join(root, 'tests/fixtures/WindowFixture.swift'), '-o', executable], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' },
  });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  child = spawn(executable, [directory], { stdio: 'ignore', env: { ...process.env, CODEX_HOME: directory } });

  // 每次只检查自建测试进程，原生桥中的其他账户与窗口不进入测试输出。
  function snapshot() {
    const result = spawnSync(path.join(root, 'native/bin/dragongirl-native'), ['--once'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).processes.find((process) => process.pid === child.pid);
  }

  // 等待系统实际窗口状态，避免动画时序或固定延时制造假通过。
  async function until(check, message) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.fail(message);
  }

  const initial = await until(() => {
    const process = snapshot();
    return process?.windows.length === 1 && process;
  }, '未发现自建 macOS 主窗口，请在桌面会话运行测试');
  assert.equal(initial.platform, 'darwin');
  const startupProbe = spawnSync(path.join(root, 'native/bin/dragongirl-startup'), ['--probe'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(startupProbe.status, 0, startupProbe.stderr);
  assert.ok(JSON.parse(startupProbe.stdout).hosts.some((host) => host.startsWith(`${child.pid}:`)), '启动助手未识别真实桌面宿主');
  const main = followWindowFrame(initial);
  assert.ok(main);
  await fs.writeFile(path.join(directory, 'command'), 'open');
  const opened = await until(() => {
    const process = snapshot();
    return process?.windows.length === 2 && followWindowFrame(process) === null && process;
  }, '真实文件夹选择框打开后仍然成为跟随目标');
  assert.notEqual(opened.windows[0].id, main.id, '测试未复现面板排在主窗口之前的场景');
  // 明确丢弃可选权限信息，单独验证无辅助功能权限的真实面板几何兜底。
  assert.equal(followWindowFrame({ ...opened, modalOpen: undefined }), null);
  await fs.writeFile(path.join(directory, 'command'), 'close');
  await until(() => {
    const process = snapshot();
    return process?.windows.length === 1 && followWindowFrame(process)?.id === main.id;
  }, '关闭选择框后没有恢复原主窗口');
  await fs.writeFile(path.join(directory, 'command'), 'move');
  await until(() => {
    const frame = followWindowFrame(snapshot());
    return frame?.id === main.id && frame.x !== main.x;
  }, '关闭面板后没有继续跟随主窗口移动');
  await fs.writeFile(path.join(directory, 'command'), 'minimize');
  await until(() => snapshot()?.windows.length === 0, '最小化后窗口仍进入跟随列表');
  await fs.writeFile(path.join(directory, 'command'), 'restore');
  await until(() => followWindowFrame(snapshot())?.id === main.id, '最小化恢复后未重新跟随');
});
