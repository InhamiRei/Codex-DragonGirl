// 开心星光约两秒完成：柔和进入、持续流动，随后恢复原来的视线与眨眼。
export const HAPPY_DURATION = 2000;

// 「呆住」淡入后没有局部动作，蛋包饭在酱瓶离场后停在完整爱心上。
const DRAGON_FACE_ENTER = 150;
export const OMURICE_BOTTLE_EXIT = 2340;

// 菜单、画面和帧调度共用表情时长，停留期间仍保留完整的淡出时间。
const DRAGON_PREVIEWS = {
  heart: { label: '爱心', duration: 3500, fade: 360 },
  'white-eyes': { label: '呆住', duration: 2600, fade: 200, holdAfter: DRAGON_FACE_ENTER },
  'spiral-eyes': { label: '晕晕', duration: 3200, fade: 280 },
  omurice: { label: '蛋包饭', duration: 3600, fade: 240, holdAfter: OMURICE_BOTTLE_EXIT },
};
export const DRAGON_FACE_EXPRESSIONS = Object.entries(DRAGON_PREVIEWS).map(([name, { label }]) => [label, name]);

// 菜单和渲染器共用表情名称，未知名称不会触发龙娘动作。
export function isDragonFace(name) {
  return Object.hasOwn(DRAGON_PREVIEWS, name);
}

// 平滑连接星光的开始和结束，连续触发时也不会突然熄灭。
function smooth(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

// 计算透明度和收耳进度；有静止区间时返回下一次需要更新的时刻。
export function dragonFaceFrame(name, elapsed, from, reducedMotion = false) {
  const { duration, fade, holdAfter } = DRAGON_PREVIEWS[name];
  if (elapsed >= duration) return { amount: 0, hop: 0, finished: true };
  if (reducedMotion) return { amount: 1, hop: 0, holdUntil: duration, finished: false };
  const fadeStart = duration - fade;
  const amount = elapsed < fadeStart ? from.amount + (1 - from.amount) * smooth(elapsed / DRAGON_FACE_ENTER)
    : 1 - smooth((elapsed - fadeStart) / fade);
  const frame = { amount, hop: 0, finished: false };
  if (holdAfter !== undefined && elapsed >= holdAfter && elapsed < fadeStart) frame.holdUntil = fadeStart;
  if (name !== 'heart') return frame;
  // 耳尖先收、停一拍再松开，连播时从当前姿态接续。
  const { tuck = 0 } = from;
  return {
    ...frame,
    tuck: (tuck + (1 - tuck) * smooth((elapsed - 140) / 330)) * (1 - smooth((elapsed - 820) / 680)),
  };
}

// 输出星光强度与轻弹高度，旧表情可作为新的起点，避免连续完成事件堆积动画。
export function happyFrame(elapsed, from = { amount: 0, hop: 0 }) {
  if (elapsed >= HAPPY_DURATION) return { amount: 0, hop: 0, finished: true };
  // 同一显示帧的时间戳可能略早于 IPC 到达时间，首帧等待开始，不能误判为动画结束。
  elapsed = Math.max(0, elapsed);
  const entrance = smooth(elapsed / 180);
  const amount = elapsed < 1500 ? from.amount + (1 - from.amount) * entrance
    : 1 - smooth((elapsed - 1500) / (HAPPY_DURATION - 1500));
  const bounce = elapsed < 560 ? Math.sin(Math.PI * elapsed / 560) ** 2 : 0;
  const hop = Math.min(1, from.hop * (1 - entrance) + bounce * (1 - from.amount * 0.65));
  return { amount, hop, finished: false };
}

// 三颗星芒分布在原画高光之间，主星保持清晰，缩到 60% 时也不会退化成普通光点。
export function happySparkles(elapsed, eyeIndex = 0) {
  const phase = Math.max(0, elapsed) / 1700 * Math.PI * 2 + eyeIndex * 0.28;
  return [
    { kind: 'star', x: 0.31 + Math.cos(phase) * 0.05, y: 0.04 + Math.sin(phase) * 0.045,
      radius: 0.47 + Math.sin(phase * 1.2) * 0.02, angle: Math.sin(phase * 0.7) * 0.08,
      alpha: 0.99 + Math.cos(phase * 1.3) * 0.01 },
    { kind: 'star', x: -0.50 + Math.sin(phase + 1.1) * 0.04, y: 0.18 + Math.cos(phase * 0.9 + 1.1) * 0.06,
      radius: 0.23 + Math.cos(phase * 1.4) * 0.015, angle: Math.cos(phase) * 0.10,
      alpha: 0.97 + Math.sin(phase * 1.1 + 1.4) * 0.03 },
    { kind: 'star', x: 0.52 + Math.sin(phase + 2) * 0.03, y: 0.48 + Math.cos(phase + 2) * 0.05,
      radius: 0.145 + Math.sin(phase * 1.3) * 0.012, angle: Math.sin(phase + 0.8) * 0.12,
      alpha: 0.94 + Math.sin(phase + 0.5) * 0.04 },
    { kind: 'dot', x: -0.19 + Math.cos(phase * 0.8) * 0.05, y: 0.30 + Math.sin(phase * 0.8) * 0.04,
      radius: 0.028, angle: 0, alpha: 0.80 + Math.cos(phase + 2) * 0.1 },
  ];
}
