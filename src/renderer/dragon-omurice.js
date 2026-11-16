import { EYE_ARTWORK } from '../shared/gaze.js';
import { clamp } from '../shared/geometry.js';
import { OMURICE_BOTTLE_EXIT } from '../shared/expression.js';

// 用 PNG 保留原裁切盘面的半透明像素，运行时不再裁切、拉伸或解码未显示的图层。
const ASSET = new URL('../../assets/characters/codex-dragon-girl-omurice-plate.png', import.meta.url).href;
const PLATE_IMAGE_WIDTH = 636;
const PLATE_IMAGE_HEIGHT = 298;

// 盘子居中贴近原画底边，瓶嘴在盘面正上方跟着落点移动。
const PLATE_WIDTH = 480;
const PLATE_SCALE = PLATE_WIDTH / PLATE_IMAGE_WIDTH;
const PLATE_LEFT = (EYE_ARTWORK.width - PLATE_WIDTH) / 2;
const PLATE_TOP = EYE_ARTWORK.height - PLATE_IMAGE_HEIGHT * PLATE_SCALE - 10;

// 爱心从凹口起笔，画在蛋皮饱满的中上部，底尖离开蛋皮边缘。
const HEART_START = [318, 113];
const HEART_CURVES = [
  [289, 75, 228, 65, 202, 95],
  [165, 139, 246, 172, 319, 195],
  [388, 168, 466, 131, 431, 90],
  [403, 62, 345, 73, ...HEART_START],
];
const CURVE_SAMPLES = 32;
const SAUCE_START = 220;
const SAUCE_END = 1950;
const NOZZLE = { x: 84, y: 312 };
const BOTTLE_HEIGHT_SCALE = .83;

