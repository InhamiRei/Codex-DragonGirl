import { parentPort, workerData } from 'node:worker_threads';
import { Ledger } from '../core/ledger.js';
import fs from 'node:fs/promises';
import path from 'node:path';
const ledger = new Ledger(workerData.file);
let scanning = false,
  stopping = false,
  instances = [],
  settings = {},
  lastScan = 0,
  ledgerScanErrors = 0;
const changes = ledger.db.prepare('SELECT total_changes() AS count');
const reports = new Map();
let revision = 0, revisionKey = '';
let scanController;
let recentThreads = new Map();

// 只有数据库或统计口径变化才废弃汇总，空闲扫描继续更新完成时间。
function updateRevision() {
  const key = JSON.stringify([changes.get().count, settings.timezone, settings.prices]);
  if (key !== revisionKey) {
    revisionKey = key;
    revision++;
    reports.clear();
  }
}
// 所有数据库访问串行通过消息队列，主线程不进行历史 JSON 解析。
let queue = Promise.resolve();
parentPort.on('message', (message) => {
  // 关闭先中断正在读取的大日志，不能等整份归档读完才处理退出消息。
  if (message.type === 'close') { stopping = true; scanController?.abort(); }
  queue = queue
    .then(() => handle(message))
    .catch((error) => parentPort.postMessage({ type: 'index-error', id: message.id, error: error.message }));
});
// 扫描每个目录的变化文件，并把进度和最新额度观测交给主进程。
async function scan() {
  if (scanning || stopping) return;
  scanning = true;
  scanController = new AbortController();
  const errors = [];
  const threads = new Map();
  let done = 0,
    total = 0;
  try {
    const lists = [];
    for (const i of instances) {
      const files = await ledger.filesFor(i.home);
      lists.push([i, files]);
      total += files.length;
    }
    parentPort.postMessage({ type: 'progress', done, total });
    for (const [instance, files] of lists) {
      if (stopping) break;
      let latest = null,
        account = null;
      for (const file of files) {
        if (stopping) break;
        try {
          const state = await ledger.scanFile(file, instance.id, (task) =>
            parentPort.postMessage({ type: 'task', task }), scanController.signal);
          if (state.quota && (!latest || state.quota.capturedAt > latest.capturedAt)) {
            latest = state.quota;
            account = state.account;
          }
          // 界面只展示十分钟内的任务状态；历史文件不逐条跨线程重复传输。
          const key = `${instance.id}:${state.thread}`;
          if (state.lastAt > Date.now() - 600000 && state.lastAt >= (threads.get(key)?.lastAt || 0)) {
            const current = { home: instance.id, thread: state.thread, status: state.status,
              lastAt: state.lastAt, parent: state.parent };
            threads.set(key, current);
            const prior = recentThreads.get(key);
            // 活动任务有变化时立即推送，首次长扫描也不推迟状态反馈。
            if (current.lastAt >= (prior?.lastAt || 0) && JSON.stringify(current) !== JSON.stringify(prior)) {
              recentThreads.set(key, current);
              parentPort.postMessage({ type: 'thread-state', ...current });
            }
          }
        } catch {
          if (stopping) break;
          errors.push({ home: instance.id, file: path.basename(file), message: '无法读取或解析日志' });
        }
        done++;
        if (done % 8 === 0) parentPort.postMessage({ type: 'progress', done, total });
      }
      parentPort.postMessage({ type: 'log-quota', home: instance.id, quota: latest, account });
    }
    ledger.prune(settings.retentionDays);
    lastScan = Date.now();
    ledgerScanErrors = errors.length;
    updateRevision();
    recentThreads = threads;
    parentPort.postMessage({ type: 'thread-states', states: [...threads.values()] });
    parentPort.postMessage({ type: 'progress', done, total, complete: true, errors });
    parentPort.postMessage({ type: 'indexed', at: lastScan, revision });
  } finally {
    // 部分文件写入后整体扫描失败，也不能继续提供旧的缓存汇总。
    updateRevision();
    scanController = null;
    scanning = false;
  }
}
// 固定命令集合不接受任意 SQL，导出仅返回规范化用量字段。
async function handle(m) {
  if (stopping && m.type !== 'close') {
    if (m.id) parentPort.postMessage({ id: m.id, error: '统计进程正在退出' });
    return;
  }
  if (m.type === 'configure') {
    instances = m.instances;
    settings = m.settings;
    await scan();
  } else if (m.type === 'scan') {
    await scan();
    if (m.id) parentPort.postMessage({ id: m.id, result: { at: lastScan, errors: ledgerScanErrors } });
  }
  else if (m.type === 'report') {
    const key = JSON.stringify(m.filter || {});
    if (!reports.has(key)) {
      // 缓存数量有界，保留总览、今日和近期筛选，不能随用户反复筛选无限增长。
      if (reports.size >= 4) reports.delete(reports.keys().next().value);
      reports.set(key, ledger.report(m.filter, settings));
    }
    parentPort.postMessage({ id: m.id, result: reports.get(key) });
  }
  else if (m.type === 'rows') parentPort.postMessage({ id: m.id, result: ledger.rows(m.filter) });
  else if (m.type === 'rebuild') {
    ledger.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await fs.copyFile(workerData.file, workerData.file + '.backup-' + Date.now());
    ledger.clear();
    await scan();
    parentPort.postMessage({ id: m.id, result: true });
  } else if (m.type === 'backup') {
    ledger.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await fs.copyFile(workerData.file, m.path);
    parentPort.postMessage({ id: m.id, result: true });
  } else if (m.type === 'close') {
    stopping = true;
    ledger.close();
    parentPort.postMessage({ id: m.id, result: true });
    parentPort.close();
  }
}
