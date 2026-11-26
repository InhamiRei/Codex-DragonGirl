import { createReadStream, watch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { isInheritedEvent, parserState, parseUsageEvent, TASK_END_EVENTS, tokens } from '../core/usage-parser.js';
import { readLogLines } from '../core/log-lines.js';

// 定期检查近期日志，目录监听跟踪旧会话的追加，低频核对补齐漏掉的系统事件。
const RECONCILE_MS = 60000;
const RECENT_LOG_MS = 10 * 60000;
const CONTEXT_BYTES = 128 * 1024;
const LOG_TYPES = ['session_meta', 'turn_context', 'token_usage_record'];
const EVENT_TYPES = ['task_started', ...TASK_END_EVENTS, 'token_count'];
const LOG_MARKERS = LOG_TYPES.map((type) => `"${type}"`);
const EVENT_MARKERS = EVENT_TYPES.map((type) => `"${type}"`);
const EMPTY_USAGE = Object.freeze(tokens());
const sources = new Map();
let interval, timer, scanning = false;

// 与账本一样用文件编号和创建时间识别更换，支持 Windows 和 macOS。
function identity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

// 只解析会话、轮次和计数记录，跳过对话正文与工具输出。
function taskEvent(line) {
  if (!line || !(LOG_MARKERS.some((marker) => line.includes(marker))
    || (line.includes('"event_msg"') && EVENT_MARKERS.some((marker) => line.includes(marker))))) return null;
  try {
    const event = JSON.parse(line.toString('utf8'));
    return LOG_TYPES.includes(event?.type)
      || (event?.type === 'event_msg' && EVENT_TYPES.includes(event.payload?.type)) ? event : null;
  } catch {
    return null;
  }
}

// 按本次检查的文件长度读取完整行，半行保留原偏移，超长行也不会无限累积内存。
function logLines(file, offset, size) {
  if (offset >= size) return [];
  const stream = createReadStream(file, { start: offset, end: size - 1, highWaterMark: CONTEXT_BYTES });
  return readLogLines(stream, offset);
}

// 校验完整的轮次计数，只把显示需要的输入、输出和缓存分项交给主进程。
function usageDifference(total, baseline) {
  if (!total || !baseline) return null;
  const input = total.input_tokens - baseline.input_tokens;
  const output = total.output_tokens - baseline.output_tokens;
  const cached = total.cached_input_tokens - baseline.cached_input_tokens;
  if (!Number.isSafeInteger(input + output) || input < 0 || output < 0
    || cached < 0 || cached > input || input + output === 0) return null;
  return { input, output, cached };
}

// 优先使用 Codex 报出的本轮累计。旧日志可用会话累计差值，或去重后的独立请求记录。
function completedTurnUsage(state) {
  const cumulative = state.nativeTurnUsage ?? usageDifference(state.total, state.turnBaseline);
  if (cumulative || !state.turnRequests?.size) return cumulative;
  const total = tokens();
  for (const request of state.turnRequests.values()) {
    total.input_tokens += request.input_tokens;
    total.output_tokens += request.output_tokens;
    total.cached_input_tokens += request.cached_input_tokens;
  }
  return usageDifference(total, EMPTY_USAGE);
}

// 只有读到开始边界才把之前的会话累计作为基线；日志从中间接入时仍可使用本轮原生快照。
function beginTurnUsage(state, previousTurn, atStart) {
  const firstTurn = !previousTurn && state.fromBeginning && !state.parent && state.boundary === null;
  state.turnBaseline = atStart ? state.total ?? (firstTurn ? EMPTY_USAGE : null) : null;
  state.collectTurnRequests = atStart || state.fromBeginning;
  state.turnFinished = false;
  state.nativeTurnUsage = null;
  state.turnRequests = null;
}

// 实时提醒只需要计数，直接读取快照，省去账本用的配额解析、请求摘要与费用字段。
function applyTurnUsage(event, state, timestamp, inherited) {
  if (state.source !== '主任务' || !Number.isFinite(timestamp)) return;
  const payload = event.payload;
  if (event.type === 'event_msg') {
    const raw = payload.info?.total_token_usage;
    if (!raw) return;
    const next = tokens(raw);
    if (!inherited && state.total && next.total_tokens < state.total.total_tokens) state.turnBaseline = null;
    state.total = next;
    return;
  }
  if (inherited || (payload?.thread_id && state.thread && payload.thread_id !== state.thread)) return;
  if (payload?.turn_id && payload.turn_id !== state.turn) {
    // 迟到的其他轮记录不能切换正在工作的轮次；缺少开始事件的原生记录仍能用自身轮次定位。
    if (state.turn && !state.turnFinished) return;
    const previousTurn = state.turn;
    state.turn = payload.turn_id;
    beginTurnUsage(state, previousTurn, false);
  }
  if (!state.turn) return;
  const native = payload?.turn_token_usage && usageDifference(tokens(payload.turn_token_usage), EMPTY_USAGE);
  if (native) {
    const previous = state.nativeTurnUsage;
    if (!previous || native.input + native.output >= previous.input + previous.output)
      state.nativeTurnUsage = native;
    // 可信的完整快照到达后，请求级备份不再需要，也无需随每次追加复制。
    state.turnRequests = null;
  } else if (state.collectTurnRequests && !state.nativeTurnUsage && payload?.usage) {
    const request = tokens(payload.usage);
    if (!usageDifference(request, EMPTY_USAGE)) return;
    const key = payload.response_id ? `response:${payload.response_id}` : `record:${event.ordinal ?? timestamp}`;
    (state.turnRequests ??= new Map()).set(key, request);
  }
}

// 文件身份由首条有效会话元数据确定，继承的累计只用于确认旧格式的基线。
function applyTaskEvent(event, state, home) {
  if (!event) return;
  if (event.type === 'session_meta') {
    if (state.thread) return;
    parseUsageEvent(event, state, home);
    return;
  }
  const timestamp = Date.parse(event.timestamp);
  const inherited = isInheritedEvent(event, state, timestamp);
  if (event.type === 'token_usage_record' || event.payload?.type === 'token_count') {
    applyTurnUsage(event, state, timestamp, inherited);
    return;
  }
  if (inherited) return;

  const previousTurn = state.turn;
  const { task } = parseUsageEvent(event, state, home);
  if (state.turn && state.turn !== previousTurn && state.source === '主任务') beginTurnUsage(state, previousTurn, true);
  // 结束事件可以补上未知轮次，重复的旧结束记录不能改写已有的轮次归属。
  if (task?.turn && !state.turn) state.turn = task.turn;
  if (task?.turn && task.turn === state.turn) {
    if (task.status === 'complete' && task.source === '主任务') task.turnUsage = completedTurnUsage(state);
    if (task.status === 'complete' || task.status === 'cancelled') state.turnFinished = true;
  }
  return task;
}

// 旧会话首次追加时跳过空行或无效记录，找到文件自身的身份和继承边界即可停止。
async function readMetadata(file, offset, state, home) {
  for await (const { line } of logLines(file, 0, offset)) {
    const event = taskEvent(line);
    if (event?.type !== 'session_meta') continue;
    applyTaskEvent(event, state, home);
    if (state.thread) break;
  }
}

// 老会话首次追加时回读近期上下文，恢复轮次和已落盘的计数，无需重扫全部历史。
async function restoreRecentContext(file, offset, state, home) {
  const start = Math.max(0, offset - CONTEXT_BYTES);
  state.fromBeginning = start === 0;
  for await (const { line } of logLines(file, start, offset)) {
    applyTaskEvent(taskEvent(line), state, home);
  }
}

// 文件无变化只做元数据检查，追加时从上次完整行继续，替换或截断时重新验证事件时间。
async function checkFile(source, file, changedByWatch) {
  const stat = await fs.lstat(file).catch((error) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!stat?.isFile()) {
    source.files.delete(file);
    source.recent.delete(file);
    return [];
  }
  // 按偏好间隔核对近期有写入的日志，包括恢复后仍在追加的旧会话。
  const expires = stat.mtimeMs + RECENT_LOG_MS;
  if (expires > Date.now()) source.recent.set(file, expires);
  else source.recent.delete(file);
  const previous = source.files.get(file);
  const key = identity(stat);
  const sameFile = previous?.key === key;
  if (sameFile && previous.size === stat.size && previous.mtime === stat.mtimeMs) return [];
  const continuing = sameFile && stat.size > previous.size;
  // 启动前未变化的文件只记长度。首次发现的短会话也检查启动后的实际事件。
  let offset = continuing ? previous.offset : !changedByWatch && stat.mtimeMs <= workerData.startedAt ? stat.size : 0;
  const prior = continuing ? previous.state : null;
  let state = prior ? { ...prior, turnRequests: prior.turnRequests && new Map(prior.turnRequests) } : null;
  const tasks = [];
  if (offset < stat.size) {
    const start = offset;
    if (!state) {
      state = { ...parserState(), fromBeginning: !start };
      if (start) {
        if (start > CONTEXT_BYTES) await readMetadata(file, start, state, source.id);
        await restoreRecentContext(file, start, state, source.id);
      }
    }
    for await (const entry of logLines(file, start, stat.size)) {
      offset = entry.offset;
      const task = applyTaskEvent(taskEvent(entry.line), state, source.id);
      if (!task) continue;
      if (!(task.time > workerData.startedAt)) continue;
      // 同一日志读到的完成结果和用量一起发送，提醒可独立于账本更新。
      tasks.push({ home: source.id, thread: task.thread || path.basename(file, '.jsonl'),
        turn: task.turn, time: task.time, status: task.status, source: task.source, turnUsage: task.turnUsage });
    }
  }
  source.files.set(file, { key, size: stat.size, mtime: stat.mtimeMs, offset, state });
  return tasks;
}

// 仅枚举明文会话日志，跳过归档与子目录中的符号链接。
async function listLogs(directory, files, recursive = true) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (recursive && entry.isDirectory()) await listLogs(file, files);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.add(file);
  }
}

