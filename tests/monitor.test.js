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
