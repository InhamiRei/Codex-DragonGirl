import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)),
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-app-')),
  user = path.join(temp, 'user'),
  data = path.join(temp, 'data');
// 不预装用户音效，首次启动必须直接使用安装包中的九段原声。
await fs.mkdir(data, { recursive: true });
// 用旧版已保存的默认模板启动，验证覆盖安装后能直接迁移用量单位。
await fs.writeFile(
  path.join(data, 'settings.json'),
  JSON.stringify({ bubbleTemplate: '{实例} · {套餐}\n{额度}\n今日 {今日用量} 词元 · {任务状态}' }),
);
const homes = [
  path.join(user, '.codex'),
  ...[0, 1, 2, 3].map((n) => path.join(user, '.cockpit_tools/instances/codex', String(n))),
];
// 五份假日志覆盖多于两个实例的隔离，所有会话内容均为测试生成。
for (const [index, home] of homes.entries()) {
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  const time = '2026-10-28T02:00:00Z',
    rows = [
      {
        type: 'session_meta',
        timestamp: time,
        payload: {
          id: `thread-${index}`,
          creator_account_id: `account-${index}`,
          cwd: `/example/project-${index}`,
        },
      },
      { type: 'turn_context', timestamp: time, payload: { model: 'gpt-6.1-sol' } },
      { type: 'event_msg', timestamp: time, payload: { type: 'task_started', turn_id: 't' } },
      {
        type: 'token_usage_record',
        timestamp: time,
        payload: {
          thread_id: `thread-${index}`,
          turn_id: 't',
          response_id: `response-${index}`,
          usage: {
            input_tokens: 900 * (index + 1),
            cached_input_tokens: 600 * (index + 1),
            output_tokens: 100 * (index + 1),
            total_tokens: 1000 * (index + 1),
          },
        },
      },
      { type: 'event_msg', timestamp: time, payload: { type: 'task_complete', turn_id: 't' } },
    ];
  await fs.writeFile(
    path.join(home, 'sessions', 'one.jsonl'),
    rows.map(JSON.stringify).join('\n') + '\n',
  );
}
const env = {
  ...process.env,
  DRAGONGIRL_TEST: '1',
  DRAGONGIRL_MONITOR_TEST: '1',
  DRAGONGIRL_DATA_DIR: data,
  DRAGONGIRL_FIXTURE_HOME: user,
};
delete env.ELECTRON_RUN_AS_NODE;
let application, page;
let processExit = null, stderrTail = '';
const errors = [];
// 等待明确状态条件，失败时报告最接近用户观察的现象。
async function until(check, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(message);
}
// 通过自定义下拉菜单选择选项，同时验证菜单位于输入框正下方。
async function choose(selector, choice) {
  const select = page.locator(selector);
  const id = await select.getAttribute('id');
  const trigger = page.locator(`.select-trigger[data-select="${id}"]`);
  await trigger.click();
  const popup = page.locator(`#${id}-list`);
  await until(() => popup.isVisible(), '下拉菜单没有打开');
  const control = await trigger.boundingBox(),
    menu = await popup.boundingBox();
  assert.ok(Math.abs(menu.x - control.x) <= 1, '下拉菜单左边未对齐');
  assert.ok(Math.abs(menu.y - control.y - control.height - 6) <= 1, '下拉菜单没有出现在正下方');
  assert.ok(Math.abs(menu.width - control.width) <= 1, '下拉菜单宽度不一致');
  const index =
    typeof choice === 'object'
      ? choice.index
      : await select.evaluate((s, value) => [...s.options].findIndex((o) => o.value === value), choice);
  assert.ok(index >= 0, '目标选项不存在');
  await popup.locator('[role="option"]').nth(index).click();
  assert.equal(await popup.isVisible(), false);
}

// 在宽窄窗口中检查导航、设置行与弹层，覆盖用户反馈的对齐和定位问题。
async function verifyLayout() {
  await page.locator('.main-nav [data-tab="settings"]').click();
  for (const size of [
    [880, 660],
    [1160, 820],
    [1440, 900],
  ]) {
    await application.evaluate(
      (_, size) => globalThis.__dragonGirlApp.dashboard.window.setSize(...size),
      size,
    );
    await until(
      () => page.evaluate((width) => Math.abs(window.innerWidth - width) < 4, size[0]),
      '窗口没有调整到验收尺寸',
    );
    await page.locator('[data-settings-tab="appearance"]').click();
    const geometry = await page.evaluate(() => {
      const nav = [...document.querySelectorAll('.main-nav button')].map((b) => ({
        height: b.getBoundingClientRect().height,
        textX: b.querySelector('span').getBoundingClientRect().x,
      }));
      const rows = [
        ...document.querySelectorAll('[data-settings-pane="appearance"] .setting-control'),
      ].map((e) => e.getBoundingClientRect().x);
      const scroll = document.getElementById('content-scroll');
      return { nav, rows, overflow: scroll.scrollWidth > scroll.clientWidth + 1 };
    });
    assert.equal(geometry.nav.length, 4);
    assert.ok(
      geometry.nav.every((r) => r.height === 44 && r.textX === geometry.nav[0].textX),
      '导航文字或高度没有对齐',
    );
    assert.ok(
      geometry.rows.every((x) => Math.abs(x - geometry.rows[0]) < 1),
      '设置控件列没有对齐',
    );
    assert.equal(geometry.overflow, false, '页面出现横向溢出');
    await choose('select[name="mode"]', 'follow');
    const trigger = page.locator('[data-select="display-mode"]');
    const outer = await trigger.boundingBox(),
      arrow = await trigger.locator('.select-chevron').boundingBox();
    assert.ok(outer.x + outer.width - arrow.x - arrow.width >= 12, '下拉箭头贴近右边缘');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('End');
    await page.keyboard.press('Escape');
    assert.equal(
      await page.locator('select[name="mode"]').inputValue(),
      'follow',
      '取消下拉时意外修改了设置',
    );
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('select[name="mode"]').inputValue(), 'desktop', '键盘选择没有生效');
    await page.locator('#cancel-settings').click();
  }
  await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.window.setSize(1160, 820));
  await page.locator('.main-nav [data-tab="overview"]').click();
}

