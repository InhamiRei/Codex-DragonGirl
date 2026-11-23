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

// 同一目录开两个进程后，切去别的应用时仍保持最近的宿主。关闭该进程后才改选另一个。
async function verifySharedHome() {
  const pids = await application.evaluate(async () => {
    const { monitor, dashboard, companion } = globalThis.__dragonGirlApp;
    const first = { ...monitor.processes[0], frontmost: false };
    const second = { ...first, pid: first.pid + 1, frontmost: true };
    monitor.processes = [first, second];
    await dashboard.updatePets();
    const focused = companion.followPID;
    second.frontmost = false;
    await dashboard.updatePets();
    const covered = companion.followPID;
    monitor.processes = [first];
    await dashboard.updatePets();
    return { first: first.pid, second: second.pid, focused, covered, remaining: companion.followPID };
  });
  assert.equal(pids.focused, pids.second);
  assert.equal(pids.covered, pids.second);
  assert.equal(pids.remaining, pids.first);
}

// 在受控的小工作区中通过真实管理页入口连续打开，让系统实际执行最小化和恢复。
async function verifyDashboardWindow() {
  const result = await application.evaluate(async ({ screen }) => {
    const { dashboard } = globalThis.__dragonGirlApp, previous = dashboard.window;
    const closed = new Promise(resolve => previous.once('closed', resolve));
    previous.close();
    await closed;
    const display = screen.getPrimaryDisplay();
    const area = { ...display.workArea, width: Math.min(760, display.workArea.width), height: Math.min(520, display.workArea.height) };
    const nearest = screen.getDisplayNearestPoint;
    screen.getDisplayNearestPoint = () => ({ ...display, workArea: area });
    try {
      const first = dashboard.open(), window = dashboard.window;
      const second = dashboard.open();
      const early = window.isVisible();
      await Promise.all([first, second]);
      return { early, same: dashboard.window === window, bounds: window.getBounds(), minimum: window.getMinimumSize(), area };
    } finally { screen.getDisplayNearestPoint = nearest; }
  });
  assert.equal(result.early, false, '重复打开提前显示了尚未加载的管理窗口');
  assert.equal(result.same, true);
  assert.ok(result.minimum[0] <= result.area.width && result.minimum[1] <= result.area.height);
  assert.ok(result.bounds.width <= result.area.width && result.bounds.height <= result.area.height);
  // 用实际渲染的按钮验证窄窗底部仍能保存；只看原生窗口的宽高会漏掉内容裁切。
  const smallPage = application.windows().find(view => !view.isClosed() && view.url().endsWith('/dashboard.html'));
  await smallPage.locator('.main-nav [data-tab="settings"]').click();
  const save = smallPage.locator('#save-settings');
  await save.scrollIntoViewIfNeeded();
  assert.ok(await save.evaluate(button => {
    const b = button.getBoundingClientRect();
    return b.left >= 0 && b.top >= 0 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1;
  }), '小屏管理窗口内的保存按钮被裁切');
  await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.window.minimize());
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.dashboard.window.isMinimized()), '管理窗口未进入最小化');
  await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.open());
  await until(() => application.evaluate(() => {
    const win = globalThis.__dragonGirlApp.dashboard.window;
    return win.isVisible() && !win.isMinimized();
  }), '从托盘再次打开后管理窗口仍在最小化');
}

