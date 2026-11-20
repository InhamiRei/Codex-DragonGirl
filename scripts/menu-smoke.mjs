import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PRAYER_TEXT } from '../src/shared/dialogue.js';
import { EYE_ARTWORK } from '../src/shared/gaze.js';

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
      expressions: c.contextMenu?.items.find((item) => item.label === '动作')?.submenu.items.map((item) => item.label) };
  });
}

// 从真实脸颊发出右键事件，覆盖渲染器、预加载和所属角色的主进程入口。
async function openMenu() {
  // 等待原生菜单关闭、窗口坐标同步和翻转结束，防止点在角色暂时穿透的中间帧。
  if (process.platform === 'darwin') await until(() => nativeMenus().length === 0, '上一轮原生菜单尚未关闭');
  const bounds = await application.evaluate(() => globalThis.__dragonGirlTest.windows.get('character').getContentBounds());
  await until(() => page.evaluate((bounds) => innerWidth === bounds.width && innerHeight === bounds.height
    && Math.abs(screenX - bounds.x) <= 1 && Math.abs(screenY - bounds.y) <= 1
    && document.getElementById('character').dataset.flipping === 'false', bounds), '网页尚未同步人物窗口坐标或完成翻转');
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
    for (let attempt = 0; attempt < 3; attempt++) {
      let dismissed;
      await until(async () => {
        dismissed = !(await snapshot()).menuOpen;
        if (dismissed) return true;
        menus = nativeMenus();
        return menus.some((menu) => menu.alpha >= 0.9 && menu.height > reference.bounds.height + 24
          && menu.x >= area.x - 8 && menu.y >= area.y - 8
          && menu.x + menu.width <= area.x + area.width + 8
          && menu.y + menu.height <= area.y + area.height + 8);
      }, '原生菜单没有完整展开在屏幕内');
      if (!dismissed) return;
      // 焦点切换可能关闭系统菜单，只在确实关闭后重新打开一次采样。
      if (attempt < 2) await openMenu();
    }
    throw new Error('采样完成前系统连续关闭了原生菜单');
  } catch (error) { throw new Error(`${error.message}\n${JSON.stringify({ reference, menus, current: await snapshot() })}`); }
}

// 在原画分辨率验收贴图，锁住左眼角、左右刘海、侧发和嘴部的透明像素。
async function verifyDragonEyeAtlas() {
  const regions = [[390, 614, 36, 30], [376, 706, 13, 40], [586, 617, 45, 113],
    [687, 620, 47, 122], [957, 751, 46, 87], [600, 847, 131, 106]];
  const result = await page.evaluate(async ({ artwork, regions }) => {
    const atlas = new Image();
    atlas.src = 'dragon://app/assets/characters/codex-dragon-girl-expressions.png';
    await atlas.decode();
    const [left, right] = artwork.eyes;
    const canvas = new OffscreenCanvas(artwork.width, artwork.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const clear = [];
    // 按正式切片坐标还原三种眼神，保护区内每一个像素的透明度都必须是零。
    for (let row = 0; row < 3; row += 1) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      const top = row * right.height;
      context.drawImage(atlas, 0, top, left.width, left.height, left.x, left.y, left.width, left.height);
      context.drawImage(atlas, left.width, top, right.width, right.height, right.x, right.y, right.width, right.height);
      clear.push(regions.every((region) => context.getImageData(...region).data
        .every((channel, index) => index % 4 !== 3 || channel === 0)));
    }
    return { height: atlas.naturalHeight, clear };
  }, { artwork: EYE_ARTWORK, regions });
  assert.equal(result.height, EYE_ARTWORK.eyes[1].height * 3, '贴图应当只有三种眼神');
  assert.deepEqual(result.clear, [true, true, true], '表情贴图覆盖了发丝、脸线或嘴部的原画像素');
}

