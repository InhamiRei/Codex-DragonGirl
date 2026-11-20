import { KOKKORO_ASSET } from '../shared/characters.js';

// 表情素材无损保存 B 版的原生脸部像素，帽子、花饰和衣领由待机立绘绘制。
const FILES = { half: 'blink-half.png', closed: 'blink-closed.png', happy: 'success.png', sad: 'failure.png' };
const FACE = 'M 253 536 C 294 486 374 468 464 481 C 540 488 586 476 641 489 C 722 503 760 563 784 630 C 789 676 819 718 840 761 C 854 804 831 861 792 897 C 766 931 700 949 650 951 C 573 958 522 977 449 969 C 370 959 301 921 266 876 C 234 833 230 783 228 737 C 225 670 226 587 253 536 Z';
export const KOKKORO_FACE_BOUNDS = { x: 197, y: 448, width: 692, height: 560 };

// 羽化只发生在远离眼白、眼线和嘴角的边缘，表情区整块采用同一张画。
function faceMask() {
  const { x, y, width, height } = KOKKORO_FACE_BOUNDS;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.translate(-x, -y);
  ctx.filter = 'blur(11px)';
  ctx.fill(new Path2D(FACE));
  return canvas;
}

// 在原生尺寸上合成并缓存表情。每张文件就是脸部区域，直接解码所需像素。
export async function loadKokkoroFrames() {
  const mask = faceMask();
  const { width, height } = KOKKORO_FACE_BOUNDS;
  const layers = await Promise.all(Object.entries(FILES).map(async ([name, file]) => {
    const image = new Image();
    image.src = new URL(file, KOKKORO_ASSET).href;
    await image.decode();
    if (image.naturalWidth !== width || image.naturalHeight !== height)
      throw new Error('可可萝表情帧尺寸与脸部区域不一致：' + file);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    // 原画脸内接近不透明的像素完全采用表情帧，避免睁眼原图从闭眼帧下透出来。
    const pixels = ctx.getImageData(0, 0, width, height);
    for (let offset = 3; offset < pixels.data.length; offset += 4)
      if (pixels.data[offset] >= 245) pixels.data[offset] = 255;
    ctx.putImageData(pixels, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask, 0, 0);
    return [name, canvas];
  }));
  return new Map(layers);
}
