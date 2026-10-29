import { clamp, MIN_CHARACTER_SCALE, MAX_CHARACTER_SCALE } from './geometry.js';

// 配置只包含这个挂件自己的外观与位置，不读取或修改 Codex 的配置。
export const DEFAULT_STATE = Object.freeze({
  version: 1,
  scale: 1,
  snapEnabled: true,
  speechEnabled: true,
  placement: null,
});

// 只接收明确支持的字段，损坏、过期或手改的配置不会把窗口移到非法位置。
export function normalizeState(input) {
  if (!input || input.version !== 1) return structuredClone(DEFAULT_STATE);
  return {
    version: 1,
    scale: Number.isFinite(input.scale)
      ? clamp(input.scale, MIN_CHARACTER_SCALE, MAX_CHARACTER_SCALE)
      : 1,
    snapEnabled: typeof input.snapEnabled === 'boolean' ? input.snapEnabled : true,
    speechEnabled: typeof input.speechEnabled === 'boolean' ? input.speechEnabled : true,
    placement: normalizePlacement(input.placement),
  };
}

// 分别校验两个轴，缺少任意一项时回退到默认位置。
function normalizePlacement(input) {
  if (!input || typeof input.displayId !== 'string' || !input.horizontal || !input.vertical) return null;
  const horizontal = normalizeAxis(input.horizontal);
  const vertical = normalizeAxis(input.vertical);
  return horizontal && vertical
    ? { displayId: input.displayId.slice(0, 80), horizontal, vertical }
    : null;
}

// 自由位置使用有限比例；边缘锚点只接受三个已知值。
function normalizeAxis(input) {
  if (!['start', 'end', null].includes(input.edge) || !Number.isFinite(input.ratio)) return null;
  return { edge: input.edge, ratio: clamp(input.ratio, 0, 1) };
}
