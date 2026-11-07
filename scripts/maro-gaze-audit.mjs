import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maro-gaze-pixels-'));
const artifacts = path.join(root, '.artifacts/maro-gaze-pixels');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
let application;

// 在真实 Electron 画布上逐像素比较中性、极限视线和眨眼，原生 1254 像素不缩放量测。
try {
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [root], env, timeout: 30000 });
  let page;
  for (let attempt = 0; attempt < 200 && !page; attempt += 1) {
    page = application.windows().find((item) => item.url().endsWith('/character.html'));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!page) throw new Error('角色测试窗口未启动');
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    clearTimeout(c.cursorTimer); c.pollCursor = () => {};
    c.windows.get('character').showInactive();
  });
  await page.waitForLoadState();
  const result = await page.evaluate(async () => {
    const { createMaroEyes } = await import('./maro-eyes.js');
    const { EyeTracker } = await import('./eyes.js');
    const { MARO_EYE_ARTWORK, maroEyeMask } = await import('../shared/maro-eyes.js');
    const { MARO_ASSET } = await import('../shared/characters.js');
    const image = new Image(); image.src = MARO_ASSET; await image.decode();
    const model = { asset: MARO_ASSET, visible: true, rect: { x: 0, y: 0, width: 1254, height: 1254 },
      appearance: { settings: { eyeTracking: true, blinkEnabled: false, expressionsEnabled: false, motion: false } } };
    const before = new EyeTracker(document.createElement('div'), () => {}, {
      asset: MARO_ASSET, artwork: { ...MARO_EYE_ARTWORK, travel: { x: 17, y: 10 } },
      expressions: false, bodyFollow: false, nativeResolution: true,
      skinSample: [565, 745, 25, 20], foregroundMask: maroEyeMask,
    });
    const after = createMaroEyes(document.createElement('div'));
    for (const tracker of [before, after]) tracker.configure(image, model, { scaleX: 1, scaleY: 1, angle: 0 }, false);
    if (after.patches.length !== 2) throw new Error('麻吕眼区没有启用');

    // 合成实际覆盖层，保持原图的透明度；空白叠层不能被当成颜色不变。
    function render(tracker, x, y, blink = 0) {
      tracker.current = { x, y }; tracker.blink = blink; tracker.paint();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1254;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      for (const patch of tracker.patches) if (!patch.canvas.hidden)
        context.drawImage(patch.canvas, patch.eye.x, patch.eye.y, patch.eye.width, patch.eye.height);
      return { canvas, data: context.getImageData(0, 0, 1254, 1254).data };
    }

    // 独立指定眼白范围及上下眼睑样点，检查器不使用渲染器的移动权重来判定通过。
    const regions = [{ left: 335, right: 502, top: 590, bottom: 670 },
      { left: 615, right: 777, top: 584, bottom: 669 }];
    const contours = [[340, 608], [360, 601], [410, 583], [454, 578], [480, 579],
      [355, 667], [380, 675], [410, 677], [440, 672], [466, 664],
      [625, 570], [654, 570], [689, 575], [723, 579], [787, 595],
      [635, 661], [662, 672], [692, 675], [726, 673], [757, 665]];

    // 颜色和 alpha 都必须一致，分别记录脸部、刘海、眼眶及白区以外的变动像素。
    function compare(reference, actual) {
      let changed = 0, outside = 0, contour = 0, hair = 0, cheek = 0, ink = 0, rgbOutside = 0;
      const inkSamples = [];
      for (let y = 0; y < 1254; y += 1) for (let x = 0; x < 1254; x += 1) {
        const offset = (y * 1254 + x) * 4;
        if ([0, 1, 2, 3].every((channel) => reference[offset + channel] === actual[offset + channel])) continue;
        changed += 1;
        if (!regions.some((region) => x >= region.left && x <= region.right && y >= region.top && y <= region.bottom)) {
          outside += 1;
          if ([0, 1, 2].some((channel) => reference[offset + channel] !== actual[offset + channel])) rgbOutside += 1;
        }
        if (contours.some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 <= 4)) contour += 1;
        if (reference[offset + 3] > 240 && reference[offset] > 170
          && reference[offset] - reference[offset + 1] > 32 && reference[offset + 1] - reference[offset + 2] > 8) hair += 1;
        if (y >= 690 && y <= 810 && x >= 310 && x <= 830) cheek += 1;
        // 虹膜自身的深色边缘允许移动；固定检查上下眼睑带、外眼角和独立眼眶标记。
        if ((y <= 590 || y >= 669 || x <= 337 || x >= 775 || contours.some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 <= 4))
          && x >= 310 && x <= 830 && y >= 530 && y <= 700 && reference[offset + 3] > 240
          && reference[offset] < 180 && reference[offset + 1] < 170 && reference[offset + 2] < 165
          && reference[offset] >= reference[offset + 1] && reference[offset + 1] >= reference[offset + 2]) {
          ink += 1;
          if (inkSamples.length < 12) inkSamples.push({ x, y, before: [...reference.slice(offset, offset + 4)], after: [...actual.slice(offset, offset + 4)] });
        }
      }
      return { changed, outside, rgbOutside, contour, ink, hair, cheek, inkSamples };
    }

    const directions = [['left', -1, 0], ['right', 1, 0], ['up', 0, -1], ['down', 0, 1],
      ['upper-left', -Math.SQRT1_2, -Math.SQRT1_2], ['upper-right', Math.SQRT1_2, -Math.SQRT1_2],
      ['lower-left', -Math.SQRT1_2, Math.SQRT1_2], ['lower-right', Math.SQRT1_2, Math.SQRT1_2]];
    const labels = { left: '左极限', right: '右极限', up: '上极限', down: '下极限',
      'upper-left': '左上极限', 'upper-right': '右上极限', 'lower-left': '左下极限', 'lower-right': '右下极限' };
    const neutral = render(after, 0, 0);
    const rows = [], images = [{ name: 'neutral', png: neutral.canvas.toDataURL('image/png').split(',')[1] }], boards = [];
    // 对照板放大同一块眼区，不对不同状态重新裁剪或自动居中。
    for (let group = 0; group < 2; group += 1) {
      const board = document.createElement('canvas'); board.width = 1620; board.height = 880;
      const context = board.getContext('2d'); context.fillStyle = '#f7f7f7'; context.fillRect(0, 0, board.width, board.height);
      for (let index = group * 4; index < group * 4 + 4; index += 1) {
        const [name, x, y] = directions[index];
        const old = render(before, x, y), fixed = render(after, x, y);
        const previous = compare(neutral.data, old.data), current = compare(neutral.data, fixed.data);
        rows.push({ direction: name, previous, current });
        images.push({ name, png: fixed.canvas.toDataURL('image/png').split(',')[1] });
        for (const [column, item] of [old, neutral, fixed].entries()) {
          const px = column * 540, py = index % 4 * 220;
          context.fillStyle = '#222'; context.font = '15px sans-serif';
          context.fillText(`${labels[name]} / ${['修复前', '待机原图', '修复后'][column]}`, px + 10, py + 20);
          context.drawImage(item.canvas, 300, 535, 530, 185, px + 5, py + 30, 530, 185);
        }
      }
      boards.push(board.toDataURL('image/png').split(',')[1]);
    }
    const blinks = [];
    // 同一眨眼进度下比较极限方向，视线不能额外扯动闭合的眼皮。
    for (const amount of [0.5, 1]) {
      const baseline = render(after, 0, 0, amount);
      for (const [direction, x, y] of directions.slice(0, 4)) {
        const frame = render(after, x, y, amount);
        blinks.push({ amount, direction, ...compare(baseline.data, frame.data) });
      }
    }
    const restored = compare(neutral.data, render(after, 0, 0).data);
    before.reset(); after.reset();
    return { rows, blinks, restored, images, boards };
  });
  await fs.mkdir(artifacts, { recursive: true });
  for (const image of result.images)
    await fs.writeFile(path.join(artifacts, `${image.name}.png`), Buffer.from(image.png, 'base64'));
  for (let index = 0; index < result.boards.length; index += 1)
    await fs.writeFile(path.join(artifacts, `comparison-${index + 1}.png`), Buffer.from(result.boards[index], 'base64'));
  delete result.images; delete result.boards;
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(result, null, 2));
  assert.ok(result.rows.every((row) => row.previous.outside > 0), '旧版对照没有重现眼区外变形');
  assert.ok(result.rows.every((row) => row.current.changed > 0), '视线被完全禁用');
  assert.ok(result.rows.every((row) => ['outside', 'contour', 'ink', 'hair', 'cheek'].every((key) => row.current[key] === 0)), '眼白以外的像素仍然被视线改变');
  assert.ok(result.blinks.every((row) => row.outside === 0 && row.cheek === 0 && row.hair === 0 && row.ink === 0), '眨眼叠加视线时出现额外外部形变');
  assert.ok(result.blinks.filter((row) => row.amount === 1).every((row) => row.changed === 0), '闭眼时眼睑仍随视线偏移');
  assert.equal(result.restored.changed, 0);
  console.log(JSON.stringify({ directions: result.rows.length, protectedChangedPixels: 0, closedGazeChangedPixels: 0,
    neutralRestoredExactly: true, previousOutsideRGBChangedPixels: result.rows.map((row) => row.previous.rgbOutside) }));
} finally {
  await application?.close().catch(() => {});
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
