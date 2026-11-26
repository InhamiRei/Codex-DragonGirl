// 套餐使用官方客户端原名；未知标识原样显示，避免自行翻译或猜测档位。
export function planLabel(value) {
  const labels = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro 200',
    prolite: 'Pro 100',
    promax: 'Pro 500',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
    apiKey: 'API Key',
    unknown: '套餐待确认',
  };
  return Object.hasOwn(labels, value) ? labels[value] : value || '套餐待确认';
}

// 同一额度桶的周额度耗尽时，5h 的可用量归零；仅创建展示副本，保留真实读数以便恢复。
export function quotaAvailableWindows(windows) {
  if (!windows.some((window) => window.minutes === 10080 &&
      Number.isFinite(window.remaining) && window.remaining <= 0)) return windows;
  return windows.map((window) => window.minutes === 300
    ? { ...window, remaining: 0, isBlockedByWeeklyLimit: true }
    : window);
}

// Pro 仅有周窗口时可按偏好补一条 5 小时展示行，沿用周额度进度，保留真实窗口。
export function quotaDisplayWindows(windows, planType, showProFiveHourQuota = false) {
  if (!showProFiveHourQuota || !['pro', 'prolite', 'promax'].includes(String(planType || '').toLowerCase()) ||
      windows.length !== 1 || windows[0].minutes !== 10080) return windows;
  const weekly = windows[0];
  return [{ ...weekly, id: 'unlimited-five-hour', label: '5 小时', minutes: 300,
    resetsAt: null, isUnlimited: true }, weekly];
}

// 只拆分已格式化用量的数量单位，保留原数字、分隔符和未知文字，不重新换算消耗。
export function tokenDisplayParts(value) {
  const text = String(value ?? '0');
  const parts = /^([+-]?\d[\d,.]*)(万亿|亿|万)$/.exec(text);
  return { number: parts ? parts[1] : text, unit: parts ? parts[2] : '' };
}

const compactTurnTokens = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

// 默认紧凑格式最大只到 T，更大的计数使用标准单位 P。
function formatTurnTokens(value) {
  return value >= 1e15 ? `${compactTurnTokens.format(value / 1e15)}P` : compactTurnTokens.format(value);
}

// 气泡和系统通知复用三个完整指标，缓存命中率以输入总量为分母。
export function completionBubble({ input, output, cached }) {
  const metrics = [
    { label: '输入', value: formatTurnTokens(input) },
    { label: '输出', value: formatTurnTokens(output) },
    { label: '缓存命中', value: input > 0 ? `${Math.round((cached / input) * 100)}%` : '—' },
  ];
  return {
    text: `任务完成啦！ 本轮 · ${metrics.map(({ label, value }) => `${label} ${value}`).join(' · ')}`,
    completion: { title: '本轮任务完成啦！', metrics },
  };
}

// 自动生成的实例名称使用中文；用户自己填写的名称原样保留。
export function instanceLabel(instance, settings = {}) {
  if (settings.aliases?.[instance.home]) return instance.name;
  if (instance.name === '默认 Codex') return '默认实例';
  if (/^Codex [a-f\d]+$/i.test(instance.name || '')) return instance.name.replace(/^Codex /i, '实例 ');
  if (instance.name === 'Codex 实例') return '应用实例';
  return instance.name || '未命名实例';
}

// 技术来源标识只在界面转为用户可读的中文名称。
export function originLabel(origin) {
  return origin === 'Cockpit' ? '多开目录' : origin;
}
