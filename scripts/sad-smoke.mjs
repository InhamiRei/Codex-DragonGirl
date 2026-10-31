import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EYE_ARTWORK, DEFAULT_CHARACTER_ASSET } from '../src/shared/gaze.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-sad-'));
const artifacts = path.join(root, '.artifacts');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
const errors = [];
let application, page;

// 根据实际表情和像素等待，不把尚未开始的表情当成恢复成功。
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(message);
}

// 通过正式外观通道切换选项，静音和关闭身体动画仍应保留含泪效果。
async function appearance(settings = {}, asset = DEFAULT_CHARACTER_ASSET) {
  await application.evaluate((_, value) => globalThis.__dragonGirlTest.setAppearance(value), {
    asset, settings: { motion: false, eyeTracking: false, blinkEnabled: false, expressionsEnabled: true, soundEnabled: false, ...settings },
  });
}

// 完成和失败共用主进程表情入口，未知名称不能传入渲染器。
async function trigger(name = 'sad') {
  await application.evaluate((_, name) => globalThis.__dragonGirlTest.showExpression(name), name);
}

// 只读取当前表情标签，不通过测试入口伪造真实事件是否到达。
async function expression() {
  return page.locator('#character').getAttribute('data-expression');
}

// 固定实际渲染器的时间以比较泪珠位置，期间不新增另一套画布或表情实现。
async function seek(time) {
  await page.evaluate(async (time) => {
    const { sadFrame } = await import('../shared/sad.js');
    const tracker = window.__sadTracker;
    cancelAnimationFrame(tracker.frame);
    tracker.frame = 0;
    tracker.expressionStarted = null;
    tracker.expressionName = 'sad';
    tracker.expressionTime = time;
    tracker.expression = sadFrame(time);
    tracker.paint();
    tracker.paintBody();
  }, time);
}

// 按统一画幅比较真正的眼区像素，嘴部不能出现新增图形，泪珠的重心必须向下移动。
async function metrics() {
  return page.evaluate((artwork) => {
    const image = document.getElementById('portrait');
    const baseline = document.createElement('canvas'), actual = document.createElement('canvas');
    baseline.width = actual.width = 665; baseline.height = actual.height = 591;
    const before = baseline.getContext('2d', { willReadFrequently: true }), after = actual.getContext('2d', { willReadFrequently: true });
    before.drawImage(image, 0, 0, 665, 591); after.drawImage(image, 0, 0, 665, 591);
    const layers = [...document.querySelectorAll('.eye-layer')];
    for (const [index, canvas] of layers.entries()) if (!canvas.hidden) {
      const eye = artwork.eyes[index];
      after.drawImage(canvas, eye.x / 2, eye.y / 2, eye.width / 2, eye.height / 2);
    }
    const original = before.getImageData(0, 0, 665, 591).data, painted = after.getImageData(0, 0, 665, 591).data;
    const eyes = artwork.eyes.map((eye) => {
      let changed = 0, signature = 0;
      for (let y = Math.ceil(eye.y / 2); y < (eye.y + eye.height) / 2; y += 1)
        for (let x = Math.ceil(eye.x / 2); x < (eye.x + eye.width) / 2; x += 1) {
          const offset = (y * 665 + x) * 4;
          const delta = Math.abs(painted[offset] - original[offset]) + Math.abs(painted[offset + 1] - original[offset + 1]) + Math.abs(painted[offset + 2] - original[offset + 2]);
          if (delta > 24) changed += 1;
          signature += delta * (x + 1) * (y + 1);
        }
      return { changed, signature };
    });
    let mouthChanged = 0, mouthDark = 0, mass = 0, tearY = 0;
    for (let y = 425; y < 457; y += 1) for (let x = 305; x < 365; x += 1) {
      const offset = (y * 665 + x) * 4;
      if (Math.max(...[0, 1, 2].map((channel) => Math.abs(painted[offset + channel] - original[offset + channel]))) > 24) mouthChanged += 1;
      if (painted[offset] < 130 && painted[offset + 1] < 110 && painted[offset + 2] < 180) mouthDark += 1;
    }
    for (let y = 417; y < 451; y += 1) for (let x = 443; x < 459; x += 1) {
      const offset = (y * 665 + x) * 4;
      const light = painted[offset + 2] - original[offset + 2] + (original[offset] - painted[offset]) * 0.3;
      if (light > 8) { mass += light; tearY += light * y * 2; }
    }
    const matrix = new DOMMatrix(getComputedStyle(document.getElementById('character')).transform);
    return { eyes, mouthChanged, mouthDark, tear: { mass, y: mass ? tearY / mass : 0 },
      hidden: layers.every((canvas) => canvas.hidden), y: matrix.f, angle: Math.atan2(matrix.b, matrix.a) * 180 / Math.PI };
  }, EYE_ARTWORK);
}

