import { KOKKORO_ASSET } from '../shared/characters.js';
import { createKokkoroEyes, KOKKORO_EYE_ARTWORK } from './kokkoro-eyes.js';
import { KOKKORO_FACE_BOUNDS, loadKokkoroFrames } from './kokkoro-expressions.js';

// 轻弹或惊一下只发生在动作开头，定格等待恢复时不持续绘制。
const ACTIONS = {
  happy: { duration: 2200, moveFor: 540, scale: 0.024 },
  sad: { duration: 3200, moveFor: 420, scale: -0.019 },
};

export class KokkoroFace {
  // 只有切到可可萝才创建画布、解码表情帧和建立视线标定。
  constructor(character, onPose) {
    this.character = character;
    this.onPose = onPose;
    this.scaleY = 1;
    this.motionFrame = 0;
    this.timer = 0;
  }

  // 换角色、隐藏、拖动和关闭动态表情时取消动作和排队中的请求。
  configure(image, model, pose, reducedMotion, pressed) {
    if (model.asset !== KOKKORO_ASSET && this.view?.model.asset !== KOKKORO_ASSET) return;
    const hadMotion = this.motion;
    const settings = model.appearance?.settings || {};
    this.view = { image, model, pose, reducedMotion, pressed };
    this.motion = !reducedMotion && settings.motion !== false;
    const visible = model.asset === KOKKORO_ASSET && model.visible !== false && !document.hidden && !pressed;
    this.allowed = visible && settings.expressionsEnabled !== false;
    this.ready = visible && image.src === KOKKORO_ASSET
      && image.naturalWidth === KOKKORO_EYE_ARTWORK.width && image.naturalHeight === KOKKORO_EYE_ARTWORK.height;
    if (!this.allowed) {
      this.pending = null;
      this.stop();
    }
    if (!this.ready) {
      if (this.eyes?.enabled) this.eyes.reset();
      return;
    }
    if (!this.loading) this.prepareFrames();
    if (!this.action) this.syncEyes();
    else if (hadMotion !== this.motion) this.move(performance.now());
  }

  // 表情加载完成时只接续当前角色的最后一次触发，切走或隐藏时直接丢弃。
  prepareFrames() {
    this.loading = loadKokkoroFrames().then((frames) => {
      if (this.destroyed) return;
      this.frames = frames;
      if (this.pending) this.play(this.pending);
      else this.syncEyes();
    }).catch((error) => {
      this.pending = null;
      console.warn('可可萝表情素材暂不可用：', error.message);
    });
  }

  // 待机使用全屏光标方向，播放表情时记下最新位置供恢复后继续跟随。
  follow(point) {
    this.point = point;
    this.eyes?.follow(point);
  }

  // 眨眼和视线各用已有的偏好开关，在表情帧加载完成前先提供正常的视线。
  syncEyes() {
    if (!this.ready) return;
    this.eyes ??= createKokkoroEyes(this.character, (amount) => this.paintBlink(amount));
    const { image, model, pose, reducedMotion, pressed } = this.view;
    const appearance = this.frames ? model.appearance : {
      ...model.appearance,
      settings: { ...model.appearance?.settings, blinkEnabled: false },
    };
    this.eyes.configure(image, { ...model, appearance }, pose, reducedMotion, pressed);
    this.eyes.follow(this.point);
  }

  // 眨眼依次显示半闭、全闭、半闭，隐去的眼白始终只来自当前帧。
  paintBlink(amount) {
    if (this.action) return;
    this.showFrame(amount >= 0.82 ? 'closed' : amount >= 0.15 ? 'half' : null);
  }

  // 一次只显示一张表情帧，按同一坐标跟随角色缩放或镜像。
  showFrame(name) {
    if (this.currentFrame === name) return;
    const layer = this.frames?.get(name);
    if (!layer) {
      if (this.canvas) this.canvas.hidden = true;
      delete this.character.dataset.kokkoroFrame;
      this.currentFrame = null;
      return;
    }
    if (!this.canvas) {
      const { x, y, width, height } = KOKKORO_FACE_BOUNDS;
      const artwork = KOKKORO_EYE_ARTWORK;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'kokkoro-face';
      this.canvas.width = width;
      this.canvas.height = height;
      this.canvas.setAttribute('aria-hidden', 'true');
      this.canvas.style.left = x / artwork.width * 100 + '%';
      this.canvas.style.top = y / artwork.height * 100 + '%';
      this.canvas.style.width = width / artwork.width * 100 + '%';
      this.canvas.style.height = height / artwork.height * 100 + '%';
      this.ctx = this.canvas.getContext('2d');
      this.character.append(this.canvas);
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(layer, 0, 0);
    this.canvas.hidden = false;
    this.character.dataset.kokkoroFrame = name;
    this.currentFrame = name;
  }

  // 手动预览、轻点和主任务通知共用入口，最新一次触发替换当前动作。
  play(name) {
    if (!this.allowed || !Object.hasOwn(ACTIONS, name)) return;
    if (!this.ready || !this.frames) {
      this.pending = name;
      return;
    }
    this.pending = null;
    this.eyes?.reset();
    clearTimeout(this.timer);
    this.action = name;
    this.started = performance.now();
    this.character.dataset.kokkoroExpression = name;
    this.showFrame(name);
    this.move(this.started);
    this.timer = setTimeout(() => {
      this.stop();
      this.syncEyes();
    }, ACTIONS[name].duration);
  }

  // 以平切底边为锚点轻弹或缩身，命中与画面共用缩放比例。
  move(time) {
    cancelAnimationFrame(this.motionFrame);
    this.motionFrame = 0;
    const { moveFor, scale } = ACTIONS[this.action];
    const progress = Math.max(0, (time - this.started) / moveFor);
    if (!this.motion || progress >= 1) {
      this.setScale(1);
      return;
    }
    this.setScale(1 + scale * Math.sin(Math.PI * progress) ** 2);
    this.motionFrame = requestAnimationFrame((next) => this.move(next));
  }

  // 姿势真正变化时才刷新原画容器与透明命中。
  setScale(scale) {
    if (this.scaleY === scale) return;
    this.scaleY = scale;
    this.onPose();
  }

  // 完成、隐藏或换角色时清掉定格和动作时钟，露出原画。
  stop() {
    if (!this.action) return;
    clearTimeout(this.timer);
    cancelAnimationFrame(this.motionFrame);
    this.timer = this.motionFrame = 0;
    this.action = null;
    this.showFrame(null);
    delete this.character.dataset.kokkoroExpression;
    this.setScale(1);
  }

  // 页面关闭时清理动作、眨眼、视线和缓存。
  destroy() {
    this.destroyed = true;
    this.stop();
    this.pending = null;
    this.eyes?.reset();
    for (const patch of this.eyes?.patches || []) patch.canvas.remove();
    this.canvas?.remove();
    this.frames?.clear();
  }
}
