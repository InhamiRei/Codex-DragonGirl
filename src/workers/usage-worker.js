import { parentPort, workerData } from 'node:worker_threads';
import { Ledger } from '../core/ledger.js';
import fs from 'node:fs/promises';
const ledger = new Ledger(workerData.file);
let scanning = false,
  stopping = false,
  instances = [],
  settings = {},
  lastScan = 0,
  ledgerScanErrors = 0;
// 所有数据库访问串行通过消息队列，主线程不进行历史 JSON 解析。
let queue = Promise.resolve();
parentPort.on('message', (message) => {
  queue = queue
    .then(() => handle(message))
    .catch((error) => parentPort.postMessage({ id: message.id, error: error.message }));
});
// 扫描每个目录的变化文件，并把进度和最新额度观测交给主进程。
async function scan() {
  if (scanning || stopping) return;
  scanning = true;
  const errors = [];
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
      let latest = null,
        account = null;
      for (const file of files) {
        if (stopping) break;
        try {
          const state = await ledger.scanFile(file, instance.id, (task) =>
            parentPort.postMessage({ type: 'task', task }),
          );
          if (state.quota && (!latest || state.quota.capturedAt > latest.capturedAt)) {
            latest = state.quota;
            account = state.account;
          }
          parentPort.postMessage({
            type: 'thread-state',
            home: instance.id,
            thread: state.thread,
            status: state.status,
            lastAt: state.lastAt,
            parent: state.parent,
          });
        } catch {
          errors.push({ home: instance.id, file: file.split('/').pop(), message: '无法读取或解析日志' });
        }
        done++;
        if (done % 8 === 0) parentPort.postMessage({ type: 'progress', done, total });
      }
      parentPort.postMessage({ type: 'log-quota', home: instance.id, quota: latest, account });
    }
    ledger.prune(settings.retentionDays);
    lastScan = Date.now();
    ledgerScanErrors = errors.length;
    parentPort.postMessage({ type: 'progress', done, total, complete: true, errors });
    parentPort.postMessage({ type: 'indexed', at: lastScan });
  } finally {
    scanning = false;
  }
}
// 固定命令集合不接受任意 SQL，导出仅返回规范化用量字段。
async function handle(m) {
  if (m.type === 'configure') {
    instances = m.instances;
    settings = m.settings;
    await scan();
  } else if (m.type === 'scan') {
    await scan();
    if (m.id) parentPort.postMessage({ id: m.id, result: { at: lastScan, errors: ledgerScanErrors } });
  }
  else if (m.type === 'report')
    parentPort.postMessage({ id: m.id, result: ledger.report(m.filter, settings) });
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
