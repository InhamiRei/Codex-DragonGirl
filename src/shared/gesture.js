// 点击与拖动共用一个状态机，跨过阈值后才移动，取消手势永不保存位置。
export class DragGesture {
  // 阈值采用屏幕逻辑像素，兼容 Retina 显示器。
  constructor(threshold = 5) {
    this.threshold = threshold;
    this.active = null;
  }

  // 以按下时的屏幕坐标和角色位置作为唯一基准，避免窗口跟着移动时产生累计漂移。
  begin(point, rect) {
    this.active = { start: { ...point }, initial: { ...rect }, moved: false };
  }

  // 使用从起点计算的总位移，快速拖动和帧丢失都不会放大误差。
  move(point) {
    if (!this.active) return null;
    const dx = point.x - this.active.start.x;
    const dy = point.y - this.active.start.y;
    this.active.moved ||= Math.hypot(dx, dy) > this.threshold;
    return {
      kind: this.active.moved ? 'drag' : 'press',
      rect: { ...this.active.initial, x: this.active.initial.x + dx, y: this.active.initial.y + dy },
    };
  }

  // 松手时才决定点击或拖动，保证拖拽之后不会额外弹出气泡。
  end(point) {
    const result = this.move(point);
    this.active = null;
    if (!result) return null;
    return { ...result, kind: result.kind === 'press' ? 'click' : 'drag' };
  }

  // 系统取消、失去捕获或休眠时回到原位，不把异常坐标写入配置。
  cancel() {
    const initial = this.active?.initial;
    this.active = null;
    return initial ? { kind: 'cancel', rect: initial } : null;
  }
}
