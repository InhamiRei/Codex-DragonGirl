import { createReadStream, watch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { parserState, parseUsageEvent, TASK_END_EVENTS } from '../core/usage-parser.js';

// 定期检查近期日志，目录监听跟踪旧会话的追加，低频核对补齐漏掉的系统事件。
const RECONCILE_MS = 60000;
const RECENT_LOG_MS = 10 * 60000;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const TASK_EVENTS = ['task_started', ...TASK_END_EVENTS];
const TASK_MARKERS = TASK_EVENTS.map((type) => `"${type}"`);
const sources = new Map();
let interval, timer, scanning = false;

// 与账本一样用文件编号和创建时间识别更换，支持 Windows 和 macOS。
function identity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

// 仅解析会话元数据、轮次和任务结果，跳过正文、工具输出和用量记录。
function taskEvent(line) {
  if (!line || !(line.includes('"session_meta"') || line.includes('"turn_context"')
    || (line.includes('"event_msg"') && TASK_MARKERS.some((marker) => line.includes(marker))))) return null;
  try {
    const event = JSON.parse(line.toString('utf8'));
    return event?.type === 'session_meta' || event?.type === 'turn_context'
      || (event?.type === 'event_msg' && TASK_EVENTS.includes(event.payload?.type)) ? event : null;
  } catch {
    return null;
  }
}

// 按本次检查的文件长度读取完整行，半行保留原偏移，超长行也不会无限累积内存。
async function* logLines(file, offset, size) {
  if (offset >= size) return;
  const stream = createReadStream(file, { start: offset, end: size - 1, highWaterMark: 128 * 1024 });
  let fragments = [], length = 0;
  for await (const chunk of stream) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const fragment = chunk.subarray(start, newline < 0 ? chunk.length : newline);
      length += fragment.length;
      if (length > MAX_LINE_BYTES) fragments = [];
      else if (fragment.length) fragments.push(fragment);
      if (newline < 0) break;
      offset += length + 1;
      yield { line: fragments.length > 1 ? Buffer.concat(fragments, length) : fragments[0], offset };
      fragments = [];
      length = 0;
      start = newline + 1;
    }
  }
}

// 恢复历史会话时按需读取首行以识别实例下的会话、子代理和继承边界。
async function readMetadata(file, offset, state, home) {
  for await (const { line } of logLines(file, 0, offset)) {
    const event = taskEvent(line);
    if (event?.type === 'session_meta') parseUsageEvent(event, state, home);
    break;
  }
}

// 旧会话追加不带轮次的结果时，用读取位置前的近期记录恢复轮次，避免同一轮响两次。
async function readPreviousTurn(file, offset, state, home) {
  const context = { ...state, turn: '' };
  for await (const { line } of logLines(file, Math.max(0, offset - 128 * 1024), offset)) {
    const event = taskEvent(line);
    if (!event) continue;
    const { task } = parseUsageEvent(event, context, home);
    if (task?.turn) context.turn = task.turn;
  }
  return context.turn;
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
  let state = continuing && previous.state ? { ...previous.state } : null;
  const tasks = [];
  if (offset < stat.size) {
    const start = offset;
    if (!state) {
      state = parserState();
      if (start) await readMetadata(file, start, state, source.id);
    }
    let previousTurn;
    for await (const entry of logLines(file, start, stat.size)) {
      offset = entry.offset;
      const event = taskEvent(entry.line);
      if (!event) continue;
      const { task } = parseUsageEvent(event, state, source.id);
      if (!task) continue;
      if (task.turn) state.turn = task.turn;
      if (!(task.time > workerData.startedAt)) continue;
      if (!task.turn && start) {
        previousTurn ??= await readPreviousTurn(file, start, state, source.id);
        task.turn = state.turn = previousTurn;
      }
      // 跨线程只发提醒所需的标识和结果，正文、目录和账户信息留在读取线程内。
      tasks.push({ home: source.id, thread: task.thread || path.basename(file, '.jsonl'),
        turn: task.turn, time: task.time, status: task.status, source: task.source });
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
