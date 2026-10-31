import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHARACTER_ASSET, EYE_ARTWORK } from '../src/shared/gaze.js';

// 去掉目录末尾的反斜杠，避免 Windows 启动参数中的闭合引号被转义。
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-eyes-'));
const artifacts = path.join(root, '.artifacts');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
const errors = [];
let application, page;

// 等待真实绘制或 IPC 结果，失败时给出对应的验收项。
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(message);
}

// 分别追踪虹膜、紫色眼眶和深色上睫毛，避免仅有高光移动也被判定为整眼跟随。
async function eyeFeatures() {
  return page.evaluate((artwork) => [...document.querySelectorAll('.eye-layer')].map((canvas, eyeIndex) => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const eye = artwork.eyes[eyeIndex];
    const iris = { sum: 0, x: 0, y: 0 }, rim = { sum: 0, x: 0, y: 0 }, lash = { sum: 0, x: 0, y: 0 };
    const bounds = eyeIndex === 0 ? [380, 620, 610, 840] : [715, 625, 1010, 870];
    // 将像素位置还原到原画坐标，显示密度和角色大小不会改变验收阈值。
    for (let row = 0; row < canvas.height; row += 1) for (let col = 0; col < canvas.width; col += 1) {
      const index = (row * canvas.width + col) * 4;
      const x = eye.x + (col + 0.5) * eye.width / canvas.width;
      const y = eye.y + (row + 0.5) * eye.height / canvas.height;
      if (!data[index + 3] || x < bounds[0] || y < bounds[1] || x > bounds[2] || y > bounds[3]) continue;
      const r = data[index], g = data[index + 1], b = data[index + 2];
      let feature;
      if (r > 110 && r < 220 && g < 190 && b > r + 15 && b > g + 15) feature = iris;
      else if (r > 45 && r < 120 && g > 25 && g < 100 && b > r + 5 && b < 155) feature = rim;
      else if (r < 45 && g < 45 && b < 100 && y < (eyeIndex === 0 ? 718 : 762)) feature = lash;
      if (feature) {
        feature.sum += 1; feature.x += x; feature.y += y;
      }
    }
    for (const feature of [iris, rim, lash]) {
      feature.x /= feature.sum; feature.y /= feature.sum;
    }
    return { hidden: canvas.hidden, iris, rim, lash };
  }), EYE_ARTWORK);
}

// 读取最终 CSS 矩阵，确认身体确实向鼠标倾斜、平移，同时不被水平翻转改变屏幕方向。
async function bodyState() {
  return page.evaluate(() => {
    const matrix = new DOMMatrix(getComputedStyle(document.getElementById('character')).transform);
    return { x: matrix.e, y: matrix.f, angle: Math.atan2(-matrix.c, matrix.d) * 180 / Math.PI };
  });
}

// 关闭效果、减少动态效果或隐藏窗口后，身体应立即恢复原来的锚点姿态。
async function assertNeutralBody() {
  const pose = await bodyState();
  assert.ok(Math.abs(pose.x) < 0.001 && Math.abs(pose.y) < 0.001 && Math.abs(pose.angle) < 0.001,
    `身体没有恢复原位：${JSON.stringify(pose)}`);
}

// 通过真实主进程的固定光标通道输入，覆盖预加载订阅与渲染器的连接。
async function look(x, y) {
  await application.evaluate((_, point) => {
    globalThis.__dragonGirlTest.windows.get('character').webContents.send('dg:cursor', point);
  }, { x, y });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await until(() => page.evaluate(() => performance.now() - window.__lastEyeFrame > 180), '视线动画没有收敛停止');
  return eyeFeatures();
}

// 外观更新沿用生产入口，开关和翻转不会跳过主进程布局协议。
async function appearance(settings, asset = DEFAULT_CHARACTER_ASSET) {
  await application.evaluate((_, value) => {
    globalThis.__dragonGirlTest.setAppearance(value);
  }, { asset, settings: { eyeTracking: true, blinkEnabled: false, soundEnabled: false, ...settings } });
}

