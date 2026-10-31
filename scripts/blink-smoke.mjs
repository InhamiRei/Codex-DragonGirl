import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHARACTER_ASSET, EYE_ARTWORK } from '../src/shared/gaze.js';

// 去掉目录末尾的反斜杠，避免 Windows 启动参数中的闭合引号被转义。
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-blink-'));
const artifacts = path.join(root, '.artifacts');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
const errors = [];
let application, page;

// 等待实际状态，定时自然眨眼最多七秒后开始，不能用固定截图时间碰运气。
async function until(check, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

// 使用生产外观入口，独立切换眨眼与鼠标跟随。
async function appearance(settings) {
  await application.evaluate((_, settings) => {
    globalThis.__dragonGirlTest.setAppearance({ asset: 'dragon://app/assets/characters/codex-dragon-girl.png', settings });
  }, { eyeTracking: false, blinkEnabled: false, soundEnabled: false, ...settings });
}

// 合成原画与眼区后统计紫色虹膜、睫毛，闭合必须真实遮住虹膜并留下可见的眼睑线。
async function metrics(preview = true) {
  return page.evaluate(({ artwork, preview }) => {
    const layers = preview ? window.__blinkPreview.patches.map((patch) => patch.canvas)
      : [...document.querySelectorAll('.eye-layer')];
    return layers.map((layer, index) => {
      const eye = artwork.eyes[index], canvas = document.createElement('canvas');
      canvas.width = layer.width; canvas.height = layer.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(document.getElementById('portrait'), eye.x, eye.y, eye.width, eye.height, 0, 0, canvas.width, canvas.height);
      if (!layer.hidden) context.drawImage(layer, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let purple = 0, dark = 0;
      for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
        const sourceX = eye.x + (x + 0.5) * eye.width / canvas.width;
        const sourceY = eye.y + (y + 0.5) * eye.height / canvas.height;
        if (Math.abs(sourceX - eye.blink.cx) > eye.blink.rx * 0.85
          || sourceY < eye.blink.cy - 80 || sourceY > eye.blink.cy + eye.blink.ry + 8) continue;
        const offset = (y * canvas.width + x) * 4;
        const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
        if (r > 110 && r < 220 && g < 190 && b > r + 15 && b > g + 15) purple += 1;
        if (r < 45 && g < 45 && b < 100) dark += 1;
      }
      return { purple, dark, hidden: layer.hidden };
    });
  }, { artwork: EYE_ARTWORK, preview });
}

// 预览直接使用同一个渲染器，固定进度仅用于逐帧视觉验收，不向生产页面暴露调试入口。
async function preview(amount, name) {
  await page.evaluate((amount) => {
    window.__blinkPreview.blink = amount;
    window.__blinkPreview.paint();
  }, amount);
  await page.screenshot({ path: path.join(artifacts, `blink-${name}.png`), omitBackground: true });
  return metrics();
}

try {
  await fs.mkdir(artifacts, { recursive: true });
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DRAGONGIRL_MONITOR_TEST;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env, timeout: 30000 });
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest?.ready.size === 2), '角色没有启动');
  page = application.windows().find((window) => window.url().endsWith('/character.html'));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await application.evaluate(() => {
    const companion = globalThis.__dragonGirlTest;
    clearTimeout(companion.cursorTimer); companion.pollCursor = () => {};
  });
  await appearance({});
  await page.evaluate(async () => {
    const { EyeTracker } = await import('./eyes.js');
    const model = await window.dragonGirl.bootstrap();
    model.appearance.settings = { eyeTracking: true, blinkEnabled: false };
    const preview = new EyeTracker(document.getElementById('character'));
    preview.configure(document.getElementById('portrait'), model, { scaleX: 1, scaleY: 1, angle: 0 }, false);
    window.__blinkPreview = preview;
  });
  const open = await preview(0, 'open');
  const half = await preview(0.5, 'half');
  const closed = await preview(1, 'closed');
  for (let index = 0; index < 2; index += 1) {
    assert.ok(closed[index].purple < open[index].purple * 0.2, `闭眼后仍残留大面积虹膜：${JSON.stringify({ open, half, closed })}`);
    assert.ok(half[index].purple < open[index].purple && half[index].purple > closed[index].purple, '半闭眼没有连续收起虹膜');
    assert.ok(closed[index].dark > open[index].dark * 0.4, '闭眼时睫毛被压成不可见的细线');
  }
  assert.deepEqual(await preview(0, 'reopened'), open, '重新睁开没有恢复原画');
  // 缩放后再次闭眼，确认实际使用的 60% 大小和翻转都不会错位。
  await application.evaluate(() => globalThis.__dragonGirlTest.setScale(0.6));
  await page.evaluate(async () => {
    const model = await window.dragonGirl.bootstrap();
    model.appearance.settings = { eyeTracking: true, blinkEnabled: false };
    window.__blinkPreview.configure(document.getElementById('portrait'), model, { scaleX: 1, scaleY: 1, angle: 0 }, false);
  });
  await preview(1, 'small-closed');
  await appearance({ flip: true });
  await preview(1, 'small-flipped');
  // 频繁布局更新不能推迟眨眼；按压则取消本轮，松开后重新等待。
  const lifecycle = await page.evaluate(async () => {
    const tracker = window.__blinkPreview;
    const model = await window.dragonGirl.bootstrap();
    model.appearance.settings = { eyeTracking: false, blinkEnabled: true };
    const image = document.getElementById('portrait'), pose = { scaleX: -1, scaleY: 1, angle: 0 };
    tracker.configure(image, model, pose, false);
    const timer = tracker.blinkTimer;
    tracker.configure(image, model, pose, false);
    const stable = tracker.blinkTimer === timer && timer !== 0;
    // 开心在眨眼途中到达时，当前眼皮继续完成动作，不因出现星光而突然睁开。
    tracker.blinkStarted = performance.now() - 70;
    tracker.blink = 0.8;
    const started = tracker.blinkStarted;
    tracker.showHappy();
    const preserved = tracker.blink === 0.8 && tracker.blinkStarted === started;
    tracker.blink = 0.5;
    tracker.configure(image, model, pose, false, true);
    const cancelled = tracker.blinkTimer === 0 && tracker.blinkStarted === null && tracker.blink === 0;
    tracker.configure(image, model, pose, false, false);
    const restarted = tracker.blinkTimer !== 0 && tracker.blinkTimer !== timer;
    return { stable, preserved, cancelled, restarted };
  });
  assert.deepEqual(lifecycle, { stable: true, preserved: true, cancelled: true, restarted: true });
  await page.evaluate(() => {
    window.__blinkPreview.reset();
    for (const { canvas } of window.__blinkPreview.patches) canvas.remove();
    delete window.__blinkPreview;
  });

  // 真正的自动眨眼由原有角色实例启动；鼠标跟随关闭、鼠标静止时也应发生。
  await appearance({ blinkEnabled: true });
  await until(() => page.locator('.eye-layer').count().then((count) => count === 2), '自动眨眼没有创建眼区');
  await until(() => page.locator('.eye-layer:not([hidden])').count().then((count) => count === 0), '等待眨眼时没有保持睁眼原画');
  await until(() => page.locator('.eye-layer:not([hidden])').count().then((count) => count === 2), '鼠标静止时没有自动眨眼');
  const natural = await until(async () => {
    const values = await metrics(false);
    return values.every((eye) => !eye.hidden && eye.purple < 70) ? values : false;
  }, '自动眨眼没有真正闭合');
  await until(() => page.locator('.eye-layer:not([hidden])').count().then((count) => count === 0), '自动眨眼后没有重新睁开');
  const matrix = await page.evaluate(() => getComputedStyle(document.getElementById('character')).transform);
  assert.equal(matrix, 'matrix(1, 0, 0, 1, 0, 0)', '单独眨眼改变了身体姿态');

  // 减少动态效果、原生隐藏和开关取消等待中的眨眼，恢复后重新安排下一次轻眨。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.eye-layer:not([hidden])').count(), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await application.evaluate(() => globalThis.__dragonGirlTest.hide());
  await until(() => page.locator('.eye-layer:not([hidden])').count().then((count) => count === 0), '隐藏后眼区没有恢复');
  await application.evaluate(() => globalThis.__dragonGirlTest.show());
  await appearance({ blinkEnabled: false });
  assert.equal(await page.locator('.eye-layer:not([hidden])').count(), 0);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'blink-report.json'), JSON.stringify({ passed: true, open, half, closed, natural, lifecycle, asset: DEFAULT_CHARACTER_ASSET }, null, 2));
  console.log('自然眨眼验证通过：开合像素、睫毛厚度、原画恢复、60% 大小、静止自动眨眼、独立开关、减少动态效果和隐藏恢复。');
} finally {
  if (application) await application.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
