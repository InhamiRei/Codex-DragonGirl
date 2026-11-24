import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KANNA_PORTRAIT, KOKKORO_PORTRAIT } from '../src/renderer/portrait-artwork.js';
import { dialogueLine } from '../src/shared/dialogue.js';
import { verifyKannaBlinkGaze, verifyKannaLinework, watchKannaLinework } from './kanna-linework.mjs';

const root = process.cwd();
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
let application, page;

// 按各自原画选择应锁定的装饰和闭眼时应消失的虹膜像素。
const portraits = [
  { artwork: KOKKORO_PORTRAIT, name: '可可萝', fixed: [[0, 0], [650, 170], [1012, 680], [489, 1101], [607, 1201]],
    samples: [[332, 680, 114, 111], [632, 740, 114, 111]] },
  { artwork: KANNA_PORTRAIT, name: '康娜', fixed: [[0, 0], [670, 170], [1000, 1000], [610, 1150]],
    samples: [[392, 644, 100, 104], [735, 682, 90, 99]] },
];

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

// 将任务结果送入真实提醒队列，等待它经实例路由更新角色气泡。
async function task(status, source = '主任务') {
  return application.evaluate(async (_, { status, source }) => {
    const { monitor, companion } = globalThis.__dragonGirlApp;
    const displayed = source === '主任务' ? new Promise((resolve) => monitor.once('notice', resolve)) : null;
    monitor.receiveTaskEvents([{ home: monitor.instances[0].id, thread: `smoke-${source}`, turn: status, source, status }]);
    await displayed;
    return companion.bubbleModel.text;
  }, { status, source });
}

