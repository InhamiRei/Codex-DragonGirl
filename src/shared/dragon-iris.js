// 用一小段柔和过渡保留原画高光和眼线的抗锯齿。
function fade(value) {
  const amount = Math.max(0, Math.min(1, value));
  return amount * amount * (3 - 2 * amount);
}

// 只重绘坐标范围内的紫色虹膜，保留亮度、透明度与原始明暗层次。
export function tintIris(data, width, left, top, iris, tone) {
  if (tone === null) return;
  const custom = [1, 3, 5].map((offset) => Number.parseInt(tone.slice(offset, offset + 2), 16));
  for (let index = 0; index < data.length; index += 4) {
    if (!data[index + 3]) continue;
    const r = data[index], g = data[index + 1], b = data[index + 2];
    if (b - r <= 8 || r - g <= 2 || b <= 55) continue;
    const x = left + (index / 4) % width;
    const y = top + Math.floor(index / 4 / width);
    const edge = Math.hypot((x - iris.cx) / (iris.rx + 16), (y - iris.cy) / (iris.ry + 15));
    const weight = fade((1.12 - edge) / 0.19) * fade((b - r - 8) / 16) * fade((r - g - 2) / 9);
    // 自选色以虹膜中间调为基准；高光、眼线和泪光仍保留原画。
    const brightness = r * 0.21 + g * 0.72 + b * 0.07;
    for (let channel = 0; channel < 3; channel += 1) {
      const original = data[index + channel];
      const reference = custom[channel];
      const shade = brightness < 145 ? reference * brightness / 145
        : reference + (255 - reference) * (brightness - 145) / 110;
      data[index + channel] = original + (shade - original) * weight;
    }
  }
}
