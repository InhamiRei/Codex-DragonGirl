// 日期边界按所选时区换算，避免北京时间午夜被 UTC 日期拆开。
export function dayKey(timestamp = Date.now(), timezone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(timestamp);
}
// 迭代修正目标时区偏移，兼容夏令时下的自然日边界。
export function midnight(day, timezone = 'Asia/Shanghai') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式无效');
  const target = Date.parse(day + 'T00:00:00Z');
  let time = target;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(fmt.formatToParts(time).map((x) => [x.type, x.value]));
    const asUTC = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const diff = target - asUTC;
    time += diff;
    if (!diff) break;
  }
  return time;
}
// 区间终点使用下一个自然日，覆盖跨夏令时的 23 或 25 小时日。
export function nextDay(day) {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// 重置时间沿用统计时区；跨日以月.日显示日期，未知或已到期时不推测下个周期。
export function quotaResetTime(timestamp, timezone = 'Asia/Shanghai', now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0)
    return { text: '重置时间未知', title: '服务暂未提供此额度窗口的重置时间' };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp).map((part) => [part.type, part.value]));
  const clock = `${parts.hour}:${parts.minute}`;
  const title = `${parts.year}-${parts.month}-${parts.day} ${clock} 重置（${timezone}）`;
  if (timestamp <= now) return { text: '重置待刷新', title: `${title}；时间已到，等待最新额度` };
  const date = dayKey(timestamp, timezone) === dayKey(now, timezone) ? '' : `${parts.month}.${parts.day} `;
  return { text: `${date}${clock} 重置`, title };
}
