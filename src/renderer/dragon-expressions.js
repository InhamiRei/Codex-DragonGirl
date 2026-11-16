import { EYE_ARTWORK } from '../shared/gaze.js';
import { OMURICE_BOTTLE_EXIT } from '../shared/expression.js';
import { DragonOmurice } from './dragon-omurice.js';

const ASSET = new URL('../../assets/characters/codex-dragon-girl-expressions.png', import.meta.url).href;
const [LEFT_EYE, RIGHT_EYE] = EYE_ARTWORK.eyes;
const ROW_HEIGHT = RIGHT_EYE.height;
// 第三行只擦掉旧眼线，旋转的部分另外绘制，发际线不参与旋转。
const ATLAS_ROWS = { heart: 0, 'white-eyes': 1, 'spiral-eyes': 2 };
const SPIRALS = [
  { x: 491, y: 740, radius: 95, clip: new Path2D('M408 641 Q437 618 512 628 Q518 651 554 677 '
    + 'Q572 691 579 725 C591 748 596 782 580 810 Q567 834 534 848 Q469 872 408 835 '
    + 'Q391 804 394 747 Q394 677 408 641 Z') },
  { x: 836, y: 756, radius: 102, clip: new Path2D('M800 629 Q839 620 882 658 Q917 690 941 716 '
    + 'Q950 777 925 828 Q896 883 824 874 Q758 867 722 824 Q726 779 756 726 Q782 694 800 629 Z') },
];
const TAU = Math.PI * 2;
// 蛋包饭的笑眼向中间挤，左右两边沿原画的高低和刘海位置分别落笔。
const OMURICE_SQUINT = new Path2D('M425 656 Q493 679 554 724 Q565 731 565 741 '
  + 'L563 752 Q561 760 551 764 L408 806 Q401 808 399 801 L391 773 Q389 767 396 765 '
  + 'L502 735 Q458 708 405 685 Q400 683 404 678 L418 659 Q421 654 425 656 Z '
  + 'M915 687 Q925 684 928 692 L938 714 Q941 722 933 726 Q870 741 807 768 '
  + 'Q846 799 900 830 Q908 834 904 840 L895 863 Q890 868 884 865 '
  + 'Q812 824 752 780 Q742 773 745 761 L748 749 Q749 742 761 736 C805 712 869 696 915 687 Z');
const PUPIL_HEART = new Path2D('M0 -.38 C-.36 -.85 -.95 -.64 -.97 -.15 C-1 .35 -.56 .77 0 1.04 '
  + 'C.55 .77 .99 .35 .97 -.15 C.94 -.64 .36 -.85 0 -.38 Z');
// 两眼顺着原画的大小和倾斜分别定位，粉色心形上方留出原画高光。
const PUPILS = [
  { x: 492, y: 735, size: 49, angle: -.09 }, { x: 838, y: 761, size: 53, angle: .09 },
];

// 保留双颊和鼻尖的渐变，沿刘海和脸侧手工标定，红晕不会染到白发。
const CHEEK_CLIP = new Path2D('M388 764 C426 753 455 771 506 749 C536 739 555 741 573 719 '
  + 'C603 734 632 741 656 751 C688 761 720 765 742 771 C768 777 787 788 818 794 '
  + 'C860 796 890 796 925 785 C914 828 886 861 858 889 C801 920 728 942 653 943 '
  + 'C546 939 451 914 391 877 C352 853 346 810 365 784 Z');

// 逐像素叠加柔和的脸颊色，最外缘衰减到完全透明。
function blush(context, amount, lovestruck = false) {
  context.save();
  context.clip(CHEEK_CLIP);
  context.globalAlpha = amount;
  // 爱心眼的红晕沿眼下连成一片，蛋包饭的红晕淡淡落在双颊。
  const regions = lovestruck ? [[636, 816, 282, 69, .28], [460, 816, 124, 77, .45], [844, 843, 117, 72, .46]]
    : [[438, 822, 116, 81, .26], [818, 855, 113, 81, .24]];
  for (const [x, y, rx, ry, opacity] of regions) {
    context.save();
    context.translate(x, y);
    context.scale(rx, ry);
    const glow = context.createRadialGradient(0, 0, 0, 0, 0, 1);
    glow.addColorStop(0, 'rgba(247,110,145,' + opacity + ')');
    glow.addColorStop(.44, 'rgba(251,138,164,' + opacity * .68 + ')');
    glow.addColorStop(1, 'rgba(250,149,175,0)');
    context.fillStyle = glow;
    context.fillRect(-1, -1, 2, 2);
    context.restore();
  }
  context.restore();
}

