import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHARACTER_ASSET, EYE_ARTWORK } from '../src/shared/gaze.js';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-expression-'));
const artifacts = path.join(root, '.artifacts');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
const errors = [];
let application, page;

// 等待原生手势和实际绘制状态，不能用固定延时把没有触发误判为恢复成功。
async function until(check, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

// 通过生产布局入口更新外观，静音和关闭跟随不能顺带禁止表情。
async function appearance(settings = {}, asset = DEFAULT_CHARACTER_ASSET) {
  await application.evaluate((_, value) => globalThis.__dragonGirlTest.setAppearance(value), {
    asset, settings: { eyeTracking: false, blinkEnabled: false, expressionsEnabled: true, soundEnabled: false, ...settings },
  });
}

// 对照原画检查虹膜像素，确认光确实在眼内变化，嘴部及眼外区域没有新增图形。
async function faceState() {
  return page.evaluate((artwork) => {
    const image = document.getElementById('portrait');
    const layers = [...document.querySelectorAll('.eye-layer')];
    const eyes = layers.map((canvas, index) => {
      const eye = artwork.eyes[index], iris = eye.iris;
      const baseline = document.createElement('canvas');
      baseline.width = canvas.width; baseline.height = canvas.height;
      const context = baseline.getContext('2d', { willReadFrequently: true });
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, eye.x, eye.y, eye.width, eye.height, 0, 0, canvas.width, canvas.height);
      const original = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const actual = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const white = new Uint8Array(canvas.width * canvas.height);
      let changed = 0, outside = 0, signature = 0, x = 0, y = 0, light = 0;
      if (!canvas.hidden) for (let row = 0; row < canvas.height; row += 1) for (let col = 0; col < canvas.width; col += 1) {
        const offset = (row * canvas.width + col) * 4;
        if (!actual[offset + 3]) continue;
        const difference = Math.abs(actual[offset] - original[offset]) + Math.abs(actual[offset + 1] - original[offset + 1]) + Math.abs(actual[offset + 2] - original[offset + 2]);
        if (difference < 8) continue;
        const sourceX = eye.x + (col + 0.5) * eye.width / canvas.width;
        const sourceY = eye.y + (row + 0.5) * eye.height / canvas.height;
        const inside = ((sourceX - iris.cx) / (iris.rx + 3)) ** 2 + ((sourceY - iris.cy) / (iris.ry + 3)) ** 2 <= 1
          && sourceY >= iris.lid + (sourceX - iris.cx) * iris.slope - 3;
        if (!inside) outside += 1;
        changed += 1;
        signature += difference * (col + 1) * (row + 1);
        light += difference; x += difference * col; y += difference * row;
        // 只计新增的明亮星芒，原画的白色圆高光和仅有轻微颜色变化的柔光不算可见星星。
        if (inside && actual[offset] >= 239 && actual[offset + 1] >= 225 && actual[offset + 2] >= 243
          && actual[offset + 1] - original[offset + 1] >= 30) white[row * canvas.width + col] = 1;
      }
      // 以实际屏幕尺寸测量亮区连通轮廓，防止像素变了但缩小后只剩几个看不清的点。
      const highlights = [], pixelSize = canvas.getBoundingClientRect().width / canvas.width;
      for (let start = 0; start < white.length; start += 1) {
        if (!white[start]) continue;
        const pending = [start];
        white[start] = 0;
        let minX = canvas.width, maxX = 0, minY = canvas.height, maxY = 0, area = 0;
        while (pending.length) {
          const pixel = pending.pop(), col = pixel % canvas.width, row = Math.floor(pixel / canvas.width);
          minX = Math.min(minX, col); maxX = Math.max(maxX, col);
          minY = Math.min(minY, row); maxY = Math.max(maxY, row); area += 1;
          for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
            const nx = col + dx, ny = row + dy, next = ny * canvas.width + nx;
            if (nx >= 0 && nx < canvas.width && ny >= 0 && ny < canvas.height && white[next]) {
              white[next] = 0; pending.push(next);
            }
          }
        }
        const width = maxX - minX + 1, height = maxY - minY + 1;
        highlights.push({ width: width * pixelSize, height: height * pixelSize,
          area: area * pixelSize ** 2, fill: area / (width * height) });
      }
      return { changed, outside, signature, x: light ? x / light : 0, y: light ? y / light : 0, highlights };
    });
    const character = document.getElementById('character');
    const matrix = new DOMMatrix(getComputedStyle(character).transform);
    return {
      happy: character.dataset.expression === 'happy', hidden: layers.every((canvas) => canvas.hidden),
      colored: eyes.reduce((sum, eye) => sum + eye.changed, 0), outside: eyes.reduce((sum, eye) => sum + eye.outside, 0),
      faceLayers: document.querySelectorAll('.expression-layer').length, eyes, y: matrix.f,
    };
  }, EYE_ARTWORK);
}

