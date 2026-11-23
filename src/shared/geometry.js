export const CHARACTER_WIDTH = 260;
export const CHARACTER_RATIO = 1182 / 1330;
export const MIN_CHARACTER_SCALE = 0.5;
export const MAX_CHARACTER_SCALE = 1.5;
export const STAGE_PADDING = 32;
export const EDGE_MARGIN = 0;
export const SNAP_DISTANCE = 28;
// 标准大小的设计画布包含椭圆、透明边距和两颗小泡，渲染和原生窗口共用同一个比例。
export const BUBBLE_SIZE = Object.freeze({ width: 242, height: 204 });
// 椭圆主体外预留两颗独立思绪泡，去掉凸点后保持主体与小泡的位置不变。
export const BUBBLE_FRAME = Object.freeze({
  inset: 8, thoughtSpace: 34, width: 16, height: 42,
  thoughtWidth: 44, thoughtHeight: 22, thoughtRoot: 8,
  thoughtGap: 12, stroke: 3.5,
});

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

// 以角色实际宽度缩放；小角色收缓缩小速度，50% 档仍保留 80% 字号。小屏幕按两轴一起限幅。
export function bubbleDimensions(characterWidth = CHARACTER_WIDTH, workArea) {
  const relative = characterWidth / CHARACTER_WIDTH;
  const preferred = relative < 1 ? 0.6 + 0.4 * relative : relative;
  const scale = workArea ? Math.min(preferred, Math.max(1, workArea.width - 8) / BUBBLE_SIZE.width,
    Math.max(1, workArea.height - 8) / BUBBLE_SIZE.height) : preferred;
  return {
    width: Math.max(1, Math.round(BUBBLE_SIZE.width * scale)),
    height: Math.max(1, Math.round(BUBBLE_SIZE.height * scale)),
    scale,
  };
}

// 按上方摆放的设计坐标计算椭圆与泡链。下方摆放沿画布垂直镜像，主进程与绘制端共用同一个弧线落点。
export function bubbleOutline({ width, height }, tailX) {
  const { inset, stroke, thoughtGap } = BUBBLE_FRAME;
  const centerX = width / 2, centerY = inset + (height - BUBBLE_FRAME.height) / 2;
  const radiusX = Math.max(1, (width - BUBBLE_FRAME.width - stroke) / 2);
  const radiusY = Math.max(1, (height - BUBBLE_FRAME.height - stroke) / 2);
  const span = Math.max(0, radiusX - 20);
  const anchorX = clamp(tailX, centerX - span, centerX + span);
  const arc = radiusY * Math.sqrt(Math.max(0, 1 - ((anchorX - centerX) / radiusX) ** 2));
  const tailTop = centerY + arc + stroke / 2 + thoughtGap;
  return { centerX, centerY, radiusX, radiusY, anchorX, tailTop };
}

// 小圆泡的末端指向头侧，反推泡链在椭圆上的起点；桌面边缘夹紧窗口后也要重新换算。
function bubbleTailX(character, horizontal, x, width, scale) {
  const right = horizontal === 'right';
  const tip = character.x + character.width * (right ? 2 / 3 : 1 / 3);
  const reach = (BUBBLE_FRAME.thoughtWidth - BUBBLE_FRAME.thoughtRoot) * scale;
  const margin = (BUBBLE_FRAME.inset + BUBBLE_FRAME.stroke / 2 + 20) * scale;
  const outerMargin = Math.max(margin, reach);
  return clamp(tip - x + (right ? reach : -reach), right ? outerMargin : margin, width - (right ? margin : outerMargin));
}

// 优先把气泡贴近头像上方，空间不足时依次考虑下方和侧面，给两颗小泡以及角色回弹留出净空。
export function placeBubble(character, workArea, size = bubbleDimensions(character.width, workArea)) {
  const width = Math.min(size.width, Math.max(1, workArea.width - 8));
  const height = Math.min(size.height, Math.max(1, workArea.height - 8));
  const scale = size.scale ?? 1;
  const minimumX = workArea.x + 4;
  const maximumX = workArea.x + workArea.width - width - 4;
  const minimumY = workArea.y + 4;
  const maximumY = workArea.y + workArea.height - height - 4;
  const leftRoom = character.x - minimumX;
  const rightRoom = maximumX + width - character.x - character.width;
  let horizontal = leftRoom < width / 2 + character.width * .12 && rightRoom > leftRoom ? 'right' : 'left';
  const anchor = character.x + character.width * (horizontal === 'left' ? -.12 : 1.12);
  let x = Math.round(clamp(anchor - width / 2, minimumX, maximumX));
  let tailX = bubbleTailX(character, horizontal, x, width, scale);

  // 按实际描边的最远端留白。缩小档的气泡和角色使用不同缩放曲线，不能用角色高度估算泡尾长度。
  const outline = bubbleOutline({ width: width / scale, height: height / scale }, tailX / scale);
  const paintedBottom = Math.max(height - BUBBLE_FRAME.thoughtSpace * scale, (outline.tailTop + BUBBLE_FRAME.thoughtHeight) * scale);
  const gap = Math.max(4, 6 * scale);
  const above = Math.floor(character.y - paintedBottom - gap);
  const below = Math.ceil(character.y + character.height + gap - (height - paintedBottom));
  let side = above >= minimumY ? 'above' : 'below';
  if (above < minimumY && below > maximumY) {
    // 上下都放不下时，把完整气泡移向余量较大的一侧，避免窗口夹紧后反压到头部。
    horizontal = rightRoom > leftRoom ? 'right' : 'left';
    x = Math.round(clamp(horizontal === 'left' ? character.x - width - gap : character.x + character.width + gap, minimumX, maximumX));
    tailX = bubbleTailX(character, horizontal, x, width, scale);
    side = character.y - minimumY > maximumY + height - character.y - character.height ? 'above' : 'below';
  }
  const y = clamp(side === 'above' ? above : below, minimumY, maximumY);
  return { bounds: { x, y, width, height }, side, horizontal, tailX };
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
