import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KOKKORO_ASSET } from '../src/shared/characters.js';
import { dialogueLine } from '../src/shared/dialogue.js';

const root = process.cwd();
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-kokkoro-'));
const data = path.join(temporary, 'data');
const home = path.join(temporary, 'home');
const artifacts = path.join(root, '.artifacts/kokkoro');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
let application, page;
const errors = [];

// 等到实际渲染后的状态，避免把发出请求当作动作已显示。
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

// 走实际保存和桌宠更新路径，使开关与用户在偏好里操作一致。
async function settings(patch) {
  await application.evaluate(async (_, value) => {
    const { monitor, dashboard } = globalThis.__dragonGirlApp;
    await monitor.saveSettings((current) => ({ ...current, ...value }));
    await dashboard.updatePets();
  }, patch);
}

// 原生托盘和右键菜单共用模板，执行选项使用同一个回调。
async function clickMenu(label, submenu) {
  return application.evaluate((_, { label, submenu }) => {
    let { items } = globalThis.__dragonGirlApp.companion.buildMenu();
    if (submenu) items = items.find((entry) => entry.label === submenu).submenu.items;
    const item = items.find((entry) => entry.label === label);
    if (!item?.enabled) throw new Error('菜单项不可用：' + label);
    item.click();
    return globalThis.__dragonGirlApp.companion.bubbleModel.text;
  }, { label, submenu });
}

// 构造统计进程的主任务通知，不经过模拟的表情或台词回调。
async function task(status, source = '主任务') {
  return application.evaluate((_, { status, source }) => {
    const { monitor, companion } = globalThis.__dragonGirlApp;
    monitor.workerMessage({ type: 'task', task: { home: monitor.instances[0].id, source, status } });
    return companion.bubbleModel.text;
  }, { status, source });
}

// 使用实际画布的睁眼原图和眼区，量测两眼紫红像素的中心。
async function gazePixels() {
  return page.evaluate(async () => {
    const { KOKKORO_EYE_ARTWORK } = await import('dragon://app/src/renderer/kokkoro-eyes.js');
    const source = document.getElementById('portrait');
    return [...document.querySelectorAll('.kokkoro-eye-layer')].map((layer, index) => {
      const eye = KOKKORO_EYE_ARTWORK.eyes[index];
      const canvas = document.createElement('canvas');
      canvas.width = eye.width;
      canvas.height = eye.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, eye.x, eye.y, eye.width, eye.height, 0, 0, eye.width, eye.height);
      if (!layer.hidden) ctx.drawImage(layer, 0, 0, eye.width, eye.height);
      const pixels = ctx.getImageData(0, 0, eye.width, eye.height).data;
      let count = 0, x = 0, y = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
        if (r - g <= 26 || b - g <= 21 || g >= 165) continue;
        count += 1;
        x += offset / 4 % eye.width;
        y += Math.floor(offset / 4 / eye.width);
      }
      return { x: x / count, y: y / count, visible: !layer.hidden };
    });
  });
}

// 读取实际容器变换，翻转时也按屏幕方向计算倾角。
async function bodyPose() {
  return page.locator('#character').evaluate((character) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(character).transform);
    return {
      horizontal: matrix.e / character.offsetWidth,
      angle: Math.atan2(-matrix.c, matrix.d) * 180 / Math.PI,
      scaleY: Math.hypot(matrix.c, matrix.d),
    };
  });
}

// 发送窗口外的全局光标坐标，等待两眼从上一方向转过来并收敛。
async function look(point, moved) {
  await application.evaluate((_, point) =>
    globalThis.__dragonGirlApp.companion.windows.get('character').webContents.send('dg:cursor', point), point);
  let previous, stable = 0;
  return until(async () => {
    const eyes = await gazePixels();
    if (eyes.length !== 2 || !eyes.every(({ visible }) => visible) || !moved(eyes)) return false;
    stable = previous && eyes.every((eye, index) =>
      Math.hypot(eye.x - previous[index].x, eye.y - previous[index].y) < 0.09) ? stable + 1 : 0;
    previous = eyes;
    return stable >= 3 && eyes;
  }, '视线在窗口外没有正确收敛');
}

