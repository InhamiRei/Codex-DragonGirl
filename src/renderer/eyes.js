import { DEFAULT_CHARACTER_ASSET, EYE_ARTWORK, eyeTrackingEnabled, eyeWarpWeight, gazeTarget, stepGaze, bodyFollowPose } from '../shared/gaze.js';
import { BLINK_DURATION, blinkAmount, nextBlinkDelay, blinkColumn, blinkSourceY, blinkSkinCoverage } from '../shared/blink.js';
import { happyFrame } from '../shared/expression.js';
import { EyeSparkles } from './expression.js';
import { sadFrame, sadEyeWeight, sadBodyPose } from '../shared/sad.js';
import { SadEyes, loadSadArtwork } from './sad.js';

// 按角色标定绘制视线与眨眼，支持整眼联动和固定眼眶的小幅虹膜活动。
export class EyeTracker {
  // 两块小画布跟随角色共同缩放和翻转，所有输入仍由原来的透明命中图处理。
  constructor(character, onBodyPose = () => {}, options = {}) {
    this.character = character;
    this.onBodyPose = onBodyPose;
    this.artwork = options.artwork || EYE_ARTWORK;
    this.asset = options.asset || DEFAULT_CHARACTER_ASSET;
    this.className = options.className || 'eye-layer';
    this.nativeResolution = options.nativeResolution === true;
    this.supportsExpressions = options.expressions !== false;
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
    this.expressionFrom = { amount: 0, hop: 0 };
    this.expressionName = null;
    this.sadImage = null;
  }

