import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MARO_ASSET } from '../src/shared/characters.js';
import { MARO_EYE_ARTWORK } from '../src/shared/maro-eyes.js';

const root = process.cwd();
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'maro-interaction-'));
const artifacts = path.join(root, '.artifacts/maro-interaction');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
let application, page;
const errors = [];

// 等待实际像素和界面状态变化，不用收到事件代替已显示动画。
async function until(check, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

// 保持工作状态以隔离偶发捋发，待机眼部交互在工作中也必须正常运行。
async function appearance(settings) {
  await application.evaluate((_, settings) => {
    const c = globalThis.__dragonGirlTest;
    c.setAppearance({ ...c.appearance, status: 'working',
      settings: { ...c.appearance.settings, ...settings } });
  }, settings);
}

// 从两只眼睛的真实蓝色像素计算虹膜中心和面积。
async function metrics(preview = false) {
  return page.evaluate((preview) => window.__maroMetrics(preview), preview);
}

// 发送正式光标 IPC，并等待视线像素停止变化后再验收方向。
async function look(x, y) {
  await application.evaluate((_, point) => globalThis.__dragonGirlTest.windows.get('character').webContents.send('dg:cursor', point), { x, y });
  let previous, stable = 0;
  return until(async () => {
    const current = await metrics();
    if (previous && current.every((eye, index) => Math.hypot(eye.x - previous[index].x, eye.y - previous[index].y) < 0.08)) stable += 1;
    else stable = 0;
    previous = current;
    return stable >= 4 ? current : false;
  }, '眼睛跟随没有收敛');
}

// 在当前实际显示的画布上量测发色，点击后的图片和原始文件不能混用。
async function hairColor() {
  return page.evaluate(() => {
    const canvas = document.querySelector('.character-sprites');
    const data = canvas.getContext('2d').getImageData(0, 0, 1254, 1254).data;
    const channels = [[], [], []];
    for (let y = 160; y < 440; y += 1) for (let x = 420; x < 760; x += 1) {
      const offset = (y * 1254 + x) * 4;
      if (data[offset + 3] < 240 || data[offset] - data[offset + 1] <= 32 || data[offset + 1] - data[offset + 2] <= 8) continue;
      channels.forEach((values, channel) => values.push(data[offset + channel]));
    }
    return channels.map((values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]);
  });
}

try {
  await fs.mkdir(artifacts, { recursive: true });
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env, timeout: 30000 });
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest?.ready.size === 2), '角色没有启动');
  page = application.windows().find((item) => item.url().endsWith('/character.html'));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await application.evaluate(({ app }, asset) => {
    const c = globalThis.__dragonGirlTest;
    c.__realPollCursor = c.pollCursor.bind(c);
    clearTimeout(c.cursorTimer); c.pollCursor = () => {};
    c.setAppearance({ asset, assetPath: app.getAppPath() + '/assets/characters/maro/idle.png', status: 'working',
      settings: { characterId: 'maro', autoFlip: false, motion: true, eyeTracking: true, blinkEnabled: false,
        expressionsEnabled: true, soundEnabled: false } });
    c.setScale(0.75); c.show();
  }, MARO_ASSET);
  await until(() => page.locator('.maro-eye-layer').count().then((count) => count === 2), '麻吕眼区未创建');
  // 量测使用原画加实际眼区合成，不能只检查用于调试的视线数值。
  await page.evaluate((artwork) => {
    window.__maroMetrics = (preview = false) => {
      const layers = preview ? window.__maroEyePreview.patches.map((patch) => patch.canvas)
        : [...document.querySelectorAll('.maro-eye-layer')];
      return layers.map((layer, index) => {
        const eye = artwork.eyes[index], canvas = document.createElement('canvas');
        canvas.width = layer.width; canvas.height = layer.height;
        const context = canvas.getContext('2d');
        context.drawImage(document.getElementById('portrait'), eye.x, eye.y, eye.width, eye.height, 0, 0, canvas.width, canvas.height);
        if (!layer.hidden) context.drawImage(layer, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let blue = 0, ink = 0, sumX = 0, sumY = 0;
        for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
          const offset = (y * canvas.width + x) * 4;
          const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
          if (b > r + 15 && g > r + 8 && r < 160) { blue += 1; sumX += x; sumY += y; }
          if (r < 120 && g < 120 && b < 120) ink += 1;
        }
        return { blue, ink, x: eye.x + sumX / Math.max(1, blue) * eye.width / canvas.width,
          y: eye.y + sumY / Math.max(1, blue) * eye.height / canvas.height, hidden: layer.hidden };
      });
    };
  }, MARO_EYE_ARTWORK);
  const left = await look(-8000, 160), right = await look(8000, 160);
  await page.screenshot({ path: path.join(artifacts, 'look-right.png'), omitBackground: true });
  const up = await look(180, -8000), down = await look(180, 8000);
  await page.screenshot({ path: path.join(artifacts, 'look-down.png'), omitBackground: true });
  for (let index = 0; index < 2; index += 1) {
    const horizontal = right[index].x - left[index].x, vertical = down[index].y - up[index].y;
    assert.ok(horizontal > 3 && horizontal <= 12.5, '左右跟随幅度不在轻微活动范围内');
    assert.ok(vertical > 1 && vertical <= 6.5, '上下跟随幅度不在轻微活动范围内');
  }
  await appearance({ flip: true });
  const flipped = await look(8000, 160);
  assert.ok(flipped.every((eye, index) => eye.x < right[index].x - 3), '翻转后的视线方向错误');
  await appearance({ flip: false });
  await until(() => page.locator('#character').getAttribute('data-flipping').then((value) => value === 'false'), '镜像切换没有结束');
  // 实际系统鼠标落在窗口外，仍应走主进程的全屏光标消息路径。
  const outside = await application.evaluate(({ screen }) => {
    const c = globalThis.__dragonGirlTest, point = screen.getCursorScreenPoint(), area = c.display.workArea;
    c.character = { ...c.character, x: area.x + (point.x < area.x + area.width / 2 ? area.width - c.character.width - 40 : 40), y: area.y + 120 };
    c.applyCharacter();
    const bounds = c.windows.get('character').getBounds();
    return { x: point.x - bounds.x, y: point.y - bounds.y, width: bounds.width, height: bounds.height };
  });
  assert.ok(outside.x < 0 || outside.x > outside.width || outside.y < 0 || outside.y > outside.height);
  await page.evaluate(() => { window.__outsideCursors = []; window.dragonGirl.onCursor((point) => { window.__outsideCursors.push(point); }); });
  const delivered = await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    c.windows.get('character').showInactive();
    c.cursorPositions.clear(); c.__realPollCursor(); clearTimeout(c.cursorTimer);
    return { point: c.cursorPositions.get('character'), bounds: c.windows.get('character').getBounds() };
  });
  assert.ok(delivered.point, '主进程没有为麻吕生成光标消息');
  assert.ok(delivered.point.x < 0 || delivered.point.x > delivered.bounds.width
    || delivered.point.y < 0 || delivered.point.y > delivered.bounds.height, '实际光标不在窗口外');
  await until(() => page.evaluate((point) => window.__outsideCursors.some((value) => value.x === point.x && value.y === point.y), delivered.point), '窗口外鼠标没有送给麻吕');
  await appearance({ eyeTracking: false, blinkEnabled: false });
  const idleColor = await hairColor();
  await page.screenshot({ path: path.join(artifacts, 'idle.png'), omitBackground: true });
  // 走真实轻点手势入口，确认用户点击后显示的完成表情颜色也被统一。
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    const point = { x: c.character.x + c.character.width / 2, y: c.character.y + c.character.height * 0.65 };
    c.gesture.begin(point, c.character); c.endGesture(point);
  });
  await until(() => page.locator('#character').getAttribute('data-sprite-state').then((state) => state === 'happy'), '轻点没有触发完成表情');
  await until(() => page.locator('#character').getAttribute('data-flipping').then((value) => value === 'false'), '点击截图仍处于镜像过渡');
  const happyColor = await hairColor();
  assert.ok(happyColor.every((value, channel) => Math.abs(value - idleColor[channel]) <= 4), '点击表情发色仍与待机不一致');
  await page.screenshot({ path: path.join(artifacts, 'clicked-happy.png'), omitBackground: true });
  await until(() => page.locator('#character').getAttribute('data-sprite-state').then((state) => state === 'idle'), '点击表情没有恢复');
  // 使用正式眼部工厂定格眨眼的中间态和完全闭合态，检查虹膜消失而睫毛仍保留。
  await page.evaluate(async () => {
    const { createMaroEyes } = await import('./maro-eyes.js');
    const model = await window.dragonGirl.bootstrap();
    model.appearance.settings = { eyeTracking: true, blinkEnabled: false };
    const tracker = createMaroEyes(document.getElementById('character'));
    tracker.configure(document.getElementById('portrait'), model, { scaleX: 1, scaleY: 1, angle: 0 }, false);
    window.__maroEyePreview = tracker;
  });
  const open = await metrics(true);
  await page.evaluate(() => { window.__maroEyePreview.blink = 0.5; window.__maroEyePreview.paint(); });
  const half = await metrics(true);
  await page.screenshot({ path: path.join(artifacts, 'blink-half.png'), omitBackground: true });
  await page.evaluate(() => { window.__maroEyePreview.blink = 1; window.__maroEyePreview.paint(); });
  const closed = await metrics(true);
  await page.screenshot({ path: path.join(artifacts, 'blink-closed.png'), omitBackground: true });
  for (let index = 0; index < 2; index += 1) {
    assert.ok(closed[index].blue < open[index].blue * 0.12, '闭眼后仍有明显蓝色虹膜');
    assert.ok(half[index].blue < open[index].blue && half[index].blue > closed[index].blue, '半闭眼过渡不连续');
    assert.ok(closed[index].ink > open[index].ink * 0.4, '闭眼时睫毛被抹掉');
  }
  await page.evaluate(() => { window.__maroEyePreview.blink = 0; window.__maroEyePreview.paint(); });
  assert.deepEqual(await metrics(true), open);
  await page.evaluate(() => {
    window.__maroEyePreview.reset();
    window.__maroEyePreview.patches.forEach((patch) => patch.canvas.remove());
    delete window.__maroEyePreview;
  });
  await appearance({ eyeTracking: false, blinkEnabled: true });
  const natural = await page.evaluate(() => new Promise((resolve) => {
    const baseline = window.__maroMetrics().map((eye) => eye.blue);
    let minimum = [...baseline], reopened = false;
    const started = performance.now();
    const timer = setInterval(() => {
      const eyes = window.__maroMetrics();
      minimum = minimum.map((value, index) => Math.min(value, eyes[index].blue));
      reopened = minimum.every((value, index) => value < baseline[index] * 0.15) && eyes.every((eye) => eye.hidden);
      if (reopened || performance.now() - started > 8500) {
        clearInterval(timer); resolve({ baseline, minimum, reopened });
      }
    }, 12);
  }));
  assert.ok(natural.reopened, '没有完成一次自然眨眼并恢复');
  await appearance({ eyeTracking: true, blinkEnabled: true });
  await look(8000, 160);
  await application.evaluate(() => globalThis.__dragonGirlTest.showExpression('hair', { preview: true }));
  await until(() => page.locator('#character').getAttribute('data-sprite-state').then((state) => state === 'hair'), '捋发未开始');
  assert.equal(await page.locator('.maro-eye-layer:not([hidden])').count(), 0, '眼部贴层遮住了捋发表情');
  await appearance({ motion: false, eyeTracking: false, blinkEnabled: false });
  assert.equal(await page.locator('.maro-eye-layer:not([hidden])').count(), 0);
  await appearance({ motion: true, eyeTracking: true, blinkEnabled: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.maro-eye-layer:not([hidden])').count(), 0);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ passed: true, idleColor, happyColor,
    left, right, up, down, flipped, open, half, closed, natural, outsideCursorDelivered: true }, null, 2));
  console.log('麻吕点击配色、四向视线、翻转、窗口外鼠标、自然眨眼和动作互斥全部通过。');
} finally {
  await application?.close().catch(() => {});
  await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
