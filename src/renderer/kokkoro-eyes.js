import { KOKKORO_ASSET } from '../shared/characters.js';
import { EyeTracker } from './eyes.js';

// 按 B 版的原画坐标标定斜眼睑，左侧外眼角和右侧眼前的刘海各有自己的遮挡边界。
export const KOKKORO_EYE_ARTWORK = {
  width: 1299, height: 1211,
  center: { x: 545, y: 765 },
  travel: { x: 10, y: 5 },
  eyes: [
    {
      x: 249, y: 590, width: 215, height: 242,
      outline: [[266, 619], [322, 610], [370, 637], [410, 665], [441, 708],
        [450, 739], [438, 775], [424, 803], [379, 807], [337, 804], [305, 773], [280, 692]],
      eyelid: 'M 265 615 Q 285 632 323 630 Q 317 620 322 604 Q 335 629 369 634 C 412 643 443 681 451 733 Q 447 744 443 741 C 444 767 440 795 422 805 Q 394 810 363 806 C 335 805 304 781 293 749 C 285 732 281 701 278 673 Q 276 648 267 635 Z',
      iris: 'M 326 668 C 363 658 420 697 438 728 C 449 758 439 786 424 800 Q 386 808 352 799 C 327 780 311 728 326 668 Z',
    },
    {
      x: 580, y: 697, width: 255, height: 191,
      outline: [[586, 751], [610, 727], [646, 711], [681, 711], [730, 723],
        [771, 744], [824, 773], [812, 801], [787, 836], [749, 861], [716, 873],
        [661, 863], [631, 840], [613, 816], [598, 787]],
      eyelid: 'M 588 752 Q 616 718 653 712 C 691 705 724 719 748 730 Q 778 748 825 771 C 816 799 801 821 784 838 Q 755 864 719 874 Q 670 870 640 853 C 624 837 600 799 588 752 Z',
      iris: 'M 635 745 C 672 731 734 743 771 758 C 790 783 768 825 750 849 Q 732 870 713 869 C 682 865 642 854 630 828 C 616 807 622 774 635 745 Z',
    },
  ],
};

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

// 跟随只推动虹膜和原有高光，眼白边缘与睫毛留在原位。
function gazeMask(_source, width, height, eye) {
  return pathWeights(eye.iris, width, height, eye, 22);
}

// 用现有的全屏光标、平滑收敛和自然眨眼时序，眼区参数只供可可萝使用。
export function createKokkoroEyes(character, onBlink) {
  return new EyeTracker(character, undefined, {
    asset: KOKKORO_ASSET, artwork: KOKKORO_EYE_ARTWORK, className: 'kokkoro-eye-layer',
    expressions: false, bodyFollow: false, onBlink,
    foregroundMask, gazeMask,
  });
}
