import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { normalizeSettings } from '../src/core/settings.js';
import { Monitor } from '../src/main/monitor.js';

// 生成真实 JSONL 结构，避免提醒监听依赖模拟的日志解析器。
function logLine(type, payload, timestamp = new Date().toISOString(), ordinal) {
  return JSON.stringify({ type, payload, timestamp, ordinal }) + '\n';
}

// 主任务和子代理使用同一种任务结果，子代理身份来自会话首行。
function finish(turn, timestamp) {
  return logLine('event_msg', { type: 'task_complete', turn_id: turn }, timestamp);
}

// 采用 Codex 的日期目录布局，核对跨日路径使用的本地日期。
function todayFolder(home) {
  const date = new Date();
  return path.join(home, 'sessions', String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
}

// 等待实际提醒到达，使用上限报错而不是依赖固定睡眠时间。
async function until(check, message) {
  const deadline = Date.now() + 7000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await delay(25);
  }
}

// 升级旧版设置时保持账本的频率，独立验证提醒间隔和开关的默认值及范围。
test('提醒设置默认两秒和关闭子代理，并限制调整范围', () => {
  const legacy = normalizeSettings({ scanSeconds: 30 });
  assert.equal(legacy.scanSeconds, 30);
  assert.equal(legacy.taskCheckSeconds, 2);
  assert.equal(legacy.subagentNotifications, false);
  assert.equal(normalizeSettings({ taskCheckSeconds: 1 }).taskCheckSeconds, 2);
  assert.equal(normalizeSettings({ taskCheckSeconds: 99 }).taskCheckSeconds, 60);
  assert.equal(normalizeSettings({ subagentNotifications: true }).subagentNotifications, true);
});

// 同时完成时即便 Worker 先读到子代理，也必须先提示主任务，并为每条子代理留出展示时间。
test('并发主任务优先，逐个显示子代理且同一轮只通知一次', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const monitor = new Monitor(os.tmpdir(), { testMode: true });
  monitor.settings = normalizeSettings({ subagentNotifications: true });
  monitor.instances = [{ id: 'home', name: '测试实例' }];
  const notices = [];
  monitor.on('notice', (notice) => notices.push(notice));
  const parent = { home: 'home', thread: 'parent', turn: 'shared-turn', source: '主任务', status: 'complete' };
  const child = { ...parent, thread: 'child', source: '子代理' };
  // 同一批次里的错误记录不能抢占随后确认的成功结果。
  monitor.receiveTaskEvents([child, { ...parent, status: 'error' }, parent,
    { ...parent, time: 10 }, { ...child, turn: 'next-turn' }]);
  assert.deepEqual(notices.map((notice) => notice.dialogueKind), ['complete']);
  t.mock.timers.tick(2000);
  assert.equal(notices[1].text, '子代理完成');
  assert.equal(notices[1].expression, undefined);

  // 子代理已经在显示时，新到的主任务可以立刻插队，剩余子代理随后继续。
  monitor.receiveTaskEvents([{ ...parent, turn: 'next-turn' }, { ...child, time: 20 }]);
  assert.equal(notices[2].dialogueKind, 'complete');
  t.mock.timers.tick(2000);
  assert.equal(notices[3].text, '子代理完成');
  t.mock.timers.tick(4000);
  assert.equal(notices.length, 4);
});

