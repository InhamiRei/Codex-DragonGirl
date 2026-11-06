import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Monitor } from '../src/main/monitor.js';
import { normalizeSettings } from '../src/core/settings.js';

// 可控的完成信号让并发测试无需依赖网络速度或固定等待时间。
function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// 只向当前可用管道发送有限窗口编号，失联、背压和停止期间等待后续恢复，不继续积压旧排序。
test('Windows 层级管道校验编号并在恢复后重新接受请求', () => {
  const monitor = new Monitor(os.tmpdir(), { testMode: true });
  const writes = [];
  const input = { writable: true, destroyed: false, writableLength: 0,
    // 记录完整行协议，原生端读取的数字不能混入任意命令。
    write(value) { writes.push(JSON.parse(value)); },
  };
  assert.equal(monitor.stackWindows(1, [2, 3], [2, 3]), false);
  monitor.native = { stdin: input };
  assert.equal(monitor.stackWindows(1, ['2', '3'], ['2', '3']), true);
  assert.deepEqual(writes, [{ host: 1, overlays: [2, 3], owned: [2, 3] }]);
  assert.equal(monitor.stackWindows(1, [NaN], []), false);
  input.writableLength = 20000;
  assert.equal(monitor.stackWindows(1, [2], [2]), false);
  input.writableLength = 0;
  input.destroyed = true;
  assert.equal(monitor.stackWindows(1, [2], [2]), false);
  input.destroyed = false;
  assert.equal(monitor.stackWindows(0, [2, 3], []), true);
  monitor.stopped = true;
  assert.equal(monitor.stackWindows(1, [2], [2]), false);
  assert.equal(writes.length, 2);
});

// 只有遮挡顺序变化时也必须触发跟随，同时避免管理界面与账户数据重复刷新。
test('原生层级单独变化立即同步窗口，实例与权限变化仍正常发布', async () => {
  const monitor = new Monitor(os.tmpdir(), { testMode: true });
  const bridge = monitor.native = {};
  let publications = 0;
  const orders = [];
  monitor.publish = () => publications++;
  monitor.on('windows', () => orders.push(monitor.windowOrder));
  const row = { pid: 123, home: os.tmpdir(), frontmost: false, windows: [{ id: 1, x: 100, y: 100, width: 800, height: 600 }] };
  await monitor.receiveNative({ processes: [row], screenPermission: true, windowOrder: [3, 2, 1] }, bridge);
  assert.equal(publications, 1);
  await monitor.receiveNative({ processes: [row], screenPermission: true, windowOrder: [3, 1, 2] }, bridge);
  assert.deepEqual(orders, [[3, 2, 1], [3, 1, 2]]);
  assert.equal(publications, 1);
  // Windows 静止心跳也要触发层级校正，但不能重新发布用量或重绘管理界面。
  await monitor.receiveNative({ processes: [row], screenPermission: true, windowOrder: [3, 1, 2] }, bridge);
  assert.deepEqual(orders, [[3, 2, 1], [3, 1, 2], [3, 1, 2]]);
  assert.equal(publications, 1);
  await monitor.receiveNative({ processes: [{ ...row, frontmost: true }], screenPermission: true, windowOrder: [1, 3, 2] }, bridge);
  assert.equal(publications, 2);
  await monitor.receiveNative({ processes: [{ ...row, frontmost: true }], screenPermission: false, windowOrder: [1, 3, 2] }, bridge);
  assert.equal(publications, 3);
});

// 后台刷新未完成时的点击必须排队，重复入口复用任务，并等到账本汇总结束。
test('手动刷新串接正在进行的批次，合并重复操作并等待账本', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-refresh-'));
  const monitor = new Monitor(directory, { testMode: true });
  t.after(async () => {
    monitor.stopped = true;
    clearTimeout(monitor.publishTimer);
    await fs.rm(directory, { recursive: true, force: true });
  });
  monitor.settings = normalizeSettings();
  monitor.instances = [{ id: 'a' }, { id: 'b' }];
  const automatic = gate(), manual = gate(), started = gate(), scanned = gate(), summarized = gate();
  let calls = 0, finished = false;
  // 替换边界服务，验证调度顺序；实际 RPC 和 Worker 扫描由桌面集成测试覆盖。
  monitor.refreshOne = async (_instance, details) => {
    assert.equal(details, true, '自动与手动刷新都应读取重置卡详情');
    calls++;
    const batch = calls <= 2 ? automatic : manual;
    if (calls === 4) started.resolve();
    await batch.promise;
    return true;
  };
  monitor.discover = async () => {};
  monitor.request = () => scanned.promise;
  monitor.summaryPromise = summarized.promise;
  const background = monitor.refresh();
  const foreground = monitor.refreshAll();
  foreground.then(() => { finished = true; });
  assert.equal(monitor.refreshAll(), foreground);
  assert.equal(monitor.refresh(), foreground);
  assert.equal(calls, 2);
  automatic.resolve();
  await background;
  await started.promise;
  manual.resolve();
  scanned.resolve({ errors: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, '汇总未完成时不应报告刷新完成');
  summarized.resolve();
  const result = await foreground;
  assert.equal(calls, 4);
  assert.equal(result.success, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.running, false);
  assert.equal(result.indexError, null);
  assert.ok(result.finishedAt >= result.startedAt);
});

