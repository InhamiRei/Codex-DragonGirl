import assert from 'node:assert/strict';
import { DRAGON_FOREGROUND } from '../src/shared/dragon-gear.js';
import { EYE_ARTWORK } from '../src/shared/gaze.js';

// 在同一个配置窗口保存切换前的完整画布，读取最终绘制结果。
export async function captureFixedPortrait(portrait) {
  await portrait.evaluate((canvas) => {
    const context = canvas.getContext('2d');
    window.__dragonPortraitBefore = context.getImageData(0, 0, canvas.width, canvas.height);
  });
}

// 按同一散发基准检查每款的实色 RGBA，包含肤色、眼睛、龙角、耳朵和服装。
export async function verifyFixedPortrait(portrait) {
  const result = await portrait.evaluate(async (canvas, foregroundAsset) => {
    const before = window.__dragonPortraitBefore;
    const { width, height } = canvas;
    if (!before || before.width !== width || before.height !== height) throw new Error('切换前后的画幅不同');
    const image = new Image();
    image.src = foregroundAsset;
    await image.decode();
    const front = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    front.drawImage(image, 0, 0, width, height);
    const foreground = front.getImageData(0, 0, width, height).data;
    const after = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let compared = 0;
    let changed = 0;
    let changedBehind = 0;
    for (let i = 0; i < after.length; i += 4) {
      const different = before.data[i] !== after[i] || before.data[i + 1] !== after[i + 1]
        || before.data[i + 2] !== after[i + 2] || before.data[i + 3] !== after[i + 3];
      if (foreground[i + 3] >= 250) {
        compared++;
        if (different) changed++;
      } else if (different) {
        changedBehind++;
      }
    }
    return { compared, changed, changedBehind };
  }, 'dragon://app/' + DRAGON_FOREGROUND);
  assert.ok(result.compared > 0 && result.changedBehind > 0, '没有完整前景或实际后发变化');
  assert.equal(result.changed, 0, '切换发型改变了共用前景的实色像素');
  return result;
}

// 几何取样区位于两侧发梢，避开衣服和共用的前发，确认马尾确实到了画面右侧。
export async function verifyRightPonytail(portrait) {
  const fixed = await verifyFixedPortrait(portrait);
  const tail = await portrait.evaluate((canvas) => {
    const context = canvas.getContext('2d');
    const width = 325;
    const top = 1005;
    const height = canvas.height - top;

    // 分别数两块对称区域的实色像素，忽略透明边缘中的微量噪点。
    function opaquePixels(left) {
      const { data } = context.getImageData(left, top, width, height);
      let count = 0;
      for (let index = 3; index < data.length; index += 4)
        if (data[index] >= 250) count++;
      return count;
    }
    return { left: opaquePixels(0), right: opaquePixels(canvas.width - width) };
  });
  assert.equal(tail.left, 0, '左侧发梢位置仍然有马尾');
  assert.ok(tail.right > 10000, '右侧缺少完整的马尾发梢');
  return { ...fixed, tail };
}

// 龙角、呆毛、耳朵、发饰、脸颊和衣服的原生坐标用于核对齐刘海。
const straightBangsFixedParts = {
  horns: [
    'M0 0 H552 V205 C489 226 405 273 350 327 C308 372 266 414 232 443 H0 Z',
    'M900 0 H1330 V459 H1173 Q1157 482 1144 499 L1092 515 C1057 440 1016 373 956 306 Q915 271 909 225 L900 190 Z',
  ],
  cowlick: ['M562 0 H899 V205 Q832 193 763 198 Q716 205 709 231 Q688 238 657 225 Q631 210 603 204 L562 196 Z'],
  ears: [
    'M0 625 H190 Q203 646 189 689 Q174 738 182 775 L211 818 H0 Z',
    'M1100 652 H1330 V874 H1162 Q1147 836 1138 781 L1116 748 Z',
  ],
  accessory: [
    'M1052 473 Q1131 462 1178 479 Q1231 491 1235 567 Q1240 631 1207 660 Q1175 684 1155 669 L1191 934 Q1146 950 1089 934 L1089 857 Q1086 735 1074 670 Q1021 628 1021 566 Q1024 496 1052 473 Z',
  ],
  cheeks: ['M405 832 H912 L881 915 Q807 961 662 955 Q509 950 405 897 Z'],
  clothes: [
    'M390 1182 L420 1100 L449 1040 L492 994 L617 996 L646 964 L716 971 L758 1008 L805 1011 L842 1027 L828 1049 L821 1063 L812 1082 L807 1097 L803 1117 L813 1182 Z',
    'M902 1066 L922 1077 L967 1155 L975 1182 H853 Q844 1162 852 1132 Q860 1108 877 1092 Z',
  ],
};

