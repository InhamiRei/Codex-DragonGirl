import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Windows 目录结尾的反斜杠会转义启动参数的闭合引号，统一使用规范路径。
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, '.artifacts/project-audit');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-performance-'));
const user = path.join(temporary, 'user');
const home = path.join(user, '.codex');
const timestamp = Date.parse('2026-11-02T02:00:00Z');
let application;

// 等待实际消息处理完成，以节点身份和工作次数判断优化，避免依赖机器快慢。
async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(message);
}

// 等待连续两张完全相同的截图，排除原生窗口首帧与字体栅格尚未稳定的波动。
async function stableScreenshot(page, filename) {
  const deadline = Date.now() + 10000;
  let previous;
  while (Date.now() < deadline) {
    const current = await page.screenshot({ animations: 'disabled' });
    if (previous?.equals(current)) {
      await fs.writeFile(filename, current);
      return current;
    }
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('固定数据下的页面画面未能稳定');
}

// 同一份隔离数据分别启动审查前源码与当前源码，截图使用相同时间与读数。
async function measure(applicationRoot, name) {
  const directory = path.join(temporary, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({
    mode: 'desktop', pinnedBubble: true, soundEnabled: false, eyeTracking: false, blinkEnabled: false,
  }));
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1',
    DRAGONGIRL_DATA_DIR: directory, DRAGONGIRL_FIXTURE_HOME: user };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    console.log(`${name}：启动隔离性能验收`);
    // 发行验证可以直接运行解压后的成品，审查前源码对比仍使用各自入口。
    const executablePath = applicationRoot === root ? process.env.DRAGONGIRL_TEST_EXECUTABLE : null;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}),
      args: [...(executablePath ? [] : [applicationRoot]), '--force-color-profile=srgb'], env, timeout: 30000 });
    console.log(`${name}：应用已启动，等待统计与管理窗口`);
    await until(() => application.evaluate(() => !!globalThis.__dragonGirlApp?.monitor.indexedAt), '账本没有完成初始扫描');
    let page;
    await until(() => { page = application.windows().find((item) => item.url().endsWith('/dashboard.html')); return !!page; }, '管理窗口不存在');
    const errors = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.setFixedTime(timestamp);
    await application.evaluate(async (_, now) => {
      const { monitor: m, dashboard: d } = globalThis.__dragonGirlApp;
      clearInterval(m.discoveryTimer);
      clearInterval(m.scanTimer);
      await m.request('scan');
      await m.summaryPromise;
      clearTimeout(m.publishTimer);
      m.publishTimer = null;
      m.indexedAt = now;
      m.dataRevision = 1;
      const id = m.instances[0].id;
      m.readings.set(id, { loading: false, account: { type: 'chatgpt', planType: 'plus' }, quota: {
        capturedAt: now, buckets: [{ id: 'fixture', plan: 'plus', windows: [
          { id: 'primary', label: '5 小时', remaining: 80, minutes: 300, resetsAt: now + 3600000 },
          { id: 'secondary', label: '周额度', remaining: 60, minutes: 10080, resetsAt: now + 86400000 },
        ] }], resetCredits: { count: 0, details: [] },
      } });
      m.emit('update', m.snapshot());
      await d.updatePets();
    }, timestamp);
    await until(() => page.locator('.account .plan').textContent().then((value) => value === 'Plus'), '固定测试读数未显示');
    await page.evaluate(() => document.fonts.ready);
    await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.window.focus());
    await page.mouse.move(0, 0);
    const screenshot = await stableScreenshot(page, path.join(artifacts, `${name}-overview.png`));
    console.log(`${name}：固定画面已稳定`);
    const pixels = createHash('sha256').update(screenshot).digest('hex');

    // 连续相同推送应保留卡片、指标和图表节点，不能依赖降低推送频率来通过。
    await page.evaluate(() => {
      window.__performance = { updates: 0, removed: 0,
        nodes: ['.account', '#metrics .metric', '#overview-chart .chart-col'].map((selector) => document.querySelector(selector)) };
      window.dragonGirl.onMonitor(() => window.__performance.updates++);
      const observer = new MutationObserver((records) => {
        window.__performance.removed += records.reduce((sum, record) => sum + record.removedNodes.length, 0);
      });
      for (const id of ['accounts', 'metrics', 'overview-chart']) observer.observe(document.getElementById(id), { childList: true, subtree: true });
    });
    await application.evaluate(() => {
      const m = globalThis.__dragonGirlApp.monitor;
      for (let index = 0; index < 10; index++) m.emit('update', m.snapshot());
    });
    await until(() => page.evaluate(() => window.__performance.updates >= 10), '重复推送没有送达渲染器');
    const dom = await page.evaluate(() => ({ removed: window.__performance.removed,
      retained: window.__performance.nodes.map((item) => item.isConnected) }));
    const menuBuilds = await application.evaluate(async () => {
      const { dashboard: d, companion: c } = globalThis.__dragonGirlApp;
      await d.updatePets();
      const build = c.buildMenu.bind(c);
      let count = 0;
      c.buildMenu = () => { count++; return build(); };
      for (let index = 0; index < 10; index++) await d.updatePets();
      c.buildMenu = build;
      return count;
    });
    console.log(`${name}：重复推送和菜单复用检查完成`);

    // 只更新额度，不改变角色外观，常驻气泡也必须拿到新读数。
    const bubbleUpdated = await application.evaluate(async () => {
      const { monitor: m, dashboard: d, companion: c } = globalThis.__dragonGirlApp;
      const quota = m.readings.get(m.instances[0].id).quota;
      quota.capturedAt = Date.now();
      m.emit('update', m.snapshot());
      await d.updatePets();
      c.showBubble(d.bubbleFor(c), 'usage');
      const old = c.bubbleModel.usage.quotas[0].remaining;
      quota.buckets[0].windows[0].remaining = 42;
      m.emit('update', m.snapshot());
      await d.updatePets();
      const updated = old === 80 && c.bubbleModel.usage.quotas[0].remaining === 42;
      c.hideBubble();
      return updated;
    });
    console.log(`${name}：常驻气泡检查完成`);
    // 配额时间不变、只有进程上线时，测智页仍应及时更新运行状态。
    await page.locator('.main-nav [data-tab="account-tests"]').click();
    await until(() => page.locator('.test-account').count().then((count) => count === 1), '账号测智列表未加载');
    const received = await page.evaluate(() => window.__performance.updates);
    await application.evaluate(async () => {
      const { monitor: m, dashboard: d } = globalThis.__dragonGirlApp;
      m.processes = [{ pid: 777777, home: m.instances[0].home, frontmost: true, windows: [] }];
      m.emit('update', m.snapshot());
      await d.updatePets();
    });
    // 等待真实消息被界面消费，不依赖后台或 CI 会话中可能暂停的动画帧。
    await until(() => page.evaluate((before) => window.__performance.updates > before, received), '账号运行状态推送未送达');
    const accountUpdated = /(?:^|\s)运行中/.test(await page.locator('.test-account-copy > .hint').textContent());
    console.log(`${name}：账号状态检查完成`);
    assert.deepEqual(errors, []);
    return { pixels, dom, menuBuilds, bubbleUpdated, accountUpdated };
  } finally {
    await application?.close().catch(() => {});
    application = null;
  }
}

