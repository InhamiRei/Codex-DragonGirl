import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Monitor } from '../src/main/monitor.js';
import { CLI_UNAVAILABLE, CLI_UNAVAILABLE_MESSAGE } from '../src/core/rpc.js';
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

// 窗口移动和层级变化立即同步给桌宠，避免管理界面重复刷新账户数据。
test('原生几何和层级立即同步，实例与权限变化仍正常发布', async () => {
  const monitor = new Monitor(os.tmpdir(), { testMode: true });
  const bridge = monitor.native = {};
  let publications = 0;
  const orders = [];
  monitor.publish = () => publications++;
  monitor.on('windows', () => orders.push(monitor.windowOrder));
  const row = { pid: 123, home: os.tmpdir(), frontmost: false, windows: [{ id: 1, x: 100, y: 100, width: 800, height: 600 }] };
  await monitor.receiveNative({ processes: [row], screenPermission: true, windowOrder: [3, 2, 1] }, bridge);
  assert.equal(publications, 1);
  const moved = { ...row, windows: [{ ...row.windows[0], x: 200 }] };
  await monitor.receiveNative({ processes: [moved], screenPermission: true, windowOrder: [3, 1, 2] }, bridge);
  assert.deepEqual(orders, [[3, 2, 1], [3, 1, 2]]);
  assert.equal(monitor.processes[0].windows[0].x, 200);
  assert.equal(publications, 1);
  // Windows 静止心跳也要触发层级校正，但不能重新发布用量或重绘管理界面。
  await monitor.receiveNative({ processes: [moved], screenPermission: true, windowOrder: [3, 1, 2] }, bridge);
  assert.deepEqual(orders, [[3, 2, 1], [3, 1, 2], [3, 1, 2]]);
  assert.equal(publications, 1);
  await monitor.receiveNative({ processes: [{ ...row, frontmost: true }], screenPermission: true, windowOrder: [1, 3, 2] }, bridge);
  assert.equal(publications, 2);
  await monitor.receiveNative({ processes: [{ ...row, frontmost: true }], screenPermission: false, windowOrder: [1, 3, 2] }, bridge);
  assert.equal(publications, 3);
});

// 手动点击复用进行中的详细查询，只补读未覆盖的账号，并让账本独立推进。
test('手动刷新复用正在进行的账户查询，账本独立扫描并保留限流', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-refresh-'));
  const monitor = new Monitor(directory, { testMode: true });
  t.after(async () => {
    monitor.stopped = true;
    clearTimeout(monitor.publishTimer);
    await fs.rm(directory, { recursive: true, force: true });
  });
  monitor.settings = normalizeSettings();
  monitor.instances = [{ id: 'a' }, { id: 'b' }, { id: 'limited' }];
  monitor.readings.set('b', { attemptedAt: Date.now(), retryMs: 60000 });
  monitor.readings.set('limited', { error: '查询被限流，稍后自动重试', attemptedAt: Date.now(), retryMs: 60000 });
  const automatic = gate(), manual = gate(), started = gate(), scanning = gate(), scanned = gate(), summarized = gate();
  const calls = [];
  let finished = false;
  // 替换边界服务，验证调度顺序；实际 RPC 和 Worker 扫描由桌面集成测试覆盖。
  monitor.refreshOne = async (instance, details) => {
    assert.equal(details, true, '自动与手动刷新都应读取重置卡详情');
    calls.push(instance.id);
    const batch = instance.id === 'a' ? automatic : manual;
    if (instance.id === 'b') started.resolve();
    await batch.promise;
    return true;
  };
  monitor.discover = async () => {};
  monitor.request = () => { scanning.resolve(); return scanned.promise; };
  monitor.summaryPromise = summarized.promise;
  const background = monitor.refresh();
  const foreground = monitor.refreshAll();
  foreground.then(() => { finished = true; });
  assert.equal(monitor.refreshAll(), foreground);
  assert.equal(monitor.refresh(), foreground);
  assert.deepEqual(calls, ['a']);
  await scanning.promise;
  assert.equal(monitor.refreshState.accountsPending, true);
  assert.equal(monitor.refreshState.indexPending, true);
  automatic.resolve();
  await background;
  await started.promise;
  manual.resolve();
  scanned.resolve({ errors: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, '汇总未完成时不应报告刷新完成');
  summarized.resolve();
  const result = await foreground;
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(result.success, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.running, false);
  assert.equal(result.accountsPending, false);
  assert.equal(result.indexPending, false);
  assert.equal(result.indexError, null);
  assert.ok(result.finishedAt >= result.startedAt);
});

