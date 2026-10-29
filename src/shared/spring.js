// 自己实现阻尼弹簧，按压和回弹可以中途改变目标，连续点击不会堆积动画。
export class PressSpring {
  // 三个独立分量分别控制横向、纵向和轻微倾斜。
  constructor() {
    this.value = [1, 1, 0];
    this.velocity = [0, 0, 0];
    this.target = [1, 1, 0];
  }

  // 按压方向由点击位置决定，形变围绕角色底部中心进行。
  press(lean = 0) {
    this.target = [1.055, 0.91, Math.max(-1, Math.min(1, lean)) * 0.9];
  }

  // 松开只切换目标值，保留当前速度以获得连续的回弹。
  release() {
    this.target = [1, 1, 0];
  }

  // 细分时间步长，避免拖动窗口或后台节流产生的大帧间隔让弹簧发散。
  step(seconds) {
    const duration = Math.min(0.064, Math.max(0, seconds));
    const steps = Math.max(1, Math.ceil(duration / (1 / 120)));
    const dt = duration / steps;
    for (let step = 0; step < steps; step += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const acceleration = (this.target[axis] - this.value[axis]) * 420 - this.velocity[axis] * 23;
        this.velocity[axis] += acceleration * dt;
        this.value[axis] += this.velocity[axis] * dt;
      }
    }
    const settled = this.value.every(
      (value, index) =>
        Math.abs(value - this.target[index]) < 0.0003 && Math.abs(this.velocity[index]) < 0.004,
    );
    if (settled) {
      this.value = [...this.target];
      this.velocity = [0, 0, 0];
    }
    return { ...this.pose(), settled };
  }

  // 命中检测读取同一份姿态，因此角色变形后不会出现点击位置与画面错位。
  pose() {
    return { scaleX: this.value[0], scaleY: this.value[1], angle: this.value[2] };
  }
}
