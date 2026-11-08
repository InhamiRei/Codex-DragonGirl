// 手心位置对应合掌图的坐标比例，波心和原画使用同一个锚点。
export const PRAYER_PALM = Object.freeze({ x: 0.5, y: 0.89 });
// 与 DeepspaceWorld 的星球升级扩散段使用相同的八秒时长。
export const PRAYER_WAVE_MS = 8000;

// 以离波心最远的角为终点，长窗口和靠边的波心也能扫完整个视口。
export function prayerWaveReach(width, height, origin) {
  return Math.hypot(Math.max(origin.x, width - origin.x), Math.max(origin.y, height - origin.y));
}
