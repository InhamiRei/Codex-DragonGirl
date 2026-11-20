import { EYE_ARTWORK, eyeTrackingEnabled, eyeWarpWeight, gazeTarget, stepGaze, bodyFollowPose } from '../shared/gaze.js';
import { isDragonAsset } from '../shared/characters.js';
import { BLINK_DURATION, blinkAmount, nextBlinkDelay, blinkColumn, blinkSourceY, blinkSkinCoverage } from '../shared/blink.js';
import { dragonFaceFrame, happyFrame, isDragonFace } from '../shared/expression.js';
import { EyeSparkles } from './expression.js';
import { SAD_TEAR_X, sadFrame, sadEyeWeight, sadBodyPose } from '../shared/sad.js';
import { SadEyes, loadSadArtwork } from './sad.js';
import { tintedDragonPortrait } from './dragon-portrait.js';
import { dragonEyeTone } from '../shared/dragon-gear.js';

// 表情画布交回待机后留一个短拍，再从同一姿态恢复跟随和呼吸。
const PREVIEW_REST_MS = 180;

// 给脸线旁的权重留一段连续过渡，避免固定和移动区域之间出现硬边。
function smoothEdge(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

// 每行沿原画脸线插值，保持相邻扫描行的过渡位置连续。
function faceEdgeAt(edge, y) {
  let next = 1;
  while (next < edge.length - 1 && y > edge[next][0]) next += 1;
  const [top, start] = edge[next - 1], [bottom, end] = edge[next];
  return start + (y - top) * (end - start) / (bottom - top);
}

// 按角色标定绘制视线与眨眼，支持整眼联动和固定眼眶的小幅虹膜活动。
export class EyeTracker {
  // 两块小画布跟随角色共同缩放和翻转，所有输入仍由原来的透明命中图处理。
  constructor(character, onBodyPose = () => {}, options = {}) {
    this.character = character;
    this.onBodyPose = onBodyPose;
    this.artwork = options.artwork || EYE_ARTWORK;
    this.asset = options.asset;
    this.className = options.className || 'eye-layer';
    this.nativeResolution = options.nativeResolution === true;
    this.supportsExpressions = options.expressions !== false;
    this.onFace = options.onFace;
    this.onBlink = options.onBlink;
    this.supportsBodyFollow = options.bodyFollow !== false;
    this.foregroundMask = options.foregroundMask || null;
    this.gazeMask = options.gazeMask || null;
    this.skinSample = options.skinSample || [640, 800, 20, 20];
    this.patches = [];
    this.point = null;
    this.current = { x: 0, y: 0 };
    this.target = { x: 0, y: 0 };
    this.body = { x: 0, y: 0 };
    this.frame = 0;
    this.enabled = false;
    this.blink = 0;
    this.blinkStarted = null;
    this.blinkTimer = 0;
    this.expression = { amount: 0, hop: 0 };
    this.expressionTime = 0;
    this.expressionStarted = null;
    this.expressionTimer = 0;
    this.expressionFrom = { amount: 0, hop: 0 };
    this.expressionName = null;
    this.expressionPreview = false;
    this.previewRestUntil = 0;
    this.dragonFace = false;
  }

  // ready 前准备含泪素材，加载失败时仍可使用原画、跟随、眨眼与开心效果。
  async prepareSad() {
    try {
      this.sadOriginal = await loadSadArtwork();
      return true;
    } catch {
      console.warn('伤心表情素材暂不可用');
      return false;
    }
  }

  // 素材完成解码后才创建眼区；系统减少动态效果、隐藏窗口和自定义图片均恢复原画。
  configure(image, model, pose, reducedMotion, pressed = false) {
    this.rect = model.rect;
    // 翻转只改变素材朝向，身体保留屏幕上的倾斜方向，再平滑跟随新的局部目标。
    if (this.pose && (this.pose.scaleX < 0) !== (pose.scaleX < 0)) this.body.x *= -1;
    this.pose = pose;
    const settings = model.appearance?.settings || {};
    const expressionsEnabled = this.supportsExpressions && settings.expressionsEnabled !== false;
    const featuresEnabled = reducedMotion ? !!this.onFace && expressionsEnabled
      : settings.eyeTracking !== false || settings.blinkEnabled !== false || expressionsEnabled;
    const matchingAsset = this.asset ? model.asset === this.asset : isDragonAsset(model.asset);
    this.enabled = featuresEnabled && matchingAsset
      && model.visible !== false && !document.hidden && (!image.src || image.src === model.asset)
      && (image.naturalWidth ?? image.width) === this.artwork.width
      && (image.naturalHeight ?? image.height) === this.artwork.height;
    if (!this.enabled) {
      this.reset();
      return;
    }
    // 拖拽或按压期间身体平滑回正，关闭动画反馈则即时回正；眼睛继续跟随。
    let redraw = false;
    this.expressionAllowed = expressionsEnabled && !pressed;
    // 偏好改变时唤醒可能在定格等待的表情，下一帧从原有时间轴切换。
    if (this.dragonFace && reducedMotion !== this.reducedMotion) this.wake();
    this.reducedMotion = reducedMotion;
    this.expressionMotion = !reducedMotion && settings.motion !== false;
    if (!this.expressionAllowed || (reducedMotion && !this.dragonFace)) {
      redraw = this.expression.amount > 0;
      this.cancelExpression();
    }
    this.trackingEnabled = !reducedMotion && eyeTrackingEnabled(model.asset, settings);
    if (!this.trackingEnabled) {
      redraw ||= this.current.x !== 0 || this.current.y !== 0;
      this.current = { x: 0, y: 0 };
      this.target = { x: 0, y: 0 };
    }
    this.bodyEnabled = this.supportsBodyFollow && this.trackingEnabled && settings.motion !== false && !pressed;
    if (!this.trackingEnabled || settings.motion === false) this.body = { x: 0, y: 0 };
    this.blinkingEnabled = !reducedMotion && settings.blinkEnabled !== false && !pressed;
    if (!this.blinkingEnabled) {
      redraw ||= this.blink > 0;
      this.cancelBlink();
    }
    this.paintBody();
    // 只按实际显示密度创建眼区，放大区域后仍不在每帧处理原图全部像素。
    const resolution = this.nativeResolution ? 1
      : Math.min(1, Math.max(0.2, model.rect.width / this.artwork.width * window.devicePixelRatio));
    if (!reducedMotion && (!this.patches.length || resolution !== this.resolution || this.patchImage !== image)) {
      for (const { canvas } of this.patches) canvas.remove();
      this.resolution = resolution;
      // 瞳色改变时重取当前眼区，含泪表情也沿用所选颜色。
      this.patchImage = image;
      const tone = dragonEyeTone(settings);
      if (this.sadOriginal && this.sadTone !== tone) {
        this.sadTone = tone;
        this.sadArtwork = tintedDragonPortrait(this.sadOriginal, tone);
      }
      this.skin = null;
      this.patches = this.artwork.eyes.map((eye, index) => this.createPatch(image, eye, index));
      redraw = true;
    }
    if (redraw) this.paint();
    this.follow(this.point);
    this.scheduleBlink();
  }

  // 素材或显示大小改变时缓存完整眼区，权重只计算一次，轮廓以外的远处像素保持透明。
  createPatch(image, eye, index) {
    // 从原画面颊的无装饰区域采样肤色，闭眼时补齐眼皮，不需要修改或新增角色图片。
    if (!this.skin) {
      const sample = document.createElement('canvas');
      sample.width = sample.height = 1;
      const context = sample.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, ...this.skinSample, 0, 0, 1, 1);
      this.skin = context.getImageData(0, 0, 1, 1).data;
    }
    const canvas = document.createElement('canvas');
    canvas.className = this.className;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.width = Math.ceil(eye.width * this.resolution);
    canvas.height = Math.ceil(eye.height * this.resolution);
    canvas.style.left = `${eye.x / this.artwork.width * 100}%`;
    canvas.style.top = `${eye.y / this.artwork.height * 100}%`;
    canvas.style.width = `${eye.width / this.artwork.width * 100}%`;
    canvas.style.height = `${eye.height / this.artwork.height * 100}%`;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, eye.x, eye.y, eye.width, eye.height, 0, 0, canvas.width, canvas.height);
    const source = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const foreground = this.foregroundMask?.(source, canvas.width, canvas.height, eye)
      ?? (eye.fixedFaceEdge ? new Float32Array(canvas.width * canvas.height) : null);
    const output = context.createImageData(canvas.width, canvas.height);
    const gazeWeights = this.gazeMask?.(source, canvas.width, canvas.height, eye);
    const scaleX = canvas.width / eye.width, scaleY = canvas.height / eye.height;
    const columns = this.onBlink ? null
      : Array.from({ length: canvas.width }, (_, x) => blinkColumn(eye.x + (x + 0.5) / scaleX, eye));
    const pixels = [];
    for (let y = 0; y < canvas.height; y += 1) {
      const ay = eye.y + (y + 0.5) / scaleY;
      const faceX = eye.fixedFaceEdge && faceEdgeAt(eye.fixedFaceEdge, ay);
      for (let x = 0; x < canvas.width; x += 1) {
        const ax = eye.x + (x + 0.5) / scaleX;
        const weight = eyeWarpWeight(ax, ay, eye);
        const pixelIndex = y * canvas.width + x;
        const offset = pixelIndex * 4;
        // 前发和脸线直接露出原画；附近的视线位移提前减弱，避免从发丝采样到脸上。
        if (eye.fixedFaceEdge) foreground[pixelIndex] = 1 - smoothEdge((ax - faceX - 5) / 5);
        const protection = foreground?.[pixelIndex] || 0;
        const gazeWeight = gazeWeights ? (protection > 0 ? 0 : gazeWeights[pixelIndex])
          : eye.fixedFaceEdge ? weight * smoothEdge((ax - Math.max(faceX, eye.gazeMinFaceX) - 6) / 24) : weight;
        if (gazeWeights) gazeWeights[pixelIndex] = gazeWeight;
        if (protection >= 1) continue;
        // 眉毛和泪珠仍在同一眼区内绘制，眼睛外的像素不跟随视线拉扯。
        const tearRegion = this.supportsExpressions && index === 1 && Math.abs(ax - SAD_TEAR_X) <= 17 && ay >= 800 && ay <= 904;
        if (weight > 0 || (this.supportsExpressions && sadEyeWeight(ax, ay, index) > 0) || tearRegion)
          pixels.push({ x, y, index: offset, gazeWeight, protection });
      }
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = true;
    this.character.append(canvas);
    const sparkles = this.supportsExpressions ? new EyeSparkles(eye, canvas.width, canvas.height, index) : null;
    const sad = this.sadArtwork ? new SadEyes(eye, canvas.width, canvas.height, index, this.sadArtwork) : null;
    return { canvas, context, source, output, pixels, columns, eye, index, sparkles, sad, foreground, gazeWeights,
      width: canvas.width, height: canvas.height, scaleX, scaleY };
  }

  // 原生消息允许携带窗口外或副屏上的负坐标，不能把它们当作鼠标离开。
  follow(point) {
    this.point = point;
    if (!this.enabled) return;
    this.target = this.trackingEnabled ? gazeTarget(point, this.rect, this.pose, this.artwork) : { x: 0, y: 0 };
    const bodyTarget = this.bodyEnabled ? this.target : { x: 0, y: 0 };
    if (this.frame || (Math.hypot(this.target.x - this.current.x, this.target.y - this.current.y) < 0.002
      && Math.hypot(bodyTarget.x - this.body.x, bodyTarget.y - this.body.y) < 0.002)) return;
    this.wake();
  }

  // 只有视线、身体或眼皮有动作时请求帧，安静等待下一次眨眼时只保留一个定时器。
  wake() {
    if (this.frame || !this.enabled) return;
    clearTimeout(this.expressionTimer);
    this.expressionTimer = 0;
    this.previousTime = performance.now();
    this.frame = requestAnimationFrame((time) => this.animate(time));
  }

  // 不因连续鼠标消息重新计时，鼠标不动时也会自然轻眨双眼。
  scheduleBlink() {
    if (!this.enabled || !this.blinkingEnabled || this.blinkTimer || this.blinkStarted !== null || this.expressionStarted !== null) return;
    this.blinkTimer = setTimeout(() => {
      this.blinkTimer = 0;
      if (!this.enabled || !this.blinkingEnabled) return;
      this.blinkStarted = performance.now();
      this.wake();
    }, nextBlinkDelay());
  }

  // 隐藏、拖动、换图或关闭开关时恢复睁眼，取消尚未开始或正在进行的轻眨。
  cancelBlink() {
    clearTimeout(this.blinkTimer);
    this.blinkTimer = 0;
    this.blinkStarted = null;
    if (this.blink > 0) this.onBlink?.(0);
    this.blink = 0;
  }

  // 新事件替换上一种表情，同类事件续接亮度；隐藏、拖动和未准备好的素材不积压事件。
  showExpression(name, { source } = {}) {
    const dragonFace = isDragonFace(name);
    if (!this.enabled || !this.expressionAllowed
      || (this.reducedMotion && !dragonFace)
      || (dragonFace ? !this.onFace : !['happy', 'sad'].includes(name))
      || (name === 'sad' && !this.sadArtwork)) return false;
    if (this.expressionName && this.expressionName !== name) {
      this.cancelExpression();
      this.paint();
    }
    // 手动预览的轻弹从零起算，后续自动事件从当前可见姿态开始。
    this.expressionFrom = this.expressionPreview ? { ...this.expression, hop: 0 } : this.expression;
    this.expressionPreview = source === 'preview';
    this.previewRestUntil = 0;
    // 固定眼形接管正在进行的眨眼；开心与伤心仍允许当前自然眨眼完成。
    if (dragonFace) this.cancelBlink();
    else {
      clearTimeout(this.blinkTimer);
      this.blinkTimer = 0;
    }
    this.expressionTime = 0;
    this.expressionStarted = performance.now();
    this.expressionName = name;
    this.dragonFace = dragonFace;
    this.expression = this.expressionFrame();
    // 减少动态效果时首帧就是定格，先画出新表情，再交给帧循环计时。
    if (this.reducedMotion) this.paint();
    // 选中手动表情时先锁定身体，局部表情和眼睛继续逐帧绘制。
    if (this.expressionPreview) this.paintBody();
    this.wake();
    return true;
  }

  // 三种动态画面和白圆眼共用退出机制，原有开心、伤心沿用自己的节奏。
  expressionFrame() {
    const { expressionName, expressionTime, expressionFrom } = this;
    if (this.dragonFace) return dragonFaceFrame(expressionName, expressionTime, expressionFrom, this.reducedMotion);
    return (expressionName === 'sad' ? sadFrame : happyFrame)(expressionTime, expressionFrom);
  }

  // 隐藏、换图、按压和关闭表情时立即恢复，旧完成事件不在稍后重新显示时重放。
  cancelExpression() {
    if (this.dragonFace) this.onFace?.(null, 0, 0);
    clearTimeout(this.expressionTimer);
    this.expressionTimer = 0;
    this.expressionStarted = null;
    this.expressionFrom = { amount: 0, hop: 0 };
    this.expression = { amount: 0, hop: 0 };
    this.expressionTime = 0;
    this.expressionName = null;
    this.expressionPreview = false;
    this.previewRestUntil = 0;
    this.dragonFace = false;
    if (this.supportsExpressions && this.character.dataset.expression !== undefined) delete this.character.dataset.expression;
  }

  // 传出屏幕方向的身体姿态，计算目标仍使用原来的锚点，避免身体追逐自身位移而抖动。
  paintBody(held = this.expressionPreview || performance.now() < this.previewRestUntil) {
    const flipped = this.pose.scaleX < 0;
    const pose = bodyFollowPose(this.body, this.rect, flipped);
    // 与待机交接时沿用已显示的姿态，其他时刻按当前反馈计算身体动作。
    if (this.expressionMotion && !held) {
      pose.translateY -= this.rect.height * 0.018 * this.expression.hop;
      if (this.expressionName === 'sad') {
        const sad = sadBodyPose(this.expressionTime, this.expression.amount, this.rect.height, flipped);
        pose.translateY += sad.translateY;
        pose.angle += sad.angle;
      }
    }
    this.onBodyPose(pose, flipped ? -this.body.x : this.body.x, held);
  }

  // 按角色的视线范围取样，双线性采样保持轮廓平滑，眨眼单独控制眼睑。
  paint() {
    // 独立眼睑可以接管眨眼画面，时序和睁眼时的视线仍由同一个控制器管理。
    const independentLids = this.onBlink && this.blink > 0;
    const closure = independentLids ? 0 : this.blink;
    const amount = this.expression.amount;
    const preview = this.dragonFace && amount > 0;
    this.onFace?.(preview ? this.expressionName : null, amount, this.expressionTime, this.expression);
    for (const patch of this.patches) {
      const { canvas, context, output, pixels, columns, eye, width, height, scaleX, scaleY } = patch;
      // 新眼神已在原画上完成合成，视线画布在预览结束后才恢复覆盖眼部。
      canvas.hidden = independentLids || preview
        || (Math.hypot(this.current.x, this.current.y) < 0.002 && closure === 0 && amount === 0);
      if (canvas.hidden) continue;
      const renderer = this.expressionName === 'sad' ? patch.sad : patch.sparkles;
      const source = amount > 0 && renderer ? renderer.illuminate(patch.source, amount, this.expressionTime) : patch.source;
      // 带前景的眼区先清掉上一帧，固定的像素直接显示底下的原画。
      const masked = this.gazeMask || eye.fixedFaceEdge;
      if (masked) output.data.fill(0);
      for (const { x, y, index, gazeWeight, protection } of pixels) {
        if (masked && closure === 0 && gazeWeight === 0 && amount === 0) continue;
        let sx = x, sy = y;
        let cover = 0;
        if (this.gazeMask) {
          // 先用固定坐标闭合眼皮，再只移动仍可见的虹膜，鼠标不能改变半闭眼的眼睑形状。
          if (closure > 0) {
            const originalY = eye.y + (y + 0.5) / scaleY;
            cover = blinkSkinCoverage(originalY, columns[x], closure);
            sy = (blinkSourceY(originalY, columns[x], closure) - eye.y) * scaleY - 0.5;
          }
          const sourceRow = Math.max(0, Math.min(height - 1, Math.round(sy)));
          const weight = protection > 0 ? 0 : patch.gazeWeights[sourceRow * width + x] * (1 - closure);
          sx -= this.current.x * this.artwork.travel.x * scaleX * weight;
          sy -= this.current.y * this.artwork.travel.y * scaleY * weight;
        } else {
          // 保持原有的眼部联动；贴着前发的眼睑闭合时，先把偏移收回脸内。
          const weight = eye.fixedFaceEdge ? gazeWeight * (1 - closure) : gazeWeight;
          sx = Math.max(0, Math.min(width - 1, x - this.current.x * this.artwork.travel.x * scaleX * weight));
          sy -= this.current.y * this.artwork.travel.y * scaleY * weight;
          if (closure > 0) {
            const column = Math.min(width - 2, Math.floor(sx)), mix = sx - column;
            const originalY = eye.y + (sy + 0.5) / scaleY;
            cover = blinkSkinCoverage(originalY, columns[column], closure, columns[column + 1], mix);
            sy = (blinkSourceY(originalY, columns[column], closure, columns[column + 1], mix) - eye.y) * scaleY - 0.5;
          }
        }
        sx = Math.max(0, Math.min(width - 1, sx));
        const ix = Math.min(width - 2, Math.floor(sx)), dx = sx - ix;
        sy = Math.max(0, Math.min(height - 1, sy));
        const iy = Math.min(height - 2, Math.floor(sy)), dy = sy - iy;
        const top = (iy * width + ix) * 4, bottom = top + width * 4;
        // 固定的发丝和脸线不能作为眼白或闭眼皮肤的取样来源。
        const blocked = (patch.foreground?.[iy * width + ix] || 0) >= 0.5;
        for (let channel = 0; channel < 3; channel += 1) {
          let sampled =
            (source[top + channel] * (1 - dx) + source[top + 4 + channel] * dx) * (1 - dy)
            + (source[bottom + channel] * (1 - dx) + source[bottom + 4 + channel] * dx) * dy;
          if (blocked) sampled = closure > 0 ? this.skin[channel] : patch.source[index + channel];
          const animated = sampled * (1 - cover) + this.skin[channel] * cover;
          const original = patch.source[index + channel];
          output.data[index + channel] = original + (animated - original) * (1 - protection);
        }
        output.data[index + 3] = 255;
      }
      context.putImageData(output, 0, 0);
    }
    this.onBlink?.(this.blink);
    const name = amount > 0 ? this.expressionName : undefined;
    if (!this.supportsExpressions || this.character.dataset.expression === name) return;
    if (name) this.character.dataset.expression = name;
    else delete this.character.dataset.expression;
  }

  // 眼睛先看过去，身体稍慢跟上；两者收敛后一起停止动画，身体帧不重复重绘眼区。
  animate(time) {
    const seconds = (time - this.previousTime) / 1000;
    const previous = this.current;
    const previousBlink = this.blink;
    const previousExpression = this.expression.amount;
    const previousHold = this.expression.holdUntil;
    this.current = stepGaze(this.current, this.target, seconds);
    this.previousTime = time;
    if (this.expressionStarted !== null) {
      this.expressionTime = Math.max(0, time - this.expressionStarted);
      this.expression = this.expressionFrame();
      if (this.expression.finished) {
        if (this.expressionPreview && this.expressionMotion) this.previewRestUntil = time + PREVIEW_REST_MS;
        this.expressionStarted = null;
        this.expressionName = null;
        this.expressionPreview = false;
        this.dragonFace = false;
        this.scheduleBlink();
      }
    }
    // 保留交接前的身体跟随量，闲置后从这里继续收敛到光标目标。
    const held = this.expressionPreview || time < this.previewRestUntil;
    if (!held) this.body = stepGaze(this.body, this.bodyEnabled ? this.target : { x: 0, y: 0 }, seconds, 0.18);
    if (this.blinkStarted !== null) {
      const elapsed = time - this.blinkStarted;
      this.blink = blinkAmount(elapsed);
      if (elapsed >= BLINK_DURATION) {
        this.blinkStarted = null;
        this.scheduleBlink();
      }
    }
    // 停留期间可能仍有视线变化；眼睛收敛后只保留一个唤醒下一次过渡的定时器。
    const { holdUntil } = this.expression;
    if (previous.x !== this.current.x || previous.y !== this.current.y || previousBlink !== this.blink
      || previousExpression !== this.expression.amount || previousHold !== holdUntil
      || (this.expressionStarted !== null && holdUntil === undefined)) this.paint();
    this.paintBody(held);
    if (holdUntil !== undefined && this.current.settled && (this.expressionPreview || this.body.settled)
      && this.blinkStarted === null) {
      this.frame = 0;
      this.expressionTimer = setTimeout(() => this.wake(), this.expressionStarted + holdUntil - performance.now());
      return;
    }
    this.frame = !held && this.current.settled && this.body.settled && this.blinkStarted === null && this.expressionStarted === null
      ? 0 : requestAnimationFrame((next) => this.animate(next));
  }

  // 开关即时生效，清除待执行的帧和上次姿态，重新启用时从原画平滑转向鼠标。
  reset() {
    this.enabled = false;
    this.cancelExpression();
    this.cancelBlink();
    this.blinkingEnabled = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.current = { x: 0, y: 0 };
    this.target = { x: 0, y: 0 };
    this.body = { x: 0, y: 0 };
    this.onBodyPose({ translateX: 0, translateY: 0, angle: 0 });
    for (const { canvas } of this.patches) canvas.hidden = true;
  }
}
