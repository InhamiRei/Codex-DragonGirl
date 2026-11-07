// 区分衣领、眼睛、线稿、头发、肤色和浅色衣料，避免整幅滤镜把蓝眼与绿色衣领一起染色。
export function spriteColorGroup(r, g, b) {
  if (g > r + 2 && g > b + 3) return 0;
  if (b > r + 8 && b >= g - 4) return 1;
  if (Math.max(r, g, b) < 170) return 2;
  if (r - g > 32 && g - b > 8) return 3;
  if (r > 185 && r - g > 12) return 4;
  return 5;
}

// 只用主体内部的实色统计色板，半透明边缘与残留底色不能改变整帧配色。
export function spritePalette(pixels) {
  const groups = Array.from({ length: 6 }, () => ({ count: 0,
    channels: Array.from({ length: 3 }, () => new Uint32Array(256)) }));
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] < 240) continue;
    const group = groups[spriteColorGroup(pixels[offset], pixels[offset + 1], pixels[offset + 2])];
    group.count += 1;
    for (let channel = 0; channel < 3; channel += 1) group.channels[channel][pixels[offset + channel]] += 1;
  }
  return groups;
}

// 从实色统计中取中位数，只校正色调中心，避免直方图逐档匹配产生斑块和断裂高光。
function paletteMedian(histogram, count) {
  let sum = 0;
  for (let value = 0; value < 256; value += 1) {
    sum += histogram[value];
    if (sum >= count / 2) return value;
  }
  return 255;
}

// 使用连续、单调的柔和色阶变换，保留线稿和原画阴影的明暗关系。
function paletteChannel(source, target, sourceCount, targetCount, gain) {
  const lookup = new Float32Array(256);
  const center = paletteMedian(source, sourceCount);
  const destination = paletteMedian(target, targetCount);
  for (let value = 0; value < 256; value += 1) {
    lookup[value] = Math.max(0, Math.min(255, destination + (value - center) * gain));
  }
  return lookup;
}

// 各帧对照同一张待机原画；没有露出的眼睛等小色组使用首帧色板，不放大少数噪点。
export function spriteColorLookup(source, target, fallback = source) {
  return source.map((group, index) => {
    const from = group.count >= 12 ? group : fallback[index];
    const to = target[index];
    if (from.count < 12 || to.count < 12) return null;
    // 高清重生素材只校正中心色值，保留原画的渐变对比度，不做降噪或模糊。
    return from.channels.map((channel, component) => paletteChannel(channel, to.channels[component], from.count, to.count, 1));
  });
}

// 色组之间平滑过渡，抗锯齿、脸颊红晕和头发高光不会在分类边界突然换色。
function smoothColor(value, low, high) {
  const amount = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return amount * amount * (3 - 2 * amount);
}

// 修正运行时画布的色阶并清理不可见杂点，原始 GPT 素材保持不变，透明区域不参与染色。
export function applySpritePalette(pixels, lookup) {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] <= 24) {
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = pixels[offset + 3] = 0;
      continue;
    }
    const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
    const green = smoothColor(g - r, 0, 10) * smoothColor(g - b, 1, 12);
    const blue = smoothColor(b - r, 4, 20) * smoothColor(b - g, -8, 5);
    let remaining = Math.max(0, 1 - green - blue);
    const hair = remaining * smoothColor(r - g, 24, 50) * smoothColor(g - b, 5, 16) * smoothColor(r, 150, 210);
    remaining -= hair;
    const ink = remaining * (1 - smoothColor(Math.max(r, g, b), 110, 185));
    remaining -= ink;
    const skin = remaining * smoothColor(r - g, 7, 20) * smoothColor(r, 175, 220);
    const weights = [green, blue, ink, hair, skin, remaining - skin];
    for (let channel = 0; channel < 3; channel += 1) {
      const original = pixels[offset + channel];
      let adjusted = 0;
      for (let group = 0; group < weights.length; group += 1)
        adjusted += weights[group] * (lookup[group]?.[channel][original] ?? original);
      pixels[offset + channel] = adjusted;
    }
  }
}

// 测量主体的真实边界，忽略透明外框，替代原来的固定放大 1.1 倍和拍定偏移。
export function spriteBounds(pixels, width, height) {
  let left = width, right = 0, top = height, bottom = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (pixels[(y * width + x) * 4 + 3] <= 200) continue;
    left = Math.min(left, x); right = Math.max(right, x + 1);
    top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
  }
  if (right <= left || bottom <= top) throw new Error('角色帧中没有可见主体');
  return { left: left / width, top: top / height, width: (right - left) / width, height: (bottom - top) / height };
}

// 头顶上方区域不受抬手影响，使用透明轮廓重心定位，颜色校准不会反过来改变锚点。
export function spriteCrown(pixels, width, height, band) {
  let sumX = 0, sumY = 0, count = 0;
  const first = Math.max(0, Math.floor(band.top * height));
  const last = Math.min(height, Math.ceil((band.top + (band.height ?? 0.13)) * height));
  for (let y = first; y < last; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    if (pixels[offset + 3] <= 200) continue;
    sumX += x + 0.5; sumY += y + 0.5; count += 1;
  }
  if (!count) throw new Error('角色帧缺少可校准的头顶区域');
  return { x: sumX / count / width, y: sumY / count / height, top: band.top };
}

