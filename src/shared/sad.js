// 伤心沿用确认过的含泪预览，实际动作结束即停帧，不保留预览末尾的静止等待。
export const SAD_DURATION = 5600;
export const SAD_CHARACTER_ASSET = 'dragon://app/assets/characters/codex-dragon-girl-sad.png';
export const SAD_EYES = Object.freeze([
  { cx: 479, cy: 710, rx: 170, ry: 174, irisX: 486, waterY: 783, waterSlope: -0.04 },
  { cx: 845, cy: 731, rx: 173, ry: 178, irisX: 835, waterY: 810, waterSlope: 0.22 },
]);

// 平滑进入、聚泪和恢复，重复失败时不会排队播放多个表情。
function smooth(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

// 眼皮逐渐低垂并保持含泪，约六秒内完整恢复；相同表情续接已有强度。
export function sadFrame(elapsed, from = { amount: 0 }) {
  if (elapsed >= SAD_DURATION) return { amount: 0, hop: 0, finished: true };
  const time = Math.max(0, elapsed);
  const entrance = smooth((time - 450) / 750);
  const amount = time < 4500 ? from.amount + (1 - from.amount) * entrance
    : 1 - smooth((time - 4500) / 1100);
  return { amount, hop: 0, finished: false };
}

// 眼睛与眉毛使用羽化边缘，固定小泪珠的位置留给独立的下落动画。
export function sadEyeWeight(x, y, index) {
  const eye = SAD_EYES[index];
  const distance = Math.hypot((x - eye.cx) / eye.rx, (y - eye.cy) / eye.ry);
  let weight = 1 - smooth((distance - 0.81) / 0.19);
  if (index === 1) {
    const bead = Math.hypot((x - 904) / 18, (y - 838) / 16);
    weight *= smooth((bead - 0.55) / 0.45);
  }
  return weight;
}

// 泪珠始终留在右侧脸颊，先聚拢、再滑落并淡去，每轮只有一滴。
export function sadTear(elapsed, amount) {
  const time = Math.max(0, elapsed);
  const progress = Math.max(0, Math.min(1, (time - 2200) / 1700));
  return {
    x: 901 + Math.sin(progress * Math.PI) * 2.5,
    y: 821 + smooth(progress) * 58,
    radius: 9.8 + Math.sin(progress * Math.PI) * 1.3,
    alpha: smooth((time - 2050) / 380) * (1 - smooth((time - 3650) / 600)) * amount,
  };
}

// 输出很轻的低头姿态，使用比例而非窗口位移，缩放或翻转后仍保持原锚点。
export function sadBodyPose(elapsed, amount, height, flip = false) {
  return {
    translateY: height * 0.00237 * amount,
    angle: amount * (-0.004 + Math.sin(elapsed / 1200) * 0.00065) * 180 / Math.PI * (flip ? -1 : 1),
  };
}
