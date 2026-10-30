import { AUDIO_GROUPS, DEFAULT_EVENT_SOUNDS, audioFile } from '../shared/audio-library.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export const SOUND_EVENTS = ['press', 'release', 'complete', 'error', 'question', 'approval', 'quota'];
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  mode: 'follow',
  selectedHome: '',
  multiplePets: false,
  refreshSeconds: 45,
  scanSeconds: 15,
  soundEnabled: true,
  volume: 0.35,
  soundTheme: 'duck',
  eventVolumes: {
    press: 1,
    release: 1,
    complete: 0.8,
    error: 0.6,
    question: 0.7,
    approval: 0.7,
    quota: 0.65,
  },
  eventSounds: { ...DEFAULT_EVENT_SOUNDS },
  notifications: true,
  lowQuota: 20,
  tokenBudget: 0,
  costBudget: 0,
  quietStart: '',
  quietEnd: '',
  bubbleSeconds: 10,
  pinnedBubble: false,
  bubbleTemplate: '{套餐}\n{额度}\n今日 {今日用量} Tokens',
  flip: false,
  motion: true,
  characterAsset: '',
  manualHomes: [],
  followOffsets: {},
  aliases: {},
  hiddenHomes: [],
  prices: {},
  currency: 'USD',
  exchangeRate: 7,
  timezone: 'Asia/Shanghai',
  startupMode: 'manual',
  launchAtLogin: false,
  retentionDays: 0,
});