// 本机 CLI 缺失只短等，宿主路径回来后无需等定时窗口，远端限流仍保持原退避。
test('宿主恢复后立即重查找不到 CLI 的账号', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-cli-retry-'));
  const home = await fs.realpath(directory);
  const paths = [];
  const monitor = new Monitor(directory, { testMode: true, accountReader: async (_home, { appPath }) => {
    paths.push(appPath);
    if (!appPath) throw Object.assign(new Error('test'), { code: CLI_UNAVAILABLE });
    return { account: { type: 'chatgpt' }, quota: { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } }, errors: {} };
  } });
  t.after(async () => { clearTimeout(monitor.publishTimer); await fs.rm(directory, { recursive: true, force: true }); });
  monitor.settings = normalizeSettings();
  monitor.instances = [{ id: 'test', home, processes: [] }, { id: 'limited', home: path.join(home, 'limited'), processes: [] }];
  monitor.readings.set('limited', { error: '查询被限流，稍后自动重试', attemptedAt: Date.now(), retryMs: 240000 });
  assert.equal((await monitor.refresh()).failed, 1);
  assert.equal(monitor.readings.get('test').error, CLI_UNAVAILABLE_MESSAGE);
  assert.equal(monitor.readings.get('test').retryMs, 5000);
  assert.equal((await monitor.refresh()).skipped, 2);
  const bridge = monitor.native = {};
  await monitor.receiveNative({ processes: [{ home, appPath: '/fixture/Codex.exe', pid: 10 }] }, bridge);
  assert.equal((await monitor.refresh()).success, 1);
  assert.deepEqual(paths, [undefined, '/fixture/Codex.exe']);
  assert.equal(monitor.readings.get('test').quota.source, '实时账户');
  assert.equal(monitor.readings.get('limited').retryMs, 240000);
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

// 账户退避时连续执行自动检查，只在账户缓存或提醒去重记录变化时写盘。
test('空闲账户检查不重复写缓存和推送界面', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-idle-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const monitor = new Monitor(directory, { testMode: true });
  monitor.settings = normalizeSettings();
  monitor.instances = [{ id: 'account' }];
  monitor.readings.set('account', { attemptedAt: Date.now(), retryMs: 60000 });
  let publications = 0;
  monitor.publish = () => publications++;
  const write = t.mock.method(fs, 'writeFile');
  for (let index = 0; index < 20; index++) {
    const result = await monitor.refresh();
    assert.equal(result.skipped, 1);
  }
  assert.equal(write.mock.callCount(), 1);
  assert.equal(publications, 0);
  monitor.alerts.seen.add('fixture-budget');
  await monitor.refresh();
  await monitor.refresh();
  assert.equal(write.mock.callCount(), 2);
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'snapshots.json'), 'utf8'));
  assert.deepEqual(stored.alerts, ['fixture-budget']);
});

// 账户额度可用时无需遍历历史，读数过期后仍进入日志兜底。
test('新鲜账户额度跳过日志兜底扫描', async (t) => {
  const monitor = new Monitor(os.tmpdir(), { testMode: true });
  monitor.instances = [{ id: 'account', home: os.tmpdir() }];
  const enumerate = t.mock.method(fs, 'readdir', async () => []);
  monitor.readings.set('account', { quota: { capturedAt: Date.now() } });
  await monitor.refreshLogs();
  assert.equal(enumerate.mock.callCount(), 0);
  monitor.readings.set('account', { quota: { capturedAt: Date.now() - 121000 } });
  await monitor.refreshLogs();
  assert.equal(enumerate.mock.callCount(), 1);
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
  const messages = [];
  const workerMessage = monitor.workerMessage.bind(monitor);
  // 从配置开始记录真实 Worker 推送，区分首次建账与已有检查点的扫描。
  monitor.workerMessage = (message) => {
    messages.push(message);
    workerMessage(message);
  };
  await monitor.start();
  await monitor.request('scan');
  await monitor.summaryPromise;
  assert.equal(monitor.summary.total, 6500);
  assert.equal(monitor.activeTasks.size, 1);
  assert.ok(messages.some((m) => m.type === 'progress' && m.building && m.done === 8 && m.total === 65));
  const revision = monitor.dataRevision;
  const initialReports = reports;
  messages.length = 0;
  await monitor.request('scan');
  await monitor.summaryPromise;
  assert.equal(reports, initialReports, '空闲扫描仍然重复查询全部历史');
  assert.equal(monitor.dataRevision, revision);
  const progress = messages.filter((m) => m.type === 'progress');
  assert.equal(progress.length, 2, '已有账本只需要发布检查开始和结束');
  assert.ok(progress.every((m) => m.building === false && m.total === 65));
  assert.equal(messages.filter((m) => m.type === 'thread-states').length, 1);
  assert.equal(messages.filter((m) => m.type === 'thread-state').length, 0);
  // 任务完成仍更新界面和提醒，单纯的任务记录不会触发全量用量汇总。
  await fs.appendFile(path.join(folder, '64.jsonl'), JSON.stringify({ type: 'event_msg', timestamp: stamp,
    payload: { type: 'task_complete', turn_id: 'turn' } }) + '\n');
  await monitor.request('scan');
  await monitor.summaryPromise;
  assert.equal(monitor.dataRevision, revision);
  assert.equal(reports, initialReports);
  assert.equal([...monitor.activeTasks.values()][0].status, 'complete');
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
