import assert from 'node:assert/strict';
import { DRAGON_FACE_EXPRESSIONS } from '../src/shared/expression.js';
import { EYE_ARTWORK } from '../src/shared/gaze.js';

// 观察真实视线实例的收敛状态，并让实际鼠标停留的位置不参与这组受控验收。
export async function prepareHairstyleActions(application, pet) {
  await application.evaluate(() => {
    const companion = globalThis.__dragonGirlTest;
    clearTimeout(companion.cursorTimer);
    companion.pollCursor = () => {};
  });
  await pet.evaluate(async () => {
    window.addEventListener('pointermove', (event) => event.stopImmediatePropagation(), true);
    const { EyeTracker } = await import('dragon://app/src/renderer/eyes.js');
    const follow = EyeTracker.prototype.follow;
    EyeTracker.prototype.follow = function (point) {
      if (this.className === 'eye-layer') window.__hairstyleEyeTracker = this;
      return follow.call(this, point);
    };
  });
}

// 通过主进程走真实布局更新，只修改当前验收窗口的动作开关。
async function configureActions(application, changes) {
  await application.evaluate((_, settings) => {
    const companion = globalThis.__dragonGirlTest;
    companion.setAppearance({ ...companion.appearance, settings: { ...companion.appearance.settings, ...settings } });
  }, changes);
}

// 通过光标 IPC 触发视线和身体跟随，再从眼区画布读取虹膜的水平质心。
async function look(application, pet, direction) {
  const point = await application.evaluate((_, side) => {
    const companion = globalThis.__dragonGirlTest;
    const point = { x: side * 1800, y: companion.character.height * 0.63 };
    companion.windows.get('character').webContents.send('dg:cursor', point);
    return point;
  }, direction);
  // 光标目标和身体变换都到位后才取样，避免读取上一方向的眼区。
  await pet.waitForFunction(({ x, y }) => {
    const tracker = window.__hairstyleEyeTracker;
    const transform = new DOMMatrix(getComputedStyle(document.getElementById('character')).transform);
    return tracker?.point?.x === x && tracker.point.y === y && tracker.trackingEnabled
      && tracker.frame === 0 && transform.e * Math.sign(x) > 0.1
      && document.querySelectorAll('.eye-layer:not([hidden])').length === 2;
  }, point);
  return pet.locator('.eye-layer').evaluateAll((eyes, regions) => eyes.map((canvas, index) => {
    const { width, height } = canvas;
    const eye = regions[index];
    const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
    let purple = 0;
    let sumX = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const column = offset / 4 % width;
      const row = Math.floor(offset / 4 / width);
      const x = eye.x + (column + 0.5) * eye.width / width;
      const y = eye.y + (row + 0.5) * eye.height / height;
      if (Math.abs(x - eye.iris.cx) > eye.iris.rx + 20 || Math.abs(y - eye.iris.cy) > eye.iris.ry + 12) continue;
      const r = data[offset], g = data[offset + 1], b = data[offset + 2];
      if (data[offset + 3] && r > 110 && r < 220 && g < 190 && b > r + 15 && b > g + 15) {
        purple++;
        sumX += column;
      }
    }
    return sumX / purple / width;
  }), EYE_ARTWORK.eyes);
}

// 比较不参与耳朵和发梢变形的发型区域，防止表情画布错用其他发型的立绘。
async function verifyHairLayer(pet, selector, name) {
  const layer = pet.locator(selector);
  await layer.waitFor({ state: 'visible' });
  const { sampled, changed } = await layer.evaluate((canvas, action) => {
    const { width, height } = canvas;
    const image = document.getElementById('portrait');
    const base = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    base.imageSmoothingQuality = 'high';
    base.drawImage(image, 0, 0, width, height);
    const original = base.getImageData(0, 0, width, height).data;
    const painted = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const areas = [[20, 225, 305, 570], [1110, 225, 1310, 680], [156, 1025, 300, 1176], [1055, 1098, 1210, 1176]];
    // 蛋包饭会在画面下方绘制盘子，仍可核对两侧发根和上方轮廓。
    if (action === 'omurice') areas.length = 2;
    let sampled = 0, changed = 0;
    for (const [left, top, right, bottom] of areas) {
      for (let y = top; y < bottom; y += 8) {
        for (let x = left; x < right; x += 8) {
          const at = (Math.floor(y * height / 1182) * width + Math.floor(x * width / 1330)) * 4;
          sampled++;
          if (Math.abs(original[at + 3] - painted[at + 3]) > 64) changed++;
        }
      }
    }
    return { sampled, changed };
  }, name);
  assert.ok(changed / sampled < 0.02, name + ' 播放时发型轮廓改变：' + changed + '/' + sampled);
}

