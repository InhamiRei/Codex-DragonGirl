import { EyeTracker } from './eyes.js';

// 在眼区的实际显示分辨率栅格化路径，虹膜位移在睫毛和眼眶前平滑归零。
function pathWeights(path, width, height, eye, recess = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const x = width / eye.width, y = height / eye.height;
  ctx.setTransform(x, 0, 0, y, -eye.x * x, -eye.y * y);
  const shape = new Path2D(path);
  ctx.fill(shape);
  if (recess) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = recess;
    ctx.filter = 'blur(' + (9 * x) + 'px)';
    ctx.stroke(shape);
  }
  const rgba = ctx.getImageData(0, 0, width, height).data;
  return Float32Array.from({ length: width * height }, (_, index) => rgba[index * 4 + 3] / 255);
}

// 脸部的遮挡边界由原画直接显示，位移不会把弯入眼前的刘海采到虹膜内部。
function foregroundMask(_source, width, height, eye) {
  return pathWeights(eye.eyelid, width, height, eye).map((alpha) => 1 - alpha);
}

// 刘海遮挡的眼睛用单独的虹膜路径，其余眼睛从眼白边缘向内羽化，固定睫毛。
function gazeMask(_source, width, height, eye) {
  return pathWeights(eye.iris ?? eye.eyelid, width, height, eye, 22);
}

// 全屏光标与眨眼时序沿用现有控制器，遮挡路径来自当前立绘。
export function createPortraitEyes(character, artwork, onBlink) {
  return new EyeTracker(character, undefined, {
    asset: artwork.asset, artwork, className: 'portrait-eye-layer ' + artwork.id + '-eye-layer',
    expressions: false, bodyFollow: false, onBlink,
    foregroundMask, gazeMask,
  });
}