// 缓入缓出时改变瓶嘴的离盘高度，让悬浮入场和收瓶连续衔接。
function smooth(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

// 细分曲线得到同一条绘制路径和落酱位置，转弯时也能保持均匀的描画速度。
function traceHeart() {
  const path = new Path2D();
  let [startX, startY] = HEART_START;
  let length = 0;
  const points = [{ x: startX, y: startY, distance: length }];
  path.moveTo(startX, startY);
  for (const [ax, ay, bx, by, endX, endY] of HEART_CURVES) {
    for (let step = 1; step <= CURVE_SAMPLES; step += 1) {
      const t = step / CURVE_SAMPLES, u = 1 - t;
      const x = u ** 3 * startX + 3 * u ** 2 * t * ax + 3 * u * t ** 2 * bx + t ** 3 * endX;
      const y = u ** 3 * startY + 3 * u ** 2 * t * ay + 3 * u * t ** 2 * by + t ** 3 * endY;
      const previous = points.at(-1);
      length += Math.hypot(x - previous.x, y - previous.y);
      points.push({ x, y, distance: length });
      path.lineTo(x, y);
    }
    startX = endX;
    startY = endY;
  }
  path.closePath();
  return { path, points, length };
}

const SAUCE_GUIDE = traceHeart();

// 在采样点之间按弧长插值，让酱流末端始终接到当前笔尖。
function sauceTip(progress) {
  const { points, length } = SAUCE_GUIDE;
  const distance = length * progress;
  const index = points.findIndex((point, index) => index > 0 && point.distance >= distance);
  const start = points[index - 1], end = points[index];
  const t = (distance - start.distance) / (end.distance - start.distance);
  return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
}

// 加长红瓶的上段，放大奶白标签和倒置尖嘴，预绘成透明贴图。
function makeBottle() {
  const sprite = new OffscreenCanvas(168, 318);
  const context = sprite.getContext('2d');
  const body = new Path2D('M27 18 C52 4 113 4 141 18 C155 24 161 37 158 60 '
    + 'L151 194 C149 216 138 231 117 239 L51 239 C31 231 19 216 17 193 L10 60 C8 38 12 25 27 18 Z');
  const cap = new Path2D('M52 232 Q84 242 116 232 L112 265 Q84 278 56 265 Z');
  const spout = new Path2D('M66 262 H102 L96 295 Q92 308 84 312 Q76 309 72 296 Z');
  const red = context.createLinearGradient(10, 0, 158, 0);
  red.addColorStop(0, '#d94756');
  red.addColorStop(.28, '#fa7175');
  red.addColorStop(.68, '#eb4c59');
  red.addColorStop(1, '#b53950');
  context.fillStyle = red;
  context.strokeStyle = '#562840';
  context.lineWidth = 6.5;
  context.lineJoin = 'round';
  context.fill(spout);
  context.stroke(spout);
  context.fill(body);
  // 奶白标签顺着瓶身弯曲，绿边和番茄图案在小尺寸下也能辨认。
  context.save();
  context.clip(body);
  context.fillStyle = '#fff2df';
  context.fill(new Path2D('M10 101 Q84 116 158 101 L153 178 Q84 196 15 178 Z'));
  context.strokeStyle = '#74a369';
  context.lineWidth = 7;
  context.stroke(new Path2D('M11 112 Q84 126 157 112 M14 168 Q84 185 154 168'));
  context.fillStyle = '#e85153';
  context.beginPath();
  context.ellipse(84, 149, 24, 16, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#49724e';
  context.fill(new Path2D('M83 137 Q77 130 69 130 L74 136 L68 141 L79 140 L85 146 L90 140 L101 139 '
    + 'L92 135 L97 128 Q90 129 83 137 Z'));
  context.fillStyle = '#ffaaa1';
  context.fill(new Path2D('M25 44 Q25 29 43 24 L70 20 Q79 21 74 28 L46 34 Q34 38 33 49 Q24 56 25 44 Z'));
  context.restore();
  context.stroke(body);
  context.fillStyle = red;
  context.fill(cap);
  context.stroke(cap);
  context.strokeStyle = '#ff9291';
  context.lineWidth = 4.5;
  context.lineCap = 'round';
  context.stroke(new Path2D('M65 244 L66 262 M81 245 L81 264 M99 244 L98 262 M81 280 L83 297'));
  return sprite;
}

// 每次播放共用同一张透明盘面和预绘的悬浮酱瓶。
export class DragonOmurice {
  // 首次预览时解码盘面，尺寸不符或加载失败只停用蛋包饭表情。
  async prepare() {
    try {
      const image = new Image();
      image.src = ASSET;
      await image.decode();
      if (image.naturalWidth !== PLATE_IMAGE_WIDTH || image.naturalHeight !== PLATE_IMAGE_HEIGHT)
        throw new Error('蛋包饭盘面尺寸不匹配');
      this.bottle = makeBottle();
      this.sprite = image;
    } catch (error) {
      console.warn('蛋包饭贴图暂不可用：', error.message);
    }
  }

  // 先画盘面和已经落下的酱线，再把悬空的瓶子叠在最前方。
  paint(context, time, amount, animate) {
    if (!this.sprite) return;
    const progress = animate ? clamp((time - SAUCE_START) / (SAUCE_END - SAUCE_START), 0, 1) : 1;
    context.save();
    context.globalAlpha = amount;
    context.translate(PLATE_LEFT, PLATE_TOP);
    context.scale(PLATE_SCALE, PLATE_SCALE);
    context.drawImage(this.sprite, 0, 0);
    if (progress > 0) this.paintSauce(context, progress);
    this.paintBottle(context, time, progress, animate);
    context.restore();
  }

  // 深红的边缘和顶部窄高光模拟番茄酱的厚度，圆形笔尖随着同一条酱线前进。
  paintSauce(context, progress) {
    const { path, length } = SAUCE_GUIDE;
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (progress < 1) context.setLineDash([length * progress, length]);
    context.strokeStyle = '#aa2d23';
    context.lineWidth = 27;
    context.stroke(path);

    context.translate(0, -2);
    const sauce = context.createLinearGradient(0, 76, 0, 195);
    sauce.addColorStop(0, '#f65135');
    sauce.addColorStop(1, '#d93b27');
    context.strokeStyle = sauce;
    context.lineWidth = 20;
    context.stroke(path);

    context.translate(0, -1.6);
    context.strokeStyle = '#ff976a';
    context.lineWidth = 4;
    context.stroke(path);
    context.restore();
  }

  // 瓶嘴与蛋皮保持间距，沿心形逐段挤酱，画完后提起并露出完整心形。
  paintBottle(context, time, progress, animate) {
    if (animate && time >= OMURICE_BOTTLE_EXIT) return;
    // 减少动态效果时，大瓶停在心形凹口正上方，与完整爱心一起呈现。
    const tip = sauceTip(progress);
    const settle = animate ? smooth(time / SAUCE_START) : 1;
    const lift = animate ? smooth((time - SAUCE_END) / (OMURICE_BOTTLE_EXIT - SAUCE_END)) : 0;
    const flow = animate ? clamp(Math.min((time - SAUCE_START) / 70, (SAUCE_END - time) / 80), 0, 1) : 0;
    // 瓶嘴和落点共用横坐标，酱流竖直下落，收瓶时沿原地抬起。
    const gap = 54 + .18 * Math.max(0, tip.y - 110);
    const x = tip.x;
    const y = tip.y - gap - 18 * (1 - settle) - 48 * lift;
    context.save();
    context.globalAlpha *= 1 - lift;
    if (flow > 0) {
      // 酱流用亮红色酱芯和深色边缘两笔绘制，让小尺寸下的直落轨迹也能看清。
      const stream = new Path2D();
      stream.moveTo(x, y);
      stream.lineTo(x, tip.y);
      context.lineCap = 'round';
      context.strokeStyle = '#a92d24';
      context.lineWidth = 15 * flow;
      context.stroke(stream);
      context.strokeStyle = '#eb4b36';
      context.lineWidth = 10 * flow;
      context.stroke(stream);
    }
    context.translate(x, y);
    // 纵向缩短展示比例，让大瓶在画到爱心高处时少遮住笑眼。
    context.scale(1 - .06 * flow, BOTTLE_HEIGHT_SCALE);
    context.drawImage(this.bottle, -NOZZLE.x, -NOZZLE.y);
    context.restore();
  }
}
