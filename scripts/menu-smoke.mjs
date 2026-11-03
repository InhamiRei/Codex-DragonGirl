import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-menu-'));
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
const errors = [];
let application, page;
const menuProbe = path.join(temporary, 'menu-probe');

// 用系统菜单窗口的真实尺寸验收完整展开，不能只凭 JavaScript 中存在菜单对象判断成功。
function nativeMenus() {
  const result = spawnSync(menuProbe, [String(application.process().pid)], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

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
      bounds, area: c.display.workArea, screen: c.display.bounds, state: c.state, character: c.character,
      position: { x: bounds.x + model.rect.x, y: bounds.y + model.rect.y },
      expressions: c.contextMenu?.items.find((item) => item.label === '表情')?.submenu.items.map((item) => item.label) };
  });
}

// 从真实脸颊发出右键事件，覆盖渲染器、预加载和所属角色的主进程入口。
async function openMenu() {
  // 等待上一轮原生菜单真正消失、网页收到窗口坐标，避免把关闭动画或旧坐标当成本轮菜单。
  if (process.platform === 'darwin') await until(() => nativeMenus().length === 0, '上一轮原生菜单尚未关闭');
  const bounds = await application.evaluate(() => globalThis.__dragonGirlTest.windows.get('character').getContentBounds());
  await until(() => page.evaluate((bounds) => innerWidth === bounds.width && innerHeight === bounds.height
    && Math.abs(screenX - bounds.x) <= 1 && Math.abs(screenY - bounds.y) <= 1, bounds), '网页尚未同步人物窗口坐标');
  const point = await page.evaluate(async () => {
    const { rect } = await window.dragonGirl.bootstrap();
    return { x: rect.x + rect.width * 0.48, y: rect.y + rect.height * 0.72 };
  });
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await until(async () => (await snapshot()).menuOpen, '右键没有打开原生菜单');
}

// 菜单交给系统避让屏幕边缘，直接验证真正菜单窗口的完整尺寸与屏幕边界。
async function verifyNativeMenu(reference) {
  if (process.platform !== 'darwin') return;
  const area = reference.screen;
  let menus;
  try {
    await until(() => {
      menus = nativeMenus();
      return menus.some((menu) => menu.alpha >= 0.9 && menu.height > reference.bounds.height + 24
        && menu.x >= area.x - 8 && menu.y >= area.y - 8
        && menu.x + menu.width <= area.x + area.width + 8
        && menu.y + menu.height <= area.y + area.height + 8);
    }, '原生菜单没有完整展开在屏幕内');
  } catch (error) { throw new Error(`${error.message}\n${JSON.stringify({ reference, menus, current: await snapshot() })}`); }
}

