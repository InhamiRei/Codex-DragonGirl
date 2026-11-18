// 2026-11-18 核对的官方价目表，USD / 百万 token；旧日期缺少历史价时保持未定价。
// 来源：https://developers.openai.com/api/docs/pricing 与各模型官方卡片。
export const PRICE_DATE = '2026-11-18';
export const PRICE_SOURCE = 'https://developers.openai.com/api/docs/pricing';

// 两个 6.2 型号共用长上下文门槛和速度倍率；极速优惠按太平洋时间到期。
const GPT_62_TERMS = {
  fast: 2,
  flex: 0.5,
  ultrafast: 6,
  ultrafastPromotion: { multiplier: 3, endsAt: Date.parse('2027-03-01T00:00:00-08:00') },
  longThreshold: 272000,
  effective: '2026-11-17T00:00:00-08:00',
};

// 内置标准价含 30 分钟缓存写入，历史型号各自保留原生效日期。
export const BUILTIN_PRICES = Object.freeze({
  'gpt-6.2-astra': {
    ...GPT_62_TERMS,
    input: 8,
    cached: 0.4,
    cacheWrite: 10,
    output: 40,
  },
  'gpt-6.2-sol': {
    ...GPT_62_TERMS,
    input: 2,
    cached: 0.1,
    cacheWrite: 2.5,
    output: 10,
  },
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
