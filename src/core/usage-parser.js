import { BUILTIN_PRICES } from '../shared/pricing.js';
import { createHash } from 'node:crypto';
import { quotaFromEvent } from './quota.js';
const FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
];
// 用稳定摘要保存内部身份，账本无需保存原始账户标识。
export function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
// 完整保留 token 的包含关系，缓存和推理只作分项，不重复加入总量。
export function tokens(raw = {}) {
  const value = {};
  for (const k of FIELDS) value[k] = Number.isSafeInteger(raw[k]) && raw[k] >= 0 ? raw[k] : 0;
  if (!Object.hasOwn(raw, 'total_tokens')) value.total_tokens = value.input_tokens + value.output_tokens;
  return value;
}
// 文件偏移的配套解析状态可持久化，恢复扫描时不会丢失模型或累计基线。
export function parserState() {
  return {
    thread: '',
    session: '',
    parent: '',
    account: '',
    model: '未知模型',
    tier: 'unknown',
    project: '',
    source: '主任务',
    started: 0,
    boundary: null,
    total: null,
    turn: '',
    status: 'unknown',
    lastAt: 0,
    quota: null,
    issues: 0,
  };
}
// 合法时间戳外的记录不参加日统计，避免被误放到今天。
export function parseUsageEvent(event, state, homeId) {
  const p = event?.payload || {},
    timestamp = Date.parse(event?.timestamp),
    kind = event?.type;
  if (kind === 'session_meta') {
    state.thread = String(p.id || p.thread_id || p.session_id || '');
    state.session = String(p.session_id || state.thread);
    state.parent = String(p.parent_thread_id || p.forked_from_id || '');
    state.account = p.creator_account_id ? digest(p.creator_account_id) : '';
    state.project = typeof p.cwd === 'string' ? p.cwd : '';
    state.started = Date.parse(p.timestamp || event.timestamp) || 0;
    state.boundary = Number.isFinite(p.subagent_history_start_ordinal)
      ? p.subagent_history_start_ordinal
      : null;
    state.source = typeof p.source === 'object' ? '子代理' : '主任务';
    return {};
  }
  if (kind === 'turn_context') {
    if (p.model) state.model = p.model;
    if (p.turn_id) state.turn = p.turn_id;
    if (p.service_tier) state.tier = p.service_tier;
    return {};
  }
  if (p.type === 'thread_settings_applied') {
    const settings = p.thread_settings || {};
    if (settings.model) state.model = settings.model;
    if (settings.service_tier) state.tier = settings.service_tier;
    return {};
  }
  const inherited =
    (state.boundary !== null && Number(event.ordinal) < state.boundary) ||
    (timestamp < state.started && !!state.parent);
  if (Number.isFinite(timestamp) && !inherited) state.lastAt = Math.max(state.lastAt || 0, timestamp);
  if (p.type === 'task_started') {
    state.turn = String(p.turn_id || '');
    if (!inherited) state.status = 'working';
    return {};
  }
  if (['task_complete', 'turn_aborted', 'error', 'task_failed'].includes(p.type)) {
    if (inherited) return {};
    state.status =
      p.type === 'task_complete' ? 'complete' : p.type === 'turn_aborted' ? 'cancelled' : 'error';
    return {
      task: {
        thread: state.thread,
        turn: p.turn_id || state.turn,
        status: state.status,
        time: timestamp,
        model: state.model,
        project: state.project,
        parent: state.parent,
        source: state.source,
      },
    };
  }
  let raw, recordKind, id;
  if (kind === 'token_usage_record' && p.usage) {
    raw = tokens(p.usage);
    recordKind = p.turn_token_usage && p.thread_token_usage ? 'canonical' : 'request';
    id = p.response_id
      ? `response:${p.response_id}`
      : `record:${state.thread}:${event.ordinal ?? timestamp}`;
    if (p.thread_id && state.thread && p.thread_id !== state.thread) return {};
    if (p.turn_id) state.turn = p.turn_id;
  } else if (p.type === 'token_count') {
    const quota = quotaFromEvent(event);
    if (quota && (!state.quota || quota.capturedAt > state.quota.capturedAt)) state.quota = quota;
    const total = p.info?.total_token_usage;
    if (!total) return {};
    const next = tokens(total),
      previous = state.total;
    state.total = next;
    if (previous && next.total_tokens === previous.total_tokens) return {};
    const reset = previous && next.total_tokens < previous.total_tokens;
    if (reset) state.issues++;
    raw = Object.fromEntries(
      FIELDS.map((k) => [k, Math.max(0, next[k] - (previous && !reset ? previous[k] : 0))]),
    );
    recordKind = 'delta';
    id = `delta:${state.thread}:${state.turn}:${timestamp}:${next.total_tokens}`;
  } else return {};
  if (inherited || !Number.isFinite(timestamp) || !raw.total_tokens) return {};
  return {
    usage: {
      key: digest(`${state.account || homeId}:${id}`),
      home: homeId,
      account: state.account,
      thread: state.thread,
      parent: state.parent,
      turn: state.turn,
      time: timestamp,
      model: state.model,
      tier: state.tier,
      project: state.project,
      source: state.model === 'codex-auto-review' ? '自动审核' : state.source,
      kind: recordKind,
      ...raw,
    },
  };
}
// 费用是明示价格下的 API 等价估算，未知模型保留 null。
export function estimateCost(row, prices = {}) {
  const price = prices[row.model]
    ? { ...BUILTIN_PRICES[row.model], ...prices[row.model] }
    : BUILTIN_PRICES[row.model];
  if (!price) return null;
  if (price.effective && row.time < Date.parse(price.effective)) return null;
  const multiplier =
    row.tier === 'ultrafast'
      ? price.ultrafast
      : ['priority', 'fast'].includes(row.tier)
        ? price.fast
        : row.tier === 'flex'
          ? price.flex
          : 1;
  if (multiplier === undefined) return null;
  const long = price.longThreshold && row.input_tokens > price.longThreshold;
  return (
    ((Math.max(0, row.input_tokens - row.cached_input_tokens - row.cache_write_input_tokens) *
      price.input *
      (long ? 2 : 1) +
      row.cached_input_tokens * price.cached * (long ? 2 : 1) +
      row.cache_write_input_tokens * (price.cacheWrite || price.input) * (long ? 2 : 1) +
      row.output_tokens * price.output * (long ? 1.5 : 1)) /
      1e6) *
    (multiplier ?? 1)
  );
}
