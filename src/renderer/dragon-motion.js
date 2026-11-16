import { DEFAULT_CHARACTER_ASSET, EYE_ARTWORK, stepGaze } from '../shared/gaze.js';

// 圈出耳尖、呆毛和发梢的局部动作范围，支点藏在发束接合处。
const PATCHES = [
  { x: 0, y: 605, width: 190, height: 240, vertical: true, drive: 0, weight: earWeight, left: true },
  { x: 1175, y: 691, width: 155, height: 225, vertical: true, drive: 0, weight: earWeight, left: false },
  { x: 558, y: 0, width: 376, height: 224, drive: 1, weight: cowlickWeight },
  { x: 0, y: 858, width: 148, height: 182, drive: 2, weight: lockWeight, left: true, pivot: [105, 914] },
  { x: 1218, y: 934, width: 112, height: 162, drive: 3, weight: lockWeight, left: false, pivot: [1254, 1002] },
];
// 左右发尖分别受力，向外张开的方向相反，右边稍晚一点落回。
const LOCKS = [
  { angle: 0.24, side: -1, frequency: 10.2, damping: 0.78, delay: 20, idle: 0.43, phase: -0.4 },
  { angle: 0.205, side: 1, frequency: 8.5, damping: 0.81, delay: 92, idle: 0.4, phase: -0.94 },
];
const NEUTRAL = { x: 0, y: 0 };
const BREATH_DURATION = 3400;
const REBOUND_DURATION = 950;
const EAR_TAP_CYCLE = 240;
const EAR_TAP_AMPLITUDES = [34, 28];
const HEART_EAR_OFFSET = 43;
// 双耳和呆毛按位移判断是否归零，发尖按旋转角判断。
const SHIFT_MINIMUMS = [0.01, 0.01, 0.00015, 0.00015];

// 平滑衰减区域边缘，变形后的像素能连续接回原画。
function smooth(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

// 一次轻戳只播放两轮抬起再落下；每轮首尾速度归零，第二轮稍轻。
function earTapOffset(age, from) {
  const cycle = Math.floor(age / EAR_TAP_CYCLE);
  if (cycle >= EAR_TAP_AMPLITUDES.length) return 0;
  const phase = age / EAR_TAP_CYCLE - cycle;
  const carry = from * (1 - smooth(age / 54));
  return carry - EAR_TAP_AMPLITUDES[cycle] * Math.sin(phase * Math.PI * 2) * Math.sin(phase * Math.PI) ** 2;
}

// 越靠近耳尖越灵活，贴近耳根或超出耳区时保持原图轮廓。
function earWeight(x, y, left) {
  const tip = left ? (181 - x) / 176 : (x - 1180) / 150;
  const centerY = left ? 734 - x * 0.04 : 820 - (EYE_ARTWORK.width - x) * 0.29;
  return smooth(tip) * (1 - smooth((Math.abs(y - centerY) - 35) / 53));
}

// 给角和发根留出固定边界，呆毛尖只在两个角之间小幅横摆。
function cowlickWeight(x, y) {
  return smooth((x - 558) / 86) * smooth((932 - x) / 100) * smooth((220 - y) / 118);
}

// 内边界沿两绺发尖下的透空间隙走；尖端整块转动，只在与静止头发相接处减弱。
function lockWeight(x, y, left) {
  if (left) {
    const gap = 116 - 30 * smooth((y - 902) / 45);
    return smooth((y - 880) / 61) * smooth((gap - x) / 22) * smooth((1035 - y) / 18);
  }
  const gap = 1238 + 31 * smooth((y - 955) / 64);
  return smooth((y - 945) / 61) * smooth((x - gap) / 21) * smooth((1094 - y) / 15);
}

// 只缓存会动的局部及其权重，按当前桌宠尺寸换算原画坐标。
function preparePatch(context, region) {
  const scaleX = context.canvas.width / EYE_ARTWORK.width;
  const scaleY = context.canvas.height / EYE_ARTWORK.height;
  const x = Math.round(region.x * scaleX);
  const y = Math.round(region.y * scaleY);
  const width = Math.round((region.x + region.width) * scaleX) - x;
  const height = Math.round((region.y + region.height) * scaleY) - y;
  const source = context.getImageData(x, y, width, height);
  const output = context.createImageData(width, height);
  const weights = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const weight = region.weight((x + column + 0.5) / scaleX, (y + row + 0.5) / scaleY, region.left);
      weights[row * width + column] = weight * (region.pivot ? 1 : region.vertical ? scaleY : scaleX);
    }
  }
  // 支点换成采样坐标，纵横缩放的取整误差不应把旋转变成拉伸。
  const pivot = region.pivot && [region.pivot[0] * scaleX - x - 0.5, region.pivot[1] * scaleY - y - 0.5];
  const aspect = scaleX / scaleY;
  return { x, y, width, height, source, output, weights, pivot, aspect, vertical: region.vertical,
    drive: region.drive, shift: 0 };
}

