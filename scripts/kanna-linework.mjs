import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// 固定鼠标方向，逐个显示帧比较两眼。半闭的标尺是同一眼神上盖一层真实眼皮。
export async function verifyKannaBlinkGaze(page, artwork, direction) {
  const result = await page.evaluate(async (art) => {
    const { loadPortraitFrames } = await import('dragon://app/src/renderer/portrait-frames.js');
    const frames = await loadPortraitFrames(art, ['half', 'closed']);
    const character = document.getElementById('character'), image = document.getElementById('portrait');
    const pupils = [...character.querySelectorAll('.kanna-eye-layer')], lids = character.querySelector('.kanna-face');
    if (!lids || !lids.hidden || pupils.length !== 2 || pupils.some(layer => layer.hidden))
      throw new Error('眨眼取样前两眼没有稳定看向鼠标');

    // 同一方向和正中之间的像素差作为标尺，避免半闭时虹膜露出面积变小导致误报。
    function distance(a, b) {
      let difference = 0;
      for (let i = 0; i < a.length; i++) difference += Math.abs(a[i] - b[i]);
      return difference;
    }
    const probes = art.eyes.map((eye, i) => {
      const pupil = pupils[i], canvas = document.createElement('canvas');
      canvas.width = Math.ceil(eye.width / 2);
      canvas.height = Math.ceil(eye.height / 2);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const sx = canvas.width / eye.width, sy = canvas.height / eye.height;
      ctx.setTransform(sx, 0, 0, sy, -eye.x * sx, -eye.y * sy);
      // 合成实际画布，并遵守 CSS 层级和同层的 DOM 顺序，覆盖缩放后重建眼区的情况。
      function draw(layers) {
        ctx.clearRect(eye.x, eye.y, eye.width, eye.height);
        ctx.drawImage(image, 0, 0);
        for (const layer of layers) {
          const rect = layer === pupil ? eye : art.face;
          ctx.drawImage(layer, rect.x, rect.y, rect.width, rect.height);
        }
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      }
      const order = [...character.children].filter(layer => layer === pupil || layer === lids)
        .sort((a, b) => (parseInt(getComputedStyle(a).zIndex) || 0) - (parseInt(getComputedStyle(b).zIndex) || 0));
      const open = draw([pupil]), half = draw([pupil, frames.get('half')]), closed = draw([frames.get('closed')]);
      const contrast = { open: distance(open, draw([])), half: distance(half, draw([frames.get('half')])) };
      if (Math.min(contrast.open, contrast.half) < 1000) throw new Error('偏向鼠标的虹膜与正中区分不足');
      return { sample: () => draw(order.filter(layer => !layer.hidden)), expected: { open, half, closed }, contrast };
    });

    const phases = [], start = performance.now();
    let drift = 0, reopened;
    while (performance.now() - start < 10500) {
      const time = await new Promise(requestAnimationFrame);
      const phase = character.dataset.kannaFrame || 'open';
      if (phases.at(-1) !== phase) phases.push(phase);
      for (const [index, probe] of probes.entries()) {
        const expected = probe.expected[phase], error = distance(probe.sample(), expected);
        if (phase === 'closed') {
          if (error / expected.length > 0.35) throw new Error('康娜闭眼时视线透出了眼皮');
        } else {
          const shift = error / probe.contrast[phase];
          if (shift > 0.2) throw new Error('康娜眨眼时视线跳动，阶段 ' + phase + '，眼 ' + (index + 1) + '，相对偏差 ' + shift.toFixed(2));
          drift = Math.max(drift, shift);
        }
      }
      if (phase === 'open' && phases.includes('closed')) reopened ??= time;
      if (reopened && time - reopened >= 100) return { phases, drift };
    }
    throw new Error('没有采到完整的侧视眨眼');
  }, artwork);
  assert.deepEqual(result.phases, ['open', 'half', 'closed', 'half', 'open']);
  console.log('康娜' + direction + '侧视眨眼逐帧通过，最大相对偏差 ' + result.drift.toFixed(3));
}

