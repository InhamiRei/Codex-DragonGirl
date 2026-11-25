import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { MARO_OUTFITS, MARO_OUTFIT_OFFSETS } from '../src/shared/maro-outfits.js';

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
    const { MARO_OUTFITS } = await import('dragon://app/src/shared/maro-outfits.js');
    const { loadMaroOutfitLayer, paintMaroOutfitLayer } = await import('dragon://app/src/renderer/maro-outfit.js');
    const sprites = new CharacterSprites(document.createElement('div'), new Image(), () => {});
    const prepareStart = performance.now();
    await sprites.prepare();
    await sprites.prepareHair();
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
    // 发束边缘的深色线稿靠颜色邻域识别，单独检查靠衣领和手臂的轮廓。
    function nearHairFill(pixels, width, x, y, foreground) {
      for (let row = Math.max(0, y - 5); row <= Math.min(width - 1, y + 5); row += 1) {
        for (let column = Math.max(0, x - 5); column <= Math.min(width - 1, x + 5); column += 1) {
          const pixel = row * width + column;
          if (foreground?.[pixel] === 2) continue;
          const offset = pixel * 4;
          const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
          if (pixels[offset + 3] > 24 && r >= 170 && r - g >= 30 && g - b >= 13) return true;
        }
      }
      return false;
    }
    // 连通区域用于区分手掌、脸颊和原校服织线，颈部单独标记以检查新领口的遮挡。
    function connectedForeground(pixels, size) {
      const candidates = new Uint8Array(size * size);
      const foreground = new Uint8Array(candidates.length);
      const component = new Int32Array(candidates.length);
      const neckAnchor = 884 * size + 589;
      const faceAnchor = 752 * size + 586;
      for (let point = 0; point < candidates.length; point += 1) {
        const offset = point * 4;
        const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
        candidates[point] = pixels[offset + 3] > 24 && r > 167 && r - g >= 18 && g - b >= 6;
      }
      for (let start = 0; start < candidates.length; start += 1) {
        if (!candidates[start]) continue;
        component[0] = start;
        candidates[start] = 0;
        let count = 1;
        for (let index = 0; index < count; index += 1) {
          const point = component[index];
          const x = point % size, y = Math.floor(point / size);
          for (let row = Math.max(0, y - 1); row <= Math.min(size - 1, y + 1); row += 1) {
            for (let column = Math.max(0, x - 1); column <= Math.min(size - 1, x + 1); column += 1) {
              const neighbor = row * size + column;
              if (!candidates[neighbor]) continue;
              candidates[neighbor] = 0;
              component[count++] = neighbor;
            }
          }
        }
        if (count < 300) continue;
        const points = component.subarray(0, count);
        const label = points.includes(neckAnchor) ? 2 : points.includes(faceAnchor) ? 3 : 1;
        for (let index = 0; index < count; index += 1) foreground[component[index]] = label;
      }
      return foreground;
    }
    // 取原脸颊最低点，给下颌的抗锯齿描边留出余量。
    function chinRows(foreground, size) {
      const chin = new Uint16Array(size);
      for (let y = 790; y < 868; y += 1) for (let x = 495; x <= 704; x += 1) {
        if (foreground[y * size + x] === 3) chin[x] = y;
      }
      return chin;
    }
    // 旧水手领墨线同时贴着绿领和原颈，只对下颌下方的两小段领缝放行。
    function oldCollarInk(pixels, foreground, chin, size, x, y) {
      const atCollarSide = (x >= 502 && x <= 556) || (x >= 642 && x <= 698);
      if (!atCollarSide || y < 811 || y > 937) return false;
      const jaw = Math.max(...chin.subarray(x - 2, x + 3));
      if (!jaw || y <= jaw + 5) return false;
      let neck = false, green = false;
      for (let row = y - 8; row <= y + 8; row += 1) for (let column = x - 8; column <= x + 8; column += 1) {
        const point = row * size + column;
        const offset = point * 4;
        if (Math.abs(row - y) <= 7 && Math.abs(column - x) <= 7 && foreground[point] === 2) neck = true;
        const g = pixels[offset + 1];
        if (pixels[offset + 3] > 24 && g >= pixels[offset] + 2 && g >= pixels[offset + 2] + 4) green = true;
      }
      return neck && green;
    }
    // 用同一生产合成器逐像素检查衣料以外的画面、眼口与原透明轮廓。
    async function auditOutfits() {
      const size = sprites.stills.idle.canvas.width;
      // 在发梢外侧记录原生像素，防止旧衬衫从这些位置漏出。
      const shoulders = [[318, 954], [804, 930], [823, 963], [835, 931]];
      const edgeSamples = {
        'cardigan-redraw': [165, shoulders],
        'bun-hoodie-redraw': [205, shoulders],
      };
      // 验证卫衣右侧领线和帽片的接合处仍然连续。
      const seamSamples = {
        'bun-hoodie-redraw': [
          [638, 872, 0, 125], [650, 864, 0, 125], [666, 852, 0, 125], [676, 845, 0, 125],
          [680, 816, 0, 145], [679, 821, 0, 145],
        ],
      };
      // 待机右侧下颌过去有帽片颜色越过描线，直接对照原画像素。
      const jawSamples = [[685, 803], [687, 804]];
      const surface = new OffscreenCanvas(size, size);
      const context = surface.getContext('2d', { willReadFrequently: true });
      const matte = new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true });
      const uniqueFrames = [...Object.values(sprites.stills), ...sprites.hair.slice(1, -1)];
      const results = [];
      for (const frame of uniqueFrames) {
        context.clearRect(0, 0, size, size);
        context.drawImage(frame.canvas, 0, 0);
        const before = context.getImageData(0, 0, size, size).data;
        const foreground = connectedForeground(before, size);
        const chin = chinRows(foreground, size);
        for (const outfit of MARO_OUTFITS.slice(1)) {
          const hasHood = outfit.id === 'bun-hoodie-redraw';
          const layer = await loadMaroOutfitLayer(outfit, frame.pose);
          context.clearRect(0, 0, size, size);
          context.drawImage(frame.canvas, 0, 0);
          paintMaroOutfitLayer(context, layer);
          matte.clearRect(0, 0, size, size);
          matte.drawImage(layer.image, layer.x, layer.y);
          const patch = matte.getImageData(0, 0, size, size).data;
          const after = context.getImageData(0, 0, size, size).data;
          const changes = { clothing: 0, outside: 0, head: 0, hair: 0, hairOutline: 0, skin: 0, alpha: 0 };
          if (hasHood && frame.pose === 'idle') {
            for (const [x, y] of jawSamples) {
              const offset = (y * size + x) * 4;
              if (after.subarray(offset, offset + 4).some((channel, index) => channel !== before[offset + index]))
                changes.head += 1;
            }
          }
          const [limit, samples] = edgeSamples[outfit.id] ?? [0, []];
          const edgePinholes = frame.pose === 'idle'
            ? samples.filter(([x, y]) => after[(y * size + x) * 4 + 1] >= limit).length : 0;
          const seamDefects = frame.pose === 'idle' ? (seamSamples[outfit.id] ?? []).filter(([x, y, low, high]) => {
            const red = after[(y * size + x) * 4];
            return red < low || red > high;
          }).length : 0;
          for (let pixel = 0; pixel < size * size; pixel += 1) {
            const offset = pixel * 4;
            if (after[offset + 3] !== before[offset + 3]) changes.alpha += 1;
            const r = before[offset], g = before[offset + 1], b = before[offset + 2];
            if (after[offset] === r && after[offset + 1] === g && after[offset + 2] === b) continue;
            const x = pixel % size, y = Math.floor(pixel / size);
            if (patch[offset + 3] === 0) changes.outside += 1;
            else changes.clothing += 1;
            // 抬起的袖口在两侧，中央头发、刘海、眼睛、脸颊和创可贴一直来自原帧。
            const chinShadow = x >= 546 && x <= 632 && y >= 813 && y <= 868 && r < 153;
            if ((y < 803 && x >= 329 && x <= 790) || foreground[pixel] === 3 || chinShadow) changes.head += 1;
            // 仅允许当前颈部连通区被新衣遮挡，抬到领口的手仍逐像素检查。
            // 右后帽片高于主领口，覆盖范围需要位于原下颌以下。
            const hoodJoin = hasHood && x >= 672 && x <= 703 && y >= 803 && y <= 854
              && chin[x] > 0 && y > Math.max(...chin.subarray(x - 2, x + 3)) + 4;
            const neckArea = hoodJoin || (hasHood && y >= 839 && y <= 1041 && x >= 495 && x <= 702);
            const newNeckline = neckArea && foreground[pixel] === 2;
            if (!newNeckline && before[offset + 3] > 24 && r > 175 && r - g > 34 && g - b > 10)
              changes.hair += 1;
            if (before[offset + 3] > 24 && r < 157 && r - g > 12 && g - b > 7
              && nearHairFill(before, size, x, y, neckArea ? foreground : null)
              && !(hasHood && oldCollarInk(before, foreground, chin, size, x, y)))
              changes.hairOutline += 1;
            if (!newNeckline && foreground[pixel] && r > 218 && r - g >= 18 && g - b >= 8)
              changes.skin += 1;
          }
          results.push({ outfit: outfit.id, pose: frame.pose, ...changes, edgePinholes, seamDefects });
        }
      }
      return results;
    }
    const outfits = await auditOutfits();
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
    return { pages, frames, nativeFrames, metrics, outfits, prepareMilliseconds, referenceBounds, referenceCrown,
      referenceHair, referenceLandmarks, referenceColors };
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
  assert.equal(result.outfits.length, (MARO_OUTFITS.length - 1) * Object.keys(MARO_OUTFIT_OFFSETS).length);
  for (const { outfit, pose, clothing, outside, head, hair, hairOutline, skin, alpha, edgePinholes, seamDefects } of result.outfits) {
    const label = outfit + ' / ' + pose;
    assert.ok(clothing > 80000, label + ' 缺少完整衣料');
    assert.deepEqual({ outside, head, hair, hairOutline, skin, alpha },
      { outside: 0, head: 0, hair: 0, hairOutline: 0, skin: 0, alpha: 0 }, label);
    assert.equal(edgePinholes, 0, label + ' 衣料边缘露出原校服的米白衣料');
    assert.equal(seamDefects, 0, label + ' 领线、袖口或手腕的交界仍有残线');
  }
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
  console.log(JSON.stringify({ frames: result.metrics.length, outfitLayers: result.outfits.length, firstExact: result.metrics[0].exactIdle,
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
