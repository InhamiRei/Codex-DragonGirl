// 开心星光约两秒完成：柔和进入、持续流动，随后恢复原来的视线与眨眼。
export const HAPPY_DURATION = 2000;

// 平滑连接星光的开始和结束，连续触发时也不会突然熄灭。
function smooth(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
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
