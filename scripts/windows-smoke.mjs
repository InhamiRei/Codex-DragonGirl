import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// 去除末尾反斜杠，避免 Windows 启动器把路径后的引号解释为转义字符。
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dragongirl-windows-'));
const env = {
  ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1',
  DRAGONGIRL_DATA_DIR: path.join(temp, 'data'), DRAGONGIRL_FIXTURE_HOME: path.join(temp, 'user'),
};
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
let application;
const errors = [];

// 等待真实应用状态，安装包必须脱离源码目录并完成统计与界面初始化。
async function until(check, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

try {
  await fs.mkdir(path.join(env.DRAGONGIRL_FIXTURE_HOME, '.codex/sessions'), { recursive: true });
  application = await electron.launch({
    ...(executablePath ? { executablePath, args: [], cwd: temp } : { args: [root], cwd: root }), env, timeout: 60000,
  });
  await until(() => application.windows().some((page) => page.url().endsWith('/dashboard.html')), '管理窗口未启动');
  const page = application.windows().find((page) => page.url().endsWith('/dashboard.html'));
  page.on('pageerror', (error) => errors.push(error.message));
  await until(async () => (await application.evaluate(() => globalThis.__dragonGirlApp?.monitor.snapshot().instances.length)) === 1, '默认目录未发现');
  assert.match(await page.title(), /GPT龙娘/);
  const initial = await application.evaluate(() => {
    const { monitor, companion } = globalThis.__dragonGirlApp;
    return { instances: monitor.instances.length, windows: companion.windows.size, tray: !companion.tray.isDestroyed(), error: monitor.indexError };
  });
  assert.equal(initial.windows, 2);
  assert.equal(initial.tray, true);
  // 切到独立桌面后验证透明角色、用量气泡与设置写入，不访问真实账户。
  await application.evaluate(async () => {
    const { dashboard, monitor } = globalThis.__dragonGirlApp;
    await dashboard.command('settings', { ...monitor.settings, mode: 'desktop', volume: 0.2 });
    await dashboard.updatePets();
  });
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.companion.windows.get('character').isVisible()), '角色未显示');
  // 使用空用户目录验证成品内置原声，不能依赖源码电脑已经下载过的音效。
  const audioStatus = await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.command('audio-status'));
  assert.equal(audioStatus.complete, true);
  assert.equal(audioStatus.installed, 9);
  assert.equal(audioStatus.bundled, 9);
  assert.deepEqual(await fs.readdir(path.join(env.DRAGONGIRL_DATA_DIR, 'assets')).catch(() => []), []);
  const character = application.windows().find((window) => window.url().endsWith('/character.html'));
  await until(() => character.evaluate(() => window.__soundEngine.buffers.size === 9), '内置原声未完成解码');
  // 自动化光标与系统真实光标分离，暂停原生轮询避免穿透状态干扰实点验收。
  await application.evaluate(() => {
    const companion = globalThis.__dragonGirlApp.companion;
    clearTimeout(companion.cursorTimer);
    companion.pollCursor = () => {};
  });
  await character.bringToFront();
  await character.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const point = await character.evaluate(async () => {
    const { rect } = await window.dragonGirl.bootstrap();
    return { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.72 };
  });
  const played = await character.evaluate(() => window.__soundEngine.played);
  await character.mouse.click(point.x, point.y);
  await until(() => character.evaluate((previous) => window.__soundEngine.played >= previous + 2, played), '点击角色未触发按下和松开原声');
  // 模拟首次预热失败后的空缓存，经真实 IPC 修复后应立刻重新预热，无需重启或保存设置。
  await character.evaluate(() => {
    const sound = window.__soundEngine;
    sound.stop();
    sound.buffers.clear();
    sound.lastError = '模拟音频预热失败';
  });
  const repaired = await page.evaluate(() => window.dragonGirl.command('install-audio'));
  assert.equal(repaired.complete, true);
  await until(() => character.evaluate(() => window.__soundEngine.buffers.size === 9 && window.__soundEngine.lastError === null), '修复后角色未自动恢复原声');
  await application.evaluate(() => globalThis.__dragonGirlApp.companion.showBubble('Windows 桌面陪伴已就绪'));
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.companion.windows.get('bubble').isVisible()), '气泡未显示');
  const saved = JSON.parse(await fs.readFile(path.join(env.DRAGONGIRL_DATA_DIR, 'settings.json'), 'utf8'));
  assert.equal(saved.mode, 'desktop');
  assert.equal(saved.volume, 0.2);
  assert.deepEqual(errors, []);
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  const report = { passed: true, packaged: !!executablePath, platform: process.platform, checks: ['界面启动', '目录发现', '统计进程', '系统托盘', '透明角色', '内置九段原声', '点击音效', '离线音效修复', '气泡', '设置保存'], errors };
  await fs.writeFile(path.join(root, '.artifacts/windows-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await application?.close();
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
