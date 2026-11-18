import { gazeTarget, stepGaze } from '../shared/gaze.js';
import { KOKKORO_EYE_ARTWORK } from './kokkoro-eyes.js';

const CENTER = { x: 0, y: 0 };
const REST = { translateX: 0, translateY: 0, angle: 0, scaleY: 1 };

// 待机轻摆和鼠标带动的头身动作统一使用较柔和的幅度。
const SWAY_AMPLITUDE = 0.8;

// 完成时以底边为锚点轻轻点头，失败沿用原来的短促缩身。
const GESTURES = {
  happy: { duration: 760, depth: 0.036 },
  sad: { duration: 420, depth: 0.019 },
};

export class KokkoroMotion {
  // 只更新角色容器姿态，帽子、身体与当前表情在同一次变换里移动。
  constructor(onPose) {
    this.onPose = onPose;
    this.pose = REST;
    this.lean = CENTER;
    this.frame = 0;
    this.tick = this.tick.bind(this);
  }

  // 拖动、隐藏或关闭动画时回到中性姿势，重新显示时从自然起点继续。
  configure(model, gesture, enabled) {
    this.rect = model.rect;
    this.gesture = gesture;
    this.track = model.appearance?.settings?.eyeTracking !== false;
    if (!enabled) {
      this.reset();
      return;
    }
    this.updateTarget();
    if (this.frame) return;
    this.idleStarted = this.lastFrame = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  // 主进程传入窗口外的光标位置，光标停下时身体仍有轻微的起伏。
  follow(point) {
    this.point = point;
    if (this.frame) this.updateTarget();
  }

  // 以未摆动的锚点计算目标，翻转后肩膀依旧朝屏幕上的鼠标方向靠过去。
  updateTarget() {
    const aim = this.track ? gazeTarget(this.point, this.rect, this.gesture, KOKKORO_EYE_ARTWORK) : CENTER;
    this.target = { x: aim.x * Math.sign(this.gesture.scaleX), y: aim.y };
  }

  // 动作与待机共用姿态，点头或缩身结束后直接接回原来的轻摆。
  setAction(name) {
    this.gestureAction = GESTURES[name];
    this.actionStarted = performance.now();
  }

  // 身体比眼睛稍慢跟上。约六秒的左右轻摆叠加错开的呼吸节奏。
  tick(time) {
    const delta = time - this.lastFrame;
    if (delta >= 25) {
      this.lastFrame = time;
      this.lean = stepGaze(this.lean, this.target, delta / 1000, 0.24);
      const { x, y } = this.lean;
      const elapsed = (time - this.idleStarted) / 1000;
      const sway = Math.sin(elapsed * 2 * Math.PI / 5.8);
      const breath = (1 - Math.cos(elapsed * 2 * Math.PI / 4.6)) / 2;
      const drift = Math.sin(elapsed * 2 * Math.PI / 9.3);
      const action = this.gestureAction;
      const progress = action ? Math.min(1, Math.max(0, (time - this.actionStarted) / action.duration)) : 1;
      const nod = action ? action.depth * Math.sin(Math.PI * progress) ** 2 : 0;
      this.pose = {
        translateX: SWAY_AMPLITUDE * this.rect.width * (0.012 * x + 0.004 * sway),
        translateY: SWAY_AMPLITUDE * this.rect.height * 0.0035 * y,
        angle: SWAY_AMPLITUDE * (2.6 * x + (0.86 * sway + 0.14 * drift) * (1 - Math.abs(x) * 0.24)),
        scaleY: 1 + SWAY_AMPLITUDE * (0.012 * breath - 0.010 * y) - nod,
      };
      this.onPose();
    }
    this.frame = requestAnimationFrame(this.tick);
  }

  // 停帧后把透明命中和画面一起恢复到原始位置。
  reset() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lean = CENTER;
    if (this.pose === REST) return;
    this.pose = REST;
    this.onPose();
  }
}