// 用实际监听器验证继承日志不会消费父轮次的提醒，同时覆盖首读、分批追加和重启后回读。
test('子代理继承父会话的历史不会误报主任务停止或占用真正的结束提醒', { timeout: 20000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-inherited-notices-'));
  const sessions = path.join(home, 'sessions');
  await fs.mkdir(sessions);
  const monitor = new Monitor(home, { testMode: true });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(home, { recursive: true, force: true });
  });
  const now = Date.now(), fresh = new Date(now).toISOString(), old = new Date(now - 60000);
  const parentMeta = logLine('session_meta', { id: 'parent', source: 'cli', timestamp: old.toISOString() }, fresh, 1);
  // 三个子会话使用相同的继承边界，复制过来的结束记录带着新时间戳。
  const childMeta = (id) => logLine('session_meta', { id, parent_thread_id: 'parent',
    source: { subagent: {} }, subagent_history_start_ordinal: 284 }, fresh, 0);
  const history = parentMeta
    + logLine('turn_context', { turn_id: 'parent-turn' }, fresh, 279)
    + logLine('event_msg', { type: 'task_started', turn_id: 'parent-turn' }, fresh, 280)
    + logLine('event_msg', { type: 'turn_aborted', turn_id: 'parent-turn' }, fresh, 281);
  const childDone = logLine('event_msg', { type: 'task_complete' }, fresh, 284);
  const parent = path.join(sessions, 'parent.jsonl');
  const appended = path.join(sessions, 'appended.jsonl'), resumed = path.join(sessions, 'resumed.jsonl');
  await fs.writeFile(parent, parentMeta + logLine('turn_context', { turn_id: 'parent-turn' }, fresh));
  await fs.writeFile(path.join(sessions, 'child.jsonl'), childMeta('child') + history + childDone);
  await fs.writeFile(appended, childMeta('appended'));
  await fs.writeFile(resumed, '\n' + childMeta('resumed') + history);
  await fs.utimes(resumed, old, old);

  monitor.instances = [{ id: 'home', name: '测试实例', home }];
  monitor.settings = normalizeSettings({ subagentNotifications: false, taskCheckSeconds: 60 });
  monitor.taskStartedAt = now - 1000;
  const notices = [];
  monitor.on('notice', (notice) => notices.push(notice.dialogueKind));
  monitor.startTaskWorker();
  // 每批都含有真实结果，用 Worker 回执确认扫描完成，避免因为检查过早而误判没有提醒。
  const nextTasks = async () => (await once(monitor.taskWorker, 'message', { signal: AbortSignal.timeout(5000) }))[0].tasks;
  const initial = await nextTasks();
  assert.deepEqual(initial.map(({ thread, turn, status, source }) => [thread, turn, status, source]),
    [['child', '', 'complete', '子代理']]);
  assert.deepEqual(notices, []);

  // 新增的子轮次可用自己的上下文；旧文件的无轮次结果不可借用回读到的父轮次。
  await fs.appendFile(appended, history + logLine('turn_context', { turn_id: 'child-turn' }, fresh, 284)
    + logLine('event_msg', { type: 'task_complete' }, fresh, 285));
  await fs.appendFile(resumed, childDone);
  await fs.appendFile(parent, finish('parent-turn', fresh)
    + logLine('event_msg', { type: 'turn_aborted', turn_id: 'another-parent-turn' }, fresh));
  const next = nextTasks();
  monitor.reconcileTaskLogs();
  const tasks = await next;
  assert.deepEqual(tasks.map(({ thread, turn, status, source }) => [thread, turn, status, source]).sort(), [
    ['appended', 'child-turn', 'complete', '子代理'], ['resumed', '', 'complete', '子代理'],
    ['parent', 'parent-turn', 'complete', '主任务'], ['parent', 'another-parent-turn', 'cancelled', '主任务'],
  ].sort());
  await until(() => notices.length === 2, '主任务真正完成和取消时均应提醒');
  assert.deepEqual(notices, ['complete', 'cancelled']);
});