// 只终止隔离测试窗口的渲染器，必须回到同一个原生窗口，并保留用户选择的显隐状态。
async function verifyRendererRecovery() {
  // 进程编号改变且页面重新就绪，才能判定恢复完成。
  async function restart(view) {
    const previous = await application.evaluate((_, view) => {
      const { dashboard, companion } = globalThis.__dragonGirlApp;
      const window = view === 'dashboard' ? dashboard.window : companion.windows.get(view);
      const old = { id: window.id, pid: window.webContents.getOSProcessId() };
      window.webContents.forcefullyCrashRenderer();
      return old;
    }, view);
    await until(() => application.evaluate(async (_, { view, previous }) => {
      const { dashboard, companion } = globalThis.__dragonGirlApp;
      const window = view === 'dashboard' ? dashboard.window : companion.windows.get(view);
      const contents = window?.webContents;
      if (!contents || contents.isCrashed() || contents.isLoadingMainFrame() || !contents.getOSProcessId()
        || contents.getOSProcessId() === previous.pid || window.id !== previous.id) return false;
      return view === 'dashboard' ? contents.executeJavaScript("document.readyState === 'complete' && !!document.querySelector('#save-settings')")
        : companion.ready.has(view);
    }, { view, previous }), view + ' 页面异常后没有在原窗口内恢复');
  }
  await restart('character');
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.companion.windows.get('character').isVisible()), '角色重新就绪后未恢复可见');
  await application.evaluate(() => globalThis.__dragonGirlApp.companion.toggleBubble());
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.companion.windows.get('bubble').isVisible()), '恢复后的角色未能打开气泡');
  await restart('bubble');
  assert.ok(await application.evaluate(() => {
    const c = globalThis.__dragonGirlApp.companion;
    return c.visible && c.windows.get('character').isVisible() && !c.windows.get('bubble').isVisible() && !c.interactive.get('bubble');
  }), '气泡恢复改变了角色状态或留下输入区域');
  await application.evaluate(() => globalThis.__dragonGirlApp.companion.hide());
  await restart('character');
  assert.equal(await application.evaluate(() => globalThis.__dragonGirlApp.companion.windows.get('character').isVisible()), false,
    '页面恢复覆盖了用户主动隐藏的设置');
  await restart('dashboard');
}

try {
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  home = await fs.realpath(home);
  await launch();
  await page.locator('[data-tab="settings"]').click();
  await page.locator('[data-settings-tab="appearance"]').click();
  const desktopAnchor = await application.evaluate(() => globalThis.__dragonGirlApp.companion.state.placement);
  await drag(0.25, 0.35);
  await until(async () => !!(await offset()), '拖动未保存窗口位置');
  const saved = await offset();
  assert.deepEqual(await application.evaluate(() => globalThis.__dragonGirlApp.companion.state.placement), desktopAnchor,
    '跟随拖动覆盖了独立桌面的位置');
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
  const stable = await application.evaluate(() => {
    const { companion, dashboard } = globalThis.__dragonGirlApp;
    const before = { ...companion.character };
    dashboard.follow();
    return { before, after: companion.character };
  });
  assert.deepEqual(stable.after, stable.before, '保存还在排队时，下一份宿主快照把角色拉回了旧位置');
  await application.close(); application = null;
  await launch();
  const immediate = await offset();
  assert.ok(Math.abs(immediate.x - 0.65) < 0.01 && Math.abs(immediate.y - 0.55) < 0.01, '拖动后立即退出丢失了尚未写入的位置');
  // 从用户实际的菜单重置，再重开应用检查宿主锚点有没有写入。
  await application.evaluate(() => globalThis.__dragonGirlApp.companion.buildMenu().items.find(item => item.label === '回到右下角').click());
  await until(async () => { const value = await offset(); return value.x === 1 && value.y === 1; }, '菜单没有重置宿主锚点');
  await application.close(); application = null;
  await launch();
  assert.deepEqual(await offset(), { x: 1, y: 1 });
  await verifySharedHome();
  await verifyDashboardWindow();
  await verifyRendererRecovery();
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  const report = { passed: true, checks: ['旧偏好草稿不覆盖新位置', '重启恢复跟随锚点与真实摆放', '拖动后立即退出仍保存', '重启后九段内置音效可用且没有下载',
    '跟随拖动保留独立桌面位置、慢保存期间不跳回、菜单重置可重启恢复', '同账户多进程切走前台后跟随原宿主',
    '小屏管理页、连点托盘及最小化后重新打开', '角色、气泡和管理页渲染器异常后原窗恢复，保留主动隐藏'] };
  await fs.writeFile(path.join(root, '.artifacts/position-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (application) await application.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
