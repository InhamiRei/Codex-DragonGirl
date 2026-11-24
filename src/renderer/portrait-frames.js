// 表情文件只含原生脸部像素，头饰和衣领始终由待机立绘绘制。
const FILES = { half: 'blink-half', closed: 'blink-closed', happy: 'success', sad: 'failure' };

// 羽化只发生在远离眼白、眼线和嘴角的边缘，表情区整块采用同一张画。
function faceMask({ x, y, width, height, path }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.translate(-x, -y);
  ctx.filter = 'blur(11px)';
  ctx.fill(new Path2D(path));
  return canvas;
}

// 在原生尺寸上合成并缓存表情。每张文件就是脸部区域，直接解码所需像素。
export async function loadPortraitFrames({ asset, face }, names = Object.keys(FILES)) {
  const mask = face.path ? faceMask(face) : null;
  const { width, height, extension = 'png' } = face;
  const layers = await Promise.all(names.map(async (name) => {
    const image = new Image();
    image.src = new URL(FILES[name] + '.' + extension, asset).href;
    await image.decode();
    if (image.naturalWidth !== width || image.naturalHeight !== height)
      throw new Error('表情帧尺寸与脸部区域不一致：' + image.src);
    // 已分离的五官直接使用文件的透明度，避免重复描画底图的头发和脸线。
    if (!mask) return [name, image];
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
