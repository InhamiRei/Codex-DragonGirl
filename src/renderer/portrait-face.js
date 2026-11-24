import { createPortraitEyes } from './portrait-eyes.js';
import { loadPortraitFrames } from './portrait-frames.js';
import { PortraitMotion } from './portrait-motion.js';

// 表情定格与身体节奏各自计时，动作结束后恢复视线和眨眼。
const ACTIONS = { happy: 2200, sad: 3200 };

export class PortraitFace {
  // 每次选中角色才使用它的脸部标定，画布和表情都延迟到需要时加载。
  constructor(character, onPose, artwork) {
    this.character = character;
    this.artwork = artwork;
    this.frameKey = artwork.id + 'Frame';
    this.expressionKey = artwork.id + 'Expression';
    this.motion = new PortraitMotion(onPose, artwork);
    // 同一张表记录已请求的帧，解码中为 null，就绪后替换为实际图层。
    this.frames = new Map();
    this.timer = 0;
  }

  // 原画、眼部和命中图一起使用这个姿态。
  get pose() {
    return this.motion.pose;
  }

  // 换角色、隐藏、拖动和关闭动态表情时取消动作和排队中的请求。
  configure(image, model, pose, reducedMotion, pressed) {
    const settings = model.appearance?.settings || {};
    this.view = { image, model, pose, reducedMotion, pressed };
    const visible = model.visible !== false && !document.hidden && !pressed;
    this.allowed = visible && settings.expressionsEnabled !== false;
    this.ready = visible && image.src === this.artwork.asset
      && image.naturalWidth === this.artwork.width && image.naturalHeight === this.artwork.height;
    if (!this.allowed) {
      this.pending = null;
      this.stop();
    }
    this.motion.configure(model, pose, this.ready && !reducedMotion && settings.motion !== false);
    if (!this.ready) {
      if (this.eyes?.enabled) this.eyes.reset();
      return;
    }
    // 眨眼或表情启用时预热帧素材，两个开关都关闭时只加载待机立绘。
    this.prepareFrames(!reducedMotion && settings.blinkEnabled !== false, this.allowed);
    if (!this.action) this.syncEyes();
  }

  // 眨眼与任务表情可各自启用，已请求的帧不会重复解码。两项同时开启时共用一次脸部遮罩。
  prepareFrames(blink, actions) {
    const needBlink = blink && !this.frames.has('half');
    const needActions = actions && !this.frames.has('happy');
    if (!needBlink && !needActions) return;
    const names = [];
    if (needBlink) names.push('half', 'closed');
    if (needActions) names.push('happy', 'sad');
    for (const name of names) this.frames.set(name, null);
    loadPortraitFrames(this.artwork, names).then((frames) => {
      if (this.destroyed) return;
      for (const [name, layer] of frames) this.frames.set(name, layer);
      if (this.frames.get(this.pending)) this.play(this.pending);
      else if (!this.action) this.syncEyes();
    }).catch((error) => {
      for (const name of names) this.frames.delete(name);
      if (names.includes(this.pending)) this.pending = null;
      console.warn('角色表情素材暂不可用：', error.message);
    });
  }

  // 待机使用全屏光标方向，播放表情时记下最新位置供恢复后继续跟随。
  follow(point) {
    this.point = point;
    this.eyes?.follow(point);
    this.motion.follow(point);
  }

  // 眨眼和视线各用已有的偏好开关，在表情帧加载完成前先提供正常的视线。
  syncEyes() {
    if (!this.ready) return;
    if (!this.eyes) {
      this.eyes = createPortraitEyes(this.character, this.artwork, (amount) => this.paintBlink(amount));
      this.eyes.follow(this.point);
    }
    const { image, model, pose, reducedMotion, pressed } = this.view;
    const appearance = this.frames.get('closed') ? model.appearance : {
      ...model.appearance,
      settings: { ...model.appearance?.settings, blinkEnabled: false },
    };
    this.eyes.configure(image, { ...model, appearance }, pose, reducedMotion, pressed);
  }

  // 切换眼皮并告诉视线控制器是否遮住瞳孔。康娜的半闭眼仍露出当前朝向的虹膜。
  paintBlink(amount) {
    if (this.action) return true;
    const frame = amount >= 0.82 ? 'closed' : amount >= 0.15 ? 'half' : null;
    this.showFrame(frame);
    return this.artwork.blinkOverGaze ? frame === 'closed' : amount > 0;
  }

  // 一次只显示一张表情帧，按同一坐标跟随角色缩放或镜像。
  showFrame(name) {
    if (this.currentFrame === name) return;
    const layer = this.frames.get(name);
    if (!layer) {
      if (this.canvas) this.canvas.hidden = true;
      delete this.character.dataset[this.frameKey];
      this.currentFrame = null;
      return;
    }
    if (!this.canvas) {
      const artwork = this.artwork;
      const { x, y, width, height } = artwork.face;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'portrait-face ' + artwork.id + '-face';
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
    this.character.dataset[this.frameKey] = name;
    this.currentFrame = name;
  }

  // 手动预览、轻点和主任务通知共用入口，最新一次触发替换当前动作。
  play(name) {
    if (!this.allowed || !Object.hasOwn(ACTIONS, name)) return;
    if (!this.ready || !this.frames.get(name)) {
      this.pending = name;
      return;
    }
    this.pending = null;
    this.eyes?.reset();
    clearTimeout(this.timer);
    this.action = name;
    this.motion.setAction(name);
    this.character.dataset[this.expressionKey] = name;
    this.showFrame(name);
    this.timer = setTimeout(() => {
      this.stop();
      this.syncEyes();
    }, ACTIONS[name]);
  }

  // 完成、隐藏或换角色时清掉定格和动作时钟，露出原画。
  stop() {
    if (!this.action) return;
    clearTimeout(this.timer);
    this.timer = 0;
    this.action = null;
    this.motion.setAction(null);
    this.showFrame(null);
    delete this.character.dataset[this.expressionKey];
  }

  // 页面关闭时清理动作、眨眼、视线和缓存。
  destroy() {
    this.destroyed = true;
    this.stop();
    this.motion.reset();
    this.pending = null;
    this.eyes?.reset();
    this.showFrame(null);
    for (const patch of this.eyes?.patches || []) patch.canvas.remove();
    this.canvas?.remove();
    this.frames.clear();
  }
}