// 从脸部主连通区域测量下巴，手掌、眼睛、领口和后发不能参与头部尺寸计算。
export function spriteLandmarks(pixels, width, height) {
  const bounds = spriteBounds(pixels, width, height);
  const crown = spriteCrown(pixels, width, height, { top: bounds.top });
  const left = Math.floor(width * 0.20), right = Math.ceil(width * 0.73);
  const top = Math.floor(height * 0.44), bottom = Math.ceil(height * 0.73);
  const columns = right - left, rows = bottom - top;
  const skin = new Uint8Array(columns * rows);
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const offset = (y * width + x) * 4;
    const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
    if (pixels[offset + 3] > 240 && r > 215 && g > 183 && b > 165 && r - g < 44 && g - b < 36)
      skin[(y - top) * columns + x - left] = 1;
  }
  const queue = new Uint32Array(skin.length);
  let largest = [];
  // 用四邻域分离手和脸，不依赖各姿势不同的整体包围框。
  for (let seed = 0; seed < skin.length; seed += 1) {
    if (skin[seed] !== 1) continue;
    let head = 0, tail = 1;
    queue[0] = seed; skin[seed] = 2;
    while (head < tail) {
      const cell = queue[head++];
      const x = cell % columns, y = Math.floor(cell / columns);
      for (const neighbor of [x > 0 ? cell - 1 : -1, x + 1 < columns ? cell + 1 : -1,
        y > 0 ? cell - columns : -1, y + 1 < rows ? cell + columns : -1]) {
        if (neighbor < 0 || skin[neighbor] !== 1) continue;
        skin[neighbor] = 2; queue[tail++] = neighbor;
      }
    }
    if (tail > largest.length) largest = queue.slice(0, tail);
  }
  if (largest.length < width * height * 0.015) throw new Error('无法可靠识别麻吕的脸部区域');
  let chinY = 0;
  for (const cell of largest) {
    const x = left + cell % columns, y = top + Math.floor(cell / columns);
    if (x > width * 0.40 && x < width * 0.53) chinY = Math.max(chinY, y);
  }
  const chinXs = [];
  for (const cell of largest) {
    const x = left + cell % columns, y = top + Math.floor(cell / columns);
    if (x > width * 0.40 && x < width * 0.53 && y >= chinY - height / 512) chinXs.push(x + 0.5);
  }
  if (!chinXs.length) throw new Error('无法可靠识别麻吕的下巴锚点');
  chinXs.sort((a, b) => a - b);
  // 头部上缘下方四分之一处没有手掌，取多行轮廓中位数，忽略会摆动的翘发尖。
  const chin = (chinY + 0.5) / height;
  const coreY = bounds.top + (chin - bounds.top) * 0.25;
  const starts = [], ends = [];
  for (let y = Math.floor(coreY * height) - 2; y <= Math.floor(coreY * height) + 2; y += 1) {
    let start = width, end = 0;
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] <= 200) continue;
      start = Math.min(start, x); end = Math.max(end, x + 1);
    }
    starts.push(start); ends.push(end);
  }
  starts.sort((a, b) => a - b); ends.sort((a, b) => a - b);
  // 身体中央下摆固定在同一基准，双拳之间的透明缝隙不影响量测。
  const hems = [];
  for (let x = Math.floor(width * 0.30); x < Math.ceil(width * 0.70); x += 1) {
    for (let y = height - 1; y >= 0; y -= 1) {
      if (pixels[(y * width + x) * 4 + 3] <= 200) continue;
      hems.push((y + 1) / height); break;
    }
  }
  hems.sort((a, b) => a - b);
  return { top: bounds.top, crownX: crown.x, coreY,
    coreX: (starts[2] + ends[2]) / 2 / width, coreWidth: (ends[2] - starts[2]) / width,
    chin, chinX: chinXs[Math.floor(chinXs.length / 2)] / width,
    hem: hems[Math.floor((hems.length - 1) * 0.95)] };
}

// 头部作为同尺寸整体沿指定轨迹轻轻低下，领口衔接动作，身体下部和下摆保持固定。
export function spriteRegistration(reference, source, { headOffsetY = 0 } = {}) {
  const scale = reference.coreWidth / source.coreWidth;
  if (Math.abs(scale - 1) > 0.08 || Math.abs(reference.chin - source.chin) > 0.05)
    throw new Error('动作帧偏离角色比例过大，需要重新生图');
  const neckFraction = 0.4;
  const chinX = reference.chinX - source.chinX * scale;
  return [
    { from: 0, to: 0, scale: 1, x: reference.crownX - source.crownX },
    { from: source.top, to: reference.top + headOffsetY, scale: 1, x: reference.crownX - source.crownX },
    { from: source.coreY, to: reference.coreY + headOffsetY, scale, x: reference.coreX - source.coreX * scale },
    { from: source.chin, to: reference.chin + headOffsetY, scale, x: chinX },
    // 低头位移在领口范围内平滑归零，不能把整件衣服和身体底线一起拖下去。
    { from: source.chin + (source.hem - source.chin) * neckFraction,
      to: reference.chin + (reference.hem - reference.chin) * neckFraction,
      scale: scale + (1 - scale) * neckFraction, x: chinX * (1 - neckFraction) },
    { from: source.hem, to: reference.hem, scale: 1, x: 0 },
    { from: 1, to: 1, scale: 1, x: 0 },
  ];
}

// 以目标行反查原图坐标，所有接缝连续，显示仍使用原生高清像素。
export function registeredSpriteRow(rows, y) {
  let index = 1;
  while (index < rows.length - 1 && y > rows[index].to) index += 1;
  const a = rows[index - 1], b = rows[index];
  const amount = (y - a.to) / (b.to - a.to);
  return { sourceY: a.from + (b.from - a.from) * amount,
    sourceHeight: (b.from - a.from) / (b.to - a.to),
    scale: a.scale + (b.scale - a.scale) * amount, x: a.x + (b.x - a.x) * amount };
}