// 每帧从原画逆向取样，不叠加旧轮廓；透明边缘按预乘透明度混合，避免黑边。
function paintPatch(context, patch, shift) {
  const { x, y, width, height, source, output, weights } = patch;
  if (shift === 0) {
    context.putImageData(source, x, y);
    return;
  }
  if (patch.pivot) {
    turnLock(patch, shift);
    context.putImageData(output, x, y);
    return;
  }
  const original = source.data;
  const target = output.data;
  const stride = patch.vertical ? width * 4 : 4;
  const limit = (patch.vertical ? height : width) - 1;
  target.set(original);
  for (let index = 0; index < weights.length; index += 1) {
    if (weights[index] === 0) continue;
    const offset = index * 4;
    const coordinate = patch.vertical ? Math.floor(index / width) : index % width;
    const sample = Math.max(0, Math.min(limit, coordinate - shift * weights[index]));
    const low = Math.floor(sample);
    const mix = sample - low;
    const first = offset + (low - coordinate) * stride;
    const second = offset + (Math.min(low + 1, limit) - coordinate) * stride;
    const firstAlpha = original[first + 3] * (1 - mix);
    const secondAlpha = original[second + 3] * mix;
    const alpha = firstAlpha + secondAlpha;
    target[offset + 3] = alpha;
    if (alpha === 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      target[offset + channel] =
        (original[first + channel] * firstAlpha + original[second + channel] * secondAlpha) / alpha;
    }
  }
  context.putImageData(output, x, y);
}

// 发尖绕支点作刚体转动，只有接缝在原位置和转后位置之间过渡，避免纹理呈水波。
function turnLock({ width, height, source, output, weights, pivot, aspect }, angle) {
  const original = source.data;
  const target = output.data;
  const rowStride = width * 4;
  const cos = Math.cos(angle) - 1;
  const sin = Math.sin(angle);
  target.set(original);
  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index];
    if (weight === 0) continue;
    const column = index % width, line = Math.floor(index / width);
    const dx = column - pivot[0], dy = line - pivot[1];
    const x = Math.max(0, Math.min(width - 1, column + (dx * cos + dy * sin * aspect) * weight));
    const y = Math.max(0, Math.min(height - 1, line + (dy * cos - dx * sin / aspect) * weight));
    const col = Math.floor(x), row = Math.floor(y);
    const fx = x - col, fy = y - row;
    const a = row * rowStride + col * 4;
    const b = a + (col < width - 1 ? 4 : 0);
    const c = a + (row < height - 1 ? rowStride : 0);
    const d = b + c - a;
    // 透明边缘按预乘透明度混合，转开时不会留下上一帧轮廓的重影。
    const aa = original[a + 3] * (1 - fx) * (1 - fy);
    const ab = original[b + 3] * fx * (1 - fy);
    const ac = original[c + 3] * (1 - fx) * fy;
    const ad = original[d + 3] * fx * fy;
    const alpha = aa + ab + ac + ad;
    const offset = index * 4;
    target[offset + 3] = alpha;
    if (alpha === 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      target[offset + channel] = (original[a + channel] * aa + original[b + channel] * ab
        + original[c + channel] * ac + original[d + channel] * ad) / alpha;
    }
  }
}

