import { MARO_ASSET, MARO_FRAME_SIZE, MARO_HAIR_ASSETS, HAIR_FRAMES, HAIR_DURATION,
  HAIR_FRAME_TIMES, hairFrameAt, hairNodAt } from '../shared/characters.js';
import { spritePalette, spriteColorLookup, applySpritePalette, spriteLandmarks,
  spriteRegistration, registeredSpriteRow } from '../shared/sprite-calibration.js';
import { createMaroEyes } from './maro-eyes.js';

const ROOT = 'dragon://app/assets/characters/maro/';
const SIZE = MARO_FRAME_SIZE;

// 麻吕使用独立原画与透明逐帧动画，绝不复用龙娘专用的眼睛贴片。
export class CharacterSprites {
  // 画布随角色共同缩放、翻转；每次切帧同时更新透明命中图。
  constructor(character, portrait, onMask) {
    this.character = character;
    this.portrait = portrait;
    this.onMask = onMask;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'character-sprites';
    this.canvas.width = this.canvas.height = SIZE;
    this.canvas.hidden = true;
    this.canvas.setAttribute('aria-hidden', 'true');
    character.append(this.canvas);
    this.context = this.canvas.getContext('2d');
    this.state = 'idle';
    this.frame = 0;
    this.idleTimer = 0;
    this.expressionTimer = 0;
    this.firstIdle = true;
    this.hairSource = 'idle';
    this.pendingExpression = null;
    this.eyes = createMaroEyes(character);
  }

  // 解码前验证每张图的原生尺寸，高清源图和显示画布都保持 1254 像素。
  async loadImage(url) {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (image.naturalWidth !== SIZE || image.naturalHeight !== SIZE)
      throw new Error('麻吕素材必须是独立的 1254×1254 原图：' + url);
    return image;
  }

