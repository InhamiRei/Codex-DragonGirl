// 一次轻眨先快速闭合、短暂停留，再稍慢睁开；间隔内不需要持续请求动画帧。
export const BLINK_DURATION = 260;

// 平滑连接动作两端，眼皮不会在闭合或睁开时突然折返。
function smooth(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

// 返回闭合程度，0 为睁开、1 为闭合；长时间后台暂停后直接恢复睁眼。
export function blinkAmount(elapsed) {
  if (elapsed < 0 || elapsed >= BLINK_DURATION) return 0;
  if (elapsed < 90) return smooth(elapsed / 90);
  if (elapsed < 115) return 1;
  return 1 - smooth((elapsed - 115) / (BLINK_DURATION - 115));
}

// 间隔在约三到七秒间自然变化，不使用整齐机械的固定节拍。
export function nextBlinkDelay(random = Math.random()) {
  return 3200 + Math.max(0, Math.min(1, random)) * 4000;
}

// 沿原画的斜眼睑建立每列边界，外围衔接固定，闭眼时保留睫毛的原始厚度。
export function blinkColumn(x, eye) {
  const profile = eye.blink;
  const dx = x - profile.lidX;
  const lid = profile.lidY + dx * profile.slope + dx * dx * profile.curve;
  const top = lid - profile.thickness / 2 - 4;
  const lashBottom = lid + profile.thickness / 2;
  const horizontal = (x - profile.cx) / profile.rx;
  const bottom = Math.max(lashBottom, profile.cy + profile.ry * Math.sqrt(Math.max(0, 1 - horizontal * horizontal)) + 6);
  return {
    upper: top - 24, top, lashBottom, bottom, lower: bottom + 24,
    reach: smooth((profile.rx + 12 - Math.abs(x - profile.cx)) / 12),
  };
}

// 眼皮向中间合拢，虹膜被收起；上下皮肤连续补齐，远处眉毛、脸颊与头发保持原位。
export function blinkSourceY(y, column, closure, next = column, mix = 0) {
  const amount = closure * (column.reach + (next.reach - column.reach) * mix);
  if (amount <= 0) return y;
  const upper = column.upper + (next.upper - column.upper) * mix;
  const lower = column.lower + (next.lower - column.lower) * mix;
  if (y <= upper || y >= lower) return y;
  const top = column.top + (next.top - column.top) * mix;
  const lashBottom = column.lashBottom + (next.lashBottom - column.lashBottom) * mix;
  const bottom = column.bottom + (next.bottom - column.bottom) * mix;
  const span = bottom - lashBottom;
  const shift = span * 0.45 * amount;
  const movedTop = top + shift, movedLashBottom = lashBottom + shift;
  const movedBottom = movedLashBottom + span * (1 - amount);
  // 上方刘海保持原坐标，眼皮新增的覆盖区域由原画肤色补齐，避免把发丝拉长。
  if (y < movedTop) return Math.min(y, top);
  if (y < movedLashBottom) return top + y - movedTop;
  if (y < movedBottom) return lashBottom + (y - movedLashBottom) / (1 - amount);
  return Math.max(y, bottom);
}

// 上下眼皮覆盖收起虹膜后露出的区域，保留抗锯齿边缘，防止发丝和眼眶边缘被拉伸。
export function blinkSkinCoverage(y, column, closure, next = column, mix = 0) {
  const amount = closure * (column.reach + (next.reach - column.reach) * mix);
  if (amount <= 0) return 0;
  const top = column.top + (next.top - column.top) * mix;
  const span = column.bottom - column.lashBottom
    + (next.bottom - next.lashBottom - column.bottom + column.lashBottom) * mix;
  const movedTop = top + span * 0.45 * amount;
  if (y > top && y < movedTop) return Math.min(smooth((y - top) / 2), smooth((movedTop - y) / 2));
  const bottom = column.bottom + (next.bottom - column.bottom) * mix;
  const movedBottom = bottom - span * 0.55 * amount;
  if (y > movedBottom && y < bottom) return Math.min(smooth((y - movedBottom) / 2), smooth((bottom - y) / 2));
  return 0;
}
