import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'maro-frame-audit-'));
const artifacts = path.join(root, '.artifacts/maro-audit');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
let application;

// 直接使用生产渲染器的逐帧缓存生成对照图，避免检查的图和最终安装的图不是同一套处理。
try {
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DRAGONGIRL_MONITOR_TEST;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [root], env, timeout: 30000 });
  let page;
  for (let attempt = 0; attempt < 200 && !page; attempt += 1) {
    page = application.windows().find((item) => item.url().endsWith('/character.html'));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 30));
  }
  if (!page) throw new Error('角色页没有启动');
  await page.waitForLoadState();
  const result = await page.evaluate(async () => {
    const { CharacterSprites } = await import('dragon://app/src/renderer/character-sprites.js');
    const { MARO_HAIR_ASSETS, HAIR_FRAME_TIMES, hairNodAt } = await import('dragon://app/src/shared/characters.js');
    const { spriteBounds, spriteCrown, spritePalette, spriteLandmarks } = await import('dragon://app/src/shared/sprite-calibration.js');
    const sprites = new CharacterSprites(document.createElement('div'), new Image(), () => {});
    const prepareStart = performance.now();
    await sprites.prepare();
    const prepareMilliseconds = performance.now() - prepareStart;
    const pages = [], frames = [], nativeFrames = [], metrics = [];
    // 审阅图缩至 512 像素便于比较，生产画布和打包原图始终是 1254 像素。
    function preview(image) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 512;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, 512, 512);
      return { canvas, pixels: context.getImageData(0, 0, 512, 512).data };
    }
    const baseline = preview(sprites.stills.idle.canvas);
    const referenceBounds = spriteBounds(baseline.pixels, 512, 512);
    const referenceCrown = spriteCrown(baseline.pixels, 512, 512, { top: referenceBounds.top });
    const referenceLandmarks = spriteLandmarks(sprites.stills.idle.pixels, 1254, 1254);
    // 分开量测发色、肤色、绿色衣领和米白衣料，不以一块头发的颜色代表整张角色。
    function materialColors(pixels, headOffsetY = 0) {
      const groups = Object.fromEntries(['hair', 'face', 'collar', 'blouse'].map((name) => [name, [[], [], []]]));
      for (let y = 0; y < 512; y += 1) for (let x = 0; x < 512; x += 1) {
        const offset = (y * 512 + x) * 4;
        if (pixels[offset + 3] < 240) continue;
        const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
        const headY = y - headOffsetY * 512;
        const conditions = {
          hair: x > 180 && x < 292 && headY > 70 && headY < 140 && r - g > 32 && g - b > 8,
          face: x > 190 && x < 275 && headY > 300 && headY < 323 && r > 215 && g > 183 && b > 165 && r - g < 44,
          collar: x > 140 && x < 325 && y > 335 && y < 423 && g > r + 2 && g > b + 3,
          blouse: x > 167 && x < 294 && y > 416 && y < 454 && r > 190
            && r - g >= 0 && r - g < 16 && g - b >= 0 && g - b < 20,
        };
        for (const name of Object.keys(groups)) {
          if (!conditions[name]) continue;
          for (let channel = 0; channel < 3; channel += 1) groups[name][channel].push(pixels[offset + channel]);
        }
      }
      return Object.fromEntries(Object.entries(groups).map(([name, channels]) => [name,
        channels.map((values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)])]));
    }
    const referenceColors = materialColors(baseline.pixels);
    // 量测头顶中央的实色发束，避开奶色高光、眼睛和抬起的袖口。
    function hairColor(pixels, headOffsetY = 0) {
      const channels = [[], [], []];
      for (let y = Math.round(82 + headOffsetY * 512); y < Math.round(154 + headOffsetY * 512); y += 1) for (let x = 190; x < 292; x += 1) {
        const offset = (y * 512 + x) * 4;
        const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
        if (pixels[offset + 3] < 240 || r - g <= 32 || g - b <= 8) continue;
        channels[0].push(r); channels[1].push(g); channels[2].push(b);
      }
      return channels.map((values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]);
    }
    const referenceHair = hairColor(baseline.pixels);
    // 每页六帧，对照待机、高清源图以及浅深两种背景，确认透明边缘没有彩色杂点。
    for (let group = 0; group < 5; group += 1) {
      const board = document.createElement('canvas');
      board.width = 1040; board.height = 1680;
      const context = board.getContext('2d');
      context.fillStyle = '#e7e7e7'; context.fillRect(0, 0, board.width, board.height);
      for (let row = 0; row < 6; row += 1) {
        const index = group * 6 + row;
        const source = new Image();
        source.src = MARO_HAIR_ASSETS[index];
        await source.decode();
        const frame = preview(sprites.hair[index].canvas);
        const actual = frame.pixels;
        const headOffsetY = hairNodAt(HAIR_FRAME_TIMES[index]);
        const target = { ...referenceLandmarks, top: referenceLandmarks.top + headOffsetY,
          coreY: referenceLandmarks.coreY + headOffsetY, chin: referenceLandmarks.chin + headOffsetY };
        const landmarks = spriteLandmarks(sprites.hair[index].canvas.getContext('2d').getImageData(0, 0, 1254, 1254).data, 1254, 1254);
        const bounds = spriteBounds(actual, 512, 512);
        const crown = spriteCrown(actual, 512, 512, { top: referenceBounds.top + headOffsetY });
        const hair = hairColor(actual, headOffsetY);
        const materials = materialColors(actual, headOffsetY);
        metrics.push({ ...sprites.calibration[index], frame: index + 1,
          renderWidth: sprites.hair[index].canvas.width, renderHeight: sprites.hair[index].canvas.height,
          bounds, renderedCrown: crown,
          renderedLandmarks: landmarks,
          expectedHeadOffsetPixels: headOffsetY * 1254,
          actualHeadOffsetPixels: (landmarks.chin - referenceLandmarks.chin) * 1254,
          headWidthRatio: landmarks.coreWidth / referenceLandmarks.coreWidth,
          headHeightRatio: (landmarks.chin - landmarks.top) / (referenceLandmarks.chin - referenceLandmarks.top),
          torsoHeightRatio: (landmarks.hem - landmarks.chin) / (referenceLandmarks.hem - target.chin),
          chinDistance: Math.hypot(landmarks.chin - target.chin, landmarks.chinX - target.chinX) * 1254,
          coreDistance: Math.hypot(landmarks.coreX - target.coreX, landmarks.coreY - target.coreY) * 1254,
          hemDistance: Math.abs(landmarks.hem - referenceLandmarks.hem) * 1254,
          materials, materialDeltas: Object.fromEntries(Object.entries(materials).map(([name, channels]) =>
            [name, channels.map((value, channel) => value - referenceColors[name][channel])])),
          crownDistance: Math.hypot(crown.x - referenceCrown.x, bounds.top - referenceBounds.top - headOffsetY) * 512,
          exactIdle: actual.every((value, offset) => value === baseline.pixels[offset]),
          hairColor: hair, hairDelta: hair.map((value, index) => value - referenceHair[index]),
          colors: spritePalette(actual).map((item) => item.count) });
        frames.push(frame.canvas.toDataURL('image/png').split(',')[1]);
        nativeFrames.push(sprites.hair[index].canvas.toDataURL('image/png').split(',')[1]);
        for (const [column, image] of [baseline.canvas, source, frame.canvas, frame.canvas].entries()) {
          const x = column * 260, y = row * 280 + 22;
          context.fillStyle = column === 3 ? '#25303b' : '#f7f7f7'; context.fillRect(x + 2, y, 256, 256);
          context.drawImage(image, x + 2, y, 256, 256);
          context.strokeStyle = '#467cbb55'; context.beginPath();
          context.moveTo(x + 130, y); context.lineTo(x + 130, y + 256);
          context.moveTo(x + 2, y + 249); context.lineTo(x + 258, y + 249); context.stroke();
          context.fillStyle = '#263347'; context.font = '14px sans-serif';
          context.fillText(('0' + (index + 1)).slice(-2) + ' / ' + ['IDLE', 'SOURCE 1254', 'LIGHT', 'DARK'][column], x + 8, y - 6);
        }
      }
      pages.push(board.toDataURL('image/png').split(',')[1]);
    }
    sprites.destroy();
    return { pages, frames, nativeFrames, metrics, prepareMilliseconds, referenceBounds, referenceCrown, referenceHair, referenceLandmarks, referenceColors };
  });
  await fs.mkdir(path.join(artifacts, 'frames'), { recursive: true });
  await fs.mkdir(path.join(artifacts, 'native-frames'), { recursive: true });
  for (let index = 0; index < result.pages.length; index += 1)
    await fs.writeFile(path.join(artifacts, `comparison-${index + 1}.png`), Buffer.from(result.pages[index], 'base64'));
  for (let index = 0; index < result.frames.length; index += 1)
    await fs.writeFile(path.join(artifacts, 'frames', `frame-${String(index + 1).padStart(2, '0')}.png`), Buffer.from(result.frames[index], 'base64'));
  for (let index = 0; index < result.nativeFrames.length; index += 1)
    await fs.writeFile(path.join(artifacts, 'native-frames', `frame-${String(index + 1).padStart(2, '0')}.png`), Buffer.from(result.nativeFrames[index], 'base64'));
  delete result.pages; delete result.frames; delete result.nativeFrames;
  await fs.writeFile(path.join(artifacts, 'frame-audit.json'), JSON.stringify(result, null, 2));
  assert.equal(result.metrics.length, 30);
  assert.ok(result.metrics.every((item) => [item.sourceWidth, item.sourceHeight, item.renderWidth, item.renderHeight]
    .every((size) => size === 1254)), '源图或显示画布不是 1254 像素');
  assert.ok(result.metrics[0].exactIdle && result.metrics.at(-1).exactIdle, '首尾与待机不一致');
  assert.ok(result.metrics.every((item) => item.crownDistance <= 2.5), '存在头顶偏离预定低头轨迹超过 2.5 个审阅像素的帧');
  assert.ok(result.metrics.every((item) => item.hairDelta.every((delta) => Number.isFinite(delta) && Math.abs(delta) <= 5)), '存在发色与待机明显不一致的帧');
  assert.ok(result.metrics.every((item) => Math.abs(item.headWidthRatio - 1) <= 0.008
    && Math.abs(item.headHeightRatio - 1) <= 0.004 && Math.abs(item.torsoHeightRatio - 1) <= 0.008), '存在头部或身体尺寸不稳定的帧');
  assert.ok(result.metrics.every((item) => item.chinDistance <= 3 && item.coreDistance <= 3 && item.hemDistance <= 3), '存在头部中心、下巴或身体底线跳位');
  assert.ok(result.metrics.every((item) => Object.values(item.materialDeltas).flat()
    .every((value) => Number.isFinite(value) && Math.abs(value) <= 5)), '头发、肤色、衣领或衣服存在明显色差');
  const headSteps = result.metrics.slice(1).map((item, index) =>
    Math.abs(item.actualHeadOffsetPixels - result.metrics[index].actualHeadOffsetPixels));
  assert.ok(Math.max(...headSteps) <= 5, '相邻帧低头或抬头位移过大');
  assert.ok(result.metrics[18].actualHeadOffsetPixels > 10 && headSteps[17] <= 2,
    '第十八至十九帧仍然突然抬头');
  assert.ok(result.metrics.at(-1).actualHeadOffsetPixels === 0, '动作结束后未回到待机位置');
  console.log(JSON.stringify({ frames: result.metrics.length, firstExact: result.metrics[0].exactIdle,
    lastExact: result.metrics.at(-1).exactIdle,
    maxCrownDistance: Math.max(...result.metrics.map((item) => item.crownDistance)),
    maxHairDifference: Math.max(...result.metrics.flatMap((item) => item.hairDelta.map(Math.abs))),
    maxHeadWidthDifference: Math.max(...result.metrics.map((item) => Math.abs(item.headWidthRatio - 1))),
    maxHeadHeightDifference: Math.max(...result.metrics.map((item) => Math.abs(item.headHeightRatio - 1))),
    maxAnchorDistance: Math.max(...result.metrics.flatMap((item) => [item.chinDistance, item.coreDistance, item.hemDistance])),
    maxMaterialDifference: Math.max(...result.metrics.flatMap((item) => Object.values(item.materialDeltas).flat().map(Math.abs))),
    maxNodPixels: Math.max(...result.metrics.map((item) => item.actualHeadOffsetPixels)),
    largestHeadStepPixels: Math.max(...headSteps), frame18To19HeadStepPixels: headSteps[17] }));
} finally {
  await application?.close().catch(() => {});
  await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