// 小步推进发梢的速度和位移，鼠标急转或帧间隔变长时仍能自然回稳。
function stepHairSpring(state, target, seconds, { frequency, damping }) {
  let value = state.x, velocity = state.velocity ?? 0;
  const duration = Math.max(0, Math.min(0.064, seconds));
  const steps = Math.max(1, Math.ceil(duration * 120));
  const dt = duration / steps;
  for (let index = 0; index < steps; index += 1) {
    velocity += ((target - value) * frequency ** 2 - 2 * damping * frequency * velocity) * dt;
    value += velocity * dt;
  }
  const settled = Math.abs(target - value) < 0.0015 && Math.abs(velocity) < 0.012;
  return { x: settled ? target : value, velocity: settled ? 0 : velocity, settled };
}

// 沿用原版的鼠标跟随与轻戳，所有局部动作和呼吸共用一条按需运行的动画循环。
export class DragonMotion {
  // 动效画布只替代默认原画，眼睛、表情和点击依旧由原有角色层处理。
  constructor(canvas, onPose) {
    this.canvas = canvas;
    this.onPose = onPose;
    this.frame = 0;
    this.revision = 0;
    this.breathTimer = 0;
    this.breathStarted = null;
    this.breathPausedAt = null;
    this.pokeStarted = null;
    this.pokeFrom = this.rebound = this.breath = this.hairDirection = 0;
    this.earTapFrom = this.earTap = 0;
    this.earTuck = 0;
    this.shifts = [0, 0, 0, 0];
    this.cowlick = this.hairFlow = NEUTRAL;
    this.locks = LOCKS.map(() => NEUTRAL);
    this.direction = this.target = NEUTRAL;
    this.enabled = this.pressed = false;
  }

  // 记下当前绘制尺寸；静止时无需复制原画或计算局部采样权重。
  configure(image, model, blocked, pressed, nativeResolution = false) {
    if (blocked || document.hidden || model.visible === false || model.appearance?.settings?.motion === false
      || model.asset !== DEFAULT_CHARACTER_ASSET || image.src !== model.asset
      || image.naturalWidth !== EYE_ARTWORK.width || image.naturalHeight !== EYE_ARTWORK.height) {
      this.reset();
      return;
    }
    this.enabled = true;
    this.pressed = pressed;
    // 表情按原生像素合成，待机按同一显示矩形取整，交接时底图对齐到相同的像素网格。
    const scale = Math.min(window.devicePixelRatio, image.naturalWidth / model.rect.width, image.naturalHeight / model.rect.height);
    const width = nativeResolution ? image.naturalWidth : Math.max(2, Math.round(model.rect.width * scale));
    const height = nativeResolution ? image.naturalHeight : Math.max(2, Math.round(model.rect.height * scale));
    if (image !== this.image || width !== this.width || height !== this.height) {
      this.image = image;
      this.width = width;
      this.height = height;
      if (!this.canvas.hidden) this.paint(this.shifts);
      else this.releaseSurface();
    }
    if (pressed && this.breathTimer) {
      clearTimeout(this.breathTimer);
      this.breathTimer = 0;
    }
    this.scheduleBreath();
  }

  // 耳朵使用屏幕方向，头发换算回原画方向，镜像后仍跟着同一侧摆。
  follow(direction, flipped) {
    const local = flipped ? -direction : direction;
    if (!this.enabled || (direction === this.target.x && local === this.hairDirection)) return;
    this.target = { x: direction, y: 0 };
    this.hairDirection = local;
    this.wake();
  }

  // 只响应主进程确认的轻戳，连点从当前回弹幅度接上。
  poke() {
    if (!this.enabled || this.pressed) return;
    this.pokeFrom = this.rebound;
    this.earTapFrom = this.earTap;
    this.pokeStarted = performance.now();
    this.wake();
  }

