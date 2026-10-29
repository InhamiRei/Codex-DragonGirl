// 2026-10-28 核对的官方价目表，USD / 百万 token；旧日期缺少历史价时保持未定价。
// 来源：https://developers.openai.com/api/docs/pricing 与各模型官方卡片。
export const PRICE_DATE = '2026-10-28';
export const PRICE_SOURCE = 'https://developers.openai.com/api/docs/pricing';
export const BUILTIN_PRICES = Object.freeze({
  'gpt-6.1-sol': {
    input: 2,
    cached: 0.1,
    cacheWrite: 2.5,
    output: 10,
    fast: 2,
    flex: 0.5,
    ultrafast: 6,
    longThreshold: 272000,
    effective: '2026-10-28T00:00:00+08:00',
  },
  'gpt-6.1-terra': {
    input: 1,
    cached: 0.05,
    cacheWrite: 1.25,
    output: 5,
    fast: 2,
    flex: 0.5,
    longThreshold: 272000,
    effective: '2026-10-28T00:00:00+08:00',
  },
  'gpt-6-astra': {
    input: 10,
    cached: 1,
    cacheWrite: 12.5,
    output: 50,
    fast: 2,
    flex: 0.5,
    ultrafast: 6,
    longThreshold: 272000,
    effective: '2026-10-28T00:00:00+08:00',
  },
  'gpt-6-luna': {
    input: 0.1,
    cached: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
    fast: 2,
    flex: 0.5,
    longThreshold: 272000,
    effective: '2026-10-28T00:00:00+08:00',
  },
});