// 用成品的散发画布核对齐刘海的固定部件和虹膜，并确认前后发造型有变化。
export async function verifyStraightBangsPortrait(portrait) {
  const result = await portrait.evaluate(async (canvas, { parts, irises, foregroundAsset }) => {
    const { width, height } = canvas;
    const original = window.__dragonPortraitBefore;
    if (!original || original.width !== width || original.height !== height) throw new Error('切换前后的画幅不同');
    const before = original.data;
    const after = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const mask = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    const image = new Image();
    image.src = foregroundAsset;
    await image.decode();
    mask.drawImage(image, 0, 0, width, height);
    const foreground = mask.getImageData(0, 0, width, height).data;
    mask.clearRect(0, 0, width, height);
    for (const part of parts) mask.fill(new Path2D(part));
    const fixed = mask.getImageData(0, 0, width, height).data;
    mask.clearRect(0, 0, width, height);
    for (const { cx, cy, rx, ry } of irises) {
      mask.beginPath();
      mask.ellipse(cx, cy + 6, rx - 4, ry - 9, 0, 0, Math.PI * 2);
      mask.fill();
    }
    const eyes = mask.getImageData(0, 0, width, height).data;
    let compared = 0, changedFixed = 0, irisPixels = 0, changedIris = 0, changedFringe = 0, rearShortened = 0;

    // 只比较共用前景的部件像素，统计描边，同时避开后发原本可见或被遮住的部分。
    for (let at = 0; at < after.length; at += 4) {
      const x = at / 4 % width, y = Math.floor(at / 4 / width);
      const differs = before[at] !== after[at] || before[at + 1] !== after[at + 1]
        || before[at + 2] !== after[at + 2] || before[at + 3] !== after[at + 3];
      if (eyes[at + 3]) {
        irisPixels++;
        if (differs) changedIris++;
      }
      const alpha = foreground[at + 3];
      const near = alpha > 0 && (foreground[at - 1] >= 80 || foreground[at + 7] >= 80
        || foreground[at + 3 - width * 4] >= 80 || foreground[at + 3 + width * 4] >= 80);
      if (fixed[at + 3] && (alpha >= 24 || near)) {
        compared++;
        if (differs) changedFixed++;
      }
      if (differs && x >= 340 && x < 930 && y >= 270 && y < 655) changedFringe++;
      if ((x < 395 || x >= 974) && y >= 1100 && before[at + 3] >= 250 && after[at + 3] <= 8) rearShortened++;
    }

    // 取头顶与前发的珠白色中值，排除高光和深色发束，直接比较两款成品的主色。
    function hairFill(data) {
      const colors = [[], [], []];
      for (let y = 273; y < 528; y += 2) {
        for (let x = 490; x < 870; x += 2) {
          const offset = (y * width + x) * 4;
          const [r, g, b, a] = data.subarray(offset, offset + 4);
          if (a < 248 || g < 233 || g >= 250 || b < g + 1 || b < r) continue;
          for (let channel = 0; channel < colors.length; channel++) colors[channel].push(data[offset + channel]);
        }
      }
      return colors.map((channel) => channel.sort((a, b) => a - b)[Math.floor(channel.length / 2)]);
    }

    return {
      compared, changedFixed, irisPixels, changedIris, changedFringe, rearShortened,
      mainHairColor: { reference: hairFill(before), straightBangs: hairFill(after) },
    };
  }, {
    parts: Object.values(straightBangsFixedParts).flat(),
    irises: EYE_ARTWORK.eyes.map(({ iris }) => iris),
    foregroundAsset: 'dragon://app/' + DRAGON_FOREGROUND,
  });
  assert.ok(result.compared > 300000 && result.irisPixels > 20000, JSON.stringify(result));
  assert.ok(result.changedFringe > 10000 && result.rearShortened > 10000, JSON.stringify(result));
  assert.deepEqual([result.changedFixed, result.changedIris], [0, 0], JSON.stringify(result));
  const { reference, straightBangs } = result.mainHairColor;
  assert.ok(straightBangs.every((channel, index) => Math.abs(channel - reference[index]) <= 1),
    '齐刘海和散发的前发主色差超过一档：' + JSON.stringify(result.mainHairColor));
  return result;
}