// 受控输入使用实际脸颊位置，开始前恢复窗口焦点，避免截图造成的迟到 blur 取消手势。
async function point() {
  await page.bringToFront();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(async () => {
    const { rect } = await window.dragonGirl.bootstrap();
    return { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.72 };
  });
}

// 同一个主进程入口也供任务完成使用，验证固定表情通道和渲染订阅的完整连接。
async function happy() {
  await application.evaluate(() => globalThis.__dragonGirlTest.showExpression('happy'));
}

// 表情结束后眼区、身体和持续帧请求都应恢复，原画仍保持无口造型。
async function restored() {
  await until(async () => { const face = await faceState(); return !face.happy && face.hidden && Math.abs(face.y) < 0.01; }, '开心没有在两秒后恢复');
  assert.equal(await page.locator('.eye-layer:not([hidden])').count(), 0);
}

// 录制真实安装版的逐帧画面，展示眼球静止时星光依然移动，不使用生成视频替代程序效果。
async function recordPreview() {
  await appearance({ motion: false });
  await application.evaluate(() => globalThis.__dragonGirlTest.setScale(1));
  await page.evaluate(() => { document.body.style.background = '#20202a'; });
  const frames = path.join(temporary, 'sparkle-frames');
  await fs.mkdir(frames);
  const start = Date.now(), count = 64;
  for (let index = 0; index < count; index += 1) {
    if (index === 8) await happy();
    await page.screenshot({ path: path.join(frames, String(index).padStart(4, '0') + '.png') });
    const remaining = start + (index + 1) * 50 - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  const fps = count / ((Date.now() - start) / 1000);
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', fps.toFixed(3), '-i', path.join(frames, '%04d.png'),
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    path.join(artifacts, 'happy-sparkles.mp4')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || '动画预览编码失败');
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
    companion.character = { ...companion.character, x: companion.display.workArea.x + 420, y: companion.display.workArea.y + 220 };
    companion.applyCharacter();
  });
  await appearance();
  await page.evaluate(() => {
    window.__expressionEvents = [];
    window.dragonGirl.onExpression((name) => {
      window.__expressionEvents.push(name);
      window.__expressionAt = performance.now();
    });
  });
  const original = await application.evaluate(() => ({ ...globalThis.__dragonGirlTest.character }));
  const click = await point();
  // 复现原生窗口已经显示、渲染层仍持有隐藏布局的情况，轻点必须先纠正可见性再播放。
  await application.evaluate(() => {
    const companion = globalThis.__dragonGirlTest;
    const window = companion.windows.get('character');
    if (!window.isVisible()) throw new Error('可见性回归需要实际显示的原生窗口');
    window.webContents.send('dg:layout', { ...companion.characterModel(), visible: false });
  });
  await until(async () => (await faceState()).hidden, '未复现渲染层残留的隐藏状态');
  await page.mouse.click(click.x, click.y);
  const clicked = await until(async () => {
    const value = await faceState();
    return value.happy && value.colored > 50 && value.outside === 0 && value.y < -0.8 ? value : false;
  }, '轻点没有出现眼内星光和轻弹');
  assert.equal(clicked.faceLayers, 0, '出现了嘴巴或其他脸部叠层');
  await until(() => page.evaluate(() => performance.now() - window.__expressionAt >= 350), '星光没有完成淡入');
  await page.screenshot({ path: path.join(artifacts, 'happy-click.png'), omitBackground: true });
  assert.equal(await application.evaluate(() => globalThis.__dragonGirlTest.bubbleVisible), true, '开心表情覆盖了原来的点击气泡');
  // 两次采样均在强度保持为一的阶段，差异必须来自光的位置与明暗变化。
  await until(() => page.evaluate(() => performance.now() - window.__expressionAt >= 650), '没有进入星光保持阶段');
  const firstLight = await faceState();
  await until(() => page.evaluate(() => performance.now() - window.__expressionAt >= 1100), '没有进入第二次星光采样');
  const secondLight = await faceState();
  for (let index = 0; index < 2; index += 1) {
    assert.notEqual(firstLight.eyes[index].signature, secondLight.eyes[index].signature, '眼内光只是一张静态图片');
    assert.ok(Math.hypot(firstLight.eyes[index].x - secondLight.eyes[index].x, firstLight.eyes[index].y - secondLight.eyes[index].y) > 0.2, '眼内光没有实际移动');
  }
  assert.equal(firstLight.outside + secondLight.outside, 0, '光溢出了虹膜范围');
  await restored();
  assert.deepEqual(await application.evaluate(() => ({ ...globalThis.__dragonGirlTest.character })), original, '轻弹改写了原生窗口位置');
  await page.screenshot({ path: path.join(artifacts, 'happy-restored.png'), omitBackground: true });
  await application.evaluate(() => globalThis.__dragonGirlTest.hideBubble());

  // 真实拖动跨过阈值后松手，不得额外触发开心或点击气泡。
  const beforeDrag = await page.evaluate(() => window.__expressionEvents.length);
  const drag = await point();
  const bounds = await application.evaluate(() => globalThis.__dragonGirlTest.windows.get('character').getBounds());
  const target = { x: bounds.x + drag.x + 65, y: bounds.y + drag.y + 20 };
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.x + 65, drag.y + 20);
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest.dragging), '拖动没有开始');
  const moved = await application.evaluate(() => globalThis.__dragonGirlTest.windows.get('character').getBounds());
  await page.mouse.move(target.x - moved.x, target.y - moved.y);
  await page.mouse.up();
  await until(() => application.evaluate(() => !globalThis.__dragonGirlTest.gesture.active), '拖动没有结束');
  assert.equal(await page.evaluate(() => window.__expressionEvents.length), beforeDrag, '拖动被当作点击触发开心');
  assert.equal((await faceState()).happy, false);

  // 按压失去焦点时走取消入口，不能当作轻点。
  const cancel = await point();
  await page.mouse.move(cancel.x, cancel.y);
  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await until(() => application.evaluate(() => !globalThis.__dragonGirlTest.gesture.active), '取消没有结束手势');
  assert.equal(await page.evaluate(() => window.__expressionEvents.length), beforeDrag);

  // 连续完成沿用一轮星光，停止后恢复，不会留下排队动画。
  await happy();
  await until(async () => (await faceState()).happy, '完成事件没有显示开心');
  await happy();
  await restored();
  await application.evaluate(() => globalThis.__dragonGirlTest.setScale(0.6));
  await appearance({ motion: false });
  const smallPoint = await point();
  await page.mouse.click(smallPoint.x, smallPoint.y);
  await until(async () => (await faceState()).happy, '60% 大小轻点没有触发表情');
  await until(() => page.evaluate(() => performance.now() - window.__expressionAt >= 500), '小尺寸星光没有完成淡入');
  const small = await faceState();
  await page.screenshot({ path: path.join(artifacts, 'happy-small.png'), omitBackground: true });
  // 仅测高对比白色核心，不把抗锯齿尖端和紫边算进尺寸；每眼至少出现可辨认的凹角星形。
  for (const eye of small.eyes) assert.ok(eye.highlights.some((light) => light.width >= 6 && light.height >= 6
    && light.area >= 16 && light.fill < 0.7), '60% 大小缺少轮廓清楚的星芒，只有柔光或小亮点');
  await restored();
  await application.evaluate(() => globalThis.__dragonGirlTest.hideBubble());
  await appearance({ flip: true });
  await happy();
  await until(async () => (await faceState()).colored > 20, '翻转后星光消失');
  await page.screenshot({ path: path.join(artifacts, 'happy-flipped.png'), omitBackground: true });
  await restored();

  // 关闭动画反馈保留星光但停止轻弹；关闭动态表情则完全保持原脸。
  await appearance({ motion: false });
  await happy();
  const still = await until(async () => { const value = await faceState(); return value.colored > 20 ? value : false; }, '关闭身体动画后星光也被禁用');
  assert.ok(Math.abs(still.y) < 0.01);
  await appearance({ expressionsEnabled: false });
  await happy();
  await restored();
  await appearance();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await happy();
  await restored();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await happy();
  await until(async () => (await faceState()).happy, '减少动态效果恢复后无法开心');
  await application.evaluate(() => globalThis.__dragonGirlTest.hide());
  await restored();
  await application.evaluate(() => globalThis.__dragonGirlTest.show());
  assert.equal((await faceState()).happy, false, '重新显示重放了旧开心表情');

  // 自定义图片不套用原画五官，恢复默认后才能再次显示表情。
  const custom = 'abcdef1234567890abcdef1234567890.png';
  await fs.mkdir(path.join(temporary, 'assets'), { recursive: true });
  await fs.copyFile(path.join(root, 'assets/characters/codex-dragon-girl.png'), path.join(temporary, 'assets', custom));
  await appearance({}, `dragon://app/user-assets/${custom}`);
  await happy();
  await restored();
  await appearance();
  await until(() => page.evaluate(() => document.getElementById('portrait').src === 'dragon://app/assets/characters/codex-dragon-girl.png'), '默认图片未恢复');
  await appearance({ blinkEnabled: true });
  await happy();
  await until(async () => (await faceState()).happy, '恢复默认后没有开心');
  await until(async () => (await faceState()).hidden, '开心结束后没有恢复原眼睛');
  await until(() => page.locator('.eye-layer:not([hidden])').count().then((count) => count === 2), '开心结束后没有恢复自然眨眼');
  assert.equal((await faceState()).happy, false, '自然眨眼误触发开心');
  if (process.env.DRAGONGIRL_CAPTURE_EXPRESSION === '1') await recordPreview();
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'expression-report.json'), JSON.stringify({ passed: true, clicked, firstLight, secondLight, small, still }, null, 2));
  console.log('开心星光验证通过：真实点击、60% 大小清晰星芒、眼内光持续移动且不溢出、无口造型、轻弹、两秒恢复、拖动与取消不触发、缩放翻转、开关和眨眼恢复。');
} catch (error) {
  // 失败保留原生手势与页面绘制状态，区分触发失败、像素失败和窗口焦点问题。
  const diagnostics = {
    error: error.message, errors,
    face: await faceState().catch(() => null),
    events: await page?.evaluate(() => ({ expressions: window.__expressionEvents, gesture: document.getElementById('stage').dataset.gesture })).catch(() => null),
    native: await application?.evaluate(() => globalThis.__dragonGirlTest?.snapshot()).catch(() => null),
  };
  await page?.screenshot({ path: path.join(artifacts, 'expression-failure.png'), omitBackground: true }).catch(() => {});
  await fs.writeFile(path.join(artifacts, 'expression-failure.json'), JSON.stringify(diagnostics, null, 2));
  throw error;
} finally {
  if (application) await application.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
