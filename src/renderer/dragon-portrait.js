import { DEFAULT_CHARACTER_ASSET } from '../shared/characters.js';
import { EYE_ARTWORK } from '../shared/gaze.js';
import { tintIris } from '../shared/dragon-iris.js';

let original;

// 配置页共用一次原版立绘解码，加载失败后可以重试。
export function loadOriginalDragonPortrait() {
  if (!original) {
    const image = new Image();
    image.src = DEFAULT_CHARACTER_ASSET;
    original = image.decode().then(() => image).catch((error) => {
      original = undefined;
      throw error;
    });
  }
  return original;
}

// 在目标画布原生尺寸上绘制原画，自选色只重绘虹膜所在的两个像素区域。
export function paintDragonPortrait(canvas, image, tone) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  if (tone === null) return;
  for (const { iris } of EYE_ARTWORK.eyes) {
    const rx = iris.rx + 23, ry = iris.ry + 22;
    const left = iris.cx - rx, top = iris.cy - ry;
    const region = context.getImageData(left, top, rx * 2, ry * 2);
    tintIris(region.data, region.width, left, top, iris, tone);
    context.putImageData(region, left, top);
  }
}

// 普通桌宠可以直接使用原图；自选色供视线、表情和原画显示共同取样。
export function tintedDragonPortrait(image, tone = null) {
  if (tone === null) return image;
  const canvas = document.createElement('canvas');
  canvas.width = EYE_ARTWORK.width;
  canvas.height = EYE_ARTWORK.height;
  paintDragonPortrait(canvas, image, tone);
  return canvas;
}