// 日志目录尚未创建时监听它的父目录，首次短会话无需等到下一次定期核对。
async function watchSource(source) {
  const stat = await fs.stat(source.root).catch(() => null);
  if (sources.get(source.id) !== source) return;
  const exists = !!stat?.isDirectory();
  const location = exists ? source.root : source.home;
  const key = exists ? identity(stat) : null;
  if (source.watcher && source.watchKey === key) return;
  source.watcher?.close();
  source.watcher = null;
  try {
    const watcher = watch(location, { recursive: exists }, (event, name) => {
      if (source.watcher !== watcher) return;
      if (!exists || !name) {
        if (!name || exists || name === 'sessions') source.reconcile = true;
        return;
      }
      const file = path.resolve(source.root, name);
      if (file !== source.root && !file.startsWith(source.root + path.sep)) return;
      if (file.endsWith('.jsonl')) source.changed.add(file);
      else if (event === 'rename') source.folders.add(file);
    });
    source.watcher = watcher;
    source.watchKey = key;
    // 目录删除、休眠或文件系统监听失效后，下次目录核对会恢复监听。
    watcher.on('error', () => {
      if (source.watcher !== watcher) return;
      watcher.close();
      source.watcher = null;
    });
  } catch {
    // 某些文件系统不提供变更事件，定时核对仍能读取该实例。
  }
}

