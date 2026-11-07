import { EyeTracker } from './eyes.js';
import { MARO_ASSET } from '../shared/characters.js';
import { MARO_EYE_ARTWORK, maroEyeMask, maroGazeMask } from '../shared/maro-eyes.js';

// 复用眨眼时序，视线仅在眼白内轻微移动，眼眶、刘海和身体保持固定。
export function createMaroEyes(character) {
  return new EyeTracker(character, () => {}, {
    asset: MARO_ASSET, artwork: MARO_EYE_ARTWORK, className: 'maro-eye-layer',
    expressions: false, bodyFollow: false, nativeResolution: true,
    skinSample: [565, 745, 25, 20], foregroundMask: maroEyeMask, gazeMask: maroGazeMask,
  });
}
