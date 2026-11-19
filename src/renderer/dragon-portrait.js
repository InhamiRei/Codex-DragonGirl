import { EYE_ARTWORK } from '../shared/gaze.js';
import { DRAGON_FOREGROUND, DRAGON_HAIRSTYLES } from '../shared/dragon-gear.js';
import { tintIris } from '../shared/dragon-iris.js';

// 分层原画与眼区、表情和命中判定共用一套原生坐标。
const root = new URL('../../', import.meta.url);
const hairstyles = new Map(DRAGON_HAIRSTYLES.map((style) => [new URL(style.image, root).href, style]));
// 保留最近三张完整画布，各窗口切过全部发型后也只保留这三张缓存。
const PORTRAIT_CACHE_SIZE = 3;
const portraits = new Map();
const loadingPortraits = new Map();
let foreground;

// 图层完整解码后再合成，允许生成画布与原生尺寸有 1 像素的取整差。
async function loadLayer(asset) {
  const image = new Image();
  image.src = asset;
  await image.decode();
  if (Math.abs(image.naturalWidth - EYE_ARTWORK.width) > 1 || Math.abs(image.naturalHeight - EYE_ARTWORK.height) > 1)
    throw new Error('龙娘图层尺寸与原生画布不一致：' + asset);
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

// 分层发型从后向前画，完整立绘直接画入同样的原生画布供配置、桌宠和动作使用。
export function loadDragonPortrait(asset) {
  const cached = portraits.get(asset);
  if (cached) {
    portraits.delete(asset);
    portraits.set(asset, cached);
    return Promise.resolve(cached);
  }
  const loading = loadingPortraits.get(asset);
  if (loading) return loading;
  const style = hairstyles.get(asset);
  if (!style) return Promise.reject(new Error('未知的龙娘发型地址'));
  const layers = style.rearImage === null
    ? Promise.all([null, loadLayer(asset)])
    : Promise.all([loadLayer(new URL(style.rearImage, root).href), sharedForeground()]);
  const request = layers.then(([rear, front]) => {
    const canvas = portraitCanvas();
    const context = canvas.getContext('2d');
    // 单马尾沿原画中线摆到右侧，龙角、耳朵和发饰绘制时使用正常坐标。
    if (rear) {
      if (style.mirrorRear) context.setTransform(-1, 0, 0, 1, canvas.width, 0);
      context.drawImage(rear, 0, 0, canvas.width, canvas.height);
      context.resetTransform();
    }
    context.drawImage(front, 0, 0);
    // 正在解码的请求单独去重，完成后才进入缓存。
    portraits.set(asset, canvas);
    if (portraits.size > PORTRAIT_CACHE_SIZE) portraits.delete(portraits.keys().next().value);
    return canvas;
  }).finally(() => loadingPortraits.delete(asset));
  loadingPortraits.set(asset, request);
  return request;
}

// 在目标画布的原生尺寸绘制立绘，自选色只重绘两处虹膜区域。
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

// 自选色供视线、表情和原画显示共同取样，默认色复用已载入的画面。
export function tintedDragonPortrait(image, tone = null) {
  if (tone === null) return image;
  const canvas = portraitCanvas();
  paintDragonPortrait(canvas, image, tone);
  return canvas;
}