// 只有原生事件使指针离开目标时才重新移入；指针仍在目标上但提示不出现会真实失败。
async function hoverHint(target, message) {
  await target.hover();
  await until(async () => {
    if (!(await target.evaluate((element) => element.matches(':hover')))) await target.hover();
    return (await target.getAttribute('aria-describedby')) === 'chart-tooltip' &&
      await page.locator('#chart-tooltip').isVisible();
  }, message);
}

// 验证卡片顶部信息与真实悬停交互，覆盖后台重绘、键盘访问和窄窗口边界。
async function verifyAccountHeader() {
  // 原生窗口先取得焦点并完成布局，再注入鼠标，避免桌面焦点切换带来迟到的离开事件。
  await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.window.focus());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.mouse.move(1100, 40);
  assert.deepEqual(await page.locator('.account .plan').allTextContents(), [
    'Pro 100', 'Plus', 'Pro 200', 'Pro 500', 'codex_future',
  ]);
  assert.equal(await page.locator('.account .activity-row').count(), 0);
  assert.equal(await page.locator('.account-head .reset-credits').count(), 4);
  for (const text of await page.locator('.account-meta .account-usage').allTextContents())
    assert.match(text, /今日消耗 [\d.万亿]+ Tokens/);
  const tooltip = page.locator('#chart-tooltip');
  const first = page.locator('.account').first().locator('.reset-credits');
  await hoverHint(first, '重置卡悬停未显示详情');
  assert.match(await tooltip.textContent(), /可用重置卡 2 张\n第 1 张 · .+ 到期\n第 2 张 · 无到期限制/);
  await first.evaluate((element) => { element.dataset.beforeRefresh = 'true'; });
  await application.evaluate(() => globalThis.__dragonGirlApp.monitor.publish());
  await until(() => first.getAttribute('data-before-refresh').then((value) => value === null), '后台状态未推送到卡片');
  assert.equal(await first.getAttribute('aria-describedby'), 'chart-tooltip', '后台重绘打断了重置卡提示');
  assert.equal(await tooltip.isVisible(), true);
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  await page.screenshot({ animations: 'disabled', path: path.join(root, '.artifacts/accounts-reset-hover.png') });
  await page.mouse.move(1100, 40);
  await until(() => tooltip.isHidden(), '移出重置卡后提示未关闭');
  // 缺少明细、没有可用卡与未知到期时间必须有各自的真实提示。
  const missing = page.locator('.account').nth(1).locator('.reset-credits');
  await missing.focus();
  await until(() => tooltip.textContent().then((text) => /服务未返回到期明细/.test(text)), '键盘聚焦未显示缺失明细提示');
  await missing.evaluate((element) => { element.dataset.beforeRefresh = 'true'; });
  await application.evaluate(() => globalThis.__dragonGirlApp.monitor.publish());
  await until(() => missing.getAttribute('data-before-refresh').then((value) => value === null), '后台状态未推送到卡片');
  assert.equal(await missing.evaluate((element) => document.activeElement === element), true, '后台重绘丢失了重置卡焦点');
  await missing.evaluate((element) => element.blur());
  const empty = page.locator('.account').nth(2).locator('.reset-credits');
  await empty.hover();
  assert.match(await tooltip.textContent(), /可用重置卡 0 张\n当前没有可用重置卡/);
  await page.locator('.account').nth(3).locator('.reset-credits').focus();
  assert.match(await tooltip.textContent(), /到期时间未知/);
  await page.locator('.account').nth(3).locator('.reset-credits').evaluate((element) => element.blur());
  for (const size of [[880, 660], [1160, 820], [1440, 900]]) {
    await application.evaluate((_, size) => {
      const window = globalThis.__dragonGirlApp.dashboard.window;
      window.setSize(...size);
      window.focus();
    }, size);
    await until(() => page.evaluate((width) => Math.abs(innerWidth - width) < 4, size[0]), '账户卡片窗口未调整');
    await page.evaluate(() => { document.getElementById('content-scroll').scrollTop = 0; });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.account-head, .account-meta')].some((element) => element.scrollWidth > element.clientWidth + 1)), false, '账户卡片顶部信息出现横向溢出');
    await page.mouse.move(size[0] - 20, 40);
    await hoverHint(first, '调整窗口后重置卡悬停未显示详情');
    const bounds = await tooltip.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= size[0] && bounds.y + bounds.height <= size[1], '重置卡提示超出窗口');
    if (size[0] === 880)
      await page.screenshot({ animations: 'disabled', path: path.join(root, '.artifacts/accounts-header-narrow.png') });
    await page.mouse.move(size[0] - 20, 40);
  }
  await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.window.setSize(1160, 820));
}

// 用可控的只读 RPC 子进程和新增日志验证按钮真刷新，所有数据都在隔离目录。
async function verifyUsageRefresh() {
  const fixtureApp = path.join(temp, 'Fixture.app');
  const executable = path.join(fixtureApp, 'Contents/Resources/codex');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const fixture = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'fixture.json')));
