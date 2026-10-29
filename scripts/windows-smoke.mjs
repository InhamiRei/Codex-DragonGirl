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
  await application.evaluate(() => globalThis.__dragonGirlApp.companion.showBubble('Windows 桌面陪伴已就绪'));
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.companion.windows.get('bubble').isVisible()), '气泡未显示');
  const saved = JSON.parse(await fs.readFile(path.join(env.DRAGONGIRL_DATA_DIR, 'settings.json'), 'utf8'));
  assert.equal(saved.mode, 'desktop');
  assert.equal(saved.volume, 0.2);
  assert.deepEqual(errors, []);
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  const report = { passed: true, packaged: !!executablePath, platform: process.platform, checks: ['界面启动', '目录发现', '统计进程', '系统托盘', '透明角色', '气泡', '设置保存'], errors };
  await fs.writeFile(path.join(root, '.artifacts/windows-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await application?.close();
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
