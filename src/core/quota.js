// 动态标注服务端窗口，字段缺失不推测为零或无限制。
export function windowLabel(minutes) {
  return minutes === 10080
    ? '周额度'
    : minutes === 300
      ? '5 小时'
      : !minutes
        ? '额度窗口'
        : minutes % 1440 === 0
          ? `${minutes / 1440} 天`
          : minutes % 60 === 0
            ? `${minutes / 60} 小时`
            : `${minutes} 分钟`;
}
// 同时兼容当前 RPC 与日志快照，保留所有计量桶和原始百分比。
export function normalizeQuota(result, source = '实时账户', capturedAt = Date.now()) {
  if (!result || typeof result !== 'object') return null;
  const buckets =
    result.rateLimitsByLimitId ??
    (result.rateLimits ? { [result.rateLimits.limitId || 'codex']: result.rateLimits } : null);
  if (!buckets) return null;
  const normalized = Object.entries(buckets).flatMap(([id, b]) => {
    if (!b || typeof b !== 'object') return [];
    const windows = ['primary', 'secondary'].flatMap((slot) => {
      const w = b[slot];
      if (!w || !Number.isFinite(w.usedPercent ?? w.used_percent)) return [];
      const used = w.usedPercent ?? w.used_percent,
        rawMinutes = w.windowDurationMins ?? w.window_minutes,
        minutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : null,
        reset = w.resetsAt ?? w.resets_at;
      return [
        {
          id: slot,
          usedPercent: used,
          remaining: Math.max(0, Math.min(100, 100 - used)),
          minutes,
          label: windowLabel(minutes),
          resetsAt: Number.isFinite(reset) ? reset * 1000 : null,
        },
      ];
    });
    return [
      {
        id,
        name: b.limitName || b.limit_name || id,
        plan: b.planType || b.plan_type || null,
        windows,
        credits: b.credits || null,
        reached: b.rateLimitReachedType || b.rate_limit_reached_type || null,
      },
    ];
  });
  const c = result.rateLimitResetCredits;
  return {
    capturedAt,
    source,
    accountId: typeof result.accountId === 'string' ? result.accountId : null,
    allowed: typeof result.ordinaryUsageAllowed === 'boolean' ? result.ordinaryUsageAllowed : null,
    buckets: normalized,
    resetCredits:
      c && Number.isFinite(c.availableCount)
        ? {
            count: c.availableCount,
            details: Array.isArray(c.credits)
              ? c.credits
                  .filter((x) => x && x.status === 'available')
                  .map((x) => ({
                    expiresAt: Number.isFinite(x.expiresAt) ? x.expiresAt * 1000 : null,
                    expiryKnown: x.expiresAt === null || Number.isFinite(x.expiresAt),
                  }))
              : null,
          }
        : null,
  };
}
// 日志只提供观测快照，绝不伪装成刚从服务器刷新。
export function quotaFromEvent(event) {
  const r = event?.payload?.rate_limits;
  return r && Number.isFinite(Date.parse(event.timestamp))
    ? normalizeQuota({ rateLimits: r }, '会话快照', Date.parse(event.timestamp))
    : null;
}
// 每账户每个真实重置窗口仅提醒一次，失效数据不会产生通知。
export class AlertTracker {
  // 恢复上次会话已经通知的窗口标识。
  constructor(saved = []) {
    this.seen = new Set(saved);
  }
  // 恢复到阈值以上后重新允许本周期内的下一次下降提醒。
  evaluate(scope, quota, threshold, now = Date.now()) {
    if (!quota || now - quota.capturedAt > 120000) return [];
    const alerts = [];
    for (const bucket of quota.buckets)
      for (const w of bucket.windows) {
        const key = `${scope}:${bucket.id}:${w.id}:${w.resetsAt}`;
        if (w.remaining > threshold + 3) this.seen.delete(key);
        else if (w.remaining <= threshold && !this.seen.has(key)) {
          this.seen.add(key);
          alerts.push({ key, text: `${w.label}剩余 ${Math.round(w.remaining)}%` });
        }
      }
    return alerts;
  }
}
