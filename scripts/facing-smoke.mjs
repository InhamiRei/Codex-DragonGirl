import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-facing-'));
const artifacts = path.join(root, '.artifacts');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
const errors = [];
let application, page;

// 等待原生窗口与真实绘制状态，不用改写 DOM 来伪造朝向变化。
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

// 通过生产布局入口更改偏好，关闭眨眼和声音以隔离翻转与输入验收。
async function appearance(settings = {}) {
  await application.evaluate((_, settings) => {
    const c = globalThis.__dragonGirlTest;
    c.setAppearance({ ...c.appearance, settings: {
      autoFlip: true, flip: false, motion: true, eyeTracking: true,
      blinkEnabled: false, expressionsEnabled: false, soundEnabled: false, ...settings,
    } });
  }, settings);
}

// 从实际 CSS 矩阵读取方向与连续缩放，不能只断言主进程里的目标布尔值。
async function drawing() {
  return page.evaluate(async () => {
    const character = document.getElementById('character');
    const matrix = new DOMMatrix(getComputedStyle(character).transform);
    return { scaleX: matrix.a, animating: character.dataset.flipping === 'true', model: await window.dragonGirl.bootstrap() };
  });
}

// 同时等待朝向目标与动画终点，画面中不能残留半幅图像。
async function facing(flipped) {
  await until(async () => {
    const state = await drawing();
    return state.model.flipped === flipped && !state.animating && (flipped ? state.scaleX < -.99 : state.scaleX > .99);
  }, `角色未稳定到${flipped ? '镜像' : '原始'}方向`);
}

// 用屏幕上的同一鼠标落点换算移动后窗口坐标，真实经过拖拽、松手与取消 IPC。
async function dragTo(x, y, flippedDuringDrag, cancel = false) {
  await page.bringToFront();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const before = await application.evaluate(() => globalThis.__dragonGirlTest.snapshot());
  const rect = (await page.evaluate(() => window.dragonGirl.bootstrap())).rect;
  const start = { x: rect.x + rect.width * .5, y: rect.y + rect.height * .72 };
  const target = { x: x + rect.width * .5, y: y + rect.height * .72 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x - before.windows.character.x, target.y - before.windows.character.y);
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest.dragging), '未进入真实拖拽状态');
  assert.equal((await drawing()).model.flipped, flippedDuringDrag, '拖动过程中提前切换了朝向');
  const moved = await application.evaluate(() => globalThis.__dragonGirlTest.snapshot());
  await page.mouse.move(target.x - moved.windows.character.x, target.y - moved.windows.character.y);
  if (cancel) await page.evaluate(() => window.dragonGirl.cancelGesture());
  await page.mouse.up();
  await until(() => application.evaluate(() => !globalThis.__dragonGirlTest.dragging), '拖动未结束');
  if (cancel) assert.deepEqual((await application.evaluate(() => globalThis.__dragonGirlTest.snapshot())).character, before.character);
  assert.equal(await application.evaluate(() => globalThis.__dragonGirlTest.bubbleVisible), false, '拖动误触点击气泡');
}

try {
  await fs.mkdir(artifacts, { recursive: true });
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DRAGONGIRL_MONITOR_TEST;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env, timeout: 30000 });
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest?.ready.size === 2), '角色窗口未就绪');
  page = application.windows().find(window => window.url().endsWith('/character.html'));
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const area = await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    clearTimeout(c.cursorTimer);
    c.pollCursor = () => {};
    c.setScale(.6);
    const area = c.display.workArea;
    c.character = { ...c.character, x: area.x + area.width - c.character.width - 60, y: area.y + Math.round(area.height * .45) };
    c.applyCharacter();
    return area;
  });
  await appearance();
  await facing(false);

  // 记录每一帧实际变换，验证松手后存在正、负缩放的中间帧，而非瞬间换图。
  await page.evaluate(() => {
    window.__flipFrames = [];
    window.__recordFlip = true;
    const record = (time) => {
      if (!window.__recordFlip) return;
      const node = document.getElementById('character');
      window.__flipFrames.push({ time, scaleX: new DOMMatrix(getComputedStyle(node).transform).a });
      requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
  });
  const y = area.y + Math.round(area.height * .45);
  const left = area.x + 18;
  const right = area.x + area.width - 180;
  await dragTo(left, y, false);
  await facing(true);
  const frames = await page.evaluate(() => { window.__recordFlip = false; return window.__flipFrames; });
  assert.ok(frames.some(frame => frame.scaleX > .05 && frame.scaleX < .9), '缺少正向翻转中间帧');
  assert.ok(frames.some(frame => frame.scaleX < -.05 && frame.scaleX > -.9), '缺少反向翻转中间帧');
  await page.screenshot({ path: path.join(artifacts, 'facing-left.png'), omitBackground: true });

  // 镜像后依然按可见像素点击，透明角落保持穿透，画面与命中不能错位。
  await page.mouse.move(2, 2);
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest.interactive.get('character') === false), '镜像后的透明处未穿透');
  const rect = (await page.evaluate(() => window.dragonGirl.bootstrap())).rect;
  await page.mouse.click(rect.x + rect.width * .5, rect.y + rect.height * .72);
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest.bubbleVisible), '镜像后无法点击角色');
  await application.evaluate(() => globalThis.__dragonGirlTest.hideBubble());
  await dragTo(right, y, true);
  await facing(false);
  await page.screenshot({ path: path.join(artifacts, 'facing-right.png'), omitBackground: true });
  await dragTo(left, y, false, true);
  await facing(false);

  // 自动开关关闭后左右拖动保持固定手动方向，不改写用户的手动镜像偏好。
  await appearance({ autoFlip: false, flip: true });
  await facing(true);
  await dragTo(left, y, true);
  await facing(true);
  await dragTo(right, y, true);
  await facing(true);

  // 跟随模式使用宿主内部左右，宿主处在屏幕右侧也不能把左侧角色误判为右侧。
  await appearance();
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    const area = c.display.workArea;
    c.followFrame({ x: area.x + Math.round(area.width * .55), y: area.y + 60, width: Math.round(area.width * .4), height: area.height - 120 }, { x: 0, y: .5 });
  });
  await facing(true);

  // 系统减少动态效果与关闭动画反馈均立即落位，不播放翻转过程。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await appearance({ flip: true });
  await facing(false);
  assert.equal((await drawing()).animating, false);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await appearance({ motion: false });
  await facing(true);
  assert.equal((await drawing()).animating, false);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'facing-report.json'), JSON.stringify({ passed: true, frames, checks: ['松手后翻转', '真实中间帧', '左右往返', '镜像后点击与透明穿透', '取消恢复', '手动镜像与自动开关', '宿主局部左右', '减少动态效果与动画反馈开关'] }, null, 2));
  console.log('自动朝向验收通过：拖动不提前翻转、松手后连续动画、左右往返、透明命中、取消恢复、手动镜像、跟随模式和减少动态效果。');
} finally {
  await application?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