// 用真正的两个 Worker 验证初次短会话、恢复旧会话、重复日志和用量隔离。
test('独立监听跳过旧完成，及时发现短会话且不依赖账本进程', { timeout: 20000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-task-notices-'));
  const home = path.join(directory, 'codex-home');
  const sessions = path.join(home, 'sessions');
  const resumed = path.join(sessions, 'resumed.jsonl');
  const monitor = new Monitor(directory, { testMode: true });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.mkdir(sessions, { recursive: true });
  const old = new Date(Date.now() - 10000).toISOString();
  await fs.writeFile(resumed, logLine('session_meta', { id: 'resumed' }, old)
    + finish('history', old) + logLine('event_msg', { type: 'task_started', turn_id: 'resumed-turn' }, old));
  await monitor.settingsStore.save({ manualHomes: [home], notifications: false });
  const notices = [];
  monitor.on('notice', (notice) => notices.push(notice));
  await monitor.start();
  await monitor.request('scan');
  await monitor.summaryPromise;
  const scanTimer = monitor.scanTimer;
  clearInterval(scanTimer);
  const lastIndex = monitor.indexedAt;
  const detected = [];
  monitor.taskWorker.on('message', (message) => { if (message.type === 'tasks') detected.push(...message.tasks); });

  // 在同一次目录变更中完成新建会话和子代理。暂时停表，提醒先于用量入账。
  const recent = todayFolder(home);
  await fs.mkdir(recent, { recursive: true });
  const child = path.join(recent, 'child.jsonl');
  const short = path.join(recent, 'short.jsonl');
  await fs.writeFile(child, logLine('session_meta', { id: 'child', source: { subagent: {} } })
    + logLine('token_usage_record', { response_id: 'child-request', usage: { total_tokens: 42 } })
    + finish('child-turn'));
  await fs.writeFile(short, logLine('session_meta', { id: 'short' })
    + logLine('event_msg', { type: 'error', turn_id: 'short-turn' }) + finish('short-turn'));
  await until(() => detected.some((task) => task.thread === 'child') && notices.length, '新建即结束的主任务没有提醒');
  assert.deepEqual(notices.map((notice) => notice.dialogueKind), ['complete']);
  assert.ok(detected.some((task) => task.thread === 'short'));
  assert.equal(monitor.indexedAt, lastIndex);

  // 开关关闭时也统计子代理用量，修改提醒选项不会重置账本计时器。
  await monitor.request('scan');
  await monitor.summaryPromise;
  const childUsage = await monitor.request('report', { filter: { source: '子代理' } });
  assert.equal(childUsage.total, 42);
  await monitor.saveSettings({ ...monitor.settings, taskCheckSeconds: 3, subagentNotifications: true });
  assert.equal(monitor.scanTimer, scanTimer);
  await monitor.worker.terminate();
  assert.equal(monitor.workerUnavailable, true);

  // 重复一轮的事件和整个日志副本都只提醒一次。恢复旧会话仍读取新的轮次结束。
  await fs.appendFile(short, finish('short-turn'));
  await fs.copyFile(short, path.join(recent, 'short-copy.jsonl'));
  await fs.appendFile(child, finish('child-turn'));
  await fs.appendFile(resumed, finish(undefined));
  await until(() => notices.length >= 2, '账本停止后没有收到恢复会话的提醒');
  assert.ok(detected.some((task) => task.thread === 'resumed' && task.turn === 'resumed-turn'));
  assert.ok(detected.filter((task) => task.thread === 'short').length >= 2);
  assert.ok(detected.every((task) => task.turn !== 'history'));
  assert.deepEqual(notices.map((notice) => notice.dialogueKind), ['complete', 'complete']);
  assert.equal(monitor.mainTaskNotices.length + monitor.subagentTaskNotices.length, 0);
});

// 模拟系统成功注册监听却静默丢掉事件，覆盖真实 macOS 上偶发的建档竞态。
test('目录监听静默漏事件时也能及时读到新建即完成的会话', { timeout: 12000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-watch-drop-'));
  const recent = todayFolder(home);
  const startedAt = Date.now() - 1000;
  let worker;
  t.after(async () => {
    await worker?.terminate();
    await fs.rm(home, { recursive: true, force: true });
  });
  await fs.mkdir(recent, { recursive: true });
  await fs.writeFile(path.join(recent, 'initial.jsonl'), logLine('session_meta', { id: 'initial' }) + finish('first'));
  const entry = new URL('../src/workers/task-worker.js', import.meta.url).href;
  // 在独立线程替换监听接口，真实任务 Worker 的其余读写和调度均照常运行。
  worker = new Worker(`
    const fs = require('node:fs');
    const { EventEmitter } = require('node:events');
    fs.watch = () => Object.assign(new EventEmitter(), { close() {} });
    require('node:module').syncBuiltinESMExports();
    import(${JSON.stringify(entry)});
  `, { eval: true, workerData: { startedAt } });
  const initial = once(worker, 'message', { signal: AbortSignal.timeout(5000) });
  worker.postMessage({ type: 'configure', interval: 2000, instances: [{ id: 'test', home }] });
  assert.deepEqual((await initial)[0].tasks.map(({ thread }) => thread), ['initial']);

  // 首次扫描完成后才落盘，后续只能靠近期目录的常规检查发现新文件。
  const delivered = once(worker, 'message', { signal: AbortSignal.timeout(5000) });
  await fs.writeFile(path.join(recent, 'short.jsonl'), logLine('session_meta', { id: 'short' }) + finish('next'));
  assert.deepEqual((await delivered)[0].tasks.map(({ thread }) => thread), ['short']);
});
