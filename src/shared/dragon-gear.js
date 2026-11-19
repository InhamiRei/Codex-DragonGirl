export const DEFAULT_DRAGON_EYE_COLOR = '#a78ade';
const DRAGON_GEAR_DIR = 'assets/characters/dragon-gear/';
const EYE_ICON = DRAGON_GEAR_DIR + 'eye-purple.webp';
const DRAGON_PORTRAIT = 'assets/characters/codex-dragon-girl';
export const DRAGON_FOREGROUND = DRAGON_PORTRAIT + '-foreground.png';

// 发型沿用原来的选择编号和地址。换前发的款式使用独立的完整立绘。
export const DRAGON_HAIRSTYLES = Object.freeze([
  { id: 'loose', name: '散发', image: DRAGON_PORTRAIT + '.png', rearImage: DRAGON_PORTRAIT + '-loose-back.png' },
  { id: 'ponytail', name: '单马尾', mirrorRear: true },
  { id: 'twin-tails', name: '双马尾' },
  { id: 'side-braid', name: '侧麻花辫' },
  { id: 'double-buns', name: '双丸子头' },
  { id: 'straight-bangs', name: '齐刘海', rearImage: null },
].map(({ id, name, image = DRAGON_PORTRAIT + '-' + id + '.png', rearImage = image, mirrorRear = false }) => Object.freeze({
  id,
  name,
  icon: DRAGON_GEAR_DIR + 'hair-' + id + '.webp',
  image,
  rearImage,
  mirrorRear,
})));

// 按左列到右列的顺序列出装备，发型与瞳孔各自保存。
export const DRAGON_GEAR = Object.freeze([
  { id: 'horns', label: '龙角', choices: [
    { id: 'show', name: 'GPT龙角', icon: DRAGON_GEAR_DIR + 'horns.webp' },
  ] },
  { id: 'eyes', label: '瞳孔', setting: 'dragonEyeId', choices: [
    { id: 'purple', name: 'GPT紫瞳', icon: EYE_ICON },
    { id: 'custom', name: '自选瞳色', icon: EYE_ICON },
  ] },
  { id: 'hair', label: '发型', setting: 'dragonHairstyleId', choices: DRAGON_HAIRSTYLES },
  { id: 'clothes', label: '服饰', choices: [
    { id: 'white', name: 'GPT白衣', icon: DRAGON_GEAR_DIR + 'clothes.webp' },
  ] },
].map((slot) => Object.freeze({ ...slot, choices: Object.freeze(slot.choices.map(Object.freeze)) })));

// 缺少设置或导入无效编号时使用原版散发。
export function dragonHairstyle(id) {
  return DRAGON_HAIRSTYLES.find((style) => style.id === id) ?? DRAGON_HAIRSTYLES[0];
}

// 调色板只接受六位十六进制 RGB，保存与导入使用相同规则。
export function parseDragonEyeColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

// 自选色以实际 RGB 为基准，GPT紫瞳直接使用原画。
export function dragonEyeTone(settings = {}) {
  return settings.dragonEyeId === 'custom' ? parseDragonEyeColor(settings.dragonEyeColor) : null;
}