try {
  await fs.mkdir(artifacts, { recursive: true });
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: temporary };
  delete env.ELECTRON_RUN_AS_NODE; delete env.DRAGONGIRL_MONITOR_TEST;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env });
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest?.ready.size === 2), '角色没有完成启动');
  page = application.windows().find((window) => window.url().endsWith('/character.html'));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await application.evaluate(() => {
    const companion = globalThis.__dragonGirlTest;
    clearTimeout(companion.cursorTimer); companion.pollCursor = () => {};
  });
  await appearance();
  await page.evaluate(async () => {
    const { EyeTracker } = await import('./eyes.js');
    const original = EyeTracker.prototype.showExpression;
    // 记录正式订阅调用的对象，逐帧检查仍使用生产渲染器。
    EyeTracker.prototype.showExpression = function (name) {
      window.__sadTracker = this;
      return original.call(this, name);
    };
    window.__sadEvents = [];
    window.dragonGirl.onExpression((name) => { window.__sadEvents.push(name); window.__sadAt = performance.now(); });
  });
  await trigger();
  await until(async () => await expression() === 'sad', '失败表情没有通过正式通道出现');
  await until(() => page.evaluate(() => performance.now() - window.__sadAt >= 1700), '含泪眼神没有完成进入');
  const first = await metrics();
  await page.screenshot({ path: path.join(artifacts, 'sad-active.png'), omitBackground: true });
  await until(() => page.evaluate(() => performance.now() - window.__sadAt >= 2700), '泪光没有持续播放');
  const flowing = await metrics();
  for (const [index, eye] of first.eyes.entries()) {
    assert.ok(eye.changed > 100, '伤心眼神没有显著改变');
    assert.notEqual(eye.signature, flowing.eyes[index].signature, '眼内泪光只是静态贴图');
  }
  assert.equal(first.mouthChanged + first.mouthDark + flowing.mouthChanged + flowing.mouthDark, 0, '无口区域出现新图形');
  await seek(2700); const early = await metrics();
  await seek(3550); const late = await metrics();
  assert.ok(early.tear.mass > 0 && late.tear.mass > 0 && late.tear.y > early.tear.y + 8, `泪珠没有实际下落：${JSON.stringify({ early: early.tear, late: late.tear })}`);
  await page.screenshot({ path: path.join(artifacts, 'sad-tear.png'), omitBackground: true });
  await seek(5600);
  assert.equal((await metrics()).hidden, true, '伤心结束后没有恢复原画');

  // 小尺寸和翻转仍保留含泪轮廓，低头只影响视觉姿态，不移动保存位置。
  await application.evaluate(() => globalThis.__dragonGirlTest.setScale(0.6));
  await trigger(); await until(async () => await expression() === 'sad', '60% 大小没有伤心表情');
  await seek(1800);
  await page.screenshot({ path: path.join(artifacts, 'sad-small.png'), omitBackground: true });
  await appearance({ flip: true });
  await seek(2800);
  await page.screenshot({ path: path.join(artifacts, 'sad-flipped.png'), omitBackground: true });
  await appearance({ motion: true });
  const position = await application.evaluate(() => ({ ...globalThis.__dragonGirlTest.character }));
  await seek(2400);
  const body = await metrics();
  assert.ok(body.y > 0.2 && Math.abs(body.angle) > 0.1 && Math.abs(body.angle) < 0.3);
  assert.deepEqual(await application.evaluate(() => ({ ...globalThis.__dragonGirlTest.character })), position);

  // 关闭开关和系统减少动态效果会立即恢复，重新开启不重放过期失败事件。
  await appearance({ expressionsEnabled: false });
  await trigger();
  assert.equal(await expression(), null);
  assert.equal((await metrics()).hidden, true);
  await appearance();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger();
  assert.equal(await expression(), null);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await trigger(); await until(async () => await expression() === 'sad', '恢复动态效果后无法伤心');
  await application.evaluate(() => globalThis.__dragonGirlTest.hide());
  await until(async () => await expression() === null, '隐藏后表情没有恢复');
  await application.evaluate(() => globalThis.__dragonGirlTest.show());
  assert.equal(await expression(), null);

  // 自定义角色不套用原画五官，未知表情不穿过主进程白名单。
  const custom = 'fedcba1234567890fedcba1234567890.png';
  await fs.mkdir(path.join(temporary, 'assets'), { recursive: true });
  await fs.copyFile(path.join(root, 'assets/characters/codex-dragon-girl.png'), path.join(temporary, 'assets', custom));
  await appearance({}, `dragon://app/user-assets/${custom}`);
  await trigger(); assert.equal(await expression(), null);
  const count = await page.evaluate(() => window.__sadEvents.length);
  await trigger('unknown');
  assert.equal(await page.evaluate(() => window.__sadEvents.length), count);

  // 成功和失败相互替换，不同时留下星芒与眼泪；自然播放结束后眨眼重新接管。
  await appearance({ blinkEnabled: true });
  await until(() => page.evaluate(() => document.getElementById('portrait').src.endsWith('/codex-dragon-girl.png')), '默认原画没有恢复');
  await trigger(); await until(async () => await expression() === 'sad', '恢复默认后无法伤心');
  await trigger('happy'); await until(async () => await expression() === 'happy', '开心没有替换伤心');
  await trigger(); await until(async () => await expression() === 'sad', '伤心没有替换开心');
  await until(async () => await expression() === null && (await metrics()).hidden, '伤心没有自动恢复');
  await until(() => page.locator('.eye-layer:not([hidden])').count().then((value) => value === 2), '伤心结束后没有恢复自然眨眼');
  assert.equal(await expression(), null);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'sad-report.json'), JSON.stringify({ passed: true, first, flowing, early: early.tear, late: late.tear, body }, null, 2));
  console.log('伤心验证通过：正式失败通道、泪光流动、泪珠下落、无口造型、60% 大小和翻转、轻垂锚点、开关、隐藏、自定义图、表情互换和自然恢复。');
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'sad-failure.png'), omitBackground: true }).catch(() => {});
  await fs.writeFile(path.join(artifacts, 'sad-failure.json'), JSON.stringify({ error: error.message, errors, state: await metrics().catch(() => null) }, null, 2));
  throw error;
} finally {
  await application?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
