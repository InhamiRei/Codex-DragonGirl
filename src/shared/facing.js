// 中线两侧保留少量迟滞，避免窗口抖动或像素取整反复触发朝向变化。
export const FACING_DEAD_ZONE = 12;
export const FLIP_DURATION = 0.3;

// 使用角色中心与所属区域比较，兼容负坐标副屏和跟随窗口的局部左右半区。
export function shouldFaceLeft(rect, area, previous = false) {
  if (!rect || !area || !(rect.width > 0) || !(area.width > 0)
    || ![rect.x, rect.width, area.x, area.width].every(Number.isFinite)) return previous;
  const distance = rect.x + rect.width / 2 - area.x - area.width / 2;
  if (Math.abs(distance) <= FACING_DEAD_ZONE) return previous;
  return distance < 0;
}

// 翻转与命中共用逐帧缩放值，避免 CSS 过渡与原生透明命中各自使用不同朝向。
export class FlipMotion {
  // 首次布局直接采用目标朝向，不在启动时播放无意义的翻身动画。
  constructor() {
    this.value = 1;
    this.from = 1;
    this.target = 1;
    this.elapsed = FLIP_DURATION;
    this.initialized = false;
  }

  // 重复布局不重启动画；反向请求从当前画面接续，隐藏或减少动态效果时直接落到终点。
  setFlipped(flipped, immediate = false) {
    const target = flipped ? -1 : 1;
    if (!this.initialized || immediate) {
      this.initialized = true;
      this.target = target;
      this.finish();
    } else if (target !== this.target) {
      this.from = this.value;
      this.target = target;
      this.elapsed = 0;
    }
  }

  // 平滑收尾的插值不会超调，长帧也只推进到终点，不会放大或反复穿过零点。
  step(seconds) {
    this.elapsed = Math.min(FLIP_DURATION, this.elapsed + Math.max(0, seconds));
    const t = this.elapsed / FLIP_DURATION;
    const eased = t * t * (3 - 2 * t);
    this.value = this.from + (this.target - this.from) * eased;
    if (this.settled) this.value = this.target;
    return this.value;
  }

  // 无动画模式与隐藏窗口立即结束翻转，不留下后台动画或恢复时的半幅画面。
  finish() {
    this.value = this.from = this.target;
    this.elapsed = FLIP_DURATION;
  }

  // 稳定后渲染器停止请求翻转帧，静置桌宠不增加常驻绘制。
  get settled() {
    return this.elapsed >= FLIP_DURATION;
  }
}