// 动作预览走右键菜单使用的入口，并等待目标表情开始绘制。
async function showAction(application, pet, name) {
  await application.evaluate((_, name) => globalThis.__dragonGirlTest.showExpression(name, { preview: true }), name);
  await pet.locator('#character[data-expression="' + name + '"]').waitFor({ state: 'visible' });
}

// 捕获合掌开始和结束时的半闭眼，核对两帧都只覆盖眼区。
async function verifyPrayer(application, pet) {
  await pet.evaluate(() => {
    window.__hairstylePrayerFrames = {};
    window.__hairstylePrayerObservers?.forEach((observer) => observer.disconnect());
    window.__hairstylePrayerObservers = ['prayer-half', 'prayer-portrait'].map((id) => {
      const canvas = document.getElementById(id);
      const observer = new MutationObserver(() => {
        if (canvas.hidden) return;
        const context = canvas.getContext('2d');
        window.__hairstylePrayerFrames[id] = [[95, 421], [1216, 1019], [490, 714]].map(([x, y]) =>
          context.getImageData(x, y, 1, 1).data[3]);
      });
      observer.observe(canvas, { attributes: true, attributeFilter: ['hidden'] });
      return observer;
    });
  });
  await showAction(application, pet, 'prayer');
  await pet.locator('#prayer-portrait').waitFor({ state: 'visible' });
  assert.ok(await pet.locator('#prayer-hands').isVisible());
  await pet.locator('#character[data-expression="prayer"]').waitFor({ state: 'hidden' });
  const frames = await pet.evaluate(() => window.__hairstylePrayerFrames);
  for (const id of ['prayer-half', 'prayer-portrait']) {
    const alpha = frames[id];
    assert.ok(alpha && alpha[0] === 0 && alpha[1] === 0 && alpha[2] > 220,
      '合掌眼睑没有在预期位置绘制：' + JSON.stringify(frames));
  }
}

// 对当前选中的发型逐一检查视线、轻戳、自然眨眼、各个表情、合掌与镜像。
export async function verifyHairstyleActions(application, pet) {
  await configureActions(application, {
    motion: true, eyeTracking: true, blinkEnabled: false, expressionsEnabled: true, autoFlip: false, flip: false,
  });
  const left = await look(application, pet, -1);
  const right = await look(application, pet, 1);
  assert.ok(right.every((x, index) => x - left[index] > 0.015), '两眼没有随光标向右移动：' + JSON.stringify({ left, right }));

  await configureActions(application, { eyeTracking: false });
  await pet.locator('#dragon-motion').waitFor({ state: 'hidden' });
  await application.evaluate(() => globalThis.__dragonGirlTest.windows.get('character').webContents.send('dg:poke'));
  await verifyHairLayer(pet, '#dragon-motion', '轻戳回弹');

  // 停止视线后只由自然眨眼唤醒双眼画布，随后自动回到睁眼。
  const visibleEyes = pet.locator('.eye-layer:not([hidden])');
  await visibleEyes.first().waitFor({ state: 'hidden' });
  await configureActions(application, { blinkEnabled: true });
  // 一次眨眼只有 260 毫秒，按显示帧观察以免错过双眼同时绘制的时刻。
  await pet.waitForFunction(() => document.querySelectorAll('.eye-layer:not([hidden])').length === 2);
  await visibleEyes.first().waitFor({ state: 'hidden' });
  await configureActions(application, { blinkEnabled: false });

  // 在其余表情前检查合掌，半闭眼过渡可独立观察。
  await verifyPrayer(application, pet);
  for (const name of ['happy', 'sad']) {
    await showAction(application, pet, name);
    assert.equal(await visibleEyes.count(), 2);
  }
  for (const [label, name] of DRAGON_FACE_EXPRESSIONS) {
    await showAction(application, pet, name);
    await verifyHairLayer(pet, '#dragon-expression', name === 'omurice' ? name : label);
  }
  // 收起预览表情后检查镜像，切回正面再进入下一款。
  await configureActions(application, { expressionsEnabled: false, flip: true });
  await pet.locator('#dragon-expression').waitFor({ state: 'hidden' });
  await pet.waitForFunction(() => new DOMMatrix(getComputedStyle(document.getElementById('character')).transform).a < -0.9);
  await configureActions(application, { flip: false });
  await pet.waitForFunction(() => new DOMMatrix(getComputedStyle(document.getElementById('character')).transform).a > 0.9);
}
