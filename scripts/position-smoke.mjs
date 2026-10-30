import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-position-'));
const data = path.join(temporary, 'data');
let home = path.join(temporary, 'user/.codex');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1',
  DRAGONGIRL_DATA_DIR: data, DRAGONGIRL_FIXTURE_HOME: path.dirname(home) };
delete env.ELECTRON_RUN_AS_NODE;
let application, page;

// 等待真实应用状态，不用人工刷新掩盖位置保存时序。
async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

// 每次启动使用相同隔离数据和模拟窗口，验证磁盘恢复而非内存留存。
async function launch() {
  application = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 60000 });
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp?.monitor.instances.length === 1), '测试实例未就绪');
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.dashboard.latest?.instances.length === 1 && !globalThis.__dragonGirlApp.dashboard.updating), '实例尚未发布到管理页');
  await until(() => application.windows().some((view) => view.url().endsWith('/dashboard.html')), '管理页未就绪');
  page = application.windows().find((view) => view.url().endsWith('/dashboard.html'));
  await application.evaluate(async ({ screen }, home) => {
    const { monitor, dashboard } = globalThis.__dragonGirlApp;
    const area = screen.getPrimaryDisplay().workArea;
    monitor.processes = [{ pid: 9990, home, frontmost: true, windows: [{
      x: area.x + 30, y: area.y + 50, width: Math.min(700, area.width - 60), height: Math.min(650, area.height - 100),
    }] }];
    await dashboard.updatePets();
  }, home);
}

// 走真实拖动结束与委托保存路径，跳过受桌面真实光标影响的输入注入。
async function drag(x, y, delay = false) {
  return application.evaluate((_, { x, y, delay }) => {
    const { companion, monitor } = globalThis.__dragonGirlApp;
    if (delay) monitor.settingsStore.queue = monitor.settingsStore.queue.then(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    const frame = companion.followTarget, rect = { ...companion.character };
    const start = { x: rect.x + 20, y: rect.y + 20 };
    const end = { x: start.x + frame.x + (frame.width - rect.width) * x - rect.x,
      y: start.y + frame.y + (frame.height - rect.height) * y - rect.y };
    companion.gesture.begin(start, rect);
    companion.moveGesture(end);
    companion.endGesture(end);
  }, { x, y, delay });
}

// 获取实际已保存的窗口锚点，后续比较不依赖 PID。
async function offset() {
  return application.evaluate((_, home) => globalThis.__dragonGirlApp.monitor.settings.followOffsets[home], home);
}

try {
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  home = await fs.realpath(home);
  await launch();
  await page.locator('[data-tab="settings"]').click();
  await page.locator('[data-settings-tab="appearance"]').click();
  await drag(0.25, 0.35);
  await until(async () => !!(await offset()), '拖动未保存窗口位置');
  const saved = await offset();
  await page.locator('input[name="motion"]').uncheck();
  await page.locator('#save-settings').click();
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.monitor.settings.motion === false), '偏好设置未保存');
  assert.deepEqual(await offset(), saved, '保存偏好覆盖了设置页打开后拖动的新位置');
  assert.equal((await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.command('audio-status'))).complete, true);
  await application.close(); application = null;
  await launch();
  assert.deepEqual(await offset(), saved, '重启后没有恢复跟随位置');
  const restored = await application.evaluate(() => {
    const { companion } = globalThis.__dragonGirlApp;
    const frame = companion.followTarget;
    return { x: (companion.character.x - frame.x) / (frame.width - companion.character.width),
      y: (companion.character.y - frame.y) / (frame.height - companion.character.height) };
  });
  assert.ok(Math.abs(restored.x - saved.x) < 0.01 && Math.abs(restored.y - saved.y) < 0.01, '磁盘锚点没有用于实际窗口摆放');
  assert.equal((await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.command('audio-status'))).installed, 9);
  assert.deepEqual(await fs.readdir(path.join(data, 'assets')).catch(() => []), [], '测试不应下载用户音效副本');
  await drag(0.65, 0.55, true);
  await application.close(); application = null;
  await launch();
  const immediate = await offset();
  assert.ok(Math.abs(immediate.x - 0.65) < 0.01 && Math.abs(immediate.y - 0.55) < 0.01, '拖动后立即退出丢失了尚未写入的位置');
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  const report = { passed: true, checks: ['旧偏好草稿不覆盖新位置', '重启恢复跟随锚点与真实摆放', '拖动后立即退出仍保存', '重启后九段内置音效可用且没有下载'] };
  await fs.writeFile(path.join(root, '.artifacts/position-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (application) await application.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