try {
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', path.join(os.tmpdir(), 'dragongirl-swift-cache'), path.join(root, 'tests/fixtures/MenuProbe.swift'), '-o', menuProbe], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
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
  await application.evaluate(() => {
    const window = globalThis.__dragonGirlTest.windows.get('character');
    globalThis.__menuGeometryCalls = [];
    // 菜单开关不能靠人物窗口的临时移动、缩放或隐藏完成。
    for (const name of ['setBounds', 'setPosition', 'setSize', 'hide']) {
      const original = window[name].bind(window);
      window[name] = (...args) => { globalThis.__menuGeometryCalls.push(name); return original(...args); };
    }
  });
  for (const [label, name] of [['开心', 'happy'], ['伤心', 'sad']]) {
    await openMenu();
    const opened = await snapshot();
    assert.deepEqual(opened.expressions, ['开心', '伤心']);
    assert.deepEqual(opened.position, before.position, '菜单展开移动了屏幕上的角色');
    assert.deepEqual(opened.state, before.state, '菜单展开改写了偏好');
    assert.deepEqual(opened.bounds, before.bounds, '右键菜单改变了人物原生窗口，可能先显示一帧旧坐标');
    await verifyNativeMenu(opened);

    // 鼠标移出角色、全局轮询和跟随更新不能中断原生菜单的输入或改变其锚点。
    await page.evaluate(() => window.dragonGirl.interactive(false));
    await application.evaluate(() => {
      const c = globalThis.__dragonGirlTest;
      c.pollCursor(true);
      c.followFrame({ ...c.display.workArea, x: c.display.workArea.x + 40 });
      c.setAppearance({ ...c.appearance, status: 'working' });
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
    if (process.platform === 'darwin') await until(() => nativeMenus().length === 0, '原生菜单关闭动画没有结束');
    assert.deepEqual((await snapshot()).bounds, before.bounds, '菜单关闭后没有恢复角色小窗口');
    await until(() => page.locator('#character').getAttribute('data-expression').then((value) => value === name), `${label}没有播放`);
    await until(() => page.locator('#character').getAttribute('data-expression').then((value) => value === null), `${label}没有自动恢复`);
    await page.evaluate(() => window.dragonGirl.interactive(false));
    await until(async () => !(await snapshot()).interactive, '菜单关闭后透明区域没有恢复穿透');
  }
  assert.deepEqual(await application.evaluate(() => globalThis.__menuGeometryCalls), [], '菜单开关仍修改了人物原生窗口');

  // 用户主动选择大小时应正常调整原生窗口，不能因移除菜单扩窗而只放大网页中的图片。
  await openMenu();
  await verifyNativeMenu(await snapshot());
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest, menu = c.contextMenu;
    menu.items.find((item) => item.label === '大小').submenu.items.find((item) => item.label === '标准 · 100%').click();
    menu.closePopup(c.windows.get('character'));
  });
  await until(async () => !(await snapshot()).menuOpen && (await snapshot()).bounds.width > before.bounds.width, '选择大小后人物原生窗口没有随之调整');
  if (process.platform === 'darwin') await until(() => nativeMenus().length === 0, '大小菜单尚未关闭');
  await application.evaluate((_, character) => {
    const c = globalThis.__dragonGirlTest;
    c.setScale(0.6);
    c.character = character;
    c.applyCharacter();
  }, before.character);

  // 主动收起必须关闭菜单并释放输入，重新叫出时不重放旧表情。
  await openMenu();
  await application.evaluate(() => globalThis.__dragonGirlTest.hide());
  await until(async () => !(await snapshot()).menuOpen, '收起角色没有关闭菜单');
  const hidden = await snapshot();
  assert.equal(hidden.visible, false);
  assert.equal(hidden.interactive, false);
  assert.deepEqual(hidden.bounds, before.bounds);
  await application.evaluate(() => globalThis.__dragonGirlTest.show());
  assert.equal(await page.locator('#character').getAttribute('data-expression'), null);
  // 四角连续开关必须保持人物窗口与屏幕位置不变，尤其覆盖靠右时菜单向左展开的情况。
  for (const corner of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]) {
    await application.evaluate((_, corner) => {
      const c = globalThis.__dragonGirlTest, area = c.display.workArea;
      c.character.x = area.x + 20 + (area.width - c.character.width - 40) * corner.x;
      c.character.y = area.y + 20 + (area.height - c.character.height - 40) * corner.y;
      c.applyCharacter();
      globalThis.__menuGeometryCalls = [];
    }, corner);
    const positioned = await snapshot();
    await openMenu();
    await verifyNativeMenu(await snapshot());
    assert.deepEqual((await snapshot()).bounds, positioned.bounds, '角落菜单移动或缩放了人物窗口');
    assert.deepEqual((await snapshot()).position, positioned.position, '角落菜单造成了人物瞬移');
    await application.evaluate(() => {
      const c = globalThis.__dragonGirlTest;
      c.contextMenu.closePopup(c.windows.get('character'));
    });
    await until(async () => !(await snapshot()).menuOpen, '角落菜单未关闭');
    if (process.platform === 'darwin') await until(() => nativeMenus().length === 0, '角落菜单的原生窗口尚未关闭');
    assert.deepEqual((await snapshot()).bounds, positioned.bounds);
    assert.deepEqual(await application.evaluate(() => globalThis.__menuGeometryCalls), [], '角落菜单仍修改了人物原生窗口');
  }
  assert.deepEqual(errors, []);
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  await fs.writeFile(path.join(root, '.artifacts/menu-report.json'), JSON.stringify({ passed: true, platform: process.platform, before, errors }, null, 2));
  console.log('原生菜单验证通过：展开和关闭不移动、不缩放、不隐藏人物，四角菜单完整展开、二级动作、主动缩放、跟随暂停、表情与穿透恢复、收起关闭。');
} finally {
  await application?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
