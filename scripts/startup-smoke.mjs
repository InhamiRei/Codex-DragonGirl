import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeStartupJson } from '../src/core/startup-registration.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘 静默启动-'));
const data = path.join(temp, 'data');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1',
  DRAGONGIRL_DATA_DIR: data, DRAGONGIRL_FIXTURE_HOME: path.join(temp, 'user') };
delete env.ELECTRON_RUN_AS_NODE;
let application, statusTimer, hosts = ['fixture:1'];
const revision = 'startup-smoke';
const errors = [];

// 轮询真实 Electron 状态，避免固定等待把未初始化误当静默成功。
async function until(check, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

// 测试只向临时目录发布宿主快照，不连接系统中的实际 Codex 或账户。
async function publish() {
  await writeStartupJson(path.join(data, 'startup/status.json'), { revision, updatedAt: Date.now(), hosts, phase: hosts.length ? 'running' : 'waiting' });
}

// 安装包与源码共用同一组启动参数，验证成品也支持静默入口。
async function launch(reason) {
  application = await electron.launch({
    ...(executablePath ? { executablePath, cwd: temp } : { cwd: root }),
    args: [...(executablePath ? [] : [root]), ...(reason ? [`--dg-startup=${reason}`] : [])],
    env, timeout: 60000,
  });
  application.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await until(() => application.evaluate(() => !!globalThis.__dragonGirlApp?.startup), '龙娘未完成初始化');
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.companion.ready.size === 2), '角色未初始化');
}

try {
  await fs.mkdir(path.join(env.DRAGONGIRL_FIXTURE_HOME, '.codex/sessions'), { recursive: true });
  await writeStartupJson(path.join(data, 'settings.json'), { startupMode: 'codex', mode: 'follow' });
  await writeStartupJson(path.join(data, 'startup/config.json'), { version: 1, revision, mode: 'codex' });
  await publish();
  statusTimer = setInterval(() => void publish().catch(() => {}), 300);
  await launch('codex');
  assert.equal(await application.evaluate(() => !!globalThis.__dragonGirlApp.dashboard.window), false, '自动启动弹出了管理窗口');
  assert.equal(await application.evaluate(() => globalThis.__dragonGirlApp.startup.managed), true);
  assert.equal(await application.evaluate(() => globalThis.__dragonGirlApp.companion.windows.get('character').isVisible()), false, '无目标窗口时角色不应闪现');
  // 再次从操作系统启动同一个实例，必须去重且不抢焦点。
  const duplicate = spawn(executablePath || electronPath, [...(executablePath ? [] : [root]), '--dg-startup=codex'], { env, stdio: 'ignore', windowsHide: true });
  await until(() => duplicate.exitCode !== null, '重复自动启动没有结束');
  assert.equal(await application.evaluate(() => !!globalThis.__dragonGirlApp.dashboard.window), false);
  assert.equal(await application.evaluate(() => globalThis.__dragonGirlApp.startup.managed), true);
  hosts = [];
  const automaticProcess = application.process();
  await publish();
  await until(() => automaticProcess.exitCode !== null, 'Codex 全部退出后自动实例没有退出');
  application = null;
  await assert.rejects(fs.access(path.join(data, 'startup/runtime.json')), { code: 'ENOENT' });
  // 手动启动仍显示设置，启动方式只在保存后生效。
  await launch();
  await until(() => application.windows().some((page) => page.url().endsWith('/dashboard.html')), '手动打开没有显示管理页');
  const page = application.windows().find((item) => item.url().endsWith('/dashboard.html'));
  await page.locator('[data-tab="settings"]').click();
  await page.locator('[data-settings-tab="appearance"]').click();
  assert.equal(await page.locator('#startup-mode').inputValue(), 'codex');
  await page.locator('[data-select="startup-mode"]').click();
  await page.locator('#startup-mode-list [role="option"]').nth(0).click();
  assert.equal(await application.evaluate(() => globalThis.__dragonGirlApp.monitor.settings.startupMode), 'codex');
  await page.locator('#save-settings').click();
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.monitor.settings.startupMode === 'manual'), '启动方式没有保存');
  assert.equal(await application.evaluate(() => globalThis.__dragonGirlApp.startup.managed), false);
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, '.artifacts/startup-settings.png') });
  await application.close(); application = null;
  // 登录自启同样静默，但不随 Codex 退出而停止。
  await writeStartupJson(path.join(data, 'settings.json'), { startupMode: 'login', mode: 'desktop' });
  await launch('login');
  assert.equal(await application.evaluate(() => !!globalThis.__dragonGirlApp.dashboard.window), false);
  assert.equal(await application.evaluate(() => globalThis.__dragonGirlApp.startup.managed), false);
  assert.deepEqual(errors, []);
  const report = { passed: true, checks: ['自动启动静默', '无窗口不闪现', '重复启动去重', '宿主退出正常保存', '手动启动管理页', '启动方式草稿与保存', '登录启动静默'] };
  await fs.writeFile(path.join(root, '.artifacts/startup-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  clearInterval(statusTimer);
  if (application) await application.close();
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
