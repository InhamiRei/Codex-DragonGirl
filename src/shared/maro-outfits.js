const ROOT = 'assets/characters/maro/';

// 衣柜名称用于界面显示，内部编号用于兼容已经保存的服饰选择。
export const MARO_OUTFITS = Object.freeze([
  { id: 'original', name: '原版服饰', icon: ROOT + 'gear/clothes.webp' },
  { id: 'cardigan-redraw', name: '焦糖开衫', icon: ROOT + 'gear/cardigan.webp' },
  { id: 'bun-hoodie-redraw', name: '红豆包卫衣', icon: ROOT + 'gear/bun-hoodie.webp' },
].map((outfit) => Object.freeze({
  ...outfit, layerDirectory: outfit.id === 'original' ? null : ROOT + 'outfits/' + outfit.id + '/',
})));

// 读取旧设置或收到旧款选择时，找到仍在衣柜中的同一款衣服。
const LEGACY_MARO_OUTFITS = new Map([
  ['cardigan', 'cardigan-redraw'],
  ['bun-hoodie', 'bun-hoodie-redraw'],
]);

// 查询已知款式，供服装选择命令识别有效编号。
export function findMaroOutfit(id) {
  const current = LEGACY_MARO_OUTFITS.get(id) ?? id;
  return MARO_OUTFITS.find((outfit) => outfit.id === current);
}

// 导入旧设置和渲染桌宠读取同一份清单，未知编号继续使用原版校服。
export function maroOutfit(id) {
  return findMaroOutfit(id) ?? MARO_OUTFITS[0];
}

// 捋发的中间帧以动画下标换算素材名，首尾仍由调用方复用待机。
export function maroGroomingPose(index) {
  return 'frame-' + String(index + 1).padStart(2, '0');
}

// 图层按原画坐标裁切，下列偏移在加载时将衣料放回对应姿势。
export const MARO_OUTFIT_OFFSETS = Object.freeze({
  idle: [213, 803, 709, 432],
  success: [212, 803, 710, 431],
  failure: [212, 803, 710, 431],
  'frame-02': [204, 803, 738, 433],
  'frame-03': [199, 803, 747, 432],
  'frame-04': [144, 803, 836, 432],
  'frame-05': [117, 801, 871, 434],
  'frame-06': [101, 623, 945, 613],
  'frame-07': [99, 438, 962, 797],
  'frame-08': [25, 431, 1092, 805],
  'frame-09': [37, 408, 1054, 827],
  'frame-10': [40, 413, 1050, 823],
  'frame-11': [47, 417, 1043, 817],
  'frame-12': [115, 420, 979, 815],
  'frame-13': [79, 420, 1009, 816],
  'frame-14': [40, 422, 1052, 813],
  'frame-15': [52, 389, 985, 846],
  'frame-16': [48, 386, 961, 850],
  'frame-17': [49, 383, 940, 853],
  'frame-18': [48, 403, 934, 833],
  'frame-19': [63, 555, 869, 680],
  'frame-20': [85, 663, 823, 573],
  'frame-21': [194, 804, 732, 432],
  'frame-22': [190, 803, 728, 433],
  'frame-23': [208, 804, 716, 431],
  'frame-24': [214, 803, 721, 432],
  'frame-25': [204, 803, 733, 432],
  'frame-26': [213, 803, 712, 433],
  'frame-27': [213, 803, 709, 432],
  'frame-28': [213, 803, 709, 432],
  'frame-29': [214, 803, 708, 432],
});

// 运行时和发布校验使用相同的资源地址。
export function maroOutfitLayer(outfit, pose) {
  return outfit.layerDirectory + pose + '.webp';
}
