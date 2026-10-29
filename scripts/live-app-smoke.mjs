import { installReferenceAudio } from './install-reference-audio.mjs';
import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = process.cwd(),
  data = await fs.mkdtemp(path.join(os.tmpdir(), 'dragongirl-live-'));
const seed = path.join(root, '.artifacts/live-usage-validation/usage.sqlite');
await fs.copyFile(seed, path.join(data, 'usage.sqlite'));
await installReferenceAudio(path.join(data, 'assets'));
const env = {
  ...process.env,
  DRAGONGIRL_TEST: '1',
  DRAGONGIRL_MONITOR_TEST: '1',
  DRAGONGIRL_LIVE_VERIFY: '1',
  DRAGONGIRL_DATA_DIR: data,
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
// 实际账户验收只记录成功状态、窗口种类与响应年龄，不保存账户标识或正文。
try {
  app = await _electron.launch({ args: [root], env, timeout: 30000 });
  const until = async (check, message, timeout = 45000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(message);
  };
  await until(() => app.evaluate(() => !!globalThis.__dragonGirlApp?.monitor), '采集器未启动');
  await until(
    () =>
      app.evaluate(() => {
        const m = globalThis.__dragonGirlApp.monitor;
        return (
          m.instances.length >= 2 &&
          m.instances.every((i) => !!m.readings.get(i.id)?.quota && !m.readings.get(i.id)?.error)
        );
      }),
    '真实账户额度未全部读取成功',
  );
  await until(
    () => app.evaluate(() => globalThis.__dragonGirlApp.monitor.processes.length >= 2),
    '原生多开进程未发现',
  );
  // 走与界面按钮相同的命令，确认真实账户完成时间与账本索引一并返回。
  const refresh = await app.evaluate(() => globalThis.__dragonGirlApp.dashboard.command('refresh'));
  assert.ok(refresh.success > 0, '没有真实账户刷新成功');
  assert.equal(refresh.running, false);
  assert.equal(refresh.indexError, null);
  assert.ok(refresh.finishedAt >= refresh.startedAt && refresh.indexedAt >= refresh.startedAt);
  const result = await app.evaluate(() => {
    const a = globalThis.__dragonGirlApp,
      m = a.monitor;
    return {
      passed: true,
      instances: m.instances.map((i, n) => ({
        number: n + 1,
        running: m.processes.some((p) => p.home === i.home),
        quota: !!m.readings.get(i.id)?.quota,
        source: m.readings.get(i.id)?.quota?.source,
        windows: m.readings.get(i.id)?.quota?.buckets.flatMap((b) => b.windows.map((w) => w.minutes)),
      })),
      nativePermission: m.screenPermission,
      followed: !!a.companion.followTarget,
      nativePid: m.native?.pid,
      indexFiles: m.progress.total,
    };
  });
  assert.ok(result.instances.every((i) => i.quota));
  result.manualRefresh = refresh;
  assert.equal(result.followed, true);
  const nativePid = result.nativePid;
  delete result.nativePid;
  await app.close();
  app = null;
  let alive = false;
  try {
    process.kill(nativePid, 0);
    alive = true;
  } catch {}
  assert.equal(alive, false, '应用退出后原生观察进程仍存活');
  result.processCleanup = true;
  await fs.writeFile(
    path.join(root, '.artifacts/live-app-report.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await app?.close().catch(() => {});
  await fs.rm(data, { recursive: true, force: true });
}
