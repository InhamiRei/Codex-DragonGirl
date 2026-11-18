export const DEFAULT_DRAGON_EYE_COLOR = '#a78ade';
const DRAGON_GEAR_DIR = 'assets/characters/dragon-gear/';
const EYE_ICON = DRAGON_GEAR_DIR + 'eye-purple.webp';

// 按左列到右列的顺序列出装备，瞳孔配置可以单独保存。
export const DRAGON_GEAR = Object.freeze([
  { id: 'horns', label: '龙角', choices: [
    { id: 'show', name: 'GPT龙角', icon: DRAGON_GEAR_DIR + 'horns.webp' },
  ] },
  { id: 'eyes', label: '瞳孔', setting: 'dragonEyeId', choices: [
    { id: 'purple', name: 'GPT紫瞳', icon: EYE_ICON },
    { id: 'custom', name: '自选瞳色', icon: EYE_ICON },
  ] },
  { id: 'hairpin', label: '发饰', choices: [
    { id: 'gpt', name: 'GPT发饰', icon: DRAGON_GEAR_DIR + 'hairpin.webp' },
  ] },
  { id: 'clothes', label: '服饰', choices: [
    { id: 'white', name: 'GPT白衣', icon: DRAGON_GEAR_DIR + 'clothes.webp' },
  ] },
].map((slot) => Object.freeze({ ...slot, choices: Object.freeze(slot.choices.map(Object.freeze)) })));

// 调色板只接受六位十六进制 RGB，保存与导入使用相同规则。
export function parseDragonEyeColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

// 自选色以实际 RGB 为基准，GPT紫瞳直接使用原画。
export function dragonEyeTone(settings = {}) {
  return settings.dragonEyeId === 'custom' ? parseDragonEyeColor(settings.dragonEyeColor) : null;
}