// 蛋包饭保持原画尺寸，悬空的瓶子随酱线依次画过爱心左半边、底尖和右半边。
async function verifyOmuriceRender() {
  const face = page.locator('#dragon-expression');
  // 采样笑脸，再按盘面位置和颜色分别核对爱心、直落酱流和大瓶。
  const frame = () => face.evaluate((canvas, artwork) => {
    const character = document.getElementById('character');
    const bounds = canvas.getBoundingClientRect();
    const { width, height } = canvas;
    // 从独立画布读取像素，避免反复读回时改变正在显示的画布的渲染路径。
    const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, 0, 0);
    // 采样点按原画坐标换算，覆盖桌宠缩放和不同屏幕像素比。
    const sample = (x, y) => context.getImageData(Math.round(x * width / artwork.width),
      Math.round(y * height / artwork.height), 1, 1).data;
    const eyes = [[548, 742], [765, 760]].every(([x, y]) => {
      const [r, g, b] = sample(x, y);
      return r < 65 && g < 65 && b < 90;
    });
    // 下半张脸仍是原本的肤色，双颊仅叠加浅淡的粉红。
    const [skinR, skinG, skinB] = sample(668, 888);
    const cheeks = [[438, 822], [818, 855]].every(([x, y]) => {
      const [r, g, b] = sample(x, y);
      return g >= 195 && r - g >= 17 && r - g < 55 && b >= 192;
    });
    const smiling = eyes && cheeks;
    const mouthless = skinR >= 236 && skinG >= 222 && skinB >= 205;
    const x = Math.round(width * .32), y = Math.round(height * .59);
    const sampleWidth = Math.round(width * .68) - x;
    const pixels = context.getImageData(x, y, sampleWidth, height - y).data;
    let left = 0, right = 0, tip = 0, bottlePixels = 0, bottleSum = 0, sauceTop = 1;
    const streamStart = Math.ceil(height * .79), streamEnd = Math.ceil(height * .837);
    const streamRows = Array.from({ length: streamEnd - streamStart }, () => ({ left: width, right: -1 }));
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
      const pixelX = x + (index / 4) % sampleWidth, pixelY = y + Math.floor(index / 4 / sampleWidth);
      const col = pixelX / width, row = pixelY / height;
      if (row < .92 && r > 168 && g < 119 && b >= 77 && b <= 136 && b > g + 6 && r > g * 1.6) {
        bottlePixels += 1;
        bottleSum += col;
      }
      // 窄酱流在普通像素密度下会与底色混合，按红色优势识别，再检查连续行的宽度和列位置。
      if (pixelY >= streamStart && pixelY < streamEnd && r > 140 && r - Math.max(g, b) > 48) {
        const span = streamRows[pixelY - streamStart];
        span.left = Math.min(span.left, pixelX);
        span.right = Math.max(span.right, pixelX);
      }
      if (row < .79 || r < 150 || r <= g * 1.8 || b >= 66) continue;
      sauceTop = Math.min(sauceTop, row);
      if (col < .47) left += 1;
      if (col > .53) right += 1;
      if (col > .482 && col < .518 && row > .912 && row < .937) tip += 1;
    }
    const fixed = Math.abs(bounds.top - character.offsetTop) < 1
      && Math.abs(bounds.height - character.clientHeight) < 1
      && height === Math.round(character.clientHeight * devicePixelRatio);
    const bottle = bottlePixels > 12 ? bottleSum / bottlePixels : null;
    const largeBottle = bottlePixels > width * height * .002;
    const maxStreamSpan = Math.ceil(width * .013);
    const minStreamRows = Math.max(3, Math.round(height * .018));
    let verticalFlow = false, run = 0, previousCenter = 0;
    for (const { left, right } of streamRows) {
      if (right < left || right - left > maxStreamSpan) {
        run = 0;
        continue;
      }
      const center = (left + right) / 2;
      run = run > 0 && Math.abs(center - previousCenter) <= 1 ? run + 1 : 1;
      previousCenter = center;
      if (run >= minStreamRows) verticalFlow = true;
    }
    // 原门槛来自 60% 尺寸的高分屏画面，按画布面积换算后在各像素密度上检查同一覆盖比例。
    const areaScale = width * height / (312 * 278);
    return { fixed, smiling, mouthless, hasLeft: left > 20 * areaScale, hasRight: right > 20 * areaScale,
      emptyRight: right === 0, hasTip: tip > 10 * areaScale, verticalFlow, bottle, largeBottle, sauceTop };
  }, EYE_ARTWORK);
  let leftBottle;
  await until(async () => {
    const { smiling, hasLeft, emptyRight, verticalFlow, bottle, largeBottle } = await frame();
    if (hasLeft) assert.equal(smiling, true, '画爱心时没有显示眯眼笑脸');
    if (!hasLeft || !emptyRight || !verticalFlow || !largeBottle || bottle === null || bottle >= .48) return false;
    leftBottle = bottle;
    return true;
  }, '悬空的酱瓶没有把可见的酱流挤到爱心左半边', 1400);
  await until(async () => {
    const { fixed, smiling, hasLeft, hasRight, hasTip, bottle } = await frame();
    assert.equal(fixed, true, '蛋包饭改变了人物的底部位置或画布高度');
    assert.equal(smiling, true, '画爱心时丢失了眯眼笑脸');
    return hasLeft && hasRight && hasTip && bottle !== null && bottle > leftBottle + .045;
  }, '悬空的酱瓶没有沿爱心底尖画到右半边', 2300);
  await until(async () => {
    const { smiling, mouthless, hasLeft, hasRight, hasTip, bottle, sauceTop } = await frame();
    return smiling && mouthless && hasLeft && hasRight && hasTip && bottle === null && sauceTop < .853;
  }, '收瓶后蛋皮中上部没有显示完整爱心', 1700);
}

