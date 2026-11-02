import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-menu-'));
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
const errors = [];
let application, page;

// 依据正式 IPC、窗口与绘制状态等待，未打开的菜单或未播放的动画不能误判为已经恢复。
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(message);
}

// 同时观察实际窗口和屏幕上的角色位置，菜单展开不能移动角色或改写持久化状态。
async function snapshot() {
  return application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    const bounds = c.windows.get('character').getBounds();
    const model = c.characterModel();
    return { menuOpen: !!c.contextMenu, interactive: c.interactive.get('character'), visible: c.visible,
      bounds, area: c.display.workArea, state: c.state, character: c.character,
      position: { x: bounds.x + model.rect.x, y: bounds.y + model.rect.y },
      expressions: c.contextMenu?.items.find((item) => item.label === '表情')?.submenu.items.map((item) => item.label) };
  });
}

// 从真实脸颊发出右键事件，覆盖渲染器、预加载和所属角色的主进程入口。
async function openMenu() {
  const point = await page.evaluate(async () => {
    const { rect } = await window.dragonGirl.bootstrap();
    return { x: rect.x + rect.width * 0.48, y: rect.y + rect.height * 0.72 };
  });
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await until(async () => (await snapshot()).menuOpen, '右键没有打开原生菜单');
}

try {
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DRAGONGIRL_MONITOR_TEST;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env });
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest?.ready.size === 2), '角色未完成启动');
  page = application.windows().find((page) => page.url().endsWith('/character.html'));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    // 保留真实一级菜单长度，使用空委托避免测试打开管理页或触发账户查询。
    c.delegate = { openDashboard: () => {}, refresh: () => {} };
    c.setAppearance({ settings: { motion: false, eyeTracking: false, blinkEnabled: false, soundEnabled: false, expressionsEnabled: true } });
    c.setScale(0.6);
    c.character.x = c.display.workArea.x + 300;
    c.character.y = c.display.workArea.y + c.display.workArea.height - c.character.height - 20;
    c.applyCharacter();
  });
  const before = await snapshot();
  for (const [label, name] of [['开心', 'happy'], ['伤心', 'sad']]) {
    await openMenu();
    const opened = await snapshot();
    assert.deepEqual(opened.expressions, ['开心', '伤心']);
    assert.deepEqual(opened.position, before.position, '菜单展开移动了屏幕上的角色');
    assert.deepEqual(opened.state, before.state, '菜单展开改写了偏好');
    if (process.platform === 'darwin') assert.deepEqual(opened.bounds, opened.area, '小窗口仍限制一级菜单的可用高度');

    // 鼠标移出角色、全局轮询和跟随更新不能中断原生菜单的输入或改变其锚点。
    await page.evaluate(() => window.dragonGirl.interactive(false));
    await application.evaluate(() => {
      const c = globalThis.__dragonGirlTest;
      c.pollCursor(true);
      c.followFrame({ ...c.display.workArea, x: c.display.workArea.x + 40 });
    });
    assert.equal((await snapshot()).interactive, true, '子菜单悬停期间窗口重新穿透');
    assert.deepEqual((await snapshot()).character, before.character, '跟随更新移动了菜单所属角色');

    // 执行原生子菜单的实际回调，并关闭原生菜单来验证生产关闭回调与动画通道。
    await application.evaluate((_, label) => {
      const c = globalThis.__dragonGirlTest;
      const menu = c.contextMenu;
      menu.items.find((item) => item.label === '表情').submenu.items.find((item) => item.label === label).click();
      menu.closePopup(c.windows.get('character'));
    }, label);
    await until(async () => !(await snapshot()).menuOpen, '选择表情后菜单没有释放');
    assert.deepEqual((await snapshot()).bounds, before.bounds, '菜单关闭后没有恢复角色小窗口');
    await until(() => page.locator('#character').getAttribute('data-expression').then((value) => value === name), `${label}没有播放`);
    await until(() => page.locator('#character').getAttribute('data-expression').then((value) => value === null), `${label}没有自动恢复`);
    await page.evaluate(() => window.dragonGirl.interactive(false));
    await until(async () => !(await snapshot()).interactive, '菜单关闭后透明区域没有恢复穿透');
  }

  // 主动收起必须关闭菜单并释放临时大窗口，重新叫出时不重放旧表情。
  await openMenu();
  await application.evaluate(() => globalThis.__dragonGirlTest.hide());
  await until(async () => !(await snapshot()).menuOpen, '收起角色没有关闭菜单');
  const hidden = await snapshot();
  assert.equal(hidden.visible, false);
  assert.equal(hidden.interactive, false);
  assert.deepEqual(hidden.bounds, before.bounds);
  await application.evaluate(() => globalThis.__dragonGirlTest.show());
  assert.equal(await page.locator('#character').getAttribute('data-expression'), null);
  assert.deepEqual(errors, []);
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  await fs.writeFile(path.join(root, '.artifacts/menu-report.json'), JSON.stringify({ passed: true, platform: process.platform, before, errors }, null, 2));
  console.log('原生菜单验证通过：60% 大小与屏幕底部、完整菜单空间、二级输入保持、跟随暂停、开心与伤心、自动恢复、小窗口与穿透恢复、收起关闭。');
} finally {
  await application?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