try {
  await fs.mkdir(artifacts, { recursive: true });
  const environment = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: temporary };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.DRAGONGIRL_MONITOR_TEST;
  // 安装包验收直接运行包内程序，不传源码路径，确保检查的就是待替换版本。
  application = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [root], env: environment, timeout: 30000,
  });
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest?.ready.size === 2), '角色没有启动');
  page = application.windows().find((window) => window.url().endsWith('/character.html'));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    // 仅验收中记录动画帧时间，生产页面无需暴露任何测试接口。
    const request = window.requestAnimationFrame.bind(window);
    window.__lastEyeFrame = performance.now();
    window.requestAnimationFrame = (callback) => request((time) => {
      window.__lastEyeFrame = performance.now();
      callback(time);
    });
    window.__cursorMessages = [];
    window.dragonGirl.onCursor((point) => window.__cursorMessages.push(point));
  });
  // 保留原生轮询方法供全局坐标检查，其他受控输入期间避免真实鼠标干扰。
  const actualCursor = await application.evaluate(({ screen }) => {
    const companion = globalThis.__dragonGirlTest;
    clearTimeout(companion.cursorTimer);
    companion.__pollCursor = companion.pollCursor.bind(companion);
    companion.pollCursor = () => {};
    const area = companion.display.workArea;
    const point = screen.getCursorScreenPoint();
    companion.character = {
      ...companion.character,
      x: Math.round(area.x + (point.x < area.x + area.width / 2 ? area.width - companion.character.width - 50 : 50)),
      y: Math.round(area.y + 100),
    };
    companion.applyCharacter();
    const bounds = companion.windows.get('character').getBounds();
    companion.cursorPositions.clear();
    companion.__pollCursor();
    clearTimeout(companion.cursorTimer);
    return { x: point.x - bounds.x, y: point.y - bounds.y, width: bounds.width, height: bounds.height };
  });
  assert.ok(actualCursor.x < 0 || actualCursor.x > actualCursor.width || actualCursor.y < 0 || actualCursor.y > actualCursor.height);
  await until(() => page.evaluate((expected) => window.__cursorMessages.some((point) => point.x === expected.x && point.y === expected.y), actualCursor), '窗口外系统鼠标没有传到角色');
  await appearance({});
  await until(() => page.locator('.eye-layer').count().then((count) => count === 2), '两只眼睛没有创建');
  const originalPosition = await application.evaluate(() => ({ ...globalThis.__dragonGirlTest.character }));
  const body = {};

  // 左右上下均用真实像素质心确认方向，同时保留可检查的整角色截图。
  const left = await look(-2000, 150);
  body.left = await bodyState();
  await page.screenshot({ path: path.join(artifacts, 'eyes-left.png'), omitBackground: true });
  const right = await look(2000, 150);
  body.right = await bodyState();
  await page.screenshot({ path: path.join(artifacts, 'eyes-right.png'), omitBackground: true });
  const up = await look(160, -2000);
  body.up = await bodyState();
  await page.screenshot({ path: path.join(artifacts, 'eyes-up.png'), omitBackground: true });
  const down = await look(160, 2000);
  body.down = await bodyState();
  await page.screenshot({ path: path.join(artifacts, 'eyes-down.png'), omitBackground: true });
  for (let index = 0; index < 2; index += 1) for (const feature of ['iris', 'rim', 'lash']) {
    assert.ok(right[index][feature].x - left[index][feature].x > 8, `左右视线没有移动 ${feature}：${JSON.stringify({ left, right })}`);
    assert.ok(down[index][feature].y - up[index][feature].y > 8, `上下视线没有移动 ${feature}：${JSON.stringify({ up, down })}`);
  }
  assert.ok(body.left.x < 0 && body.right.x > 0 && body.left.angle < -0.2 && body.right.angle > 0.2, '身体没有向鼠标轻微倾斜');
  assert.ok(body.up.y < 0 && body.down.y > 0, '身体没有随上下视线轻微移动');
  assert.ok(Object.values(body).every((pose) => Math.abs(pose.angle) <= 0.451), '身体倾斜超过轻微幅度');
  assert.deepEqual(await application.evaluate(() => ({ ...globalThis.__dragonGirlTest.character })), originalPosition, '身体跟随改变了原生窗口位置');

  await appearance({ flip: true });
  const flipped = await look(2000, 150);
  body.flipped = await bodyState();
  assert.ok(body.flipped.angle > 0 && body.flipped.x > 0, '翻转后身体向鼠标相反方向倾斜');
  for (let index = 0; index < 2; index += 1) for (const feature of ['iris', 'rim', 'lash'])
    assert.ok(flipped[index][feature].x < right[index][feature].x - 8, '翻转后整眼视线方向相反');

  // 缩小与放大后眼区仍按原图比例对齐，透明背景不受画布影响。
  await appearance({});
  for (const scale of [0.5, 0.6, 1.5]) {
    await application.evaluate((_, value) => globalThis.__dragonGirlTest.setScale(value), scale);
    await look(2000, 150);
    const positions = await page.evaluate(() => {
      const character = getComputedStyle(document.getElementById('character'));
      return [...document.querySelectorAll('.eye-layer')].map((canvas) => {
        // 眼区随父元素一起倾斜，使用未变换的排版坐标检查其与原图的对齐关系。
        const rect = getComputedStyle(canvas);
        return { x: parseFloat(rect.left) / parseFloat(character.width), y: parseFloat(rect.top) / parseFloat(character.height) };
      });
    });
    positions.forEach((position, index) => {
      assert.ok(Math.abs(position.x - EYE_ARTWORK.eyes[index].x / EYE_ARTWORK.width) < 0.001);
      assert.ok(Math.abs(position.y - EYE_ARTWORK.eyes[index].y / EYE_ARTWORK.height) < 0.001);
    });
    // 保留用户当前 60% 大小的实际画面，避免只在放大图中确认效果。
    if (scale === 0.6) {
      await page.screenshot({ path: path.join(artifacts, 'eyes-small-right.png'), omitBackground: true });
      await look(-2000, 150);
      await page.screenshot({ path: path.join(artifacts, 'eyes-small-left.png'), omitBackground: true });
    }
  }

  // 动画反馈可以单独关闭身体配合，同时保留已开启的眼睛跟随。
  await appearance({ motion: false });
  await look(2000, 150);
  await assertNeutralBody();
  assert.ok((await eyeFeatures()).every((eye) => !eye.hidden));
  await appearance({});
  await appearance({ eyeTracking: false });
  await until(() => page.locator('.eye-layer:not([hidden])').count().then((count) => count === 0), '关闭后仍显示眼区');
  await look(-2000, 150);
  assert.ok((await eyeFeatures()).every((eye) => eye.hidden));
  await assertNeutralBody();
  await appearance({});
  await look(2000, 150);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await until(() => page.locator('.eye-layer:not([hidden])').count().then((count) => count === 0), '减少动态效果没有恢复原画');
  await assertNeutralBody();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await look(-2000, 150);
  assert.ok((await eyeFeatures()).every((eye) => !eye.hidden));

  // 用同一张图模拟导入素材，验证关闭条件取决于素材身份而非仅仅尺寸相同。
  const customName = '1234567890abcdef1234567890abcdef.png';
  await fs.mkdir(path.join(temporary, 'assets'), { recursive: true });
  await fs.copyFile(path.join(root, 'assets/characters/codex-dragon-girl.png'), path.join(temporary, 'assets', customName));
  await appearance({}, `dragon://app/user-assets/${customName}`);
  await until(() => page.evaluate((name) => document.getElementById('portrait').src.endsWith(name), customName), '导入图片未加载');
  await look(2000, 150);
  assert.ok((await eyeFeatures()).every((eye) => eye.hidden), '自定义图片被套用默认眼区');
  await assertNeutralBody();
  await appearance({});
  await until(() => page.evaluate((asset) => document.getElementById('portrait').src === asset, DEFAULT_CHARACTER_ASSET), '恢复默认图片失败');
  await look(2000, 150);
  assert.ok((await eyeFeatures()).every((eye) => !eye.hidden));
  await application.evaluate(() => globalThis.__dragonGirlTest.hide());
  await until(() => page.locator('.eye-layer:not([hidden])').count().then((count) => count === 0), '隐藏后视线仍在绘制');
  await assertNeutralBody();
  await application.evaluate(() => globalThis.__dragonGirlTest.show());
  await look(-2000, 150);
  assert.ok((await eyeFeatures()).every((eye) => !eye.hidden));
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'eyes-report.json'), JSON.stringify({ passed: true, left, right, up, down, flipped, body }, null, 2));
  console.log('视线联动验证通过：整眼四向移动、身体轻微倾斜和平移、窗口锚点不变、收敛停止、翻转、缩放、开关、减少动态效果和隐藏恢复。');
} finally {
  if (application) await application.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
