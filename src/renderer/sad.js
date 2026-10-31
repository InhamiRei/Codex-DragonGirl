import { SAD_CHARACTER_ASSET, SAD_EYES, sadEyeWeight, sadTear } from '../shared/sad.js';
import { EYE_ARTWORK } from '../shared/gaze.js';

let artworkPromise;

// 同一页面共用一次素材解码，角色 ready 前准备好，首次失败事件也能直接显示伤心。
export function loadSadArtwork() {
  if (!artworkPromise) artworkPromise = (async () => {
    const image = new Image();
    image.src = SAD_CHARACTER_ASSET;
    await image.decode();
    if (image.naturalWidth !== EYE_ARTWORK.width || image.naturalHeight !== EYE_ARTWORK.height)
      throw new Error('伤心素材尺寸与默认角色不一致');
    return image;
  })();
  return artworkPromise;
}

// 伤心与开心共用原来的眼区画布、视线和眨眼变换，不在嘴部增加任何图层。
export class SadEyes {
  // 缓存确认过的眼神纹理及羽化、泪池权重，后续帧只处理两块小眼区。
  constructor(eye, width, height, index, image) {
    Object.assign(this, { eye, width, height, index });
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.context.imageSmoothingQuality = 'high';
    this.context.drawImage(image, eye.x, eye.y, eye.width, eye.height, 0, 0, width, height);
    this.source = this.context.getImageData(0, 0, width, height).data;
    this.texture = this.context.createImageData(width, height);
    this.pixels = [];
    const profile = SAD_EYES[index];
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const ax = eye.x + (x + 0.5) * eye.width / width, ay = eye.y + (y + 0.5) * eye.height / height;
      // 额外淡出画布边界，避免眉毛和脸颊出现矩形接缝。
      const edge = Math.max(0, Math.min(1, Math.min(ax - eye.x, eye.x + eye.width - ax, ay - eye.y, eye.y + eye.height - ay) / 10));
      const weight = sadEyeWeight(ax, ay, index) * edge * edge * (3 - 2 * edge);
      if (!weight) continue;
      const waterY = profile.waterY + (ax - profile.irisX) * profile.waterSlope;
      const side = Math.max(0, Math.min(1, (Math.abs(ax - profile.irisX) - 60) / 32));
      const wet = Math.exp(-(((ay - waterY) / 13) ** 2)) * (1 - side * side * (3 - 2 * side));
      this.pixels.push({ x, y, ax, weight, wet, offset: (y * width + x) * 4 });
    }
  }

  // 细长反光沿下眼睑的泪池移动，保留水光质感，不出现开心表情的星芒。
  paintShine(elapsed, amount) {
    const context = this.context, eye = SAD_EYES[this.index];
    const phase = elapsed / 1000 * 2.2 + (this.index === 1 ? 1.2 : 0);
    const x = eye.irisX + Math.sin(phase) * 49;
    const y = eye.waterY + (x - eye.irisX) * eye.waterSlope + Math.sin(phase * 1.7) * 1.4;
    context.save();
    context.translate(x, y);
    context.rotate(eye.waterSlope);
    context.globalAlpha = amount * (0.45 + Math.sin(phase + 0.6) * 0.15);
    context.fillStyle = 'rgb(252, 247, 255)';
    context.beginPath();
    context.ellipse(0, 0, 8.5, 2.2, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  // 小泪珠在眼角生成后缓慢下落，绘制范围固定，不会进入嘴部或角色外侧。
  paintTear(elapsed, amount) {
    if (this.index !== 1) return;
    const { x, y, radius, alpha } = sadTear(elapsed, amount);
    if (alpha <= 0) return;
    const context = this.context;
    context.save();
    context.globalAlpha = alpha;
    const fill = context.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
    fill.addColorStop(0, 'rgba(251, 246, 255, 0.75)');
    fill.addColorStop(1, 'rgba(176, 145, 220, 0.72)');
    context.fillStyle = fill;
    context.strokeStyle = 'rgba(143, 111, 181, 0.65)';
    context.lineWidth = 1.35;
    context.beginPath();
    context.moveTo(x, y - radius * 1.6);
    context.bezierCurveTo(x + radius * 0.25, y - radius * 0.6, x + radius * 1.25, y, x + radius * 0.85, y + radius * 0.7);
    context.bezierCurveTo(x + radius * 0.35, y + radius * 1.5, x - radius * 1.2, y + radius, x - radius * 0.9, y);
    context.bezierCurveTo(x - radius * 0.8, y - radius * 0.7, x - radius * 0.15, y - radius, x, y - radius * 1.6);
    context.fill();
    context.stroke();
    context.fillStyle = 'rgba(255, 252, 255, 0.9)';
    context.beginPath();
    context.ellipse(x - radius * 0.3, y - radius * 0.05, 1.8, 3.2, -0.35, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  // 原图与含泪眼神平滑衔接，波纹仅移动下眼睑纹理，输出仍交给统一视线和眨眼变换。
  illuminate(original, amount, elapsed) {
    const { context, width, height, eye, source, texture } = this;
    texture.data.set(original);
    const phase = elapsed / 1000 * 3.5 + (this.index === 1 ? 0.45 : 0);
    for (const pixel of this.pixels) {
      const sx = Math.max(0, Math.min(width - 2, pixel.x + pixel.wet * Math.cos(phase) * 1.3 * width / eye.width));
      const sy = Math.max(0, Math.min(height - 2, pixel.y + pixel.wet * Math.sin(phase + pixel.ax / 24) * 2.4 * height / eye.height));
      const ix = Math.floor(sx), iy = Math.floor(sy), dx = sx - ix, dy = sy - iy;
      const top = (iy * width + ix) * 4, bottom = top + width * 4;
      const mix = pixel.weight * amount;
      for (let channel = 0; channel < 3; channel += 1) {
        const sampled = (source[top + channel] * (1 - dx) + source[top + 4 + channel] * dx) * (1 - dy)
          + (source[bottom + channel] * (1 - dx) + source[bottom + 4 + channel] * dx) * dy;
        texture.data[pixel.offset + channel] = original[pixel.offset + channel] * (1 - mix) + sampled * mix;
      }
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.putImageData(texture, 0, 0);
    context.save();
    context.scale(width / eye.width, height / eye.height);
    context.translate(-eye.x, -eye.y);
    this.paintShine(elapsed, amount);
    this.paintTear(elapsed, amount);
    context.restore();
    return context.getImageData(0, 0, width, height).data;
  }
}