// 意外退出必须结束已发出的查询，并拒绝后续查询，刷新按钮不能永久挂起。
test('统计进程退出同时拒绝当前和后续请求', async (t) => {
  const monitor = new Monitor(os.tmpdir(), { testMode: true });
  t.after(() => { monitor.stopped = true; clearTimeout(monitor.publishTimer); });
  monitor.worker = { postMessage() {} };
  const pending = monitor.request('report');
  monitor.workerFailed();
  await assert.rejects(pending, /统计进程异常/);
  await assert.rejects(monitor.request('scan'), /统计进程异常/);
  assert.equal(monitor.pending.size, 0);
  assert.equal(monitor.scanning, false);
});

// 没有新增日志时复用汇总，价格与预算设置变化后仍能重新计算。
test('空闲扫描不重复汇总，新增日志和偏好变化会更新数据', { timeout: 15000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-index-cache-'));
  const home = path.join(directory, 'fixture-home');
  const folder = path.join(home, 'sessions');
  await fs.mkdir(folder, { recursive: true });
  const monitor = new Monitor(directory, { testMode: true });
  t.after(async () => { await monitor.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  await monitor.settingsStore.save({ manualHomes: [home] });
  // 多份历史和一份近期日志用于核对通信数量与状态回收，不接触真实账号。
  const stamp = new Date().toISOString();
  const historical = new Date(Date.now() - 86400000).toISOString();
  for (let index = 0; index < 65; index++) {
    const timestamp = index === 64 ? stamp : historical;
    await fs.writeFile(path.join(folder, `${index}.jsonl`), [
      { type: 'session_meta', timestamp, payload: { id: `thread-${index}` } },
      { type: 'turn_context', timestamp, payload: { model: 'fixture-model' } },
      { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'turn' } },
      { type: 'token_usage_record', timestamp, payload: { response_id: `response-${index}`, usage: { input_tokens: 100, total_tokens: 100 } } },
    ].map(JSON.stringify).join('\n') + '\n');
  }
  let reports = 0;
  const request = monitor.request.bind(monitor);
  monitor.request = (type, value) => { if (type === 'report') reports++; return request(type, value); };
  await monitor.start();
  await monitor.request('scan');
  await monitor.summaryPromise;
  assert.equal(monitor.summary.total, 6500);
  assert.equal(monitor.activeTasks.size, 1);
  const revision = monitor.dataRevision;
  const initialReports = reports;
  const messages = [];
  monitor.worker.on('message', (message) => messages.push(message));
  await monitor.request('scan');
  await monitor.summaryPromise;
  assert.equal(reports, initialReports, '空闲扫描仍然重复查询全部历史');
  assert.equal(monitor.dataRevision, revision);
  assert.equal(messages.filter((m) => m.type === 'thread-states').length, 1);
  assert.equal(messages.filter((m) => m.type === 'thread-state').length, 0);
  await fs.appendFile(path.join(folder, '64.jsonl'), JSON.stringify({ type: 'token_usage_record', timestamp: stamp,
    payload: { response_id: 'appended', usage: { input_tokens: 50, total_tokens: 50 } } }) + '\n');
  await monitor.request('scan');
  await monitor.summaryPromise;
  assert.equal(monitor.summary.total, 6550);
  assert.ok(monitor.dataRevision > revision);
  await monitor.saveSettings({ ...monitor.settings, prices: { 'fixture-model': { input: 1, cached: 0, output: 1 } } });
  await monitor.request('scan');
  await monitor.summaryPromise;
  assert.ok(Math.abs(monitor.summary.cost - 0.00655) < 1e-12);
  await fs.rm(path.join(folder, '64.jsonl'));
  await monitor.request('scan');
  assert.equal(monitor.activeTasks.size, 0, '已移除日志的任务状态没有释放');
});
