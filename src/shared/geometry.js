export const CHARACTER_WIDTH = 260;
export const CHARACTER_RATIO = 1182 / 1330;
export const MIN_CHARACTER_SCALE = 0.5;
export const MAX_CHARACTER_SCALE = 1.5;
export const STAGE_PADDING = 32;
export const EDGE_MARGIN = 0;
export const SNAP_DISTANCE = 28;
// 所有内容使用相同的 214×150 椭圆，窗口额外包含透明边距与两颗小泡，文字不能撑大外框。
export const BUBBLE_SIZE = Object.freeze({ width: 230, height: 192 });
export const BUBBLE_MAX_SIZE = BUBBLE_SIZE;
// 椭圆主体外预留两颗独立思绪泡，去掉凸点后保持主体与小泡的位置不变。
export const BUBBLE_FRAME = Object.freeze({
  inset: 8, thoughtSpace: 34, width: 16, height: 42,
  thoughtWidth: 44, thoughtHeight: 22, thoughtRoot: 8,
  thoughtGap: 12, stroke: 3.5,
});
// 主体向外、小泡向头部独立横移，镜像布局使用对应的反向偏移。
export const BUBBLE_PLACEMENT = Object.freeze({ bodyX: 16, bodyY: 8, thoughtX: 20 });

// 将数值限制在有效范围，兼容工作区比角色更小的情况。
export function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

// 按首选大小计算实际尺寸；小屏幕临时缩小，但不改写用户的首选比例。
export function characterSize(scale, workArea, ratio = CHARACTER_RATIO) {
  const preferred = CHARACTER_WIDTH * clamp(scale, MIN_CHARACTER_SCALE, MAX_CHARACTER_SCALE);
  const width = Math.max(
    32,
    Math.min(preferred, workArea.width - EDGE_MARGIN * 2, (workArea.height - EDGE_MARGIN * 2) / ratio),
  );
  return { width: Math.round(width), height: Math.round(width * ratio) };
}

// 在角色周围预留回弹空间，避免头发和耳朵在动画中撞上原生窗口边缘。
export function stageBounds(character) {
  return {
    x: Math.round(character.x - STAGE_PADDING),
    y: Math.round(character.y - STAGE_PADDING),
    width: character.width + STAGE_PADDING * 2,
    height: character.height + STAGE_PADDING * 2,
  };
}

// 限制的是可见角色，而不是气泡或透明窗口的包围盒。
export function constrainCharacter(rect, workArea, margin = EDGE_MARGIN) {
  return {
    ...rect,
    x: Math.round(clamp(rect.x, workArea.x + margin, workArea.x + workArea.width - rect.width - margin)),
    y: Math.round(
      clamp(rect.y, workArea.y + margin, workArea.y + workArea.height - rect.height - margin),
    ),
  };
}

// 松手后再吸附，四个边缘独立判断，因此角落可以同时吸附两条边。
export function snapCharacter(rect, workArea, enabled = true) {
  const result = constrainCharacter(rect, workArea);
  if (!enabled) return result;
  const left = workArea.x + EDGE_MARGIN;
  const right = workArea.x + workArea.width - result.width - EDGE_MARGIN;
  const top = workArea.y + EDGE_MARGIN;
  const bottom = workArea.y + workArea.height - result.height - EDGE_MARGIN;
  if (Math.abs(result.x - left) <= SNAP_DISTANCE) result.x = left;
  else if (Math.abs(result.x - right) <= SNAP_DISTANCE) result.x = right;
  if (Math.abs(result.y - top) <= SNAP_DISTANCE) result.y = top;
  else if (Math.abs(result.y - bottom) <= SNAP_DISTANCE) result.y = bottom;
  return result;
}

// 按边缘锚点或相对比例记录位置，避免显示器分辨率变化后跑到屏幕之外。
export function capturePlacement(rect, display, snapEnabled = true) {
  const area = display.workArea;
  return {
    displayId: String(display.id),
    horizontal: captureAxis(rect.x, rect.width, area.x, area.width, snapEnabled),
    vertical: captureAxis(rect.y, rect.height, area.y, area.height, snapEnabled),
  };
}

// 一维位置只保存用户意图，不依赖上次窗口的绝对像素大小。
function captureAxis(position, size, start, length, snapEnabled) {
  const span = Math.max(0, length - size - EDGE_MARGIN * 2);
  const offset = position - start - EDGE_MARGIN;
  const edge = !snapEnabled
    ? null
    : Math.abs(offset) < 1
      ? 'start'
      : Math.abs(offset - span) < 1
        ? 'end'
        : null;
  return { edge, ratio: span ? clamp(offset / span, 0, 1) : 0.5 };
}