// 「呆住」用独立画布逐像素比对，其他动态眼神用多帧验证眼纹确实在变化。
async function verifyDragonEyeRender(name) {
  if (name !== 'white-eyes') {
    // 越过淡入再对比，避免静止贴图只靠透明度变化通过验证。
    await page.waitForTimeout(300);
    if (name === 'heart') {
      const iris = await page.locator('#dragon-expression').evaluate((canvas, artwork) => {
        const context = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d', { willReadFrequently: true });
        context.drawImage(canvas, 0, 0);
        // 取两边粉心外侧的虹膜，避开跳动的心形、眼线和高光。
        return [[430, 735], [902, 768]].map(([x, y]) => [...context.getImageData(
          Math.floor(x * canvas.width / artwork.width), Math.floor(y * canvas.height / artwork.height), 1, 1).data]);
      }, EYE_ARTWORK);
      assert.ok(iris.every(([r, g, b]) => r > 100 && b > r + 20 && r > g + 10),
        '爱心眼没有保留默认的紫色虹膜：' + JSON.stringify(iris));
    }
    const frame = () => page.locator('#dragon-expression').evaluate((canvas) => {
      const x = Math.round(canvas.width * .27);
      const y = Math.round(canvas.height * .55);
      const width = Math.round(canvas.width * .43);
      const pixels = canvas.getContext('2d').getImageData(x, y, width, Math.round(canvas.height * .17)).data;
      return Array.from(pixels.filter((_, index) => index % 16 < 3));
    });
    const first = await frame();
    await until(async () => (await frame()).some((value, index) => Math.abs(value - first[index]) > 18),
      `${name}停在同一帧`, 1700);
    return;
  }
  await until(() => page.evaluate(async ({ artwork, row }) => {
    const actual = document.getElementById('dragon-expression');
    if (actual.hidden) return false;
    const atlas = new Image();
    atlas.src = 'dragon://app/assets/characters/codex-dragon-girl-expressions.png';
    await atlas.decode();
    const [left, right] = artwork.eyes;
    const composite = new OffscreenCanvas(artwork.width, artwork.height);
    const context = composite.getContext('2d');
    context.drawImage(document.getElementById('portrait'), 0, 0);
    const top = row * right.height;
    context.drawImage(atlas, 0, top, left.width, left.height, left.x, left.y, left.width, left.height);
    context.drawImage(atlas, left.width, top, right.width, right.height, right.x, right.y, right.width, right.height);
    const { width, height } = actual;
    const expected = new OffscreenCanvas(width, height).getContext('2d');
    expected.imageSmoothingQuality = 'high';
    expected.drawImage(composite, 0, 0, width, height);
    // 只读眼区和发际线，透明外轮廓的预乘色值可能有一档舍入差异。
    const x = Math.floor(340 * width / artwork.width), y = Math.floor(615 * height / artwork.height);
    const region = [x, y, Math.ceil(670 * width / artwork.width), Math.ceil(245 * height / artwork.height)];
    const pixels = expected.getImageData(...region).data;
    const rendered = actual.getContext('2d').getImageData(...region).data;
    return pixels.every((value, index) => value === rendered[index]);
  }, { artwork: EYE_ARTWORK, row: 1 }), '小尺寸表情与原生合成后的缩放画面不一致', 1500);
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
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest?.started === true), '角色未完成启动');
  page = application.windows().find((page) => page.url().endsWith('/character.html'));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await application.evaluate(({ screen }) => {
    const c = globalThis.__dragonGirlTest;
    // 固定本用例的工作区，菜单定位断言不混入系统菜单栏或程序坞的尺寸变动。
    screen.removeListener('display-metrics-changed', c.onDisplayChanged);
    // 保留真实一级菜单长度，使用空委托避免测试打开管理页或触发账户查询。
    c.delegate = { openDashboard: () => {}, refresh: () => {}, selectCharacter: async () => {} };
    c.setAppearance({ settings: { motion: false, eyeTracking: false, blinkEnabled: false, soundEnabled: false, expressionsEnabled: true } });
    c.character.x = c.display.workArea.x + 300;
    c.character.y = c.display.workArea.y + c.display.workArea.height - c.character.height - 20;
    // 通过缩放入口记录测试位置的锚点，工作区刷新时也使用这次摆放。
    c.setScale(0.6);
  });
  await verifyDragonEyeAtlas();
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
  // 通过同一个原生动作菜单逐个播放，验证素材显示和自动恢复。
  const newEyes = [['爱心', 'heart'], ['呆住', 'white-eyes'], ['晕晕', 'spiral-eyes'], ['蛋包饭', 'omurice']];
  const expressions = [['发光', 'happy'], ['哭泣', 'sad'], ['祈祷', 'prayer'], ...newEyes];
  for (const [label, name] of expressions) {
    await openMenu();
    const opened = await snapshot();
    assert.deepEqual(opened.expressions, expressions.map(([label]) => label));
    assert.deepEqual(opened.position, before.position, '菜单展开移动了屏幕上的角色');
    assert.deepEqual(opened.state, before.state, '菜单展开改写了偏好');
    assert.deepEqual(opened.bounds, before.bounds, '右键菜单改变了人物原生窗口，可能先显示一帧旧坐标');
    await verifyNativeMenu(opened);

    // 在同一次主进程检查中观察展开状态和输入保护，避免菜单已被系统关闭后才读取输入。
    const expanded = await application.evaluate((_, label) => {
      const c = globalThis.__dragonGirlTest, menu = c.contextMenu;
      if (!menu) return null;
      c.setInteractive('character', false);
      c.pollCursor(true);
      c.followFrame({ ...c.display.workArea, x: c.display.workArea.x + 40 });
      c.setAppearance({ ...c.appearance, status: 'working' });
      const state = { interactive: c.interactive.get('character'), character: { ...c.character } };
      // 执行原生菜单自己的回调，继续验证关闭后的恢复和动画通道。
      menu.items.find((item) => item.label === '动作').submenu.items.find((item) => item.label === label).click();
      menu.closePopup(c.windows.get('character'));
      return state;
    }, label);
    assert.ok(expanded, '原生菜单在检查输入保护之前已关闭');
    assert.equal(expanded.interactive, true, '子菜单悬停期间窗口重新穿透');
    assert.deepEqual(expanded.character, before.character, '跟随更新移动了菜单所属角色');
    await until(async () => !(await snapshot()).menuOpen, '选择表情后菜单没有释放');
    if (process.platform === 'darwin') await until(() => nativeMenus().length === 0, '原生菜单关闭动画没有结束');
    assert.deepEqual((await snapshot()).bounds, before.bounds, '菜单关闭后没有恢复角色小窗口');
    await until(() => page.locator('#character').getAttribute('data-expression').then((value) => value === name), `${label}没有播放`);
    if (newEyes.some(([, id]) => id === name)) {
      const face = page.locator('#dragon-expression');
      assert.equal(await face.isVisible(), true, `${label}没有显示合成画面`);
      assert.equal(await page.locator('.eye-layer:not([hidden])').count(), 0, `${label}仍叠加视线画布`);
      if (name === 'omurice') await verifyOmuriceRender();
      else await verifyDragonEyeRender(name);
    }
    if (name === 'prayer') {
      // 等合掌到位，验收原画、原版眼睑和手部覆盖。
      await page.locator('#prayer-portrait').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#prayer-hands').isVisible(), true);
      assert.equal(await page.locator('#portrait').evaluate((image) => getComputedStyle(image).opacity), '1');
      assert.equal(await page.locator('.eye-layer:not([hidden])').count(), 0, '祈祷期间仍在绘制眼区');
      await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
      await page.screenshot({ path: path.join(root, '.artifacts/prayer-menu.png'), omitBackground: true });
    }
    await until(() => page.locator('#character').getAttribute('data-expression').then((value) => value === null), `${label}没有自动恢复`);
    assert.equal(await page.locator('#portrait').isVisible(), true, `${label}结束后没有恢复原画`);
    await page.evaluate(() => window.dragonGirl.interactive(false));
    await until(async () => !(await snapshot()).interactive, '菜单关闭后透明区域没有恢复穿透');
  }
  assert.deepEqual(await application.evaluate(() => globalThis.__menuGeometryCalls), [], '菜单开关仍修改了人物原生窗口');

  // 从真实右键菜单触发祈祷；设为一秒收起，验证长祷文不受普通气泡计时干扰。
  const bubble = application.windows().find((window) => window.url().endsWith('/bubble.html'));
  bubble.on('pageerror', (error) => errors.push(error.message));
  await bubble.emulateMedia({ reducedMotion: 'no-preference' });
  const beforePrayerSettings = await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    const settings = c.appearance.settings;
    c.setAppearance({ ...c.appearance, settings: { ...settings, motion: true, bubbleSeconds: 1 } });
    return settings;
  });
  await openMenu();
  const prayerStarted = Date.now();
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest, menu = c.contextMenu;
    const index = menu.items.findIndex((item) => item.label === '切换角色');
    const item = menu.items[index + 1];
    if (index < 0 || item?.label !== '祈祷式编程' || !item.enabled) throw new Error('切换角色下方缺少可用的祈祷式编程');
    item.click();
    menu.closePopup(c.windows.get('character'));
  });
  const character = page.locator('#character');
  const message = bubble.locator('#message');
  await until(async () => {
    const partial = await message.textContent();
    return partial.length >= 4 && partial.length < PRAYER_TEXT.length && PRAYER_TEXT.startsWith(partial);
  }, '气泡没有从开头逐字打出祷文');
  // 实际采样两个同时渐显的字和遮罩中间状态，防止文字退回到逐字跳显。
  await until(() => message.evaluate((node) => {
    const reveals = node.getAnimations({ subtree: true }).filter((animation) => animation.animationName === 'prayer-letter-reveal');
    return reveals.length >= 2 && reveals.some((animation) => {
      const style = getComputedStyle(animation.effect.target);
      return style.maskImage !== 'none' && Number(style.opacity) > 0.1 && Number(style.opacity) < 0.8;
    });
  }), '祷文相邻字没有连续渐显');
  // 直接检查手部图层到位和闭眼显示，动作无需为验收维护独立标记。
  await until(() => character.evaluate((node) => node.dataset.expression === 'prayer'
    && !node.querySelector('#prayer-portrait').hidden
    && node.querySelector('#prayer-hands').style.getPropertyValue('--prayer-hands-offset') === '0%'), '龙娘没有抬手合掌');

  // 在实际渲染的光束上采样，核对动画向手心推进，而非仅检查图层出现。
  const energy = page.locator('.prayer-energy');
  assert.equal(await energy.isVisible(), true, '合掌时没有光效');
  const inward = await energy.evaluate((svg) => {
    const streams = Array.from(svg.querySelectorAll('.prayer-streams path'));
    const palm = svg.querySelector('.prayer-glow ellipse');
    const [stream] = streams;
    const [animation] = stream?.getAnimations() || [];
    if (!animation || svg.querySelector('.prayer-ring')) return false;
    const savedTime = animation.currentTime;
    animation.currentTime = 500;
    const nearStart = Number.parseFloat(getComputedStyle(stream).strokeDashoffset);
    animation.currentTime = 1800;
    const nearPalm = Number.parseFloat(getComputedStyle(stream).strokeDashoffset);
    animation.currentTime = savedTime;
    return nearPalm < nearStart - 35 && streams.every((stream) => {
      const end = stream.getPointAtLength(stream.getTotalLength());
      return Math.hypot(end.x - palm.cx.baseVal.value, end.y - palm.cy.baseVal.value) < 0.1;
    });
  });
  assert.ok(inward, '光束没有向合掌处汇聚');

  // 文本超过一屏时自动跟着末尾滚动；背景任务不会打断合掌，滚回上方也不会被拉回去。
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    c.notify('complete', '测试：后台任务已完成');
    c.showExpression('happy');
  });
  await until(() => bubble.evaluate(() => {
    const pane = document.querySelector('#bubble-content');
    return pane.scrollTop > 0 && pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 2;
  }), '长祷文没有自动滚动到最新文字');
  assert.equal(await character.getAttribute('data-expression'), 'prayer', '祷文还没打完就结束了合掌');
  assert.equal(await page.locator('#prayer-portrait').isVisible(), true, '祈祷式编程没有显示合掌姿势');
  assert.equal(await application.evaluate(() => globalThis.__dragonGirlTest.windows.get('bubble').isVisible()), true);
  await page.screenshot({ path: path.join(root, '.artifacts/prayer-energy.png'), omitBackground: true });
  const beforeReview = await bubble.evaluate(() => {
    document.querySelector('#bubble-content').scrollTop = 0;
    return document.querySelector('#message').textContent.length;
  });
  await until(() => message.textContent().then((value) => value.length > beforeReview + 5), '回看上文时停止了打字');
  assert.equal(await bubble.locator('#bubble-content').evaluate((pane) => pane.scrollTop), 0, '打字改变了回看位置');
  await bubble.screenshot({ path: path.join(root, '.artifacts/prayer-typing.png'), omitBackground: true });

  // 让真实计时走到最后一个字；没有 Codex 宿主时仍完整打完并自动收势、关气泡。
  await until(() => message.textContent().then((value) => value === PRAYER_TEXT), '祷文没有完整打完', 45000);
  await until(() => bubble.locator('body').getAttribute('data-typing').then((value) => value === null), '最后一个字渐显后没有结束打字');
  const prayerTypingMs = Date.now() - prayerStarted;
  assert.ok(prayerTypingMs >= 19500 && prayerTypingMs <= 22000, `默认祷文播放耗时 ${prayerTypingMs} ms，超出二十秒的验收范围`);
  await until(() => character.getAttribute('data-expression').then((value) => value === null), '祷文打完后没有恢复原画');
  assert.equal(await energy.isVisible(), false, '收势后光效仍在播放');
  await until(() => application.evaluate(() => !globalThis.__dragonGirlTest.bubbleVisible), '祷文结束后没有自动收起气泡');

  // 再次点击从第一字开始；中途收起会取消计时，旧文字和动作不会残留。
  await application.evaluate(() => {
    globalThis.__dragonGirlTest.buildMenu().items.find((item) => item.label === '祈祷式编程').click();
  });
  await until(() => message.textContent().then((value) => value.length > 0 && value.length < 30 && PRAYER_TEXT.startsWith(value)), '再次祈祷没有从头打字');
  // 先确认第二轮确实开始，再切换减少动态效果，验证飞行停止并保留静态光晕。
  await until(() => energy.isVisible(), '再次祈祷没有亮起光效');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await until(async () => await energy.isVisible() && await energy.evaluate((svg) => svg.getAnimations({ subtree: true }).length === 0), '减少动态效果后光束仍在飞行');
  await bubble.locator('#bubble').click();
  await until(() => bubble.locator('body').getAttribute('data-typing').then((value) => value === null), '收起后仍在打字');
  await until(() => character.getAttribute('data-expression').then((value) => value === null), '收起后仍保持合掌');
  assert.equal(await energy.isVisible(), false, '收起气泡后仍有光效');
  assert.equal(await application.evaluate(() => Boolean(globalThis.__dragonGirlTest.prayerWave)), false, '手动取消触发了震荡波');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // 还原祈祷用例的设置，后续四角菜单保持原先固定姿势的测试条件。
  await application.evaluate((_, settings) => {
    const c = globalThis.__dragonGirlTest;
    c.setAppearance({ ...c.appearance, settings });
  }, beforePrayerSettings);

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
  const beforeHide = await snapshot();
  await application.evaluate(() => globalThis.__dragonGirlTest.hide());
  await until(async () => !(await snapshot()).menuOpen, '收起角色没有关闭菜单');
  const hidden = await snapshot();
  assert.equal(hidden.visible, false);
  assert.equal(hidden.interactive, false);
  assert.deepEqual(hidden.bounds, beforeHide.bounds);
  // 触发实际交给托盘的菜单回调，收起的龙娘也能出现并播放祈祷。
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    const setContextMenu = c.tray.setContextMenu;
    let trayMenu;
    c.tray.setContextMenu = (menu) => {
      trayMenu = menu;
      return setContextMenu.call(c.tray, menu);
    };
    try {
      c.menuKey = null;
      c.updateMenu();
    } finally {
      c.tray.setContextMenu = setContextMenu;
    }
    trayMenu.items.find((item) => item.label === '动作').submenu.items.find((item) => item.label === '祈祷').click();
  });
  await until(async () => (await snapshot()).visible && await page.locator('#prayer-portrait').isVisible(), '收起后从托盘选择祈祷没有显示');
  await application.evaluate(() => globalThis.__dragonGirlTest.hide());
  await until(() => page.locator('#character').getAttribute('data-expression').then((value) => value === null), '收起后没有结束祈祷');
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
      c.contextMenu?.closePopup(c.windows.get('character'));
    });
    await until(async () => !(await snapshot()).menuOpen, '角落菜单未关闭');
    if (process.platform === 'darwin') await until(() => nativeMenus().length === 0, '角落菜单的原生窗口尚未关闭');
    assert.deepEqual((await snapshot()).bounds, positioned.bounds);
    assert.deepEqual(await application.evaluate(() => globalThis.__menuGeometryCalls), [], '角落菜单仍修改了人物原生窗口');
  }
  assert.deepEqual(errors, []);
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  await fs.writeFile(path.join(root, '.artifacts/menu-report.json'), JSON.stringify({ passed: true, platform: process.platform, before, prayerTypingMs, errors }, null, 2));
  console.log('原生菜单验证通过：四角展开、二级动作、主动缩放、跟随暂停、祈祷合掌、逐字播放全文与回看、表情与穿透恢复、收起关闭。');
} finally {
  await application?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