// 螺线的各圈始终保持同一间距，放大后也给刘海和两侧脸线留出余量。
function spiralPath(radius) {
  const path = new Path2D();
  path.moveTo(2, 0);
  for (let step = 1; step <= 155; step += 1) {
    const progress = step / 155;
    const angle = TAU * 2.44 * progress;
    const distance = 2 + (radius - 2) * progress;
    path.lineTo(Math.cos(angle) * distance, Math.sin(angle) * distance);
  }
  return path;
}

// 原画与眼部贴图在原生像素上合成，再由同一张画布统一缩放。
export class DragonFaces {
  // 沿用角色的缩放、镜像与定位，首次预览之前不分配合成画布。
  constructor(canvas) {
    this.canvas = canvas;
    this.omurice = new DragonOmurice();
  }

  // 每种素材首次用到才解码；两个预览同时请求时共用一次加载。
  async prepare(name) {
    const eyes = this.eyesReady ??= this.prepareEyes();
    if (name === 'omurice') await (this.plateReady ??= this.omurice.prepare());
    await eyes;
    return this.canPlay(name);
  }

  // 校验眼部贴图的原生像素布局，确保每只眼睛落在原位。
  async prepareEyes() {
    try {
      const atlas = new Image();
      atlas.src = ASSET;
      await atlas.decode();
      if (atlas.naturalWidth !== LEFT_EYE.width + RIGHT_EYE.width
        || atlas.naturalHeight !== ROW_HEIGHT * Object.keys(ATLAS_ROWS).length)
        throw new Error('表情贴图尺寸与龙娘眼区不一致');

      this.atlas = atlas;
    } catch (error) {
      console.warn('龙娘表情贴图暂不可用：', error.message);
    }
  }

  // 蛋包饭另需盘面图层，准备好后才接受对应菜单请求。
  canPlay(name) {
    return !!this.atlas && (name !== 'omurice' || !!this.omurice.sprite);
  }

  // 把眼纹、发际线、动作和底图合成一张画面，最后统一缩放。
  paint(image, motion, name, amount, elapsed, rect, animate) {
    const { canvas } = this;
    // 酱瓶退场后只在淡出、身体局部动作或画布尺寸变化时重画完整爱心。
    const time = !animate || name === 'white-eyes' ? 0
      : name === 'omurice' ? Math.min(elapsed, OMURICE_BOTTLE_EXIT) : elapsed;
    const width = Math.max(1, Math.round(rect.width * window.devicePixelRatio));
    const height = Math.max(1, Math.round(rect.height * window.devicePixelRatio));
    const moving = !motion.canvas.hidden;
    const revision = moving ? motion.revision : null;
    const resized = canvas.width !== width || canvas.height !== height;
    if (!canvas.hidden && !resized && this.name === name && this.amount === amount && this.time === time
      && this.motionRevision === revision && this.animate === animate) return;
    this.name = name;
    this.amount = amount;
    this.time = time;
    this.animate = animate;
    this.motionRevision = revision;
    const context = this.context ??= canvas.getContext('2d');
    const composite = this.composite ??= new OffscreenCanvas(EYE_ARTWORK.width, EYE_ARTWORK.height);
    const compositeContext = this.compositeContext ??= composite.getContext('2d');
    compositeContext.clearRect(0, 0, composite.width, composite.height);
    compositeContext.drawImage(moving ? motion.canvas : image, 0, 0);
    if (name === 'omurice') this.paintOmurice(time, amount, animate);
    else {
      this.paintEyeBase(ATLAS_ROWS[name], amount);
      if (name === 'heart') this.paintHeart(time, amount);
      if (name === 'spiral-eyes') this.paintSpirals(time, amount);
    }
    // 用高质量滤镜一次缩放整张合成图，防止小尺寸画布插值导致发丝锯齿。
    if (resized) {
      canvas.width = width;
      canvas.height = height;
      context.imageSmoothingQuality = 'high';
    } else context.clearRect(0, 0, width, height);
    context.drawImage(composite, 0, 0, width, height);
    canvas.hidden = false;
  }

