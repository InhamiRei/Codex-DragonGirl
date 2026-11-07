const ORIGIN = 'dragon://app/';

// 内置角色以稳定编号区分；自定义图片仍独立保存，不覆盖任何内置原画。
export const CHARACTERS = Object.freeze([
  Object.freeze({ id: 'dragon', name: '龙娘', image: 'assets/characters/codex-dragon-girl.png' }),
  Object.freeze({ id: 'maro', name: '麻吕', image: 'assets/characters/maro/idle.png' }),
]);
export const MARO_ASSET = ORIGIN + CHARACTERS[1].image;
export const HAIR_FRAMES = 30;
export const MARO_FRAME_SIZE = 1254;
// 动作原图保持原生 1254 像素；首尾复用待机图，避免保存重复文件，播放仍为三十帧。
export const MARO_HAIR_ASSETS = Object.freeze(Array.from({ length: HAIR_FRAMES }, (_, index) =>
  index === 0 || index === HAIR_FRAMES - 1 ? MARO_ASSET
    : ORIGIN + `assets/characters/maro/hair/frame-${String(index + 1).padStart(2, '0')}.png`));
// 抬手和放手较快，沿发束整理与偷瞄稍停留；整段五秒，不把所有帧机械地等速切换。
export const HAIR_FRAME_DURATIONS = Object.freeze([
  180, 90, 100, 110, 120, 130, 140, 150, 160, 200,
  200, 220, 220, 220, 220, 200, 220, 240, 200, 220, 220, 200,
  150, 140, 130, 120, 110, 100, 90, 200,
]);
export const HAIR_DURATION = HAIR_FRAME_DURATIONS.reduce((sum, duration) => sum + duration, 0);
// 逐帧姿势在该帧的时间中点取样，低头节奏与不等长的动作帧一致。
export const HAIR_FRAME_TIMES = Object.freeze(HAIR_FRAME_DURATIONS.map((duration, index) =>
  HAIR_FRAME_DURATIONS.slice(0, index).reduce((sum, value) => sum + value, 0) + duration / 2));

// 五次缓动在起止处同时消除速度和加速度突变，抬头跨过第十八、十九帧连续完成。
export function hairNodAt(elapsed) {
  const maximum = 0.012;
  if (elapsed <= 600 || elapsed >= 4650) return 0;
  if (elapsed >= 1900 && elapsed <= 2800) return maximum;
  const returning = elapsed > 2800;
  const progress = returning ? (elapsed - 2800) / 1850 : (elapsed - 600) / 1300;
  const eased = progress ** 3 * (progress * (progress * 6 - 15) + 10);
  return maximum * (returning ? 1 - eased : eased);
}

// 无效或旧版角色编号回退到龙娘，导入配置不能引入任意文件路径。
export function characterById(id) {
  return CHARACTERS.find((character) => character.id === id) || CHARACTERS[0];
}

// 只有内置原画地址才能启用对应表情，自定义图片不会误套眼睛或动作。
export function characterByAsset(asset = ORIGIN + CHARACTERS[0].image) {
  return CHARACTERS.find((character) => ORIGIN + character.image === asset) || null;
}

// 以绝对经过时间选帧，卡顿或后台恢复不会积累过期动作。
export function hairFrameAt(elapsed) {
  let end = 0;
  for (let index = 0; index < HAIR_FRAME_DURATIONS.length; index += 1) {
    end += HAIR_FRAME_DURATIONS[index];
    if (elapsed < end) return index;
  }
  return HAIR_FRAMES - 1;
}

// 发饰入口在原画归一化坐标中命中，随翻转和缩放一起移动。
export function isCharacterMenuPoint(asset, point) {
  return characterByAsset(asset)?.id === 'dragon'
    && ((point.x - 0.835) / 0.075) ** 2 + ((point.y - 0.505) / 0.085) ** 2 <= 1;
}
