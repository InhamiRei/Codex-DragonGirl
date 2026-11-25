import { MARO_OUTFIT_OFFSETS, maroOutfitLayer } from '../shared/maro-outfits.js';

// 解码已按姿势裁切的服装图层，只有整套帧准备好后才交给桌宠播放。
export async function loadMaroOutfitLayer(outfit, pose) {
  if (!outfit.layerDirectory) return null;
  const [x, y, width, height] = MARO_OUTFIT_OFFSETS[pose];
  const image = new Image();
  image.src = 'dragon://app/' + maroOutfitLayer(outfit, pose);
  await image.decode();
  if (image.naturalWidth !== width || image.naturalHeight !== height)
    throw new Error('麻吕服装图层尺寸异常：' + pose);
  return { image, x, y };
}

// 只在原画内部绘制衣料颜色，原有透明度、发梢和命中轮廓不受影响。
export function paintMaroOutfitLayer(context, layer) {
  if (!layer) return;
  const { image, x, y } = layer;
  context.save();
  // 限定合成范围，避免加速画布重新取样衣料图层以外的原画像素。
  context.beginPath();
  context.rect(x, y, image.naturalWidth, image.naturalHeight);
  context.clip();
  context.globalCompositeOperation = 'source-atop';
  context.drawImage(image, x, y);
  context.restore();
}
