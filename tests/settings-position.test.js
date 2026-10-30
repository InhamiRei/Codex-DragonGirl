import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../src/core/settings.js';
import { Monitor } from '../src/main/monitor.js';
import { EventEmitter } from 'node:events';

// 同时拖动多个角色和保存旧草稿，磁盘结果仍须保留每个实例的新位置。
test('并发位置更新与旧表单保存不互相覆盖', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-position-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory);
  const draft = await store.load();
  const first = path.join(directory, 'first'), second = path.join(directory, 'second');
  await Promise.all([
    store.save((current) => ({ ...current, followOffsets: { ...current.followOffsets, [first]: { x: 0.2, y: 0.3 } } })),
    store.save((current) => ({ ...current, followOffsets: { ...current.followOffsets, [second]: { x: 0.7, y: 0.8 } } })),
    store.save((current) => ({ ...draft, volume: 0.2, followOffsets: current.followOffsets })),
  ]);
  const restored = await new SettingsStore(directory).load();
  assert.deepEqual(restored.followOffsets, { [first]: { x: 0.2, y: 0.3 }, [second]: { x: 0.7, y: 0.8 } });
  assert.equal(restored.volume, 0.2);
  // 显式替换仍可恢复备份中的位置，普通保存与导入意图区分开。
  await store.save({ ...restored, followOffsets: { [first]: { x: 0.1, y: 0.9 } } });
  assert.deepEqual((await new SettingsStore(directory).load()).followOffsets, { [first]: { x: 0.1, y: 0.9 } });
});

// 退出时故意阻塞磁盘队列，确认保存完成前不关闭 Worker，也不重新创建扫描定时器。
test('停止监控等待位置写入，迟到保存不会重启后台任务', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-position-exit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const monitor = new Monitor(directory, { testMode: true });
  monitor.settings = await monitor.settingsStore.load();
  monitor.saveCache = async () => {};
  const worker = new EventEmitter();
  let closed = false, configured = false, release;
  worker.postMessage = ({ type }) => {
    if (type === 'close') { closed = true; queueMicrotask(() => worker.emit('exit')); }
    if (type === 'configure') configured = true;
  };
  worker.terminate = async () => {};
  monitor.worker = worker;
  monitor.settingsStore.queue = new Promise((resolve) => { release = resolve; });
  const home = path.join(directory, 'home');
  const saving = monitor.saveSettings((current) => ({ ...current, followOffsets: { [home]: { x: 0.4, y: 0.5 } } }));
  const stopping = monitor.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await Promise.all([saving, stopping]);
  assert.equal(closed, true);
  assert.equal(configured, false);
  assert.equal(monitor.scanTimer, undefined);
  assert.deepEqual((await new SettingsStore(directory).load()).followOffsets[home], { x: 0.4, y: 0.5 });
});