// 从持久化锚点恢复到当前工作区；初次启动默认停靠右下角。
export function restorePlacement(placement, display, size) {
  const area = display.workArea;
  return constrainCharacter(
    {
      ...size,
      x: restoreAxis(placement?.horizontal, size.width, area.x, area.width),
      y: restoreAxis(placement?.vertical, size.height, area.y, area.height),
    },
    area,
  );
}

// 吸附位置保留边距，自由位置按剩余可移动范围映射。
function restoreAxis(anchor, size, start, length) {
  const span = Math.max(0, length - size - EDGE_MARGIN * 2);
  const ratio = !anchor || anchor.edge === 'end' ? 1 : anchor.edge === 'start' ? 0 : anchor.ratio;
  return start + EDGE_MARGIN + span * clamp(ratio, 0, 1);
}

// 改大小时保留底边；横向优先保留已吸附的边，自由摆放时保留中心。
export function resizeCharacter(rect, size, placement, workArea) {
  const edge = placement?.horizontal?.edge;
  const x =
    edge === 'start'
      ? rect.x
      : edge === 'end'
        ? rect.x + rect.width - size.width
        : rect.x + (rect.width - size.width) / 2;
  return constrainCharacter({ ...size, x, y: rect.y + rect.height - size.height }, workArea);
}

// 气泡优先贴在角色左上方，左侧放不下时镜像到右上方，顶部不足再翻到下方。
export function placeBubble(character, workArea, size = BUBBLE_SIZE) {
  // 内容测量值仍受实际屏幕约束，小工作区不能把气泡推到屏幕之外。
  size = {
    width: Math.min(size.width, Math.max(1, workArea.width - 8)),
    height: Math.min(size.height, Math.max(1, workArea.height - 8)),
  };
  const minimumX = workArea.x + 4;
  const maximumX = workArea.x + workArea.width - size.width - 4;
  const leftAnchor = character.x - character.width * .25 - BUBBLE_PLACEMENT.bodyX;
  const rightAnchor = character.x + character.width * 1.25 + BUBBLE_PLACEMENT.bodyX;
  const horizontal = leftAnchor - size.width / 2 < minimumX && rightAnchor - size.width / 2 <= maximumX
    ? 'right' : 'left';
  const anchor = horizontal === 'left' ? leftAnchor : rightAnchor;
  // 主体更偏向头部左侧，独立思绪泡继续指向头部。
  const above = character.y - size.height + BUBBLE_FRAME.thoughtSpace + Math.min(8, character.height * .04) - BUBBLE_PLACEMENT.bodyY;
  const below = character.y + character.height - 6;
  const side = above >= workArea.y + 4 ? 'above' : 'below';
  const x = Math.round(
    clamp(
      anchor - size.width / 2,
      minimumX,
      maximumX,
    ),
  );
  const y = Math.round(
    clamp(
      side === 'above' ? above : below,
      workArea.y + 4,
      workArea.y + workArea.height - size.height - 4,
    ),
  );
  // 小泡单独锚定头部附近，向头部靠近时不受主体横移影响。
  const bodyWidth = size.width - BUBBLE_FRAME.width;
  const thoughtAnchor = horizontal === 'left'
    ? character.x - character.width * .05 - bodyWidth * .12 + BUBBLE_PLACEMENT.thoughtX
    : character.x + character.width * 1.05 + bodyWidth * .12 - BUBBLE_PLACEMENT.thoughtX;
  const anchorMargin = BUBBLE_FRAME.inset + BUBBLE_FRAME.stroke / 2 + 20;
  // 短句的窗口更窄，额外限制泡链靠外的一侧，避免最小圆泡被原生窗口裁掉。
  const thoughtReach = BUBBLE_FRAME.thoughtWidth - BUBBLE_FRAME.thoughtRoot;
  const minimumTail = horizontal === 'right' ? Math.max(anchorMargin, thoughtReach) : anchorMargin;
  const maximumTail = horizontal === 'left' ? Math.min(size.width - anchorMargin, size.width - thoughtReach) : size.width - anchorMargin;
  return {
    bounds: { x, y, ...size },
    side,
    horizontal,
    tailX: clamp(thoughtAnchor - x, minimumTail, maximumTail),
  };
}

// 原生光标轮询也使用同一个矩形判定，兼容负坐标的副显示器。
export function containsPoint(rect, point) {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.width &&
    point.y < rect.y + rect.height
  );
}
