export const DEFAULT_DRAGON_EYE_COLOR = '#a78ade';
const DRAGON_GEAR_DIR = 'assets/characters/dragon-gear/';
const OUTFIT_DIR = DRAGON_GEAR_DIR + 'outfits/';
const EYE_ICON = DRAGON_GEAR_DIR + 'eye-purple.webp';
const DRAGON_PORTRAIT = 'assets/characters/codex-dragon-girl';
export const DRAGON_FOREGROUND = DRAGON_PORTRAIT + '-foreground.png';
export const DRAGON_PRAYER_EYES = DRAGON_PORTRAIT + '-prayer-eyes.webp';
// 齐刘海的短鬓在这一行以下露出不同的衣料，其余部位各款发型共用。
export const DRAGON_OUTFIT_HEM_Y = 920;
// 替换白结和流苏时，耳侧底图保留所选发型原本的耳朵和后发。
export const DRAGON_TEMPLE_RECT = Object.freeze([1008, 459, 225, 491]);
// 包头帽收起双角和呆毛，绵羊帽和鱼头套只收起中央呆毛。
export const DRAGON_CROWN_MASK = OUTFIT_DIR + 'crown-cut.webp';
export const DRAGON_CROWN_HEIGHT = 520;
export const DRAGON_COWLICK_RECT = Object.freeze([569, 0, 321, 235]);
// 合身的外衣从肩膀透出当前后发，使用与长短鬓发对应的干净肩颈底图。
export const DRAGON_BODICE_RECT = Object.freeze([380, 965, 602, 217]);

// 散发使用已验收的原生合成图，避免不同渲染后端缩放后发时改变固定部件像素。
export const DRAGON_HAIRSTYLES = Object.freeze([
  { id: 'loose', name: '散发', image: DRAGON_PORTRAIT + '.png', artwork: DRAGON_PORTRAIT + '-loose.png', layered: false },
  { id: 'ponytail', name: '单马尾', mirrorRear: true },
  { id: 'twin-tails', name: '双马尾' },
  { id: 'side-braid', name: '侧麻花辫' },
  { id: 'double-buns', name: '双丸子头' },
  { id: 'straight-bangs', name: '齐刘海', layered: false, shortForelock: true },
].map(({
  id, name, image = DRAGON_PORTRAIT + '-' + id + '.png', artwork = image,
  layered = true, mirrorRear = false, shortForelock = false,
}) => Object.freeze({
  id,
  name,
  icon: DRAGON_GEAR_DIR + 'hair-' + id + '.webp',
  image,
  artwork,
  layered,
  mirrorRear,
  shortForelock,
  temple: OUTFIT_DIR + 'temple-' + (layered ? 'shared' : id) + '.webp',
  bodice: OUTFIT_DIR + 'bodice-' + (layered ? 'shared' : id) + '.webp',
})));

// 每套衣帽使用原画坐标的透明图层，保留所选发型和瞳色。
const seasonalOutfits = [
  { id: 'pumpkin-witch', name: '南瓜小魔女', replacesHairpin: true },
  { id: 'crimson-count', name: '绯月小伯爵', replacesHairpin: true },
  { id: 'mint-ghost', name: '薄荷小幽灵' },
  { id: 'pine-plaid', name: '松绿格纹', replacesHairpin: true, replacesBodice: true, hat: 'closed-cap' },
  { id: 'midnight-duffle', name: '暮蓝木扣', replacesHairpin: true, replacesBodice: true, hat: 'closed-cap' },
  { id: 'gingerbread-baker', name: '姜饼工坊', replacesHairpin: true, replacesBodice: true },
  { id: 'milk-lamb', name: '奶白绵羊', replacesHairpin: true, replacesBodice: true, hat: 'sheep-hat' },
  { id: 'berry-lamb', name: '红夹克绵羊', replacesHairpin: true, replacesBodice: true, hat: 'sheep-hat' },
  { id: 'plump-fish', name: '大肥鱼', replacesHairpin: true, replacesBodice: true, hat: 'fish-hood' },
].map((outfit) => ({
  ...outfit,
  icon: DRAGON_GEAR_DIR + 'clothes-' + outfit.id + '.webp',
  overlay: OUTFIT_DIR + outfit.id + '.webp',
  shortHem: OUTFIT_DIR + outfit.id + '-short.webp',
}));
export const DRAGON_OUTFITS = Object.freeze([
  { id: 'white', name: 'GPT白衣', icon: DRAGON_GEAR_DIR + 'clothes.webp' },
  ...seasonalOutfits,
].map(Object.freeze));

// 按左列到右列的顺序列出装备，发型、服饰与瞳孔各自保存。
export const DRAGON_GEAR = Object.freeze([
  { id: 'horns', label: '龙角', choices: [
    { id: 'show', name: 'GPT龙角', icon: DRAGON_GEAR_DIR + 'horns.webp' },
  ] },
  { id: 'eyes', label: '瞳孔', setting: 'dragonEyeId', choices: [
    { id: 'purple', name: 'GPT紫瞳', icon: EYE_ICON },
    { id: 'custom', name: '自选瞳色', icon: EYE_ICON },
  ] },
  { id: 'hair', label: '发型', setting: 'dragonHairstyleId', choices: DRAGON_HAIRSTYLES },
  { id: 'clothes', label: '服饰', setting: 'dragonOutfitId', choices: DRAGON_OUTFITS },
].map((slot) => Object.freeze({ ...slot, choices: Object.freeze(slot.choices.map(Object.freeze)) })));

// 缺少设置或导入无效编号时使用原版散发。
export function dragonHairstyle(id) {
  return DRAGON_HAIRSTYLES.find((style) => style.id === id) ?? DRAGON_HAIRSTYLES[0];
}

// 旧设置或无法识别的服饰编号回退到原画白衣。
export function dragonOutfit(id) {
  return DRAGON_OUTFITS.find((outfit) => outfit.id === id) ?? DRAGON_OUTFITS[0];
}

// 调色板只接受六位十六进制 RGB，保存与导入使用相同规则。
export function parseDragonEyeColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

// 自选色以实际 RGB 为基准，GPT紫瞳直接使用原画。
export function dragonEyeTone(settings = {}) {
  return settings.dragonEyeId === 'custom' ? parseDragonEyeColor(settings.dragonEyeColor) : null;
}
