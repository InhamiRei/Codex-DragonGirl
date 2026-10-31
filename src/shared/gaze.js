import { imagePoint } from './hit-test.js';

// 眼区只标定内置原画；自定义图片没有相同的五官位置，不能套用这组坐标。
export const DEFAULT_CHARACTER_ASSET = 'dragon://app/assets/characters/codex-dragon-girl.png';
export const EYE_ARTWORK = Object.freeze({
  width: 1330,
  height: 1182,
  center: { x: 662, y: 738 },
  travel: { x: 14, y: 10 },
  eyes: [
    {
      x: 310, y: 576, width: 332, height: 292,
      iris: { cx: 491, cy: 723, rx: 72, ry: 73, lid: 669, slope: -0.055 },
      blink: { cx: 491, cy: 723, rx: 94, ry: 88, lidX: 540, lidY: 650, slope: -0.007, curve: 0.00105, thickness: 29 },
      outline: [[365, 669], [404, 649], [462, 637], [523, 632], [572, 637],
        [585, 651], [575, 670], [579, 713], [576, 749], [561, 780], [535, 800],
        [499, 812], [461, 809], [432, 795], [411, 774], [400, 739], [405, 697], [374, 697]],
    },
    {
      x: 678, y: 590, width: 368, height: 328,
      iris: { cx: 833, cy: 751, rx: 79, ry: 79, lid: 702, slope: 0.30 },
      blink: { cx: 833, cy: 751, rx: 96, ry: 95, lidX: 765, lidY: 661, slope: 0.18, curve: 0.0007, thickness: 30 },
      outline: [[740, 654], [768, 645], [809, 651], [856, 662], [913, 685],
        [958, 705], [982, 719], [989, 735], [974, 745], [947, 735], [931, 726],
        [931, 760], [922, 797], [899, 826], [863, 843], [824, 846], [786, 832],
        [754, 804], [739, 769], [734, 736], [741, 699], [751, 683], [738, 672]],
    },
  ],
});

// 主进程和界面共用启用条件，关闭开关或导入图片后停止屏幕外的视线消息。
export function eyeTrackingEnabled(asset = DEFAULT_CHARACTER_ASSET, settings = {}) {
  return asset === DEFAULT_CHARACTER_ASSET && settings.eyeTracking !== false;
}

// 逆转角色的翻转、按压和旋转，以双眼中点计算同向视线，避免近距离变成对眼。
export function gazeTarget(point, rect, pose) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || !(rect?.width > 0) || !(rect?.height > 0)) return { x: 0, y: 0 };
  const local = imagePoint(point, rect, pose);
  const x = (local.x - EYE_ARTWORK.center.x / EYE_ARTWORK.width) / 0.65;
  const y = (local.y - EYE_ARTWORK.center.y / EYE_ARTWORK.height) * rect.height / rect.width / 0.65;
  const length = Math.max(1, Math.hypot(x, y));
  return { x: x / length, y: y / length };
}

// 计算完整眼区内外及其边缘距离，睫毛尖、眼眶和虹膜使用相同的平移权重。
export function eyeWarpWeight(x, y, eye) {
  let inside = false, distanceSquared = Infinity;
  for (let index = 0, previous = eye.outline.length - 1; index < eye.outline.length; previous = index++) {
    const [ax, ay] = eye.outline[previous], [bx, by] = eye.outline[index];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    distanceSquared = Math.min(distanceSquared, (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2);
  }
  // 核心留白大于最大位移，眼睛整块平移而不拉扯变形；周围过渡带平滑接回原画。
  if (inside || distanceSquared <= 18 ** 2) return 1;
  const t = Math.max(0, Math.min(1, (Math.sqrt(distanceSquared) - 18) / 36));
  return 1 - t * t * (3 - 2 * t);
}

// 身体在屏幕方向上轻轻配合视线，底部锚点附近的位移与倾角均有限幅。
export function bodyFollowPose(direction, rect, flip = false) {
  const x = direction.x * (flip ? -1 : 1) || 0;
  return {
    translateX: x * rect.width * 0.0025,
    translateY: direction.y * rect.height * 0.0025,
    angle: x * 0.45,
  };
}

// 按时间平滑收敛，身体可采用更慢的响应；到达目标后让渲染器停止请求帧。
export function stepGaze(current, target, seconds, responseSeconds = 0.075) {
  const blend = 1 - Math.exp(-Math.min(0.064, Math.max(0, seconds)) / responseSeconds);
  const x = current.x + (target.x - current.x) * blend;
  const y = current.y + (target.y - current.y) * blend;
  const settled = Math.hypot(target.x - x, target.y - y) < 0.002;
  return { x: settled ? target.x : x, y: settled ? target.y : y, settled };
}