// 在真实眨眼和动作发生时截取正在显示的五官层，并记录它在底图上的位置。
export function watchKannaLinework(page, artwork) {
  return page.evaluateHandle((art) => {
    const character = document.getElementById('character');
    const captures = new Map();
    const observer = new MutationObserver(() => {
      const name = character.dataset.kannaFrame;
      const layer = character.querySelector('canvas.kanna-face');
      if (!name || captures.has(name) || !layer || layer.hidden) return;
      const pixels = layer.getContext('2d').getImageData(0, 0, layer.width, layer.height);
      const root = getComputedStyle(character), style = getComputedStyle(layer);
      const sx = art.width / parseFloat(root.width), sy = art.height / parseFloat(root.height);
      captures.set(name, { pixels, rect: [
        parseFloat(style.left) * sx, parseFloat(style.top) * sy,
        parseFloat(style.width) * sx, parseFloat(style.height) * sy,
      ] });
      if (captures.size === 4) observer.disconnect();
    });
    observer.observe(character, { attributes: true, attributeFilter: ['data-kanna-frame'] });
    return captures;
  }, artwork);
}

// 把实际显示过的图层放回 A 稿坐标，逐像素比较并量测两眼的笔宽。
export async function verifyKannaLinework(captures, artifacts) {
  const { report, pngs } = await captures.evaluate(async (frames) => {
    const { KANNA_PORTRAIT: art } = await import('dragon://app/src/renderer/portrait-artwork.js');
    const image = document.getElementById('portrait');
    const canvas = document.createElement('canvas');
    canvas.width = art.width;
    canvas.height = art.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    // 所有状态从同一次底图取样恢复，避免重复解码或 GPU 回读带来的低透明度舍入差。
    const master = ctx.getImageData(0, 0, art.width, art.height);
    ctx.putImageData(master, 0, 0);
    const base = ctx.getImageData(0, 0, art.width, art.height).data;
    const basePixels = new Uint32Array(base.buffer);
    // 待机的嘴部应与邻近肤色连续，下面对所有表情的逐像素检查也会锁住这块皮肤。
    for (let y = 850; y <= 870; y++) {
      for (let x = 562; x <= 583; x++) {
        const here = (y * art.width + x) * 4, nearby = here + 24 * 4;
        if (base[here + 3] < 245 || [0, 1, 2].some((k) => Math.abs(base[here + k] - base[nearby + k]) > 12)) {
          throw new Error('康娜待机的嘴部仍有笔迹或透明空洞');
        }
      }
    }
    const stamp = new OffscreenCanvas(art.face.width, art.face.height);
    const stampContext = stamp.getContext('2d', { willReadFrequently: true });

    // 每种表情只允许改动对应五官，完成的亮眼和腮红、失败的眉眼和泪珠都绕开嘴部。
    const eyes = [[297, 570, 568, 782], [650, 594, 944, 816]];
    const allowed = {
      half: eyes, closed: eyes,
      happy: [[372, 626, 524, 762], [696, 648, 862, 800], [330, 762, 455, 826], [725, 802, 856, 863]],
      sad: [...eyes, [368, 464, 546, 566], [701, 474, 882, 606]],
    };
    const probes = {
      happy: [[370, 622], [425, 617], [490, 621], [735, 645], [775, 650], [842, 664]],
      closed: [[380, 710], [433, 720], [497, 716], [716, 748], [755, 761], [822, 769]],
    };
    // 两个状态使用同一底色、原点、缩放和画布尺寸，便于直接比较外轮廓。
    const sheet = document.createElement('canvas');
    sheet.width = 640;
    sheet.height = 348;
    const preview = sheet.getContext('2d');
    preview.fillStyle = '#f5f3f6';
    preview.fillRect(0, 0, sheet.width, sheet.height);
    preview.fillStyle = '#493b50';
    preview.font = '16px sans-serif';

    // 原图深紫描线的色域排除蓝瞳、眼白和肤色。
    function isInk(rgba, offset) {
      const r = rgba[offset], g = rgba[offset + 1], b = rgba[offset + 2];
      return rgba[offset + 3] > 150 && r < 125 && g < 93 && b < 120 && r - g > 7 && b - r < 24;
    }

    // 先找贯穿取样点的连续墨线，再按两侧中点估计切线，得到垂直于弯曲睫毛的宽度。
    function penWidth(rgba, x, y) {
      // 只量与取样点连通的墨色，排除附近的眉毛、刘海和虹膜外圈。
      function section(column) {
        const dark = (row) => isInk(rgba, (row * art.width + column) * 4);
        if (!dark(y)) throw new Error(`睫毛没有经过取样点 (${column}, ${y})`);
        let top = y, bottom = y;
        while (dark(top - 1)) top--;
        while (dark(bottom + 1)) bottom++;
        return { middle: (top + bottom) / 2, width: bottom - top + 1 };
      }
      const slope = (section(x + 3).middle - section(x - 3).middle) / 6;
      return section(x).width / Math.hypot(1, slope);
    }

    const counts = {};
    const widths = {};
    const pngs = {};
    let changedOutsideFeatures = 0, changedCheekInk = 0, changedSilhouette = 0;
    let firstMismatch;
    const placement = [art.face.x, art.face.y, art.face.width, art.face.height];
    for (const name of Object.keys(allowed)) {
      const capture = frames.get(name);
      if (!capture) throw new Error('桌宠没有实际显示 ' + name);
      // CSS 布局取整误差小于四分之一个原图像素，表情不能独立缩放或重新居中。
      if (capture.rect.some((value, i) => !Number.isFinite(value) || Math.abs(value - placement[i]) > 0.25))
        throw new Error(name + ' 的五官层位置或尺寸有偏差：' + capture.rect);
      if (capture.pixels.width !== art.face.width || capture.pixels.height !== art.face.height)
        throw new Error(name + ' 的五官画布发生缩放');
      stampContext.putImageData(capture.pixels, 0, 0);
      ctx.putImageData(master, 0, 0);
      ctx.drawImage(stamp, art.face.x, art.face.y);
      const rgba = ctx.getImageData(0, 0, art.width, art.height).data;
      const pixels = new Uint32Array(rgba.buffer);
      let changed = 0;
      for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] === basePixels[i]) continue;
        const x = i % art.width, y = Math.floor(i / art.width), offset = i * 4;
        const inside = allowed[name].some(([l, t, r, b]) => x >= l && x <= r && y >= t && y <= b);
        // 两侧遮住眼角的脸线即使落在眼区框内，也必须与母版逐像素相同。
        const cheekInk = ((x < 329 && y >= 660 && y <= 835) || (x > 905 && y >= 740 && y <= 920))
          && isInk(base, offset);
        const silhouette = (base[offset + 3] > 24) !== (rgba[offset + 3] > 24);
        if (!inside) changedOutsideFeatures++;
        if (cheekInk) changedCheekInk++;
        if (silhouette) changedSilhouette++;
        if (!inside || cheekInk || silhouette) firstMismatch ??= { name, x, y };
        changed++;
      }
      if (!changed) throw new Error(name + ' 没有显示五官变化');
      counts[name] = changed;
      if (probes[name]) {
        widths[name] = probes[name].map(([x, y]) => penWidth(rgba, x, y));
        pngs[name === 'happy' ? 'success' : 'blink-closed'] = canvas.toDataURL('image/png').split(',')[1];
        const x = name === 'happy' ? 16 : 328;
        const bitmap = await createImageBitmap(ctx.getImageData(0, 0, art.width, art.height),
          { resizeWidth: 296, resizeHeight: 296, resizeQuality: 'high' });
        preview.fillText(name === 'happy' ? '惊讶' : '闭眼', x + 4, 25);
        preview.drawImage(bitmap, x, 43);
        bitmap.close();
      }
    }
    const maxDifference = Math.max(...widths.happy.map((v, i) => Math.abs(v - widths.closed[i])));
    pngs.comparison = sheet.toDataURL('image/png').split(',')[1];
    return { report: { size: [art.width, art.height], counts, widths, maxDifference,
      changedOutsideFeatures, changedCheekInk, changedSilhouette, firstMismatch }, pngs };
  });
  await captures.dispose();
  assert.equal(report.changedOutsideFeatures + report.changedCheekInk + report.changedSilhouette, 0,
    '表情改动了固定线稿或无口区域：' + JSON.stringify(report.firstMismatch));
  assert.ok(report.maxDifference <= 1.5, '惊讶与闭眼的笔宽差过大：' + JSON.stringify(report.widths));
  // 导出的透明整图和报告均来自刚验收的桌宠渲染层。
  const directory = path.join(artifacts, 'linework');
  await fs.mkdir(directory, { recursive: true });
  for (const [name, png] of Object.entries(pngs))
    await fs.writeFile(path.join(directory, name + '.png'), Buffer.from(png, 'base64'));
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`康娜固定线稿逐像素一致，六处睫毛法向宽度最大相差 ${report.maxDifference.toFixed(2)} 原图像素。`);
}