// 限定数值范围，拒绝 NaN 与无界频率进入后台调度。
function number(value, fallback, low, high) {
  return Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback;
}
// 仅保留纯文本字典，防止导入配置污染原型或向渲染层带入凭据。
function dictionary(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
// 规范化用户偏好；导入不执行路径、脚本、网络请求或任意命令。
export function normalizeSettings(value = {}) {
  const d = structuredClone(DEFAULT_SETTINGS),
    v = dictionary(value);
  for (const key of [
    'multiplePets',
    'soundEnabled',
    'notifications',
    'pinnedBubble',
    'flip',
    'motion',
    'launchAtLogin',
  ])
    if (typeof v[key] === 'boolean') d[key] = v[key];
  // 旧版登录自启只迁移到原来的行为，不替用户开启新的 Codex 联动。
  d.startupMode = ['manual', 'login', 'codex'].includes(v.startupMode)
    ? v.startupMode : v.launchAtLogin === true ? 'login' : 'manual';
  d.launchAtLogin = d.startupMode === 'login';
  for (const [key, low, high] of [
    ['refreshSeconds', 30, 3600],
    ['scanSeconds', 5, 300],
    ['volume', 0, 1],
    ['lowQuota', 0, 100],
    ['bubbleSeconds', 1, 120],
    ['tokenBudget', 0, 1e15],
    ['costBudget', 0, 1e8],
    ['exchangeRate', 0.001, 10000],
    ['retentionDays', 0, 3650],
  ])
    d[key] = number(v[key], d[key], low, high);
  if (['desktop', 'follow'].includes(v.mode)) d.mode = v.mode;
  if (AUDIO_GROUPS.some((group) => group.id === v.soundTheme)) d.soundTheme = v.soundTheme;
  if (['USD', 'CNY'].includes(v.currency)) d.currency = v.currency;
  for (const key of ['selectedHome', 'characterAsset', 'bubbleTemplate'])
    if (typeof v[key] === 'string') d[key] = v[key].slice(0, 2000);
  // 仅迁移旧版默认文案，不覆盖用户自行编辑的气泡内容。
  if (
    [
      '{name} · {plan}\n{quota}\n今日 {tokens} tokens · {status}',
      '{实例} · {套餐}\n{额度}\n今日 {今日用量} 词元 · {任务状态}',
      '{实例} · {套餐}\n{额度}\n今日 {今日用量} Tokens · {任务状态}',
      '{套餐}\n{额度}\n今日 {今日用量} Tokens · {任务状态}',
    ].includes(d.bubbleTemplate)
  )
    d.bubbleTemplate = DEFAULT_SETTINGS.bubbleTemplate;
  for (const key of ['quietStart', 'quietEnd'])
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v[key])) d[key] = v[key];
  try {
    new Intl.DateTimeFormat('en', { timeZone: v.timezone }).format();
    if (v.timezone) d.timezone = v.timezone;
  } catch {}
  d.manualHomes = [
    ...new Set(
      (Array.isArray(v.manualHomes) ? v.manualHomes : []).filter(
        (x) => typeof x === 'string' && path.isAbsolute(x),
      ),
    ),
  ];
  if (d.characterAsset && !/^[a-f0-9]{32}\.(png|webp)$/.test(d.characterAsset)) d.characterAsset = '';
  d.followOffsets = Object.fromEntries(
    Object.entries(dictionary(v.followOffsets))
      .filter(([k, o]) => path.isAbsolute(k) && o && Number.isFinite(o.x) && Number.isFinite(o.y))
      .map(([k, o]) => [k, { x: number(o.x, 1, 0, 1), y: number(o.y, 1, 0, 1) }]),
  );
  d.hiddenHomes = (Array.isArray(v.hiddenHomes) ? v.hiddenHomes : []).filter(
    (x) => typeof x === 'string',
  );
  d.aliases = Object.fromEntries(
    Object.entries(dictionary(v.aliases))
      .filter(([k, val]) => path.isAbsolute(k) && typeof val === 'string')
      .map(([k, val]) => [k, val.slice(0, 60)]),
  );
  for (const key of SOUND_EVENTS) {
    d.eventVolumes[key] = number(v.eventVolumes?.[key], d.eventVolumes[key], 0, 1);
    if (key !== 'press' && key !== 'release' && audioFile(v.eventSounds?.[key]))
      d.eventSounds[key] = v.eventSounds[key];
  }
  // 升级旧默认音色时采用原声的成对等音量设置，保留用户其他音量偏好。
  if (
    ['crystal', 'soft', 'arcade'].includes(v.soundTheme) &&
    !v.eventSounds?.press &&
    !v.eventSounds?.release &&
    v.eventVolumes?.press === 0.65 &&
    v.eventVolumes?.release === 0.5
  ) {
    d.eventVolumes.press = 1;
    d.eventVolumes.release = 1;
  }

  d.prices = Object.fromEntries(
    Object.entries(dictionary(v.prices))
      .filter(
        ([k, p]) =>
          k.length < 120 &&
          p &&
          ['input', 'cached', 'output'].every((x) => Number.isFinite(p[x]) && p[x] >= 0),
      )
      .map(([k, p]) => [
        k,
        {
          input: p.input,
          cached: p.cached,
          output: p.output,
          cacheWrite: number(p.cacheWrite, 0, 0, 1e6),
          fast: number(p.fast, 1, 0, 100),
          flex: number(p.flex, 1, 0, 100),
          source: '用户设置',
          effective: p.effective || '',
        },
      ]),
  );
  return d;
}
// 免打扰支持跨午夜，边界采用左闭右开区间。
export function isQuiet(settings, now = new Date()) {
  if (!settings.quietStart || !settings.quietEnd) return false;
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return settings.quietStart < settings.quietEnd
    ? hhmm >= settings.quietStart && hhmm < settings.quietEnd
    : hhmm >= settings.quietStart || hhmm < settings.quietEnd;
}
// 设置采用原子替换和串行写入，异常旧文件保留备份。
export class SettingsStore {
  // 初始化设置路径与串行保存队列。
  constructor(directory) {
    this.file = path.join(directory, 'settings.json');
    this.value = normalizeSettings();
    this.queue = Promise.resolve();
  }
  // 初次读取不修改原配置。
  async load() {
    try {
      this.value = normalizeSettings(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (e) {
      if (e.code !== 'ENOENT')
        await fs.copyFile(this.file, this.file + '.recovered-' + Date.now()).catch(() => {});
    }
    return this.value;
  }
  // 普通设置提前复制，局部更新则在队列中读取最新值，防止拖动与表单保存互相覆盖。
  save(value) {
    const snapshot = typeof value === 'function' ? null : normalizeSettings(value);
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        const next = typeof value === 'function'
          ? normalizeSettings(value(structuredClone(this.value))) : snapshot;
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(this.file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
        await fs.rename(this.file + '.tmp', this.file);
        this.value = next;
        return next;
      });
    this.queue = operation;
    return operation;
  }

  // 退出必须等待窗口锚点和偏好的全部排队写入，不依赖磁盘通常足够快。
  async flush() {
    await this.queue;
  }
}