  // 从盘面出现起就用挤眼和淡红晕表现笑意，保留龙娘原画的无口造型。
  paintOmurice(time, amount, animate) {
    const context = this.compositeContext;
    this.paintEyeBase(ATLAS_ROWS['spiral-eyes'], amount);
    blush(context, amount);
    context.save();
    context.globalAlpha = amount;
    context.fillStyle = '#1a142d';
    context.fill(OMURICE_SQUINT);
    context.restore();
    this.omurice.paint(context, time, amount, animate);
  }

  // 在原图坐标扣去旧眼纹，同时保留原先逐像素校对的前发和脸线。
  paintEyeBase(row, amount) {
    const context = this.compositeContext;
    const top = row * ROW_HEIGHT;
    context.globalAlpha = amount;
    context.drawImage(this.atlas, 0, top, LEFT_EYE.width, LEFT_EYE.height,
      LEFT_EYE.x, LEFT_EYE.y, LEFT_EYE.width, LEFT_EYE.height);
    context.drawImage(this.atlas, LEFT_EYE.width, top, RIGHT_EYE.width, RIGHT_EYE.height,
      RIGHT_EYE.x, RIGHT_EYE.y, RIGHT_EYE.width, RIGHT_EYE.height);
    context.globalAlpha = 1;
  }

  // 眼内的心形轻跳，红晕沿眼下和双颊泛开。
  paintHeart(time, amount) {
    const context = this.compositeContext;
    blush(context, amount * (.91 + Math.sin(time / 580) * .09), true);
    context.save();
    context.globalAlpha = amount;
    // 左右一起轻跳，粉心下缘微微随视线角度摆动。
    PUPILS.forEach(({ x, y, size, angle }, index) => {
      const phase = time / 920 * TAU - index * .09;
      const scale = 1 + .047 * Math.sin(phase) + .018 * Math.sin(phase * 2);
      context.save();
      context.translate(x, y + 2.1 * Math.sin(phase));
      context.rotate(angle + .035 * Math.sin(phase));
      context.scale(size * scale, size * scale * 1.09);
      const fill = context.createLinearGradient(-.18, -.69, .11, 1.04);
      fill.addColorStop(0, '#fff2f6');
      fill.addColorStop(.43, '#ffcee0');
      fill.addColorStop(1, '#f6a9c8');
      context.fillStyle = fill;
      context.fill(PUPIL_HEART);
      context.restore();
    });
    context.restore();
  }

  // 两只眼睛同方向旋转，右眼相差一小段角度；底层始终与原画对齐。
  paintSpirals(time, amount) {
    const context = this.compositeContext;
    const spirals = this.spirals ??= SPIRALS.map((eye) => spiralPath(eye.radius));
    context.save();
    context.globalAlpha = amount;
    context.strokeStyle = '#241b3b';
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = 15.5;
    SPIRALS.forEach(({ x, y, clip }, index) => {
      context.save();
      context.clip(clip);
      context.translate(x, y);
      context.rotate(time / 1410 * TAU - .3 + index * .28);
      context.stroke(spirals[index]);
      context.restore();
    });
    context.restore();
  }

  // 耳尖和发梢变化时刷新表情画布，姿态未变时直接复用上一帧。
  updateMotion(image, motion, rect) {
    if (!this.canvas.hidden) this.paint(image, motion, this.name, this.amount, this.time, rect, this.animate);
  }

  // 表情结束后立即把画面交回普通原画与视线画布。
  reset() {
    this.canvas.hidden = true;
  }
}