try {
  await fs.mkdir(artifacts, { recursive: true });
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(home, 'sessions/fixture.jsonl'), [
    { type: 'session_meta', timestamp: new Date(timestamp).toISOString(), payload: { id: 'fixture', cwd: '/example/project' } },
    { type: 'token_usage_record', timestamp: new Date(timestamp).toISOString(), payload: {
      response_id: 'fixture', usage: { input_tokens: 100, total_tokens: 100 } } },
  ].map(JSON.stringify).join('\n') + '\n');
  const baseline = process.env.DRAGONGIRL_AUDIT_BASELINE
    ? await measure(process.env.DRAGONGIRL_AUDIT_BASELINE, 'baseline') : null;
  const current = await measure(root, 'current');
  assert.deepEqual(current.dom.retained, [true, true, true], '重复推送仍然替换未变化的节点');
  assert.equal(current.dom.removed, 0, '相同推送仍然重建卡片、指标或图表');
  assert.equal(current.menuBuilds, 0, '未变化的托盘菜单仍然反复构建');
  assert.equal(current.bubbleUpdated, true, '常驻额度气泡没有更新');
  assert.equal(current.accountUpdated, true, '测智页运行状态没有更新');
  if (baseline) assert.equal(current.pixels, baseline.pixels, '优化前后管理页像素发生变化');
  await fs.writeFile(path.join(artifacts, 'performance-report.json'), JSON.stringify({ passed: true, baseline, current }, null, 2));
  console.log('性能回归通过：十次相同推送零节点移除、零菜单重建，常驻气泡与账号状态及时更新。' + (baseline ? '审查前后管理页像素完全一致。' : ''));
} finally {
  await application?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