  // ready 前准备含泪素材，加载失败时仍可使用原画、跟随、眨眼与开心效果。
  async prepareSad() {
    try {
      this.sadImage = await loadSadArtwork();
      for (const patch of this.patches)
        patch.sad = new SadEyes(patch.eye, patch.width, patch.height, patch.index, this.sadImage);
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
    this.enabled = model.asset === this.asset
      && (settings.eyeTracking !== false || settings.blinkEnabled !== false
        || (this.supportsExpressions && settings.expressionsEnabled !== false))
      && model.visible !== false && !reducedMotion && !document.hidden && image.src === model.asset
      && image.naturalWidth === this.artwork.width && image.naturalHeight === this.artwork.height;
    if (!this.enabled) {
      this.reset();
      return;
    }
    // 拖拽或按压期间身体平滑回正，关闭动画反馈则即时回正；眼睛继续跟随。
    let redraw = false;
    this.expressionAllowed = this.supportsExpressions && settings.expressionsEnabled !== false && !pressed;
    this.expressionMotion = settings.motion !== false;
    if (!this.expressionAllowed) {
      redraw = this.expression.amount > 0;
      this.cancelExpression();
    }
    this.trackingEnabled = eyeTrackingEnabled(model.asset, settings);
    if (!this.trackingEnabled) {
      redraw ||= this.current.x !== 0 || this.current.y !== 0;
      this.current = { x: 0, y: 0 };
      this.target = { x: 0, y: 0 };
    }
    this.bodyEnabled = this.supportsBodyFollow && this.trackingEnabled && settings.motion !== false && !pressed;
    if (!this.trackingEnabled || settings.motion === false) this.body = { x: 0, y: 0 };
    this.blinkingEnabled = settings.blinkEnabled !== false && !pressed;
    if (!this.blinkingEnabled) {
      redraw ||= this.blink > 0;
      this.cancelBlink();
    }
    this.paintBody();
    // 只按实际显示密度创建眼区，放大区域后仍不在每帧处理原图全部像素。
    const resolution = this.nativeResolution ? 1
      : Math.min(1, Math.max(0.2, model.rect.width / this.artwork.width * window.devicePixelRatio));
    if (!this.patches.length || resolution !== this.resolution) {
      for (const { canvas } of this.patches) canvas.remove();
      this.resolution = resolution;
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
    const foreground = this.foregroundMask?.(source, canvas.width, canvas.height, eye);
    const output = context.createImageData(canvas.width, canvas.height);
    const gazeWeights = this.gazeMask?.(source, canvas.width, canvas.height, eye);
    const scaleX = canvas.width / eye.width, scaleY = canvas.height / eye.height;
    const columns = Array.from({ length: canvas.width }, (_, x) => blinkColumn(eye.x + (x + 0.5) / scaleX, eye));
    const pixels = [];
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const ax = eye.x + (x + 0.5) / scaleX, ay = eye.y + (y + 0.5) / scaleY;
        const weight = eyeWarpWeight(ax, ay, eye);
        const offset = (y * canvas.width + x) * 4;
        const protection = foreground?.[y * canvas.width + x] || 0;
        const gazeWeight = gazeWeights ? (protection > 0 ? 0 : gazeWeights[y * canvas.width + x]) : weight;
        if (gazeWeights) gazeWeights[y * canvas.width + x] = gazeWeight;
        if (protection >= 1) continue;
        // 眉毛和泪珠仍在同一眼区内绘制，眼睛外的像素不跟随视线拉扯。
        const tearRegion = this.supportsExpressions && index === 1 && ax >= 884 && ax <= 918 && ay >= 800 && ay <= 904;
        if (weight > 0 || (this.supportsExpressions && sadEyeWeight(ax, ay, index) > 0) || tearRegion)
          pixels.push({ x, y, index: offset, weight, gazeWeight, protection });
      }
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = true;
    this.character.append(canvas);
    const sparkles = this.supportsExpressions ? new EyeSparkles(eye, canvas.width, canvas.height, index) : null;
    const sad = this.sadImage ? new SadEyes(eye, canvas.width, canvas.height, index, this.sadImage) : null;
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
    this.blink = 0;
  }

  // 新事件替换上一种表情，同类事件续接亮度；隐藏、拖动和未准备好的素材不积压事件。
  showExpression(name) {
    if (!['happy', 'sad'].includes(name) || !this.enabled || !this.expressionAllowed
      || (name === 'sad' && !this.sadImage)) return false;
    if (this.expressionName && this.expressionName !== name) {
      this.cancelExpression();
      this.paint();
    }
    this.expressionFrom = { amount: this.expression.amount, hop: this.expression.hop };
    // 已经开始的自然眨眼正常结束，只暂停下一次计时，避免突然睁眼。
    clearTimeout(this.blinkTimer);
    this.blinkTimer = 0;
    this.expressionTime = 0;
    this.expressionStarted = performance.now();
    this.expressionName = name;
    this.expression = (name === 'sad' ? sadFrame : happyFrame)(0, this.expressionFrom);
    this.wake();
    return true;
  }

  // 隐藏、换图、按压和关闭表情时立即恢复，旧完成事件不在稍后重新显示时重放。
  cancelExpression() {
    this.expressionStarted = null;
    this.expressionFrom = { amount: 0, hop: 0 };
    this.expression = { amount: 0, hop: 0 };
    this.expressionTime = 0;
    this.expressionName = null;
    if (this.supportsExpressions) delete this.character.dataset.expression;
  }

  // 传出屏幕方向的身体姿态，计算目标仍使用原来的锚点，避免身体追逐自身位移而抖动。
  paintBody() {
    const pose = bodyFollowPose(this.body, this.rect, this.pose.scaleX < 0);
    if (this.expressionMotion) pose.translateY -= this.rect.height * 0.018 * this.expression.hop;
    if (this.expressionMotion && this.expressionName === 'sad') {
      const sad = sadBodyPose(this.expressionTime, this.expression.amount, this.rect.height, this.pose.scaleX < 0);
      pose.translateY += sad.translateY;
      pose.angle += sad.angle;
    }
    this.onBodyPose(pose);
  }

  // 按角色的视线范围取样，双线性采样保持轮廓平滑，眨眼单独控制眼睑。
  paint() {
    const closure = this.blink;
    for (const patch of this.patches) {
      const { canvas, context, output, pixels, columns, eye, width, height, scaleX, scaleY } = patch;
      canvas.hidden = Math.hypot(this.current.x, this.current.y) < 0.002 && closure === 0 && this.expression.amount === 0;
      if (canvas.hidden) continue;
      const renderer = this.expressionName === 'sad' ? patch.sad : patch.sparkles;
      const source = this.expression.amount > 0 && renderer
        ? renderer.illuminate(patch.source, this.expression.amount, this.expressionTime) : patch.source;
      // 局部视线模式每次清除上一轮覆盖；未移动的区域直接显示原图，像素与透明度都不改。
      if (this.gazeMask) output.data.fill(0);
      for (const { x, y, index, gazeWeight, protection } of pixels) {
        if (this.gazeMask && closure === 0 && gazeWeight === 0) continue;
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
          // 龙娘保留原有整眼联动，先还原视线位移再闭合眼皮。
          sx = Math.max(0, Math.min(width - 1, x - this.current.x * this.artwork.travel.x * scaleX * gazeWeight));
          sy -= this.current.y * this.artwork.travel.y * scaleY * gazeWeight;
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
        // 刘海遮挡属于固定前景，不能把移动前采到的橘发颜色带进眼白。
        const blocked = (patch.foreground?.[iy * width + ix] || 0) >= 0.5;
        for (let channel = 0; channel < 3; channel += 1) {
          let sampled =
            (source[top + channel] * (1 - dx) + source[top + 4 + channel] * dx) * (1 - dy)
            + (source[bottom + channel] * (1 - dx) + source[bottom + 4 + channel] * dx) * dy;
          if (blocked) sampled = closure > 0 ? this.skin[channel] : patch.source[index + channel];
          const animated = sampled * (1 - cover) + this.skin[channel] * cover;
          output.data[index + channel] = animated * (1 - protection) + patch.source[index + channel] * protection;
        }
        output.data[index + 3] = 255;
      }
      context.putImageData(output, 0, 0);
    }
    if (this.supportsExpressions) {
      if (this.expression.amount > 0) this.character.dataset.expression = this.expressionName;
      else delete this.character.dataset.expression;
    }
  }

  // 眼睛先看过去，身体稍慢跟上；两者收敛后一起停止动画，身体帧不重复重绘眼区。
  animate(time) {
    const seconds = (time - this.previousTime) / 1000;
    const previous = this.current;
    const previousBlink = this.blink;
    const previousExpression = this.expression.amount;
    this.current = stepGaze(this.current, this.target, seconds);
    this.body = stepGaze(this.body, this.bodyEnabled ? this.target : { x: 0, y: 0 }, seconds, 0.18);
    this.previousTime = time;
    if (this.expressionStarted !== null) {
      this.expressionTime = Math.max(0, time - this.expressionStarted);
      this.expression = (this.expressionName === 'sad' ? sadFrame : happyFrame)(this.expressionTime, this.expressionFrom);
      if (this.expression.finished) {
        this.expressionStarted = null;
        this.expressionName = null;
        this.scheduleBlink();
      }
    }
    if (this.blinkStarted !== null) {
      const elapsed = time - this.blinkStarted;
      this.blink = blinkAmount(elapsed);
      if (elapsed >= BLINK_DURATION) {
        this.blinkStarted = null;
        this.scheduleBlink();
      }
    }
    if (previous.x !== this.current.x || previous.y !== this.current.y || previousBlink !== this.blink
      || previousExpression !== this.expression.amount || this.expressionStarted !== null) this.paint();
    this.paintBody();
    this.frame = this.current.settled && this.body.settled && this.blinkStarted === null && this.expressionStarted === null
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
