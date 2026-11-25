const ROOT = 'assets/characters/kanna/';

// 所有服装都以同一张待机图为底，裁切区从表情画布底边下方开始。
export const KANNA_OUTFIT_REGION = Object.freeze({
  x: 222, y: 940, width: 736, height: 314, mask: ROOT + 'outfits/mask.png',
});

// 每套衣料在保护遮罩内与原画无损合成，统一用原有图片方式缩放。
export const KANNA_OUTFITS = Object.freeze([
  { id: 'original', name: '原版服饰', icon: ROOT + 'gear/clothes.webp' },
  { id: 'school', name: '校园装' },
  { id: 'sports', name: '运动会体操服' },
  { id: 'yukata', name: '夏祭绣球花浴衣' },
].map(({ id, name, icon }) => Object.freeze({
  id,
  name,
  icon: icon ?? ROOT + 'gear/' + id + '.webp',
  image: id === 'original' ? null : ROOT + 'outfits/' + id + '.png',
})));

// 旧设置和无法识别的款式都回到原版服饰。
export function kannaOutfit(id) {
  return KANNA_OUTFITS.find((outfit) => outfit.id === id) ?? KANNA_OUTFITS[0];
}
