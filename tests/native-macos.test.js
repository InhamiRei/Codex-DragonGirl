import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { followWindowFrame } from '../src/shared/follow-window.js';

const root = fileURLToPath(new URL('../', import.meta.url));

// 用真实的系统窗口验证原生桥输出与跟随选择，覆盖画中画和文件面板的窗口层级。
test('macOS 跟随跳过画中画，文件面板、移动及最小化后正确恢复', { skip: process.platform !== 'darwin', timeout: 60000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-mac-window-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    }
    // 系统可能在测试进程退出后补写目录项，短暂重试避免清理竞争误报为窗口功能失败。
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
  function snapshot(...options) {
    const result = spawnSync(path.join(root, 'native/bin/dragongirl-native'), ['--once', ...options], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const { processes, normalWindows } = JSON.parse(result.stdout);
    const process = processes.find((process) => process.pid === child.pid);
    return process && { ...process, normalWindows };
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
  const command = path.join(directory, 'command');
  const previewFile = path.join(directory, 'preview-windows.json');
  // 验证两块面板确实排在主窗前方且满足旧尺寸门槛，避免未创建成功时误判为通过。
  for (const open of ['open-preview', 'open-untitled-preview']) {
    await fs.writeFile(command, open);
    const ids = await until(async () => JSON.parse(await fs.readFile(previewFile, 'utf8').catch(() => 'null')), '未创建画中画面板');
    const opened = await until(() => {
      const state = snapshot();
      const mainIndex = state?.normalWindows.findIndex((window) => window.id === main.id);
      return mainIndex >= 0 && ids.every((id) => state.normalWindows.slice(0, mainIndex)
        .some((window) => window.id === id && window.width >= 400 && window.height >= 300)) && state;
    }, '画中画面板未在主窗口上层以普通窗口显示');
    assert.deepEqual(opened.windows, [main], '画中画被列为跟随宿主');
    assert.deepEqual(followWindowFrame(opened), main);

    // 拖动期间面板仍参与实际窗口层级，但跟随坐标应一直来自主窗。
    await fs.writeFile(command, 'move-preview');
    const moved = await until(() => {
      const state = snapshot();
      return state && ids.every((id) => state.normalWindows.some((window) => window.id === id
        && window.x !== opened.normalWindows.find((previous) => previous.id === id).x)) && state;
    }, '画中画面板没有移动');
    assert.deepEqual(followWindowFrame(moved), main, '拖动画中画改变了龙娘的跟随坐标');
    await fs.writeFile(command, 'close-preview');
    await until(() => {
      const state = snapshot();
      return state && ids.every((id) => !state.normalWindows.some((window) => window.id === id))
        && followWindowFrame(state)?.id === main.id;
    }, '关闭画中画后未恢复原主窗口');
    await fs.rm(previewFile);
  }
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
  // 独立的视频保存面板既不居中也不一定带模态标记，窗口编号和尺寸确认弹窗确实进入了前台。
  await fs.writeFile(command, 'save-video');
  const saving = await until(() => {
    const state = snapshot();
    const front = state?.windows[0];
    return front && front.id !== main.id && front.width >= 400 && front.height >= 300
      && Math.abs(front.x + front.width / 2 - main.x - main.width / 2) > 12 && state;
  }, '未复现偏离主窗口中心的独立保存面板');
  assert.equal(followWindowFrame(saving), null, '桌宠把保存视频弹窗当成了聊天窗口');
  assert.equal(snapshot('--quartz-only')?.modalOpen, true, '无辅助功能权限时没有识别独立保存面板');
  await fs.writeFile(command, 'close');
  await until(() => followWindowFrame(snapshot())?.id === main.id, '取消保存后没有恢复原主窗口');
  // 另一个同框同名窗口实际是普通聊天窗口，文件面板的识别结果不能继承到它身上。
  await fs.writeFile(command, 'other-chat');
  const chat = await until(() => {
    const frame = followWindowFrame(snapshot('--quartz-only'));
    return frame && frame.id !== main.id && frame.id !== saving.windows[0].id && frame;
  }, '同名的第二个聊天窗口未能成为跟随目标');
  // 普通标题栏和文件面板的系统边框可能相差一到两个点。
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(chat[key] - saving.windows[0][key]) <= 2, key);
  assert.equal(followWindowFrame(snapshot())?.id, chat.id);
  await fs.writeFile(command, 'close-other-chat');
  await until(() => followWindowFrame(snapshot())?.id === main.id, '关闭第二个聊天窗口后没有恢复');
  // 折叠的保存面板小于宿主尺寸门槛，但显示期间依然要收起角色。
  await fs.writeFile(command, 'save-compact');
  const compact = await until(async () => {
    const ready = JSON.parse(await fs.readFile(path.join(directory, 'ready.json'), 'utf8'));
    if (ready.stage !== 'save-compact') return false;
    const state = snapshot('--quartz-only');
    return state?.normalWindows.some((frame) => frame.id === ready.panel && frame.height < 300)
      && state;
  }, '折叠保存面板未显示');
  assert.deepEqual(compact.windows, [main]);
  assert.equal(followWindowFrame(compact), null, '无辅助功能权限时未避让折叠的保存面板');
  assert.equal(followWindowFrame(snapshot()), null);
  await fs.writeFile(command, 'confirm-save');
  const result = await until(async () => {
    const { stage } = JSON.parse(await fs.readFile(path.join(directory, 'ready.json'), 'utf8'));
    return stage !== 'save-compact' && stage;
  }, '保存面板没有响应确认操作');
  assert.equal(result, 'saved-video', '系统未确认临时目录中的视频保存路径');
  await until(() => followWindowFrame(snapshot('--quartz-only'))?.id === main.id, '确认保存后没有恢复主窗口');
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