// 对照图使用渲染器的真实表情帧和统一的原画坐标，保留整张立绘核对帽子和底边。
async function saveComparison() {
  const png = await page.evaluate(async () => {
    const { loadKokkoroFrames, KOKKORO_FACE_BOUNDS } = await import('dragon://app/src/renderer/kokkoro-expressions.js');
    const frames = await loadKokkoroFrames();
    const image = document.getElementById('portrait');
    const native = document.createElement('canvas');
    native.width = image.naturalWidth;
    native.height = image.naturalHeight;
    const pixels = native.getContext('2d', { willReadFrequently: true });
    const width = 360, scale = width / image.naturalWidth;
    const height = Math.round(image.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = 3 * width + 64;
    canvas.height = 2 * (height + 58) + 12;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f7f1f2';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '16px sans-serif';
    ctx.fillStyle = '#624755';
    const examples = [['待机', null], ['完成', 'happy'], ['失败', 'sad'], ['眨眼 · 半闭', 'half'], ['眨眼 · 全闭', 'closed']];
    const fixed = [[0, 0], [650, 170], [1012, 680], [489, 1101], [607, 1201]];
    let reference;
    for (const [index, [label, name]] of examples.entries()) {
      // 用合成后的原生像素检查虹膜残影，以及表情区以外的实色和透明点。
      pixels.clearRect(0, 0, native.width, native.height);
      pixels.drawImage(image, 0, 0);
      if (name) pixels.drawImage(frames.get(name), KOKKORO_FACE_BOUNDS.x, KOKKORO_FACE_BOUNDS.y);
      const locked = JSON.stringify(fixed.map(([x, y]) => [...pixels.getImageData(x, y, 1, 1).data]));
      if (!name) reference = locked;
      else if (reference !== locked) throw new Error('脸部以外的兔帽、花饰或半身轮廓发生变化');
      if (name === 'happy' || name === 'closed') {
        for (const [x, y] of [[332, 680], [632, 740]]) {
          const eye = pixels.getImageData(x, y, 114, 111).data;
          for (let offset = 0; offset < eye.length; offset += 4) {
            const r = eye[offset], g = eye[offset + 1], b = eye[offset + 2];
            if (r - g > 26 && b - g > 21 && g < 165) throw new Error('闭眼画面有睁眼虹膜残影');
          }
        }
      }
      const x = 16 + index % 3 * (width + 16);
      const y = 39 + Math.floor(index / 3) * (height + 58);
      ctx.fillText(label, x + 8, y - 12);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.drawImage(native, 0, 0);
      ctx.restore();
    }
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'expressions.png'), Buffer.from(png, 'base64'));
}

try {
  await fs.mkdir(data);
  await fs.mkdir(path.join(home, '.codex/sessions'), { recursive: true });
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({
    mode: 'desktop', characterId: 'kokkoro', notifications: false, soundEnabled: false,
    autoFlip: false, motion: true, eyeTracking: true, blinkEnabled: false, expressionsEnabled: false,
  }));
  const env = {
    ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1',
    DRAGONGIRL_DATA_DIR: data, DRAGONGIRL_FIXTURE_HOME: home,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [root], env, timeout: 30000 });
  await until(() => application.evaluate(() => {
    const app = globalThis.__dragonGirlApp;
    return app?.monitor.instances.length && app.companion.ready.size === 2;
  }), '隔离的桌宠实例没有准备好');
  page = application.windows().find((window) => window.url().endsWith('/character.html'));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await application.evaluate(() => {
    const { companion } = globalThis.__dragonGirlApp;
    clearTimeout(companion.cursorTimer);
    companion.pollCursor = () => {};
  });
  await page.waitForFunction((asset) => {
    const image = document.getElementById('portrait');
    return image.src === asset && image.complete && image.naturalWidth === 1299;
  }, KOKKORO_ASSET);

  // 确认两侧和上下方向都跟随，翻转后在原画里的水平方向反过来。
  const left = await look({ x: -8500, y: 180 }, () => true);
  await until(async () => {
    const body = await bodyPose();
    return body.angle < -1 && body.horizontal < -0.0035;
  }, '可可萝的头身没有跟着光标向左倾');
  const right = await look({ x: 8500, y: 180 }, (next) => next.every((eye, i) => eye.x - left[i].x > 1.6));
  await until(async () => {
    const body = await bodyPose();
    return body.angle > 1 && body.horizontal > 0.0035;
  }, '可可萝的头身没有跟着光标向右倾');
  const up = await look({ x: 148, y: -8500 }, (next) => next.every((eye, i) => eye.y < right[i].y - 0.4));
  await look({ x: 148, y: 8500 }, (next) => next.every((eye, i) => eye.y > up[i].y + 0.7));
  await settings({ flip: true });
  await look({ x: 8500, y: 180 }, (next) => next.every((eye, i) => eye.x < right[i].x - 1.6));
  await until(async () => (await bodyPose()).angle > 1, '镜像后身体倾向与屏幕鼠标方向相反');

  // 先从中性姿态恢复动画，独立量测静止光标下的左右摆幅。
  await settings({ flip: false, eyeTracking: false, motion: false });
  await until(async () => {
    const body = await bodyPose();
    return Math.abs(body.angle) < 0.001 && Math.abs(body.horizontal) < 0.001 && Math.abs(body.scaleY - 1) < 0.001;
  }, '关闭动画反馈后仍有身体摆动');
  await settings({ motion: true });
  const angles = await page.locator('#character').evaluate(async (character) => {
    const angles = [];
    for (let index = 0; index < 14; index += 1) {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(character).transform);
      angles.push(Math.atan2(-matrix.c, matrix.d) * 180 / Math.PI);
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
    return angles;
  });
  assert.ok(Math.max(...angles) - Math.min(...angles) > 0.25, '静止鼠标下可可萝的待机摆动没有显示');
  assert.ok(angles.every((angle) => Math.abs(angle) < 0.6), '待机时左右侧倾超过预期');
  // 两个开关关闭时不加载表情素材；重新开启后继续走真实眨眼和动作预览。
  const eagerFrames = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter(({ name }) => /\/kokkoro\/(blink-half|blink-closed|success|failure)\.png$/.test(name)).length);
  assert.equal(eagerFrames, 0, '关闭眨眼和动态表情时仍加载了表情帧');
  await settings({ blinkEnabled: true, expressionsEnabled: true });

  // 自然定时器实际驱动半闭、闭眼、半闭、睁眼四次变化。
  await page.evaluate(() => {
    const target = document.getElementById('character');
    window.__kokkoroBlink = [];
    const observer = new MutationObserver(() => {
      window.__kokkoroBlink.push(target.dataset.kokkoroFrame ?? 'open');
    });
    observer.observe(target, { attributes: true, attributeFilter: ['data-kokkoro-frame'] });
  });
  const blink = await until(() => page.evaluate(() => {
    const frames = window.__kokkoroBlink;
    const closed = frames.indexOf('closed');
    return closed > 0 && frames.indexOf('open', closed) > closed && frames;
  }), '可可萝没有完成自然眨眼', 10000);
  assert.deepEqual(blink.slice(0, 4), ['half', 'closed', 'half', 'open']);
  assert.equal(await page.locator('.kokkoro-eye-layer:not([hidden])').count(), 0);
  await settings({ blinkEnabled: false });

  // 菜单预览依次展示两种新表情，最末一次重复触发不会旧帧串播。
  await clickMenu('完成', '动作');
  await until(() => page.locator('#character').getAttribute('data-kokkoro-frame').then((frame) => frame === 'happy'), '完成预览没有绘制');
  await until(async () => (await bodyPose()).scaleY < 0.984, '完成表情没有配合小幅点头', 1400);
  await clickMenu('失败', '动作');
  await until(() => page.locator('#character').getAttribute('data-kokkoro-frame').then((frame) => frame === 'sad'), '失败预览没有接管画面');
  await until(() => page.locator('.kokkoro-face').isHidden(), '失败预览没有回到待机');

  // 正式任务事件触发同一帧。取消和子任务错误只保留各自既有行为。
  assert.equal(await clickMenu('说句话'), dialogueLine('chat', 0, 'kokkoro'));
  assert.equal(await clickMenu('说句话'), dialogueLine('chat', 1, 'kokkoro'));
  assert.equal(await task('complete'), dialogueLine('complete', 0, 'kokkoro'));
  await until(() => page.locator('#character').getAttribute('data-kokkoro-frame').then((frame) => frame === 'happy'), '主任务完成没有表情');
  assert.equal(await task('error'), dialogueLine('error', 0, 'kokkoro'));
  await until(() => page.locator('#character').getAttribute('data-kokkoro-frame').then((frame) => frame === 'sad'), '主任务失败没有表情');
  await settings({ expressionsEnabled: false });
  await until(() => page.locator('.kokkoro-face').isHidden(), '关闭动态表情后旧帧仍在');
  assert.equal(await task('cancelled'), dialogueLine('cancelled', 0, 'kokkoro'));
  assert.equal(await task('error', '子任务'), dialogueLine('cancelled', 0, 'kokkoro'));

  // 减少动态效果时保留静态动作反馈，外部光标和眨眼不会重新唤醒动画。
  await settings({ expressionsEnabled: true, blinkEnabled: true, eyeTracking: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await clickMenu('完成', '动作');
  await until(() => page.locator('#character').getAttribute('data-kokkoro-frame').then((frame) => frame === 'happy'), '减少动态效果时没有定格表情');
  assert.ok(Math.abs((await bodyPose()).scaleY - 1) < 0.001, '减少动态效果时仍在点头或呼吸');
  assert.equal(await page.locator('.kokkoro-eye-layer:not([hidden])').count(), 0);
  await until(() => page.locator('.kokkoro-face').isHidden(), '定格没有自动恢复');
  await saveComparison();
  assert.deepEqual(errors, []);
  console.log('可可萝的视线、鼠标带动头身、待机轻摆、眨眼、完成点头、失败与任务台词全部通过。');
} finally {
  await application?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