  // 表情的时间轴直接更新局部画布，合成时耳尖和眼神使用同一帧。
  setHeartTuck(tuck) {
    if (!this.enabled || this.earTuck === tuck) return;
    this.earTuck = tuck;
    this.paint(this.shifts);
  }

  // 手动表情期间冻结呼吸在最后一次绘制的时间点，回到待机后从同一相位续接。
  setBreathPaused(paused) {
    if (!this.enabled || paused === (this.breathPausedAt !== null)) return;
    if (paused) {
      this.breathPausedAt = this.breathStarted === null ? performance.now() : this.previousTime;
      clearTimeout(this.breathTimer);
      this.breathTimer = 0;
      return;
    }
    const heldFor = performance.now() - this.breathPausedAt;
    this.breathPausedAt = null;
    if (this.breathStarted === null) this.scheduleBreath();
    else {
      this.breathStarted += heldFor;
      this.wake();
    }
  }

  // 两轮轻呼吸之间只保留一次计时，按住或拖动时暂停启动新一轮。
  scheduleBreath() {
    if (!this.enabled || this.pressed || this.breathTimer || this.breathStarted !== null || this.breathPausedAt !== null) return;
    this.breathTimer = setTimeout(() => {
      this.breathTimer = 0;
      this.breathStarted = performance.now();
      this.wake();
    }, 5000 + Math.random() * 5000);
  }

  // 鼠标和其他动画可以共同唤醒同一条帧循环。
  wake() {
    if (this.frame) return;
    this.previousTime = performance.now();
    this.frame = requestAnimationFrame((time) => this.animate(time));
  }

  // 双耳同步抖两下，呆毛和外侧发尖沿用各自的回摆轨迹。
  animate(time) {
    const seconds = (time - this.previousTime) / 1000;
    this.previousTime = time;
    this.direction = stepGaze(this.direction, this.target, seconds, 0.14);
    const breathTime = this.breathPausedAt ?? time;
    const breathAge = this.breathStarted === null ? BREATH_DURATION : Math.max(0, breathTime - this.breathStarted);
    const phase = Math.PI * breathAge / BREATH_DURATION;
    const envelope = breathAge < BREATH_DURATION ? Math.sin(phase) ** 2 : 0;
    const breath = 0.006 * envelope;
    if (breathAge >= BREATH_DURATION) {
      this.breathStarted = null;
      this.scheduleBreath();
    }
    const pokeAge = this.pokeStarted === null ? REBOUND_DURATION : Math.max(0, time - this.pokeStarted);
    const t = pokeAge / 1000;
    this.rebound = pokeAge < REBOUND_DURATION ? Math.exp(-6.5 * t) * (Math.sin(17 * t) + this.pokeFrom) : 0;
    if (pokeAge >= REBOUND_DURATION) this.pokeStarted = null;
    // 同一个上下位移同时给两只耳朵，光标在最外侧时也给两下回摆留出空间。
    const restingEars = 32 * this.direction.x;
    this.earTap = earTapOffset(pokeAge, this.earTapFrom);
    const headroom = Math.min(1, (43.2 - Math.abs(restingEars)) / 24);
    const ears = restingEars + Math.max(-24, Math.min(24, this.earTap)) * headroom;
    const tuft = Math.max(-1, Math.min(1, 0.86 * this.hairDirection + this.rebound + 0.45 * envelope * Math.sin(phase * 2)));
    this.cowlick = stepGaze(this.cowlick, { x: tuft, y: 0 }, seconds, 0.11);
    // 发尖跟随转向的变化量，鼠标停下后逐渐落回，不会一直被拉往一边。
    this.hairFlow = stepGaze(this.hairFlow, { x: this.hairDirection, y: 0 }, seconds, 0.32);
    const gust = this.hairDirection - this.hairFlow.x;
    const locks = LOCKS.map((part, index) => {
      const kick = Math.sin(Math.PI * Math.max(0, Math.min(1, (pokeAge - part.delay) / 460))) ** 2;
      const drift = part.idle * envelope * (0.5 + 0.5 * Math.sin(phase * 2 + part.phase));
      const target = Math.max(-0.28, Math.min(1, part.side * gust * 0.86 + 0.98 * kick + drift));
      const next = stepHairSpring(this.locks[index], target, seconds, part);
      this.locks[index] = next;
      return -part.side * part.angle * Math.max(-0.3, Math.min(1, next.x));
    });
    const changed = this.paint([ears, this.cowlick.x * 22, ...locks]) || breath !== this.breath;
    this.breath = breath;
    if (changed) this.onPose();
    this.frame = this.direction.settled && this.cowlick.settled && this.hairFlow.settled
      && this.locks.every((state) => state.settled)
      && (this.breathStarted === null || this.breathPausedAt !== null) && this.pokeStarted === null
      ? 0 : requestAnimationFrame((next) => this.animate(next));
  }