// 按当前角色的原画颜色量测两眼虹膜的中心，覆盖侧脸两只眼睛不同的形状。
async function gazePixels() {
  return page.evaluate(async () => {
    const { PORTRAIT_ARTWORK } = await import('dragon://app/src/renderer/portrait-artwork.js');
    const source = document.getElementById('portrait');
    const artwork = PORTRAIT_ARTWORK.get(source.src);
    return [...document.querySelectorAll('.portrait-eye-layer')].map((layer, index) => {
      const eye = artwork.eyes[index];
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
        const iris = artwork.id === 'kanna' ? b - r > 45 && b - g > 24 : r - g > 26 && b - g > 21 && g < 165;
        if (!iris) continue;
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
      vertical: matrix.f / character.offsetHeight,
      angle: Math.atan2(-matrix.c, matrix.d) * 180 / Math.PI,
      scaleX: Math.hypot(matrix.a, matrix.b),
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

// 趁视线停在目标方向，把正在显示的两块眼部画布和周围原画截进同一个取景框。
async function captureGazeStrip(artwork) {
  return page.evaluateHandle(({ eyes }) => {
    const layers = [...document.querySelectorAll('.portrait-eye-layer:not([hidden])')];
    if (layers.length !== eyes.length) throw new Error('截取视线时眼部图层未显示');
    const margin = 24;
    const x = Math.min(...eyes.map((eye) => eye.x)) - margin;
    const y = Math.min(...eyes.map((eye) => eye.y)) - margin;
    const crop = document.createElement('canvas');
    crop.width = Math.max(...eyes.map((eye) => eye.x + eye.width)) + margin - x;
    crop.height = Math.max(...eyes.map((eye) => eye.y + eye.height)) + margin - y;
    const ctx = crop.getContext('2d');
    ctx.drawImage(document.getElementById('portrait'), -x, -y);
    for (const [index, eye] of eyes.entries()) {
      ctx.drawImage(layers[index], eye.x - x, eye.y - y, eye.width, eye.height);
    }
    return crop;
  }, artwork);
}

// 对照图使用渲染器的真实表情帧和统一的原画坐标，视线特写取自光标移动时的画面。
async function saveComparison({ artwork, fixed, samples }, artifacts, gazeStrips) {
  const png = await page.evaluate(async ({ artwork, fixed, samples, gazeStrips }) => {
    const { loadPortraitFrames } = await import('dragon://app/src/renderer/portrait-frames.js');
    const frames = await loadPortraitFrames(artwork);
    const image = document.getElementById('portrait');
    const native = document.createElement('canvas');
    native.width = image.naturalWidth;
    native.height = image.naturalHeight;
    const pixels = native.getContext('2d', { willReadFrequently: true });
    const withGaze = gazeStrips.length === 2;
    const width = withGaze ? 464 : 360, scale = width / image.naturalWidth;
    const height = Math.round(image.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = 3 * width + 64;
    canvas.height = 2 * (height + 58) + 12;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f7f1f2';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = withGaze ? '500 21px sans-serif' : '16px sans-serif';
    ctx.fillStyle = '#624755';
    const examples = [
      [withGaze ? '正常待机' : '待机', null], [withGaze ? '轻点或任务完成 · 惊讶' : '完成', 'happy'],
      [withGaze ? '任务失败 · 含泪' : '失败', 'sad'], ['眨眼 · 半闭', 'half'], ['眨眼 · 全闭', 'closed'],
    ];
    let reference;
    for (const [index, [label, name]] of examples.entries()) {
      // 用合成后的原生像素检查虹膜残影，以及表情区以外的实色和透明点。
      pixels.clearRect(0, 0, native.width, native.height);
      pixels.drawImage(image, 0, 0);
      if (name) pixels.drawImage(frames.get(name), artwork.face.x, artwork.face.y);
      const locked = JSON.stringify(fixed.map(([x, y]) => [...pixels.getImageData(x, y, 1, 1).data]));
      if (!name) reference = locked;
      else if (reference !== locked) throw new Error('脸部以外的配饰或半身轮廓发生变化');
      if (name === 'happy' || name === 'closed') {
        // 康娜完成时双眼睁开，可可萝完成时闭眼，两人的自然闭眼都应完全遮住虹膜。
        const open = artwork.id === 'kanna' && name === 'happy';
        for (const sample of samples) {
          const eye = pixels.getImageData(...sample).data;
          let irisPixels = 0;
          for (let offset = 0; offset < eye.length; offset += 4) {
            const r = eye[offset], g = eye[offset + 1], b = eye[offset + 2];
            const iris = artwork.id === 'kanna' ? b - r > 45 && b - g > 24 : r - g > 26 && b - g > 21 && g < 165;
            if (iris) irisPixels += 1;
          }
          if (open && irisPixels < sample[2] * sample[3] * 0.4) throw new Error('康娜完成表情没有露出蓝瞳');
          if (!open && irisPixels !== 0) throw new Error('闭眼画面有睁眼虹膜残影');
        }
      }
      const x = 16 + index % 3 * (width + 16);
      const y = 39 + Math.floor(index / 3) * (height + 58);
      ctx.fillText(label, x + 8, y - 12);
      // 从实际合成像素统一缩小，待机和局部表情在对照图上使用同一种抗锯齿。
      const portrait = await createImageBitmap(pixels.getImageData(0, 0, native.width, native.height),
        { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
      ctx.drawImage(portrait, x, y);
      portrait.close();
    }
    // 右下角的两张特写采用相同裁切和倍率，保留实际虹膜移动的幅度。
    if (withGaze) {
      const x = 16 + 2 * (width + 16), y = 39 + height + 58;
      ctx.fillText('鼠标跟随', x + 8, y - 12);
      ctx.font = '17px sans-serif';
      ctx.imageSmoothingQuality = 'high';
      for (const [index, strip] of gazeStrips.entries()) {
        const top = y + index * height / 2, w = width - 16;
        ctx.fillText(index === 0 ? '鼠标在左' : '鼠标在右', x + 8, top + 22);
        ctx.drawImage(strip, x + 8, top + 34, w, w * strip.height / strip.width);
      }
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }, { artwork, fixed, samples, gazeStrips });
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'expressions.png'), Buffer.from(png, 'base64'));
}

// 每个角色独立启动一套临时用户目录，经过真实菜单、任务提醒和打包后的资源协议。
async function verifyPortrait(sample) {
  const { artwork, name } = sample;
  const { id } = artwork;
  const frameAttribute = 'data-' + id + '-frame';
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-' + id + '-'));
  const data = path.join(temporary, 'data');
  const home = path.join(temporary, 'home');
  const artifacts = path.join(root, '.artifacts', id);
  const errors = [];
  try {
    await fs.mkdir(data);
    await fs.mkdir(path.join(home, '.codex/sessions'), { recursive: true });
    await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({
      mode: 'desktop', characterId: id, notifications: false, soundEnabled: false,
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
      // 手动启动会在桌宠 ready 之后显示管理窗口，等它显示后再测按压，避免中途失焦。
      return app?.monitor.instances.length && app.companion.ready.size === 2
        && app.dashboard.window?.isVisible() && !app.dashboard.opening;
    }), '隔离的桌宠实例没有准备好');
    page = application.windows().find((window) => window.url().endsWith('/character.html'));
    page.on('pageerror', (error) => errors.push(error.message));
    // 自定义协议不一定进入 Resource Timing。直接记录真正的解码调用，并确认命中了待机原画。
    await page.addInitScript(() => {
      const decode = HTMLImageElement.prototype.decode;
      window.__portraitDecodes = [];
      HTMLImageElement.prototype.decode = function () {
        window.__portraitDecodes.push(this.src);
        return decode.call(this);
      };
    });
    // 主进程重新加载自己的页面，沿用生产导航限制和原窗口的预加载桥。
    await application.evaluate(async () => {
      const contents = globalThis.__dragonGirlApp.companion.windows.get('character').webContents;
      await contents.loadURL(contents.getURL());
    });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await application.evaluate(() => {
      const { companion, dashboard } = globalThis.__dragonGirlApp;
      dashboard.window.hide();
      clearTimeout(companion.cursorTimer);
      companion.pollCursor = () => {};
    });
    await page.waitForFunction(({ asset, width }) => {
      const image = document.getElementById('portrait');
      return image.src === asset && image.complete && image.naturalWidth === width;
    }, artwork);
    // 记录真实播放过的康娜表情，最后导出同画幅的惊讶与闭眼定稿。
    const linework = id === 'kanna' ? await watchKannaLinework(page, artwork) : null;
    if (linework) {
      // 实际按住再松开，弹簧反馈仍有位移，轻点触发表情时也保持原来的宽高。
      await page.bringToFront();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const box = await page.locator('#character').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.64);
      await until(() => application.evaluate(() => globalThis.__dragonGirlApp.companion.interactive.get('character')),
        '面颊没有进入可接收按压的状态');
      await page.mouse.down();
      try {
        await until(async () => {
          const p = await bodyPose();
          return p.vertical > 0.025 && Math.abs(p.scaleX - 1) < 0.00001 && Math.abs(p.scaleY - 1) < 0.00001;
        }, '按住康娜时没有保持原画比例和按压反馈', 3000);
      } finally {
        await page.mouse.up();
      }
    }

    // 以下方向由主进程发送，隔离桌面上的真实鼠标，避免它在逐帧取样时改写测试目标。
    await page.evaluate(() => window.addEventListener('pointermove', event => event.stopImmediatePropagation(), true));
    // 确认两侧和上下方向都跟随，翻转后在原画里的水平方向反过来。
    const gazeStrips = [];
    const swayScale = id === 'kanna' ? 0.25 : 1;
    const left = await look({ x: -8500, y: 180 }, () => true);
    await until(async () => {
      const body = await bodyPose();
      return body.angle < -swayScale && body.horizontal < -0.0035 * swayScale;
    }, name + '的头身没有跟着光标向左倾');
    if (id === 'kanna') gazeStrips.push(await captureGazeStrip(artwork));
    const right = await look({ x: 8500, y: 180 }, (next) => next.every((eye, i) => eye.x - left[i].x > 1.6));
    await until(async () => {
      const body = await bodyPose();
      return body.angle > swayScale && body.horizontal > 0.0035 * swayScale;
    }, name + '的头身没有跟着光标向右倾');
    if (id === 'kanna') gazeStrips.push(await captureGazeStrip(artwork));
    const up = await look({ x: 148, y: -8500 }, (next) => next.every((eye, i) => eye.y < right[i].y - 0.4));
    await look({ x: 148, y: 8500 }, (next) => next.every((eye, i) => eye.y > up[i].y + 0.7));
    await settings({ flip: true });
    await look({ x: 8500, y: 180 }, (next) => next.every((eye, i) => eye.x < right[i].x - 1.6));
    await until(async () => (await bodyPose()).angle > swayScale, '镜像后身体倾向与屏幕鼠标方向相反');

    // 先从中性姿态恢复动画，独立量测静止光标下的左右摆幅。
    await settings({ flip: false, eyeTracking: false, motion: false });
    await until(async () => {
      const body = await bodyPose();
      return Math.abs(body.angle) < 0.001 && Math.abs(body.horizontal) < 0.001
        && Math.abs(body.vertical) < 0.001 && Math.abs(body.scaleY - 1) < 0.001;
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
    assert.ok(Math.max(...angles) - Math.min(...angles) > 0.25 * swayScale, name + '的待机摆动没有显示');
    assert.ok(angles.every((angle) => Math.abs(angle) < 0.6 * swayScale), '待机时左右侧倾超过预期');
    // 两个开关关闭时不加载表情素材；重新开启后继续走真实眨眼和动作预览。
    const decoded = await page.evaluate(() => window.__portraitDecodes);
    assert.ok(decoded.includes(artwork.asset), '未记录到本次立绘解码');
    assert.deepEqual(decoded.filter(url => /\/(blink-half|blink-closed|success|failure)\.png$/.test(url)), [],
      '关闭眨眼和动态表情时仍加载了表情帧');
    assert.deepEqual(decoded.filter(url => /codex-dragon-girl-(?:sad|prayer(?:-half|-hands)?)\.png$/.test(url)), [],
      '半身角色启动时解码了龙娘专属动作');
    await settings({ blinkEnabled: true });

    // 自然定时器实际驱动半闭、闭眼、半闭、睁眼四次变化。
    await page.evaluate((attribute) => {
      const target = document.getElementById('character');
      window.__portraitBlink = [];
      const observer = new MutationObserver(() => {
        window.__portraitBlink.push(target.getAttribute(attribute) ?? 'open');
      });
      observer.observe(target, { attributes: true, attributeFilter: [attribute] });
    }, frameAttribute);
    const blink = await until(() => page.evaluate(() => {
      const frames = window.__portraitBlink;
      const closed = frames.indexOf('closed');
      return closed > 0 && frames.indexOf('open', closed) > closed && frames;
    }), name + '没有完成自然眨眼', 10000);
    assert.deepEqual(blink.slice(0, 4), ['half', 'closed', 'half', 'open']);
    assert.equal(await page.locator('.portrait-eye-layer:not([hidden])').count(), 0);
    const blinkFiles = await page.evaluate(asset => window.__portraitDecodes.filter(url => url.startsWith(new URL('.', asset).href))
      .map(url => new URL(url).pathname.split('/').at(-1)).sort(), artwork.asset);
    assert.deepEqual(blinkFiles, ['blink-closed.png', 'blink-half.png', 'idle.png'], '只开启眨眼时应各解码一次待机和两张眼皮');
    await settings({ blinkEnabled: false });

    if (linework) {
      await settings({ eyeTracking: true });
      await look({ x: -8500, y: 180 }, next => next.every((eye, i) => Math.abs(eye.x - left[i].x) < 0.25));
      await settings({ blinkEnabled: true });
      await verifyKannaBlinkGaze(page, artwork, '向左');
      await settings({ blinkEnabled: false });
      // 眼皮已存在时再缩放，使眼睛画布重新创建，核对两层的实际遮挡顺序。
      const scale = await application.evaluate(() => {
        const pet = globalThis.__dragonGirlApp.companion, saved = pet.state.scale;
        pet.setScale(1.25);
        return saved;
      });
      await look({ x: 8500, y: 180 }, next => next.every((eye, i) => eye.x - left[i].x > 1.6));
      await settings({ blinkEnabled: true });
      await verifyKannaBlinkGaze(page, artwork, '向右');
      await settings({ blinkEnabled: false, eyeTracking: false });
      await application.evaluate((_, value) => globalThis.__dragonGirlApp.companion.setScale(value), scale);
    }

    // 单独打开动态表情后立即触发，待解码的动作也会按菜单选择显示。
    await settings({ expressionsEnabled: true });
    // 菜单预览依次展示两种新表情，最末一次重复触发不会旧帧串播。
    await clickMenu('完成', '动作');
    await until(() => page.locator('#character').getAttribute(frameAttribute).then((frame) => frame === 'happy'), '完成预览没有绘制');
    // 康娜用整身轻移点头，保持线宽；可可萝沿用原来的缩身幅度。
    await until(async () => {
      const pose = await bodyPose();
      return id === 'kanna' ? Math.abs(pose.scaleY - 1) < 0.00001 && pose.vertical > 0.010 : pose.scaleY < 0.984;
    }, '完成表情没有配合角色的点头姿态', 1400);
    await clickMenu('失败', '动作');
    await until(() => page.locator('#character').getAttribute(frameAttribute).then((frame) => frame === 'sad'), '失败预览没有接管画面');
    await until(() => page.locator('.portrait-face').isHidden(), '失败预览没有回到待机');

    // 正式任务事件触发同一帧。取消和子任务错误只保留各自既有行为。
    assert.equal(await clickMenu('说句话'), dialogueLine('chat', 0, id));
    assert.equal(await clickMenu('说句话'), dialogueLine('chat', 1, id));
    assert.equal(await task('complete'), dialogueLine('complete', 0, id));
    await until(() => page.locator('#character').getAttribute(frameAttribute).then((frame) => frame === 'happy'), '主任务完成没有表情');
    assert.equal(await task('error'), dialogueLine('error', 0, id));
    await until(() => page.locator('#character').getAttribute(frameAttribute).then((frame) => frame === 'sad'), '主任务失败没有表情');
    await settings({ expressionsEnabled: false });
    await until(() => page.locator('.portrait-face').isHidden(), '关闭动态表情后旧帧仍在');
    assert.equal(await task('cancelled'), dialogueLine('cancelled', 0, id));
    assert.equal(await task('error', '子代理'), dialogueLine('cancelled', 0, id));

    // 减少动态效果时保留静态动作反馈，外部光标和眨眼不会重新唤醒动画。
    await settings({ expressionsEnabled: true, blinkEnabled: true, eyeTracking: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await clickMenu('完成', '动作');
    await until(() => page.locator('#character').getAttribute(frameAttribute).then((frame) => frame === 'happy'), '减少动态效果时没有定格表情');
    const resting = await bodyPose();
    assert.ok(Math.abs(resting.scaleY - 1) < 0.001 && Math.abs(resting.vertical) < 0.001, '减少动态效果时仍在点头或呼吸');
    assert.equal(await page.locator('.portrait-eye-layer:not([hidden])').count(), 0);
    await until(() => page.locator('.portrait-face').isHidden(), '定格没有自动恢复');
    await saveComparison(sample, artifacts, gazeStrips);
    for (const strip of gazeStrips) await strip.dispose();
    if (linework) await verifyKannaLinework(linework, artifacts);
    // 表情播放中从原生菜单换角色，旧眼层和定格必须随之清理，新角色能立即接续预览。
    const next = portraits.find((entry) => entry.artwork.id !== id);
    await clickMenu('失败', '动作');
    await page.locator(`#character[${frameAttribute}="sad"]`).waitFor();
    await clickMenu(next.name, '切换角色');
    await page.waitForFunction((asset) => document.getElementById('portrait')?.dataset.asset === asset, next.artwork.asset);
    assert.equal(await page.locator(`.${id}-face, .${id}-eye-layer`).count(), 0);
    assert.equal(await page.locator('#character').getAttribute(frameAttribute), null);
    await clickMenu('完成', '动作');
    await page.locator(`#character[data-${next.artwork.id}-frame="happy"]`).waitFor();
    assert.deepEqual(errors, []);
    console.log(name + '的视线、鼠标带动头身、待机轻摆、眨眼、完成点头、失败与任务台词全部通过。');
  } finally {
    await application?.close().catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// 指定角色时单独验收，发行检查默认依次覆盖两位角色。
const selected = portraits.filter(({ artwork }) => !process.argv[2] || artwork.id === process.argv[2]);
if (!selected.length) throw new Error('未知的半身立绘：' + process.argv[2]);
for (const sample of selected) await verifyPortrait(sample);