// 只读夹具模拟服务延迟，未知方法不返回成功数据。
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (!m.id) return;
  fs.appendFileSync(path.join(process.env.CODEX_HOME, 'rpc-calls.log'), m.method + '\\n');
  if (m.method === 'account/rateLimits/read') fs.writeFileSync(path.join(process.env.CODEX_HOME, 'quota-params.json'), JSON.stringify(m.params));
  const result = m.method === 'initialize' ? {} : m.method === 'account/read' ? { account: { type: 'chatgpt', planType: 'prolite' } } : { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 3600 } }, rateLimitResetCredits: { availableCount: 2, credits: m.params.excludeResetCreditDetails ? null : [{ status: 'available', expiresAt: 1900000000 }, { status: 'available', expiresAt: null }, { status: 'used', expiresAt: 1800000000 }] } };
  setTimeout(() => console.log(JSON.stringify(m.method === 'account/rateLimits/read' && fixture.fail ? { id: m.id, error: { message: 'connection timeout' } } : { id: m.id, result })), m.id === 3 ? 450 : 0);
});
`, { mode: 0o755 });
  for (const [index, home] of homes.entries())
    await fs.writeFile(path.join(home, 'fixture.json'), JSON.stringify({ fail: index === 3 }));
  await application.evaluate((_, appPath) => {
    const m = globalThis.__dragonGirlApp.monitor;
    clearInterval(m.scanTimer);
    m.processes = m.instances.map((i) => ({ home: i.home, pid: 9000, appPath, windows: [] }));
    const limited = m.instances.at(-1);
    m.readings.set(limited.id, { ...m.readings.get(limited.id), error: '查询被限流，稍后自动重试', attemptedAt: Date.now(), retryMs: 300000 });
  }, fixtureApp);
  // 新增四十个会话，其中最后一个位于第三页，用于验证跨页搜索和尾页边界。
  for (let index = 0; index < 40; index++) {
    const timestamp = new Date(Date.UTC(2026, 0, 1 + index * 7, 2)).toISOString();
    const payload = { id: `paged-thread-${index}`, cwd: `/example/paged-project-${index}` };
    const rows = [
      { type: 'session_meta', timestamp, payload },
      { type: 'turn_context', timestamp, payload: { model: 'gpt-6.1-sol' } },
      { type: 'token_usage_record', timestamp, payload: { thread_id: payload.id, turn_id: 'paged', response_id: payload.id, usage: { input_tokens: 100 + index * 30, output_tokens: 0, total_tokens: 100 + index * 30 } } },
    ];
    await fs.writeFile(path.join(homes[0], 'sessions', `paged-${index}.jsonl`), rows.map(JSON.stringify).join('\n') + '\n');
  }
  await page.locator('#refresh').click();
  await until(() => page.locator('#refresh').isDisabled(), '刷新按钮没有进入等待状态');
  await until(() => page.locator('#refresh-status').textContent().then((text) => /3 个账户已更新，1 个失败，1 个限流/.test(text)), '刷新未呈现真实成功、失败和限流数量');
  await until(() => page.locator('#refresh').isEnabled(), '刷新完成后按钮未恢复');
  await until(() => page.locator('#row-count').textContent().then((text) => text.includes('共 45 个会话')), '刷新没有索引新增会话');
  assert.equal(await page.locator('#thread-rows tr').count(), 20);
  const firstPage = await page.locator('#thread-rows .thread-sub').allTextContents();
  await page.locator('#threads-next').click();
  assert.equal(await page.locator('#thread-rows tr').count(), 20);
  const secondPage = await page.locator('#thread-rows .thread-sub').allTextContents();
  assert.equal(firstPage.some((id) => secondPage.includes(id)), false, '相邻页重复会话');
  await page.locator('#threads-next').click();
  assert.equal(await page.locator('#thread-rows tr').count(), 5);
  assert.equal(await page.locator('#threads-next').isDisabled(), true);
  await page.locator('#thread-search').fill('paged-project-39');
  assert.equal(await page.locator('#thread-rows tr').count(), 1);
  assert.match(await page.locator('#thread-page').textContent(), /1 \/ 1/);
  await page.locator('#thread-search').fill('不存在的会话');
  assert.match(await page.locator('#thread-rows').textContent(), /没有匹配/);
  await page.locator('#thread-search').fill('');
  assert.equal(await page.locator('#thread-rows tr').count(), 20);
  assert.match(await page.locator('#thread-page').textContent(), /1 \/ 3/);
  // 筛选草稿不会因后台索引推送而提前应用，日期错误保持当前有效结果。
  await page.locator('#filter-from').fill('2026-12-31');
  await page.locator('#filter-to').fill('2026-01-01');
  await page.locator('#apply-filter').click();
  assert.match(await page.locator('#toast').textContent(), /开始日期/);
  assert.match(await page.locator('#row-count').textContent(), /共 45/);
  await page.locator('#clear-filter').click();
  await until(() => page.locator('#apply-filter').isEnabled(), '清除筛选未完成');
  await page.locator('#toggle-filter').click();
  await page.evaluate(() => { document.getElementById('toast').hidden = true; });
  await page.locator('.activity-panel').scrollIntoViewIfNeeded();
  const cell = page.locator('.activity-cell[data-day="2026-01-01"]');
  // 后台刷新可能替换节点，重新定位并实际悬停后验证当前提示。
  await until(async () => {
    await cell.hover();
    return page.locator('#chart-tooltip').isVisible();
  }, '热力图悬停未显示提示');
  assert.match(await page.locator('#chart-tooltip').textContent(), /2026-01-01\n100 Tokens/);
  await page.screenshot({ animations: 'disabled', path: path.join(root, '.artifacts/usage-heatmap.png') });
  await page.locator('[data-activity-mode="weekly"]').click();
  assert.equal(await page.locator('.activity-week').count(), 53);
  await page.locator('[data-activity-mode="cumulative"]').click();
  assert.match(await page.locator('#activity-summary').textContent(), /按周累计/);
  await page.locator('[data-activity-mode="daily"]').click();
  for (const size of [[880, 660], [1160, 820], [1440, 900]]) {
    await application.evaluate((_, size) => globalThis.__dragonGirlApp.dashboard.window.setSize(...size), size);
    await until(() => page.evaluate((width) => Math.abs(innerWidth - width) < 4, size[0]), '账本验收窗口未调整');
    assert.equal(await page.evaluate(() => {
      const el = document.getElementById('content-scroll');
      return el.scrollWidth > el.clientWidth + 1;
    }), false, '账本出现整页横向溢出');
    if (size[0] === 880) {
      await page.evaluate(() => { document.getElementById('content-scroll').scrollTop = 0; });
      await page.screenshot({ animations: 'disabled', path: path.join(root, '.artifacts/usage-narrow.png') });
    }
  }
  await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.window.setSize(1160, 820));
  await page.evaluate(() => {
    document.getElementById('content-scroll').scrollTop = 0;
    document.getElementById('toast').hidden = true;
  });
  await page.screenshot({ animations: 'disabled', path: path.join(root, '.artifacts/usage.png') });
  const calls = await fs.readFile(path.join(homes[0], 'rpc-calls.log'), 'utf8');
  assert.deepEqual(calls.trim().split('\n'), ['initialize', 'account/read', 'account/rateLimits/read']);
  assert.equal(JSON.parse(await fs.readFile(path.join(homes[0], 'quota-params.json'), 'utf8')).excludeResetCreditDetails, false);
  const credits = await application.evaluate(() => {
    const m = globalThis.__dragonGirlApp.monitor;
    return m.readings.get(m.instances[0].id).quota.resetCredits;
  });
  assert.deepEqual(credits, { count: 2, details: [
    { expiresAt: 1900000000000, expiryKnown: true },
    { expiresAt: null, expiryKnown: true },
  ] });
}

try {
  application = await electron.launch({
    ...(process.env.DRAGONGIRL_TEST_EXECUTABLE
      ? { executablePath: process.env.DRAGONGIRL_TEST_EXECUTABLE, args: [] }
      : { args: [root] }),
    env,
    timeout: 30000,
  });
  application.on('window', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  // 保留测试进程退出原因，区分页面关闭、运行时崩溃与普通断言失败。
  application.process().once('exit', (code, signal) => { processExit = { code, signal }; });
  application.process().stderr?.on('data', (data) => { stderrTail = (stderrTail + data).slice(-5000); });
  await until(
    () => application.evaluate(() => !!globalThis.__dragonGirlApp?.dashboard.window),
    '总览未启动',
  );
} catch (e) {
  if (!application) throw e;
}
try {
  await until(
    () => Promise.resolve(application.windows().some((p) => p.url().endsWith('/dashboard.html'))),
    '总览页面未加载',
  );
  page = application.windows().find((p) => p.url().endsWith('/dashboard.html'));
  page.on('pageerror', (e) => errors.push(e.message));
  // 完全空的音效目录也应报告就绪，避免开发缓存掩盖新用户默认无声的问题。
  const audioStatus = await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.command('audio-status'));
  assert.equal(audioStatus.complete, true);
  assert.equal(audioStatus.installed, 9);
  assert.equal(audioStatus.bundled, 9);
  assert.deepEqual(await fs.readdir(path.join(data, 'assets')).catch(() => []), []);
  await until(
    () => application.evaluate(() => globalThis.__dragonGirlApp.monitor.summary?.total === 15000),
    '五实例账本合计不正确',
  );
  // 后台索引完成后，界面仍需完成首次消息渲染，安装包冷启动也等待实际卡片就绪。
  await until(
    () =>
      page
        .locator('.account')
        .count()
        .then((count) => count === 5),
    '实例卡片尚未完成渲染',
  );
  assert.equal(await page.locator('.account').count(), 5);
  // 假官方读数仅用于 UI 验证，生产采集器仍走真实只读 RPC。
  await application.evaluate(() => {
    const m = globalThis.__dragonGirlApp.monitor;
    const plans = ['prolite', 'plus', 'pro', 'promax', 'codex_future'];
    for (const [n, i] of m.instances.entries())
      m.readings.set(i.id, {
        account: { type: 'chatgpt', planType: plans[n] },
        identity: `test-${n}`,
        quota: {
          capturedAt: Date.now(),
          source: '验收夹具',
          allowed: true,
          buckets: [
            {
              id: 'codex',
              plan: plans[n],
              windows: [
                {
                  id: 'week',
                  label: '周额度',
                  minutes: 10080,
                  usedPercent: 10 + n * 17,
                  remaining: 90 - n * 17,
                  resetsAt: Date.now() + 86400000 * 3,
                },
              ],
            },
          ],
          resetCredits: [
            { count: 2, details: [{ expiresAt: Date.now() + 86400000 * 3, expiryKnown: true }, { expiresAt: null, expiryKnown: true }] },
            { count: 2, details: null },
            { count: 0, details: [] },
            { count: 1, details: [{ expiresAt: null, expiryKnown: false }] },
            null,
          ][n],
        },
      });
    m.publish();
  });
  await until(
    () =>
      page
        .locator('.account .plan')
        .first()
        .textContent()
        .then((text) => text === 'Pro 100'),
    '账户套餐名称未显示为 Pro 100',
  );
  await verifyAccountHeader();
  await verifyLayout();
  await page.locator('button[data-tab="usage"]').click();
  await until(
    () =>
      page
        .locator('#thread-rows tr')
        .count()
        .then((n) => n === 5),
    '账本明细不是五个会话',
  );
  assert.equal(await page.locator('#filter-panel').isVisible(), false, '首次进入账本应默认隐藏筛选');
  await page.locator('#toggle-filter').click();
  await choose('#filter-home', { index: 2 });
  assert.equal(await page.locator('#thread-rows tr').count(), 5, '修改筛选草稿时不应提前查询');
  await page.locator('#apply-filter').click();
  await until(
    () =>
      page
        .locator('#thread-rows tr')
        .count()
        .then((n) => n === 1),
    '筛选单实例未隔离',
  );
  // 导出走真实主进程命令，只把保存对话框的目标限定到测试目录。
  const exportFile = path.join(temp, 'filtered.csv');
  await application.evaluate(({ dialog }, file) => {
    globalThis.__originalSaveDialog = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, exportFile);
  await page.locator('#export-csv').click();
  await until(async () => !!(await fs.stat(exportFile).catch(() => null)), '筛选 CSV 导出失败');
  const csv = await fs.readFile(exportFile, 'utf8');
  assert.equal(csv.trim().split('\n').length, 2);
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = globalThis.__originalSaveDialog;
  });
  // 解码全部原文件并离线比对输出，确认没有额外包络、变调或合成音。
  const originalAudio = await page.evaluate(async () => {
    const { SoundEngine } = await import('./audio.js');
    const { AUDIO_FILES } = await import('../shared/audio-library.js');
    const context = new OfflineAudioContext(2, 44100 * 4, 44100);
    const engine = new SoundEngine({ createContext: () => context });
    await engine.configure({
      soundEnabled: true,
      volume: 0.5,
      eventVolumes: { complete: 1 },
      soundTheme: 'duck',
    });
    const files = [];
    for (const file of AUDIO_FILES) {
      const source = engine.buffers.get(file.id);
      const outputContext = new OfflineAudioContext(2, source.length + 512, 44100);
      const playback = new SoundEngine({ createContext: () => outputContext });
      playback.settings = {
        soundEnabled: true,
        volume: 0.5,
        eventVolumes: { complete: 1 },
        soundTheme: 'duck',
        eventSounds: { complete: file.id },
      };
      playback.buffers = new Map(engine.buffers);
      await playback.play('complete', true);
      const output = await outputContext.startRendering();
      let maxDifference = 0,
        peak = 0;
      for (let channel = 0; channel < 2; channel++) {
        const original = source.getChannelData(Math.min(channel, source.numberOfChannels - 1));
        const rendered = output.getChannelData(channel);
        for (let i = 0; i < source.length; i++) {
          maxDifference = Math.max(maxDifference, Math.abs(rendered[i] - original[i] * 0.5));
          peak = Math.max(peak, Math.abs(rendered[i]));
        }
      }
      files.push({ id: file.id, seconds: source.duration, maxDifference, peak });
    }
    return {
      count: engine.buffers.size,
      expected: AUDIO_FILES.length,
      maxDifference: Math.max(...files.map((f) => f.maxDifference)),
      peak: Math.max(...files.map((f) => f.peak)),
      files,
    };
  });
  assert.equal(originalAudio.count, 9);
  assert.ok(originalAudio.files.every((file) => file.peak > 0.001));
  assert.ok(originalAudio.maxDifference < 0.00001, '原声音频被额外改变');
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.artifacts/original-audio-report.json'),
    JSON.stringify(originalAudio, null, 2),
  );
  await page.locator('button[data-tab="settings"]').click();
  await choose('select[name="mode"]', 'desktop');
  await page.locator('input[name="multiplePets"]').check();
  await page.locator('[data-settings-tab="sound"]').click();
  await until(async () => /应用已内置原声音效/.test(await page.locator('#audio-library-status').textContent()), '新安装未显示内置音效已就绪');
  await choose('select[name="soundTheme"]', 'fx1');
  await page.locator('#save-settings').click();
  await until(
    () => application.evaluate(() => globalThis.__dragonGirlApp.monitor.settings.soundTheme === 'fx1'),
    '设置保存失败',
  );
  assert.equal(await page.locator('select[name="soundTheme"] option').count(), 2);
  assert.equal(await page.locator('#event-audio-complete option').count(), 9);
  await choose('#event-audio-complete', 'exp_orb');
  const picker = page.locator('[data-select="event-audio-complete"]');
  const pickerWidth = await picker.boundingBox();
  const cellWidth = await picker.locator('..').boundingBox();
  assert.ok(Math.abs(pickerWidth.width - cellWidth.width) < 1, '原声音效选择框未铺满控件列');
  await page.locator('#save-settings').click();
  await until(
    () =>
      application.evaluate(
        () => globalThis.__dragonGirlApp.monitor.settings.eventSounds.complete === 'exp_orb',
      ),
    '原声音效选择未保存',
  );
  assert.equal(
    await page.locator('#event-audio-complete-list').count(),
    1,
    '重建设置后存在重复下拉菜单',
  );

  await page.locator('#sound-rows button').first().click();
  await choose('select[name="soundTheme"]', 'duck');
  await page.locator('#cancel-settings').click();
  assert.equal(await page.locator('select[name="soundTheme"]').inputValue(), 'fx1');
  // 从真实设置控件保存视线、眨眼与表情，确认草稿、磁盘和角色收到的外观配置保持一致。
  await page.locator('[data-settings-tab="appearance"]').click();
  assert.equal(await page.locator('#eye-tracking').isChecked(), true);
  assert.equal(await page.locator('#natural-blink').isChecked(), true);
  assert.equal(await page.locator('#dynamic-expressions').isChecked(), true);
  for (const enabled of [false, true]) {
    await page.locator('#eye-tracking').setChecked(enabled);
    await page.locator('#natural-blink').setChecked(enabled);
    await page.locator('#dynamic-expressions').setChecked(enabled);
    await page.locator('#save-settings').click();
    await until(() => application.evaluate((_, expected) => {
      const { monitor, companion } = globalThis.__dragonGirlApp;
      return monitor.settings.eyeTracking === expected && companion.appearance.settings.eyeTracking === expected
        && monitor.settings.blinkEnabled === expected && companion.appearance.settings.blinkEnabled === expected
        && monitor.settings.expressionsEnabled === expected && companion.appearance.settings.expressionsEnabled === expected;
    }, enabled), '视线、眨眼与表情开关没有同步到角色');
    assert.equal(JSON.parse(await fs.readFile(path.join(data, 'settings.json'), 'utf8')).eyeTracking, enabled);
    assert.equal(JSON.parse(await fs.readFile(path.join(data, 'settings.json'), 'utf8')).blinkEnabled, enabled);
    assert.equal(JSON.parse(await fs.readFile(path.join(data, 'settings.json'), 'utf8')).expressionsEnabled, enabled);
  }
  // 用五个不同 PID 和窗口几何验证多个角色的窗口绑定与随动。
  await application.evaluate(() => {
    const a = globalThis.__dragonGirlApp;
    a.monitor.processes = a.monitor.instances.map((i, n) => ({
      pid: 9000 + n,
      home: i.home,
      frontmost: n === 0,
      windows: [{ x: 50 + n * 50, y: 100, width: 700, height: 650 }],
    }));
    a.monitor.settings.mode = 'follow';
    a.monitor.settings.multiplePets = true;
    a.monitor.publish();
  });
  await until(
    () =>
      application.evaluate(
        () =>
          globalThis.__dragonGirlApp.dashboard.pets.size === 4 &&
          !globalThis.__dragonGirlApp.dashboard.updating &&
          [...globalThis.__dragonGirlApp.dashboard.pets.values()].every((p) => p.ready.size === 2),
      ),
    '未创建五个实例的独立角色',
  );
  const before = await application.evaluate(() => ({
    ...globalThis.__dragonGirlApp.companion.character,
  }));
  await application.evaluate(() => {
    const a = globalThis.__dragonGirlApp;
    a.monitor.processes[0].windows[0].x += 80;
    a.monitor.emit('windows', {});
  });
  const after = await application.evaluate(() => ({
    ...globalThis.__dragonGirlApp.companion.character,
  }));
  assert.equal(after.x - before.x, 80);
  // 文件夹面板必须同时收起角色和气泡，释放输入，并且不影响其他实例的角色。
  const modalState = await application.evaluate(() => {
    const { monitor, companion, dashboard } = globalThis.__dragonGirlApp;
    const runtime = monitor.processes[0];
    globalThis.__followMain = { ...runtime.windows[0], id: 100 };
    companion.showBubble('文件夹选择前的气泡', 'speech');
    companion.gesture.begin({ x: companion.character.x + 10, y: companion.character.y + 10 }, companion.character);
    companion.setInteractive('character', true);
    runtime.platform = 'darwin';
    runtime.modalOpen = true;
    runtime.windows = [{ id: 101, x: 160, y: 180, width: 640, height: 448 }, globalThis.__followMain];
    monitor.emit('windows', {});
    companion.notify('complete', '选择框打开时的新通知');
    return {
      character: companion.windows.get('character').isVisible(),
      bubble: companion.windows.get('bubble').isVisible(),
      active: !!companion.gesture.active,
      interactive: companion.interactive.get('character'),
      visible: companion.visible,
      others: [...dashboard.pets.values()].every((pet) => pet.windows.get('character').isVisible()),
    };
  });
  assert.deepEqual(modalState, { character: false, bubble: false, active: false, interactive: false, visible: true, others: true });
  const restored = await application.evaluate(() => {
    const { monitor, companion } = globalThis.__dragonGirlApp;
    monitor.processes[0].windows = [globalThis.__followMain];
    monitor.processes[0].modalOpen = false;
    monitor.emit('windows', {});
    return { visible: companion.windows.get('character').isVisible(), character: { ...companion.character } };
  });
  assert.equal(restored.visible, true);
  assert.deepEqual(restored.character, after, '关闭选择框后改变了原来的跟随位置');
  // 用户主动隐藏的角色不能因关闭系统面板重新弹出。
  const staysHidden = await application.evaluate(() => {
    const { monitor, companion } = globalThis.__dragonGirlApp;
    companion.hide();
    monitor.processes[0].modalOpen = true;
    monitor.emit('windows', {});
    monitor.processes[0].modalOpen = false;
    monitor.emit('windows', {});
    const hidden = !companion.visible && !companion.windows.get('character').isVisible();
    companion.show();
    delete globalThis.__followMain;
    return hidden;
  });
  assert.equal(staysHidden, true);
  await application.evaluate(() => {
    const a = globalThis.__dragonGirlApp;
    a.monitor.processes[0].windows = [];
    a.monitor.emit('windows', {});
  });
  assert.equal(
    await application.evaluate(() =>
      globalThis.__dragonGirlApp.companion.windows.get('character').isVisible(),
    ),
    false,
  );
  await application.evaluate(() => {
    const a = globalThis.__dragonGirlApp;
    a.monitor.settings.multiplePets = false;
    a.monitor.settings.mode = 'desktop';
    a.monitor.publish();
  });
  await until(
    () => application.evaluate(() => globalThis.__dragonGirlApp.dashboard.pets.size === 0),
    '附属角色退出后未清理',
  );
  // 检查真实气泡页面，确保旧设置迁移后的套餐和单位均显示正确。
  await application.evaluate(() => {
    const companion = globalThis.__dragonGirlApp.companion;
    companion.hideBubble();
    companion.toggleBubble();
  });
  const bubble = application.windows().find((window) => window.url().endsWith('/bubble.html'));
  await until(
    () =>
      bubble
        .locator('#bubble')
        .textContent()
        .then((text) => /Pro 100/.test(text) && /Tokens/.test(text)),
    '气泡套餐或 Tokens 单位未更新',
  );
  assert.doesNotMatch(await bubble.locator('#message').textContent(), /轻量|词元|默认实例/);
  await bubble.emulateMedia({ reducedMotion: 'reduce' });
  await until(() => bubble.evaluate(async () => {
    const model = await window.dragonGirl.bootstrap();
    return model.measuredRevision === model.revision && document.body.dataset.ready === 'true';
  }), '用量卡片没有完成测量');
  assert.equal(await bubble.locator('#plan').textContent(), 'Pro 100');
  assert.ok(await bubble.locator('.quota').count() > 0, '默认用量未显示额度层次');
  assert.equal(await bubble.locator('.metric-label').textContent(), '今日已用');
  assert.equal(await bubble.locator('.metric-unit').textContent(), 'Tokens');
  assert.doesNotMatch(await bubble.locator('#bubble').innerText(), /工作中|任务完成|任务异常|状态待更新/, '默认用量气泡仍显示任务状态');
  await bubble.screenshot({
    animations: 'disabled', omitBackground: true,
    path: path.join(root, '.artifacts/bubble-plan-tokens.png'),
  });
  // 自定义模板保持逐字纯文本；过期额度只显示待刷新，不伪造成零值或进度条。
  const customText = await application.evaluate(() => {
    const a = globalThis.__dragonGirlApp;
    const previous = a.monitor.settings.bubbleTemplate;
    a.monitor.settings.bubbleTemplate = '<img src=x onerror=alert(1)>\n今日 {今日用量} Tokens';
    const content = a.dashboard.bubbleFor(a.companion);
    a.monitor.settings.bubbleTemplate = previous;
    a.companion.showBubble(content, 'usage');
    return content.text;
  });
  await until(() => bubble.locator('#message').textContent().then((text) => text === customText), '自定义模板未保留');
  assert.equal(await bubble.locator('#message img').count(), 0, '自定义模板被当成 HTML');
  assert.equal(await bubble.locator('.quota').count(), 0);
  assert.equal(await bubble.locator('body').getAttribute('data-layout'), 'text');
  // 多桶额度必须逐项保留，小于百分之一与真实零值有不同文案，不能因卡片排版合并丢失。
  await application.evaluate(() => {
    const a = globalThis.__dragonGirlApp;
    const instance = a.dashboard.latest.instances.find((i) => i.id === a.companion.instanceId);
    const quota = instance.quota;
    const stale = instance.stale;
    instance.stale = false;
    instance.quota = {
      ...quota,
      buckets: [
        { name: 'Codex', windows: [{ label: '5 小时', remaining: 0.4 }, { label: '周额度', remaining: 0 }] },
        { name: '研究', windows: [{ label: '周额度', remaining: 100 }] },
      ],
    };
    const content = a.dashboard.bubbleFor(a.companion);
    instance.quota = quota;
    instance.stale = stale;
    a.companion.showBubble(content, 'usage');
  });
  await until(() => bubble.locator('.quota').count().then((count) => count === 3), '多桶额度未完整显示');
  assert.deepEqual(await bubble.locator('.quota-value').allTextContents(), ['<1%', '0%', '100%']);
  assert.deepEqual(await bubble.locator('.quota-label').allTextContents(), ['Codex · 5 小时剩余', 'Codex · 周额度剩余', '研究 · 周额度剩余']);
  assert.equal(await bubble.locator('.quota[data-low="true"]').count(), 2);
  await application.evaluate(() => {
    const a = globalThis.__dragonGirlApp;
    const instance = a.dashboard.latest.instances.find((i) => i.id === a.companion.instanceId);
    const stale = instance.stale;
    instance.stale = true;
    const content = a.dashboard.bubbleFor(a.companion);
    instance.stale = stale;
    a.companion.showBubble(content, 'usage');
  });
  await until(() => bubble.locator('.quota-note').textContent().then((text) => text === '额度待刷新'), '过期额度没有显示待刷新');
  assert.equal(await bubble.locator('.quota').count(), 0, '过期额度仍显示有效进度条');
  // 菜单互动直接执行真实菜单回调，并验证后台外观更新不会吞掉短句或完成提示。
  const character = application.windows().find((window) => window.url().endsWith('/character.html'));
  await character.emulateMedia({ reducedMotion: 'no-preference' });
  await character.evaluate(() => {
    window.__completionExpressions = [];
    window.dragonGirl.onExpression((name) => window.__completionExpressions.push(name));
  });
  const speech = await application.evaluate(() => {
    const c = globalThis.__dragonGirlApp.companion;
    c.state.speechEnabled = false;
    const say = () => c.buildMenu().items.find((item) => item.label === '说句话').click();
    say();
    const first = c.bubbleModel.text;
    const visible = c.windows.get('bubble').isVisible();
    say();
    const second = c.bubbleModel.text;
    c.setAppearance({ ...c.appearance, status: 'working' });
    const afterUpdate = c.bubbleModel.text;
    c.state.speechEnabled = true;
    const m = globalThis.__dragonGirlApp.monitor;
    m.workerMessage({ type: 'task', task: { home: c.instanceId, source: '主任务', status: 'complete' } });
    const complete = c.bubbleModel.text;
    c.setAppearance({ ...c.appearance, status: 'complete' });
    return { first, second, visible, afterUpdate, complete, afterComplete: c.bubbleModel.text };
  });
  assert.equal(speech.visible, true, '主动对话未显示气泡');
  assert.notEqual(speech.first, speech.second, '连续对话没有轮换');
  assert.equal(speech.afterUpdate, speech.second, '对话被后台状态覆盖');
  assert.match(speech.complete, /交卷|龙角|成果/);
  assert.equal(speech.afterComplete, speech.complete, '完成提示被后台状态覆盖');
  await until(() => character.locator('#character').getAttribute('data-expression').then((value) => value === 'happy'), '主任务完成没有通过监控器触发开心');
  assert.deepEqual(await character.evaluate(() => window.__completionExpressions), ['happy']);
  // 真正失败必须沿监控器、实例路由和表情订阅完整到达角色，取消和子任务保持独立。
  await application.evaluate(() => {
    const { monitor, companion } = globalThis.__dragonGirlApp;
    monitor.workerMessage({ type: 'task', task: { home: companion.instanceId, source: '主任务', status: 'error' } });
  });
  await until(() => character.locator('#character').getAttribute('data-expression').then((value) => value === 'sad'), '主任务失败没有通过监控器触发伤心');
  assert.deepEqual(await character.evaluate(() => window.__completionExpressions), ['happy', 'sad']);
  await bubble.screenshot({
    animations: 'disabled',
    omitBackground: true,
    path: path.join(root, '.artifacts/bubble-notice.png'),
  });
  await application.evaluate(() => globalThis.__dragonGirlApp.companion.hideBubble());
  await page.locator('button[data-tab="overview"]').click();
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  await page.evaluate(() => {
    document.getElementById('content-scroll').scrollTop = 0;
    document.getElementById('toast').hidden = true;
  });
  await page.mouse.move(1100, 40);
  await page.screenshot({ animations: 'disabled', path: path.join(root, '.artifacts/dashboard.png') });
  await page.locator('button[data-tab="settings"]').click();
  await page.locator('[data-settings-tab="appearance"]').click();
  await page.evaluate(() => {
    document.getElementById('content-scroll').scrollTop = 0;
  });
  await page.mouse.move(1100, 40);
  await page.screenshot({ animations: 'disabled', path: path.join(root, '.artifacts/settings.png') });
  await page.locator('[data-select="display-mode"]').click();
  await page.screenshot({
    animations: 'disabled',
    path: path.join(root, '.artifacts/settings-dropdown.png'),
  });
  await page.keyboard.press('Escape');
  await page.locator('[data-settings-tab="sound"]').click();
  await page.screenshot({
    animations: 'disabled',
    path: path.join(root, '.artifacts/settings-sound.png'),
  });
  for (const tab of ['bubble', 'statistics', 'instances', 'data']) {
    await page.locator(`[data-settings-tab="${tab}"]`).click();
    assert.equal(
      await page.evaluate(() => {
        const el = document.getElementById('content-scroll');
        return el.scrollWidth > el.clientWidth + 1;
      }),
      false,
      `${tab} 页面横向溢出`,
    );
    await page.screenshot({
      animations: 'disabled',
      path: path.join(root, `.artifacts/settings-${tab}.png`),
    });
  }
  await page.locator('.main-nav [data-tab="usage"]').click();
  await choose('#filter-home', { index: 0 });
  await page.locator('#apply-filter').click();
  await until(
    () =>
      page
        .locator('#thread-rows tr')
        .count()
        .then((n) => n === 5),
    '全部会话筛选未恢复',
  );
  await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.window.setSize(880, 660));
  await until(() => page.evaluate(() => Math.abs(innerWidth - 880) < 4), '窄窗口未就绪');
  assert.equal(
    await page.evaluate(() =>
      [...document.querySelectorAll('#usage-metrics .metric-value')].some(
        (el) => el.scrollWidth > el.clientWidth + 1,
      ),
    ),
    false,
    '窄窗口中的指标文字溢出',
  );
  await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.window.setSize(1160, 820));
  await until(() => page.evaluate(() => Math.abs(innerWidth - 1160) < 4), '默认窗口未恢复');
  await page.screenshot({ animations: 'disabled', path: path.join(root, '.artifacts/usage.png') });
  await verifyUsageRefresh();
  await page.locator('.main-nav [data-tab="settings"]').click();
  await page.locator('[data-settings-tab="sound"]').click();
  await page.locator('#sound-rows').scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: 'disabled',
    path: path.join(root, '.artifacts/sound-events.png'),
  });
  await page.locator('[data-settings-tab="statistics"]').click();
  await page.locator('.price-editor').scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: 'disabled',
    path: path.join(root, '.artifacts/model-prices.png'),
  });
  assert.equal(await page.locator('.main-nav button').count(), 4);
  assert.doesNotMatch(
    await page.locator('body').innerText(),
    /YOUR CODEX|CODEX COMPANION|Standard|Ultrafast|PROLITE|tokens|USD|词元/,
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(
      root,
      process.env.DRAGONGIRL_TEST_EXECUTABLE
        ? '.artifacts/package-app-report.json'
        : '.artifacts/app-report.json',
    ),
    JSON.stringify(
      {
        passed: true,
        instances: 5,
        initialLedgerTotal: 15000,
        refreshedLedgerTotal: 42400,
        pagedThreads: 45,
        checks: [
          'Plus、Pro 100、Pro 200、Pro 500 原名与未知套餐保留',
          '重置卡置顶、悬停明细、键盘访问与后台重绘保持',
          '真实 RPC 读取重置卡详情并排除已使用卡',
          '今日消耗置于运行信息旁与三种窗口宽度适配',
          '旧版默认气泡自动迁移',
          '默认用量卡片层次、多桶与真实零值、自定义模板纯文本和过期额度提示',
          '目录发现',
          '独立筛选',
          '设置保存取消',
          '视线、眨眼与动态表情开关保存并同步到角色',
          '真实主任务完成事件触发开心表情',
          '九段原声解码与线性波形一致',
          '筛选 CSV 导出',
          '五角色隔离',
          '窗口随动',
          '系统面板隐藏角色和气泡、释放输入并恢复原位置',
          '关闭面板保留用户主动隐藏与其他实例显示状态',
          '隐藏恢复',
          '资源释放',
          '三个主要页面',
          '下拉菜单位置与键盘交互',
          '三种窗口尺寸的控件对齐',
          '中文界面文案',
          '刷新成功、失败和限流反馈与真实增量扫描',
          '筛选默认收起且草稿不提前生效',
          '45 个会话分页与跨页搜索',
          'Token 热力图日期悬停与周累计',
          '主动对话轮换与完成提示保持',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log('应用集成检查通过：五实例隔离、账本、设置、音效、窗口跟随、对齐与中文界面。');
} catch (error) {
  // 集成失败保留实际页面与无障碍状态，后续定位无需反复猜测窗口时序。
  await page?.screenshot({ path: path.join(root, '.artifacts/app-failure.png') }).catch(() => {});
  const details = await page?.evaluate(() => ({
    focused: document.hasFocus(), width: innerWidth, height: innerHeight,
    tooltipHidden: document.getElementById('chart-tooltip')?.hidden,
    badges: [...document.querySelectorAll('.reset-credits')].map((element) => ({
      text: element.textContent, hover: element.matches(':hover'),
      description: element.getAttribute('aria-describedby'),
    })),
  })).catch(() => null);
  const lifecycle = await application?.evaluate(() => ({
    managed: globalThis.__dragonGirlApp?.startup.managed,
    hostExit: globalThis.__dragonGirlApp?.startup.hostExit,
    dashboardDestroyed: globalThis.__dragonGirlApp?.dashboard.window?.isDestroyed(),
  })).catch(() => null);
  await fs.writeFile(path.join(root, '.artifacts/app-failure.json'), JSON.stringify({ error: error.message, details, lifecycle, processExit, stderrTail }, null, 2));
  throw error;
} finally {
  await application?.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true });
}
