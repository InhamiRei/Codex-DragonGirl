import { EYE_ARTWORK } from '../shared/gaze.js';
import {
  DRAGON_BODICE_RECT, DRAGON_COWLICK_RECT, DRAGON_CROWN_HEIGHT, DRAGON_CROWN_MASK, DRAGON_FOREGROUND,
  DRAGON_HAIRSTYLES, DRAGON_OUTFIT_HEM_Y, DRAGON_TEMPLE_RECT, dragonOutfit,
} from '../shared/dragon-gear.js';
import { tintIris } from '../shared/dragon-iris.js';

// 分层原画与眼区、表情和命中判定共用一套原生坐标。
const root = new URL('../../', import.meta.url);
const hairstyles = new Map(DRAGON_HAIRSTYLES.map((style) => [new URL(style.image, root).href, style]));
// 仅缓存最近三种穿搭，遍历发型与服饰的全部组合也不会常驻全部画布。
const PORTRAIT_CACHE_SIZE = 3;
const portraits = new Map();
const loadingPortraits = new Map();
let foreground;

// 解码后要求图层与原画坐标严格对应，避免合成时重采样透明描边。
async function loadLayer(asset, width = EYE_ARTWORK.width, height = EYE_ARTWORK.height) {
  const image = new Image();
  image.src = asset;
  await image.decode();
  if (image.naturalWidth !== width || image.naturalHeight !== height)
    throw new Error(`龙娘图层尺寸应为 ${width} × ${height}：${asset}`);
  return image;
}

// 统一创建用于配置、桌宠和动作取样的原生尺寸画布。
function portraitCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = EYE_ARTWORK.width;
  canvas.height = EYE_ARTWORK.height;
  return canvas;
}

// 前景接近实色的像素按实色绘制，避免后发颜色透过脸和衣服。
function sharedForeground() {
  if (foreground) return foreground;
  foreground = loadLayer(new URL(DRAGON_FOREGROUND, root).href).then((image) => {
    const canvas = portraitCanvas();
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 3; offset < pixels.data.length; offset += 4) {
      if (pixels.data[offset] >= 250) pixels.data[offset] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
  }).catch((error) => {
    foreground = null;
    throw error;
  });
  return foreground;
}

// 在发型原画上套用已按龙角、前发和下巴开好遮挡的服饰，供配置、桌宠和动作共同取样。
export function loadDragonPortrait(asset, outfit = dragonOutfit()) {
  const key = asset + '|' + outfit.id;
  const cached = portraits.get(key);
  if (cached) {
    portraits.delete(key);
    portraits.set(key, cached);
    return Promise.resolve(cached);
  }
  const loading = loadingPortraits.get(key);
  if (loading) return loading;
  const style = hairstyles.get(asset);
  if (!style) return Promise.reject(new Error('未知的龙娘发型地址'));
  const artwork = loadLayer(new URL(style.artwork, root).href);
  const [left, top, patchWidth, patchHeight] = DRAGON_TEMPLE_RECT;
  const [shoulderX, shoulderY, shoulderWidth, shoulderHeight] = DRAGON_BODICE_RECT;
  const { width, height } = EYE_ARTWORK;
  const layers = Promise.all([
    style.layered ? artwork : null,
    style.layered ? sharedForeground() : artwork,
    outfit.overlay ? loadLayer(new URL(outfit.overlay, root).href) : null,
    outfit.shortHem && style.shortForelock
      ? loadLayer(new URL(outfit.shortHem, root).href, width, height - DRAGON_OUTFIT_HEM_Y) : null,
    outfit.replacesHairpin ? loadLayer(new URL(style.temple, root).href, patchWidth, patchHeight) : null,
    outfit.replacesBodice ? loadLayer(new URL(style.bodice, root).href, shoulderWidth, shoulderHeight) : null,
    outfit.hat ? loadLayer(new URL(DRAGON_CROWN_MASK, root).href, width, DRAGON_CROWN_HEIGHT) : null,
  ]);
  const request = layers.then(([rear, front, clothing, hem, temple, bodice, crown]) => {
    const canvas = portraitCanvas();
    const context = canvas.getContext('2d');
    // 耳侧或肩颈需要露出后发时，先恢复前发和耳朵，再从背面补入当前发型。
    if (temple || bodice) {
      context.save();
      const outside = new Path2D();
      outside.rect(0, 0, width, height);
      if (temple) outside.rect(...DRAGON_TEMPLE_RECT);
      if (bodice) outside.rect(...DRAGON_BODICE_RECT);
      context.clip(outside, 'evenodd');
      context.drawImage(front, 0, 0);
      context.restore();
      if (temple) context.drawImage(temple, left, top);
      if (bodice) context.drawImage(bodice, shoulderX, shoulderY);
    } else {
      context.drawImage(front, 0, 0);
    }
    // 包头帽收起双角，绵羊帽和鱼头套让原画双角从帽缘两侧露出。
    if (crown) {
      context.globalCompositeOperation = 'destination-out';
      if (outfit.hat === 'closed-cap') context.drawImage(crown, 0, 0);
      else context.drawImage(crown, ...DRAGON_COWLICK_RECT, ...DRAGON_COWLICK_RECT);
      context.globalCompositeOperation = 'source-over';
    }
    // 单马尾单独镜像，在前发与头戴背后保持原来发束的朝向。
    if (rear) {
      context.save();
      context.globalCompositeOperation = 'destination-over';
      if (style.mirrorRear) context.setTransform(-1, 0, 0, 1, width, 0);
      context.drawImage(rear, 0, 0, width, height);
      context.restore();
    }
    // 短鬓的衣领来自独立的小图条，完整衣帽与另外五款发型共用。
    if (hem) {
      context.drawImage(clothing, 0, 0, width, DRAGON_OUTFIT_HEM_Y, 0, 0, width, DRAGON_OUTFIT_HEM_Y);
      context.drawImage(hem, 0, DRAGON_OUTFIT_HEM_Y);
    } else if (clothing) {
      context.drawImage(clothing, 0, 0);
    }
    // 正在解码的请求单独去重，完成后才进入缓存。
    portraits.set(key, canvas);
    if (portraits.size > PORTRAIT_CACHE_SIZE) portraits.delete(portraits.keys().next().value);
    return canvas;
  }).finally(() => loadingPortraits.delete(key));
  loadingPortraits.set(key, request);
  return request;
}

// 在目标画布的原生尺寸绘制立绘，自选色只重绘两处虹膜区域。
export function paintDragonPortrait(canvas, image, tone) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  tintDragonEyes(context, tone);
}

// 在原生坐标中只调整虹膜，已合成的半闭眼也能沿用用户选择的瞳色。
export function tintDragonEyes(context, tone) {
  if (tone === null) return;
  for (const { iris } of EYE_ARTWORK.eyes) {
    const rx = iris.rx + 23, ry = iris.ry + 22;
    const left = iris.cx - rx, top = iris.cy - ry;
    const region = context.getImageData(left, top, rx * 2, ry * 2);
    tintIris(region.data, region.width, left, top, iris, tone);
    context.putImageData(region, left, top);
  }
}

// 自选色供视线、表情和原画显示共同取样，默认色复用已载入的画面。
export function tintedDragonPortrait(image, tone = null) {
  if (tone === null) return image;
  const canvas = portraitCanvas();
  paintDragonPortrait(canvas, image, tone);
  return canvas;
}
