import { PRAYER_WAVE_MS, prayerWaveReach } from '../shared/prayer-wave.js';

const canvas = document.querySelector('canvas');
const ink = canvas.getContext('2d');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const TAU = Math.PI * 2;
const BURST_MS = 400;

// 波带从内侧深紫过渡到外侧浅紫，前后边缘都融进透明背景。
const WAVE_COLORS = [
  [0, '95,42,185', 0],
  [0.19, '103,48,198', 0.09],
  [0.41, '116,52,218', 0.24],
  [0.60, '129,67,239', 0.40],
  [0.73, '176,107,252', 0.57],
  [0.80, '222,179,255', 0.58],
  [0.89, '144,69,235', 0.25],
  [1, '115,52,211', 0],
];
let origin;
let frame = 0;
let startedAt;

// 限制高分屏画布的像素数，尺寸变化时保持逻辑坐标和动画时钟连续。
function prepareCanvas(width, height) {
  const scale = Math.min(devicePixelRatio, 2, Math.sqrt(5_000_000 / (width * height)));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ink.setTransform(w / width, 0, 0, h / height, 0, 0);
  ink.clearRect(0, 0, width, height);
}

// 手心先闪一下，随后只留下逐渐淡去的余光。
function drawBurst(x, y, elapsed, progress) {
  const flash = Math.max(0, 1 - elapsed / BURST_MS);
  const fade = flash ** 2;
  const afterglow = (1 - progress) * 0.13;
  const radius = 25 + 88 * (1 - flash);
  const glow = ink.createRadialGradient(x, y, 0, x, y, radius);
  glow.addColorStop(0, `rgba(239,204,255,${fade * 0.82 + afterglow})`);
  glow.addColorStop(0.24, `rgba(177,89,255,${fade * 0.56 + afterglow * 0.65})`);
  glow.addColorStop(1, 'rgba(119,42,233,0)');
  ink.fillStyle = glow;
  ink.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

// 参考星球升级波纹的缓出、衰减和带宽，把分层光晕画成连续径向渐变。
function drawWave(x, y, reach, progress, elapsed) {
  const eased = 1 - (1 - progress) ** 3;
  const fade = (1 - progress) ** 1.5 * Math.min(1, elapsed / 180);
  const radius = 10 + (reach + 24) * eased;
  const band = (80 * fade + 30) * Math.min(1, reach / 700);
  const inner = Math.max(0, radius - band * 1.18);
  const outer = radius + band * 0.68;
  const gradient = ink.createRadialGradient(x, y, inner, x, y, outer);
  for (const [offset, color, alpha] of WAVE_COLORS)
    gradient.addColorStop(offset, `rgba(${color},${alpha * fade})`);

  // 在波纹扫过的地方留下少量底光，再绘制逐渐变窄的波带。
  if (inner > 0) {
    ink.beginPath();
    ink.arc(x, y, inner, 0, TAU);
    ink.fillStyle = `rgba(119,62,216,${fade * 0.03})`;
    ink.fill();
  }
  ink.beginPath();
  ink.arc(x, y, (inner + outer) / 2, 0, TAU);
  ink.lineWidth = outer - inner;
  ink.strokeStyle = gradient;
  ink.stroke();

  // 高亮细弧和稀疏的光点沿渐变波带缓慢流动。
  const ridge = inner + (outer - inner) * 0.78;
  ink.lineWidth = 1.6;
  for (let index = 0; index < 6; index++) {
    const angle = index * TAU / 6 + progress * 1.2;
    const glint = 0.62 + 0.38 * Math.sin(progress * 9 + index * 2);
    ink.beginPath();
    ink.arc(x, y, ridge, angle, angle + 0.46);
    ink.strokeStyle = `rgba(239,209,255,${fade * glint * 0.53})`;
    ink.stroke();
  }
  for (let index = 0; index < 16; index++) {
    const angle = index * TAU / 16 + progress * 1.2;
    const distance = ridge + Math.sin(angle * 5 + progress * 6) * band * 0.15;
    const glint = 0.55 + 0.45 * Math.sin(progress * 12 + index * 1.7);
    ink.beginPath();
    ink.arc(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance, 0.6 + 1.65 * fade, 0, TAU);
    ink.fillStyle = `rgba(226,184,255,${fade * glint * 0.57})`;
    ink.fill();
  }
}

// 动画结束或系统要求减少动态效果时，立即通知主进程收起特效窗口。
function finish() {
  cancelAnimationFrame(frame);
  frame = 0;
  window.dragonGirl.prayerWaveFinished();
}

// 以实际窗口最远角计算波纹半径，播放结束时由主进程回收特效窗口。
function draw(now) {
  startedAt ??= now;
  const elapsed = now - startedAt;
  const progress = elapsed / PRAYER_WAVE_MS;
  if (progress >= 1 || reducedMotion.matches) { finish(); return; }
  const width = Math.max(1, innerWidth), height = Math.max(1, innerHeight);
  const reach = prayerWaveReach(width, height, origin);
  prepareCanvas(width, height);
  drawWave(origin.x, origin.y, reach, progress, elapsed);
  drawBurst(origin.x, origin.y, elapsed, progress);
  frame = requestAnimationFrame(draw);
}

// 重定位只更新波心，不重播动画；本页没有接收键盘或鼠标的控件。
window.dragonGirl.onPrayerWave((point) => {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || !ink || reducedMotion.matches) {
    finish();
    return;
  }
  origin = point;
  if (!frame) frame = requestAnimationFrame(draw);
});
window.addEventListener('pagehide', () => cancelAnimationFrame(frame));