// 系统可能合并或漏掉建档通知，近期文件与日期目录始终按设置间隔核对。
async function pollRecentLogs(source, files) {
  const now = Date.now();
  for (const [file, expires] of source.recent) {
    if (expires > now) files.add(file);
    else source.recent.delete(file);
  }
  const directories = new Map();
  const folders = [source.root];
  for (const offset of [-1, 0, 1]) {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    folders.push(path.join(source.root, String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')));
  }
  for (const folder of folders) {
    const stat = await fs.stat(folder).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const key = `${identity(stat)}:${stat.mtimeMs}`;
    directories.set(folder, key);
    if (source.polledFolders.get(folder) === key) continue;
    // 新日志只有目录条目变化时才重新枚举当前目录，不递归访问全年历史。
    await listLogs(folder, files, false);
  }
  source.polledFolders = directories;
}

// 读取一批变更。遇到目录事件时只检查该目录，根目录核对同时回收已移除的偏移。
async function checkSource(source) {
  const { changed, folders, retries, reconcile } = source;
  source.changed = new Set();
  source.folders = new Set();
  source.retries = new Set();
  source.reconcile = false;
  const files = new Set();
  if (reconcile || folders.has(source.root)) {
    await watchSource(source);
    await listLogs(source.root, files);
    for (const file of source.files.keys()) if (!files.has(file)) {
      source.files.delete(file);
      source.recent.delete(file);
    }
  } else {
    await pollRecentLogs(source, files);
    for (const folder of folders)
      if ((await fs.lstat(folder).catch(() => null))?.isDirectory()) await listLogs(folder, files);
  }
  for (const file of changed) files.add(file);
  for (const file of retries) files.add(file);
  const tasks = [];
  for (const file of files) {
    if (sources.get(source.id) !== source) return [];
    try {
      for (const task of await checkFile(source, file, changed.has(file) || retries.has(file))) tasks.push(task);
    } catch {
      // 写入或换文件时的短暂读取错误再试一轮，长期不可读的文件交给低频核对。
      if (!retries.has(file)) source.retries.add(file);
    }
  }
  return sources.get(source.id) === source ? tasks : [];
}

// 同一轮汇总所有实例的结果，让主进程能在派送前比较主任务和子代理。
async function scan() {
  timer = null;
  scanning = true;
  try {
    const batches = await Promise.allSettled([...sources.values()].map(checkSource));
    const tasks = batches.flatMap((batch) => batch.status === 'fulfilled' ? batch.value : []);
    if (tasks.length) parentPort.postMessage({ type: 'tasks', tasks });
  } finally {
    scanning = false;
    schedule();
  }
}

// 有实例时只安排一轮轻量检查，连续写入或检查尚未结束时不会堆积定时任务。
function schedule(delay = interval) {
  if (!timer && !scanning && sources.size) timer = setTimeout(scan, delay);
}

// 目录核对用于启动后的兜底和系统唤醒，可合并到当前批次。
function reconcileSources() {
  for (const source of sources.values()) source.reconcile = true;
  clearTimeout(timer);
  timer = null;
  schedule(0);
}

// 重配时只增删变化的实例，间隔调整不会重置已有会话的读取位置。
function configure({ instances, interval: nextInterval }) {
  const ids = new Set(instances.map(({ id }) => id));
  for (const [id, source] of sources) {
    if (ids.has(id)) continue;
    source.watcher?.close();
    sources.delete(id);
  }
  let added = false;
  for (const { id, home } of instances) {
    if (sources.has(id)) continue;
    sources.set(id, { id, home, root: path.join(home, 'sessions'), files: new Map(),
      recent: new Map(), polledFolders: new Map(), changed: new Set(), folders: new Set(), retries: new Set(), reconcile: true });
    added = true;
  }
  if (added || interval !== nextInterval) {
    interval = nextInterval;
    clearTimeout(timer);
    timer = null;
    schedule(added ? 0 : interval);
  }
}

// 一个 Worker 负责所有实例，核对过程与账本的查询和重建队列独立。
parentPort.on('message', (message) => {
  if (message.type === 'configure') configure(message);
  if (message.type === 'reconcile') reconcileSources();
});
setInterval(reconcileSources, RECONCILE_MS).unref();
