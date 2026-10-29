// 日历只用 UTC 计算日期格位置，实际每日汇总已经由账本按用户时区归属。
export function activityCalendar(daily, year, today) {
  const first = new Date(Date.UTC(year, 0, 1));
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  const end = `${year}-12-31`;
  const weeks = [];
  let cumulative = 0;
  // 补齐首尾周用于对齐周一到周日，跨年和未来的格子不参与统计。
  while (start.toISOString().slice(0, 10) <= end) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const day = start.toISOString().slice(0, 10);
      const inYear = start.getUTCFullYear() === year;
      const available = inYear && day <= today;
      const value = available ? Math.max(0, Number(daily[day]) || 0) : 0;
      days.push({ day, value, inYear, available });
      start.setUTCDate(start.getUTCDate() + 1);
    }
    const valid = days.filter((day) => day.available);
    const value = valid.reduce((sum, day) => sum + day.value, 0);
    cumulative += value;
    weeks.push({ days, value, cumulative, from: valid[0]?.day, to: valid.at(-1)?.day });
  }
  return weeks;
}

// 四档相对强度保留真实零值，避免有用量的日期与无记录日期混淆。
export function activityLevel(value, max) {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(value / max) * 4)));
}
