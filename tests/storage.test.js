import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/main/state-store.js';
import { DEFAULT_STATE } from '../src/shared/state.js';

// 连续更新与立即退出模拟真实拖动、缩放和关闭的时序。
test('连续保存串行完成，最后一次设置在重新打开后仍存在', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dragongirl-state-'));
  try {
    const file = path.join(directory, 'preferences.json');
    const store = new StateStore(file);
    assert.deepEqual(await store.load(), DEFAULT_STATE);
    const jobs = [];
    for (const scale of [0.75, 1, 1.25, 1.5]) jobs.push(store.save({ ...DEFAULT_STATE, scale }));
    await Promise.all(jobs);
    await store.flush();
    assert.equal((await new StateStore(file).load()).scale, 1.5);
    assert.deepEqual(await fs.readdir(directory), ['preferences.json']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// 坏配置被保存前需要留下恢复副本，避免为了修复位置而丢掉原始文件。
test('损坏配置回退后保留原文件备份', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dragongirl-recover-'));
  try {
    const file = path.join(directory, 'preferences.json');
    await fs.writeFile(file, '{unfinished');
    const store = new StateStore(file);
    assert.deepEqual(await store.load(), DEFAULT_STATE);
    await store.save(DEFAULT_STATE);
    const files = await fs.readdir(directory);
    const recovery = files.find(name => name.startsWith('preferences.json.recovered-'));
    assert.ok(recovery);
    assert.equal(await fs.readFile(path.join(directory, recovery), 'utf8'), '{unfinished');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
