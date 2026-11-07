// 麻吕的眼区单独按 1254 原图标定，斜眼睑、蓝色虹膜和刘海遮挡不复用龙娘坐标。
export const MARO_EYE_ARTWORK = Object.freeze({
  width: 1254, height: 1254,
  center: { x: 557, y: 620 },
  travel: { x: 6, y: 3 },
  eyes: [
    { x: 285, y: 515, width: 270, height: 220, fixedTop: 552, fixedBottom: 695,
      aperture: [[338, 627], [359, 620], [403, 607], [443, 600], [481, 596],
        [497, 610], [494, 642], [479, 657], [449, 664], [409, 668], [376, 666], [352, 659], [340, 644]],
      blink: { cx: 430, cy: 618, rx: 100, ry: 62, lidX: 430, lidY: 582,
        slope: -0.20, curve: 0.0008, thickness: 25 },
      outline: [[326, 604], [354, 589], [402, 574], [464, 562], [493, 570],
        [506, 593], [501, 635], [479, 666], [441, 682], [397, 684], [355, 676], [334, 659]] },
    { x: 575, y: 505, width: 275, height: 225, fixedTop: 544, fixedBottom: 692,
      aperture: [[621, 597], [650, 594], [690, 595], [729, 600], [766, 608],
        [774, 620], [766, 645], [748, 659], [715, 666], [677, 666], [647, 660], [627, 643], [619, 617]],
      blink: { cx: 690, cy: 615, rx: 102, ry: 62, lidX: 690, lidY: 574,
        slope: 0.10, curve: 0.0007, thickness: 25 },
      outline: [[615, 566], [651, 554], [700, 555], [751, 569], [798, 588],
        [808, 603], [779, 616], [770, 650], [749, 670], [700, 682], [658, 678], [630, 660], [615, 621]] },
  ],
});

// 视线只在眼白内部移动虹膜，眼睑、眼眶和脸部边界的位移严格为零。
export function maroGazeWeight(x, y, eye) {
  let inside = false, distanceSquared = Infinity;
  const outline = eye.aperture;
  for (let index = 0, previous = outline.length - 1; index < outline.length; previous = index++) {
    const [ax, ay] = outline[previous], [bx, by] = outline[index];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    const dx = bx - ax, dy = by - ay;
    const amount = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    distanceSquared = Math.min(distanceSquared, (x - ax - amount * dx) ** 2 + (y - ay - amount * dy) ** 2);
  }
  if (!inside) return 0;
  // 在眼白内部留出固定边缘，位移在接近轮廓之前已经收敛到零。
  const amount = Math.max(0, Math.min(1, (Math.sqrt(distanceSquared) - 2) / 12));
  return amount * amount * (3 - 2 * amount);
}

// 固定轮廓生成连续权重，保留虹膜和高光的完整纹理，眼睑周围提前平滑收回位移。
export function maroGazeMask(_source, width, height, eye) {
  const weights = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = y * width + x;
    weights[index] = maroGazeWeight(eye.x + (x + 0.5) * eye.width / width,
      eye.y + (y + 0.5) * eye.height / height, eye);
  }
  return weights;
}

// 暖色发束、棕色轮廓和腮红属于眼睛前景，眨眼或看向鼠标时必须保持原位。
export function maroEyeForeground(r, g, b) {
  return (r > 170 && r - g > 32 && g - b > 8)
    || (r > 110 && r < 190 && r - g > 22 && g - b > 12);
}

// 从顶部相连的整束刘海建立连续遮挡轮廓，不能逐像素猜颜色，否则手绘纹理会变成碎斑。
export function maroEyeMask(source, width, height, eye) {
  const candidate = new Uint8Array(width * height), connected = new Uint8Array(width * height);
  for (let index = 0; index < candidate.length; index += 1) {
    const offset = index * 4;
    candidate[index] = Number(source[offset] > 170 && maroEyeForeground(source[offset], source[offset + 1], source[offset + 2]));
  }
  const queue = new Uint32Array(candidate.length);
  let head = 0, tail = 0;
  for (let x = 0; x < width; x += 1) if (candidate[x]) { queue[tail++] = x; connected[x] = 1; }
  while (head < tail) {
    const index = queue[head++], x = index % width, y = Math.floor(index / width);
    for (const next of [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1,
      y > 0 ? index - width : -1, y < height - 1 ? index + width : -1]) {
      if (next < 0 || !candidate[next] || connected[next]) continue;
      connected[next] = 1; queue[tail++] = next;
    }
  }
  const edge = new Int32Array(width).fill(-100);
  for (let index = 0; index < connected.length; index += 1)
    if (connected[index]) edge[index % width] = Math.max(edge[index % width], Math.floor(index / width));
  const margin = Math.max(1, Math.round(width / eye.width * 3));
  const mask = new Float32Array(width * height);
  // 补齐发束内部的高光洞并保护棕色描边，边界以一像素柔和衔接。
  for (let x = 0; x < width; x += 1) {
    let bottom = -100;
    for (let neighbor = Math.max(0, x - margin); neighbor <= Math.min(width - 1, x + margin); neighbor += 1)
      bottom = Math.max(bottom, edge[neighbor] + margin);
    for (let y = 0; y < height; y += 1) {
      const originalY = eye.y + (y + 0.5) * eye.height / height;
      const hair = Math.max(0, Math.min(1, bottom - y + 0.5));
      const fixedSkin = Math.max(0, Math.min(1, (eye.fixedTop - originalY) / 3 + 0.5),
        Math.min(1, (originalY - eye.fixedBottom) / 3 + 0.5));
      mask[y * width + x] = Math.max(hair, fixedSkin);
    }
  }
  return mask;
}
