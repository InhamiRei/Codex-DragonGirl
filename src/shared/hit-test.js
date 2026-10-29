// 逆转以底部中心为原点的旋转与缩放，再映射到素材坐标。
export function imagePoint(point, rect, pose = { scaleX: 1, scaleY: 1, angle: 0 }) {
  const dx = point.x - rect.x - rect.width / 2;
  const dy = point.y - rect.y - rect.height;
  const radians = (-pose.angle * Math.PI) / 180;
  const x = (dx * Math.cos(radians) - dy * Math.sin(radians)) / pose.scaleX + rect.width / 2;
  const y = (dx * Math.sin(radians) + dy * Math.cos(radians)) / pose.scaleY + rect.height;
  return { x: x / rect.width, y: y / rect.height };
}

// 只把素材的可见像素作为角色命中区域，背景与发丝之间的透明空隙都可以穿透。
export function opaqueAt(mask, normalizedPoint, threshold = 24) {
  if (
    !mask ||
    normalizedPoint.x < 0 ||
    normalizedPoint.y < 0 ||
    normalizedPoint.x >= 1 ||
    normalizedPoint.y >= 1
  )
    return false;
  const x = Math.floor(normalizedPoint.x * mask.width);
  const y = Math.floor(normalizedPoint.y * mask.height);
  return mask.alpha[y * mask.width + x] > threshold;
}

// 气泡圆角外的空白也必须穿透，不能仅按它的矩形盒子接收鼠标。
export function roundedRectContains(point, rect, radius) {
  if (
    point.x < rect.x ||
    point.y < rect.y ||
    point.x >= rect.x + rect.width ||
    point.y >= rect.y + rect.height
  )
    return false;
  const centerX = Math.max(rect.x + radius, Math.min(point.x, rect.x + rect.width - radius));
  const centerY = Math.max(rect.y + radius, Math.min(point.y, rect.y + rect.height - radius));
  return (point.x - centerX) ** 2 + (point.y - centerY) ** 2 <= radius ** 2;
}

// 基础椭圆的几何命中，排除四角空白和边界外区域。
export function ellipseContains(point, rect) {
  if (!(rect.width > 0 && rect.height > 0)) return false;
  const x = (point.x - rect.x - rect.width / 2) / (rect.width / 2);
  const y = (point.y - rect.y - rect.height / 2) / (rect.height / 2);
  return x * x + y * y <= 1;
}