  // 实际发生变形时才建立画布；重新缩放后仍沿用原来的取样精度与滤镜。
  prepareSurface() {
    const { canvas, image, width, height } = this;
    if (this.surfaceImage === image && canvas.width === width && canvas.height === height) return false;
    const context = this.context ??= canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = width;
    canvas.height = height;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    this.patches = PATCHES.map((region) => preparePatch(context, region));
    this.surfaceImage = image;
    return true;
  }

  // 隐藏或换到其他尺寸时丢弃失效的像素缓存，避免在待机时保留原生分辨率的图层。
  releaseSurface() {
    if (!this.surfaceImage) return;
    this.surfaceImage = this.patches = null;
    this.canvas.width = 0;
  }

  // 双耳使用第一组位移，爱心眼按进度收耳，其他局部照常取样。
  paint(shifts) {
    this.shifts = shifts;
    const ears = shifts[0] + (HEART_EAR_OFFSET - shifts[0]) * this.earTuck;
    const values = [ears, shifts[1], shifts[2], shifts[3]];
    let active = false;
    for (let drive = 0; drive < values.length; drive += 1) {
      if (Math.abs(values[drive]) >= SHIFT_MINIMUMS[drive]) active = true;
      else values[drive] = 0;
    }
    if (!active) {
      const wasVisible = !this.canvas.hidden;
      if (wasVisible) this.canvas.hidden = true;
      return wasVisible;
    }
    let changed = this.prepareSurface() || this.canvas.hidden;
    for (const patch of this.patches) {
      const next = values[patch.drive];
      if (next === patch.shift) continue;
      paintPatch(this.context, patch, next);
      patch.shift = next;
      changed = true;
    }
    if (this.canvas.hidden) this.canvas.hidden = false;
    if (changed) this.revision += 1;
    return changed;
  }

  // 会动的轮廓使用实际绘制的透明度命中，其他像素沿用原图。
  hit(point) {
    if (this.canvas.hidden) return undefined;
    const x = Math.floor(point.x * this.canvas.width);
    const y = Math.floor(point.y * this.canvas.height);
    for (const patch of this.patches) {
      if (patch.shift === 0) continue;
      const col = x - patch.x;
      const row = y - patch.y;
      if (col >= 0 && col < patch.width && row >= 0 && row < patch.height)
        return patch.output.data[(row * patch.width + col) * 4 + 3] > 24;
    }
    return undefined;
  }

  // 隐藏、切换角色、祈祷或关闭动效时恢复中性，清除还没播放的动作。
  reset() {
    if (!this.enabled) return;
    this.enabled = false;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.breathTimer);
    this.frame = this.breathTimer = 0;
    this.breathStarted = this.breathPausedAt = this.pokeStarted = null;
    this.direction = this.target = NEUTRAL;
    this.image = null;
    this.releaseSurface();
    this.rebound = this.breath = this.hairDirection = 0;
    this.earTapFrom = this.earTap = 0;
    this.earTuck = 0;
    this.shifts = [0, 0, 0, 0];
    this.cowlick = this.hairFlow = NEUTRAL;
    this.locks = LOCKS.map(() => NEUTRAL);
    this.canvas.hidden = true;
    this.onPose();
  }
}