  // 同一角色只解码一次；失败可重试，不把一次失败永久留成无响应状态。
  prepare() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const images = await Promise.all(['idle.png', 'success.png', 'failure.png'].map((name) => this.loadImage(ROOT + name)));
      this.idleImage = images[0];
      const referencePalette = spritePalette(this.rawFrame(images[0]).rgba.data);
      this.stills = Object.fromEntries(['idle', 'happy', 'sad'].map((name, index) => {
        const raw = this.rawFrame(images[index]);
        // 点击完成和失败表情也使用待机色板，不能只校准捋发动画。
        if (index > 0) {
          applySpritePalette(raw.rgba.data, spriteColorLookup(spritePalette(raw.rgba.data), referencePalette, referencePalette));
          raw.context.putImageData(raw.rgba, 0, 0);
        }
        return [name, this.makeFrame(raw.canvas, null, name === 'idle')];
      }));
      await this.prepareHair();
      if (this.destroyed) return;
      this.loaded = true;
    })().catch((error) => {
      this.loading = null;
      this.preparing = false;
      this.pendingExpression = null;
      throw error;
    });
    return this.loading;
  }

  // 在原生分辨率清除透明区极低透明度的彩色杂点，真实线稿和半透明发丝保持不变。
  rawFrame(image) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, SIZE, SIZE);
    for (let offset = 0; offset < rgba.data.length; offset += 4) {
      if (rgba.data[offset + 3] > 24) continue;
      rgba.data[offset] = rgba.data[offset + 1] = rgba.data[offset + 2] = rgba.data[offset + 3] = 0;
    }
    context.putImageData(rgba, 0, 0);
    return { canvas, context, rgba };
  }

  // 原画按高清尺寸缓存；命中图独立缩小以节省内存，不会降低显示图像的分辨率。
  makeFrame(image, placement, keepPixels = false) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingQuality = 'high';
    if (placement) {
      // 逐行取样共用连续坐标，保留原生细节，避免多块贴图之间出现缝隙和叠影。
      for (let y = 0; y < SIZE; y += 1) {
        const row = registeredSpriteRow(placement, (y + 0.5) / SIZE);
        context.drawImage(image, 0, row.sourceY * SIZE - row.sourceHeight / 2,
          SIZE, row.sourceHeight, row.x * SIZE, y, row.scale * SIZE, 1);
      }
    }
    else context.drawImage(image, 0, 0);
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = maskCanvas.height = 256;
    const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
    maskContext.drawImage(canvas, 0, 0, 256, 256);
    const rgba = maskContext.getImageData(0, 0, 256, 256).data;
    const alpha = new Uint8Array(256 * 256);
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = rgba[index * 4 + 3];
    if (!alpha.some((value) => value > 24) || !alpha.some((value) => value === 0))
      throw new Error('麻吕素材缺少真实透明区域');
    return { canvas, pixels: keepPixels ? context.getImageData(0, 0, SIZE, SIZE).data : null,
      mask: { width: 256, height: 256, alpha } };
  }

  // 原图共用配色和头部尺寸，轻微低头沿统一轨迹播放；分批解码避免展开三十份原始像素。
  async prepareHair() {
    const idle = this.stills.idle;
    const referencePalette = spritePalette(idle.pixels);
    const reference = spriteLandmarks(idle.pixels, SIZE, SIZE);
    this.hair = new Array(HAIR_FRAMES);
    this.calibration = new Array(HAIR_FRAMES);
    let next = 0;
    // 每个解码任务完成后让出事件循环，加载过程中菜单仍能记录用户的预览请求。
    const worker = async () => {
      while (next < HAIR_FRAMES && !this.destroyed) {
        const index = next++;
        const image = await this.loadImage(MARO_HAIR_ASSETS[index]);
        if (this.destroyed) return;
        const { canvas, context, rgba } = this.rawFrame(image);
        const lookup = spriteColorLookup(spritePalette(rgba.data), referencePalette, referencePalette);
        applySpritePalette(rgba.data, lookup);
        context.putImageData(rgba, 0, 0);
        const landmarks = spriteLandmarks(rgba.data, SIZE, SIZE);
        const headOffsetY = hairNodAt(HAIR_FRAME_TIMES[index]);
        const placement = spriteRegistration(reference, landmarks, { headOffsetY });
        this.calibration[index] = { index, sourceWidth: image.naturalWidth, sourceHeight: image.naturalHeight,
          headOffsetY, placement, landmarks };
        // 首尾直接使用待机原画，进入和退出动作时不会切换脸型、位置或清晰度。
        this.hair[index] = index === 0 || index === HAIR_FRAMES - 1 ? idle : this.makeFrame(canvas, placement);
        canvas.width = canvas.height = 1;
        image.src = '';
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // 隐藏、切换角色、按压或关闭动画时及时取消任务；过期解码结果不会重新唤醒旧角色。
  configure(model, reducedMotion, pressed, pose = { scaleX: 1, scaleY: 1, angle: 0 }) {
    if (this.destroyed) return;
    this.model = model;
    this.reducedMotion = reducedMotion;
    this.pressed = pressed;
    this.pose = pose;
    this.enabled = model?.asset === MARO_ASSET;
    this.visible = this.enabled && model.visible !== false && !document.hidden && !pressed;
    if (!this.visible) this.pendingExpression = null;
    if (!this.enabled) {
      this.eyes.reset();
      this.cancel();
      this.state = 'idle';
      this.canvas.hidden = true;
      this.portrait.style.visibility = '';
      this.lastPaint = null;
      delete this.character.dataset.spriteState;
      delete this.character.dataset.spriteFrame;
      this.onMask(null);
      return;
    }
    if (!this.loaded) {
      if (!this.preparing) {
        this.preparing = true;
        void this.prepare().then(() => {
          if (this.destroyed) return;
          this.configure(this.model, this.reducedMotion, this.pressed, this.pose);
          const pending = this.pendingExpression;
          this.pendingExpression = null;
          if (pending) this.showExpression(pending.name, { source: pending.source });
        })
          .catch((error) => console.warn('麻吕动画素材暂不可用：', error.message));
      }
      return;
    }
    if (!this.visible || (this.state === 'hair' && !this.canGroom(this.hairSource))
      || (this.state !== 'idle' && model.appearance?.settings?.expressionsEnabled === false)) {
      this.cancel();
      this.state = 'idle';
    }
    this.paint(this.state === 'hair' ? this.hair[this.hairIndex || 0] : this.stills[this.state]);
    if (!this.canGroom()) {
      clearTimeout(this.idleTimer);
      this.idleTimer = 0;
    }
    this.scheduleIdle();
  }

  // 主进程发送的全屏鼠标坐标同样传给麻吕，包含窗口外和副屏负坐标。
  follow(point) {
    this.point = point;
    this.eyes.follow(point);
  }

  // 只有睁眼待机使用眼区动画，捋发、完成和失败期间由原画控制表情。
  syncEyes() {
    if (!this.loaded || !this.enabled || !this.visible || this.state !== 'idle' || this.destroyed) {
      this.eyes.reset();
      return;
    }
    this.eyes.configure(this.idleImage, this.model, this.pose, this.reducedMotion, this.pressed);
    this.eyes.follow(this.point);
  }

  // 工作中只禁止自动动作，手动预览仍响应；隐藏、拖动和减少动态效果继续统一约束。
  canGroom(source = 'idle') {
    return this.visible && !this.destroyed && !this.reducedMotion
      && this.model?.appearance?.settings?.motion !== false
      && this.model?.appearance?.settings?.expressionsEnabled !== false
      && (source === 'preview' || this.model?.appearance?.status !== 'working');
  }

  // 首次出现稍早展示一次，之后采用较长随机间隔；空闲时不维持动画帧循环。
  scheduleIdle() {
    if (!this.loaded || this.state !== 'idle' || !this.canGroom() || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = 0;
      this.firstIdle = false;
      this.showExpression('hair', { source: 'idle' });
    }, this.firstIdle ? 8000 : 35000 + Math.random() * 30000);
  }

  // 主任务完成和失败复用正式表情事件，手动预览也走同一路径并自动返回睁眼待机。
  showExpression(name, { source = 'idle' } = {}) {
    if (!this.enabled) return false;
    if (!this.visible || this.model?.appearance?.settings?.expressionsEnabled === false) return true;
    if (name === 'hair' && !this.canGroom(source)) return true;
    if (!['happy', 'sad', 'hair'].includes(name)) return true;
    if (!this.loaded) {
      this.pendingExpression = { name, source };
      return true;
    }
    this.cancel();
    this.state = name;
    if (name === 'hair') {
      this.hairSource = source === 'preview' ? 'preview' : 'idle';
      this.started = performance.now();
      this.hairIndex = 0;
      this.paint(this.hair[0]);
      this.frame = requestAnimationFrame((time) => this.animate(time));
    } else {
      this.paint(this.stills[name]);
      this.expressionTimer = setTimeout(() => this.restore(), name === 'sad' ? 6000 : 2400);
    }
    return true;
  }

  // 按真实时间播放三十帧，不补间、不叠影；一次动作结束即停止请求动画帧。
  animate(time) {
    this.frame = 0;
    const elapsed = time - this.started;
    if (!this.canGroom(this.hairSource) || elapsed >= HAIR_DURATION) {
      this.restore();
      return;
    }
    this.hairIndex = hairFrameAt(elapsed);
    this.paint(this.hair[this.hairIndex]);
    this.frame = requestAnimationFrame((next) => this.animate(next));
  }

  // 素材与透明命中图在同一次绘制中切换，抬起的手臂能点击，留下的空白可以穿透。
  paint(frame) {
    if (!frame || this.destroyed) return;
    this.canvas.hidden = false;
    this.portrait.style.visibility = 'hidden';
    this.character.dataset.spriteState = this.state;
    if (this.state === 'hair') this.character.dataset.spriteFrame = String(this.hairIndex);
    else delete this.character.dataset.spriteFrame;
    this.syncEyes();
    if (this.lastPaint === frame) return;
    this.lastPaint = frame;
    this.context.clearRect(0, 0, SIZE, SIZE);
    this.context.imageSmoothingQuality = 'high';
    this.context.drawImage(frame.canvas, 0, 0);
    this.onMask(frame.mask);
  }

  // 完成或中断后恢复同一张待机原画，不将最后一张动作帧误留在桌面。
  restore() {
    this.cancel();
    this.state = 'idle';
    if (this.enabled && this.loaded && !this.destroyed) this.paint(this.stills.idle);
    this.scheduleIdle();
  }

  // 集中清理定时器，切换图片或隐藏时不会延迟出现旧角色的手臂。
  cancel() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.expressionTimer);
    cancelAnimationFrame(this.frame);
    this.idleTimer = this.expressionTimer = this.frame = 0;
  }

  // 页面退出后取消所有工作，异步资源返回也不再访问已销毁的窗口。
  destroy() {
    this.destroyed = true;
    this.eyes.reset();
    for (const patch of this.eyes.patches) patch.canvas.remove();
    this.pendingExpression = null;
    this.cancel();
    for (const frame of new Set([...(this.hair || []), ...Object.values(this.stills || {})])) {
      if (frame) frame.canvas.width = frame.canvas.height = 1;
    }
    this.hair = this.stills = null;
  }
}
