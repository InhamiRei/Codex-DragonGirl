import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-account-ui-'));
const user = path.join(temporary, 'user'), data = path.join(temporary, 'data');
const homes = [path.join(user, '.codex'), path.join(user, 'second-account')];
const output = path.join(root, '.artifacts/account-tests');
await fs.mkdir(data, { recursive: true });
await fs.mkdir(output, { recursive: true });
for (const home of homes) await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ manualHomes: [homes[1]] }));
const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1', DRAGONGIRL_DATA_DIR: data, DRAGONGIRL_FIXTURE_HOME: user };
delete env.ELECTRON_RUN_AS_NODE;
let application, page;
const errors = [];

// 所有等待都检查明确状态，不依赖真实网络、模型速度或长时间固定延时。
async function until(check, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(message);
}

// 生产页面和 IPC 保持不变，仅把 CLI 定位到隔离的协议假服务。
async function launch() {
  const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
  application = await _electron.launch({ args: executablePath ? [] : [root], ...(executablePath ? { executablePath } : {}), env, timeout: 30000 });
  await until(() => Promise.resolve(application.windows().some((item) => item.url().endsWith('/dashboard.html'))), '管理页面未加载');
  page = application.windows().find((item) => item.url().endsWith('/dashboard.html'));
  page.on('pageerror', (error) => errors.push(error.message));
  await until(() => page.locator('#accounts .account').count().then((count) => count === 2), '未发现两个测试实例');
  await application.evaluate((_, value) => {
    const { monitor, dashboard } = globalThis.__dragonGirlApp;
    dashboard.tests.getRuntime = () => ({ executable: value.node, prefixArgs: [value.fixture] });
    for (const [index, instance] of monitor.instances.entries()) {
      instance.name = `测试账号${index + 1}`;
      monitor.settings.aliases[instance.home] = instance.name;
      // 两个账号分别显示一项和两项额度，确认套餐仍紧跟名称且不被右侧额度挤走。
      monitor.readings.set(instance.id, {
        account: { type: 'chatgpt', planType: index ? 'plus' : 'prolite' },
        quota: {
          capturedAt: Date.now(), source: '界面验收夹具',
          buckets: [{ id: 'codex', windows: index
            ? [{ id: 'primary', label: '5 小时', remaining: 41, minutes: 300 }, { id: 'secondary', label: '周额度', remaining: 61, minutes: 10080 }]
            : [{ id: 'secondary', label: '周额度', remaining: 77, minutes: 10080 }] }],
        },
      });
    }
    monitor.publish();
  }, { node: process.execPath, fixture: path.join(root, 'tests/fixtures/account-test-server.mjs') });
  await page.locator('[data-tab="account-tests"]').click();
  await until(() => page.locator('#test-accounts input').count().then((count) => count === 2), '测试账号未加载');
}

// 下拉通过真实的组合框选项点击，覆盖显示和值同步。
async function choose(id, value) {
  await page.locator(`[data-select="${id}"]`).click();
  await page.locator(`#${id}-list [role="option"][data-value="${value}"]`).click();
}

// 卡片高度在全部状态下必须相同，并且不会随输出长度改变。
async function heights() {
  const values = await page.locator('#test-results .test-result').evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
  assert.equal(values.length, 2);
  assert.ok(values.every((value) => value === 500), '结果卡片没有固定等高');
  return values;
}

// 三个页面必须互斥，避免历史或运行过程出现在新建表单下方。
async function pane(name) {
  for (const id of ['new', 'history', 'detail']) assert.equal(await page.locator(`#test-${id}`).isVisible(), id === name, `${name} 页面与 ${id} 页面混在一起`);
}

// 页面整体和底部内容都应落在固定虚拟视口内，HTML 不能出现内部滚动条。
async function verifyPreview(frame) {
  await until(() => frame.evaluate(() => document.documentElement.dataset.previewFit === 'ready' && innerWidth === 1200 && innerHeight === 900), '预览没有完成固定视口缩放');
  const geometry = await frame.evaluate(() => {
    const root = document.documentElement;
    const boxes = [...document.body.children].filter((item) => !['SCRIPT', 'STYLE'].includes(item.tagName)).map((item) => item.getBoundingClientRect()).filter((box) => box.width && box.height);
    return { width: innerWidth, height: innerHeight, overflow: getComputedStyle(root).overflow, fit: boxes.every((box) => box.top >= -1 && box.left >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1), bridge: typeof window.dragonGirl };
  });
  assert.deepEqual([geometry.width, geometry.height], [1200, 900]);
  assert.equal(geometry.overflow, 'hidden');
  assert.equal(geometry.fit, true, 'HTML 有内容被预览边缘裁切');
  assert.equal(geometry.bridge, 'undefined');
  assert.equal(await frame.evaluate(() => { try { return !!parent.document; } catch { return false; } }), false);
  assert.equal(await frame.evaluate(async () => { try { await fetch('https://example.com/'); return true; } catch { return false; } }), false);
}

// 只检查详情中的预览，历史缩略图的懒加载帧不计入此数量。
async function detailFrames(count = 2) {
  await until(() => page.locator('#test-results iframe').count().then((value) => value === count), '详情预览没有加载');
  return Promise.all((await page.locator('#test-results iframe').elementHandles()).map((handle) => handle.contentFrame()));
}

// 完成必须同时解除表单锁定，确保队列已真正结束。
async function completed() {
  await until(async () => await page.locator('#test-results [data-status="completed"]').count() === 2 && !await page.locator('#test-fields').isDisabled(), '测试没有全部完成');
}

try {
  await launch();
  await pane('new');
  assert.equal(await page.locator('#test-model').inputValue(), 'gpt-6-astra');
  assert.equal(await page.locator('#test-effort').inputValue(), 'medium');
  assert.equal(await page.locator('#test-concurrency').inputValue(), '1');
  assert.equal(await page.locator('#test-format').count(), 0);
  await page.locator('#test-select-all').click();
  await until(() => page.locator('#test-start').isEnabled(), '共同模型没有读取成功');
  assert.equal(await page.locator('#test-model').inputValue(), 'gpt-6-astra', '没有优先使用指定的 Astra 默认值');
  assert.equal(await page.locator('#test-model-status').isVisible(), false);
  const fields = await page.evaluate(() => {
    const fields = ['test-kind', 'test-account-search', 'test-model', 'test-prompt'].map((id) => document.getElementById(id));
    return { order: fields[1].closest('.field').getBoundingClientRect().top < fields[2].closest('.field').getBoundingClientRect().top, labels: fields.map((field) => { const style = getComputedStyle(field.labels[0]); return [style.fontSize, style.fontWeight, style.lineHeight].join('|'); }) };
  });
  assert.equal(fields.order, true, '账号没有放在模型之前');
  assert.ok(fields.labels.every((value) => value === fields.labels[0]), '字段标签样式不一致');
  const accountAlignment = await page.locator('.test-account').first().evaluate((row) => {
    const check = row.querySelector('input').getBoundingClientRect(), copy = row.querySelector('.test-account-copy').getBoundingClientRect();
    return Math.abs(check.y + check.height / 2 - copy.y - copy.height / 2);
  });
  assert.ok(accountAlignment <= 1, '账号复选框没有与账号信息横向对齐');
  // 直接检查可见名称与套餐的相邻距离和垂直中心，不能把靠右分列误当作紧跟名称。
  const accountHeadings = await page.locator('.test-account').evaluateAll((rows) => rows.map((row) => {
    const name = row.querySelector('.test-account-name').getBoundingClientRect();
    const plan = row.querySelector('.test-plan').getBoundingClientRect();
    const quota = row.querySelector('.test-account-quotas').getBoundingClientRect();
    return { gap: plan.left - name.right, center: Math.abs(plan.y + plan.height / 2 - name.y - name.height / 2), separated: plan.right <= quota.left };
  }));
  assert.equal(accountHeadings.length, 2);
  assert.ok(accountHeadings.every((item) => item.gap >= 4 && item.gap <= 12 && item.center <= 1 && item.separated), '套餐没有紧跟账号名称并保持在同一行');
  await page.screenshot({ path: path.join(output, 'test-setup.png') });
  await page.locator('#test-accounts').screenshot({ path: path.join(output, 'test-accounts.png') });

  await fs.writeFile(path.join(homes[0], 'mode'), 'step');
  await fs.writeFile(path.join(homes[1], 'mode'), 'slow');
  await page.locator('#test-start').click();
  await pane('detail');
  assert.equal(await page.locator('.test-saved-prompt').evaluate((item) => item.tagName), 'DIV', '提示词不应再使用折叠控件');
  assert.equal(await page.locator('#test-detail-prompt').isVisible(), true);
  assert.match(await page.locator('#test-detail-prompt').innerText(), /SVG/);
  await until(() => page.locator('#test-results [data-status="running"]').count().then((count) => count === 1), '首个账号没有开始');
  assert.equal(await page.locator('#test-results [data-status="queued"]').count(), 1);
  const initialHeight = await heights();
  const first = page.locator('#test-results .test-result').first();
  await until(() => first.getByRole('button', { name: '源码', exact: true }).isEnabled(), '生成中源码没有提供');
  await first.getByRole('button', { name: '源码', exact: true }).click();
  assert.equal(await first.locator('.test-output').evaluate((item) => item.scrollHeight > item.clientHeight), true, '源码区域没有内部滚动');
  assert.deepEqual(await heights(), initialHeight);
  await first.getByRole('button', { name: '预览', exact: true }).click();
  await page.locator('[data-test-tab="history"]').click();
  await pane('history');
  await until(() => page.locator('.test-history-card .test-loading').count().then((count) => count === 2), '排队和生成中的缩略图都应显示加载动画');
  const loadingCard = page.locator('.test-history-card').first();
  assert.doesNotMatch(await loadingCard.innerText(), /<!doctype|<html|<head/i, '生成中的源码泄漏到历史卡片');
  assert.equal(await loadingCard.locator('.test-thumbnail-text').count(), 0);
  await loadingCard.evaluate((item) => { item.dataset.liveCard = 'kept'; });
  await page.screenshot({ path: path.join(output, 'history-loading.png') });
  await fs.writeFile(path.join(homes[0], 'release'), 'yes');
  await until(() => loadingCard.locator('iframe').count().then((count) => count === 1), '完成的历史缩略图没有实时切换为画面');
  assert.equal(await loadingCard.getAttribute('data-live-card'), 'kept', '状态更新不应重建整张记录卡');
  assert.equal(await loadingCard.locator('.test-loading').count(), 1);
  await page.locator('#test-current').click();
  await pane('detail');
  await until(() => page.locator('#test-results [data-status="completed"]').count().then((count) => count === 1), '首个账号没有完成');
  await until(() => page.locator('#test-results [data-status="running"]').count().then((count) => count === 1), '第二个账号未开始');
  assert.deepEqual(await heights(), initialHeight);
  await verifyPreview((await detailFrames(1))[0]);
  const alignment = await first.evaluate((card) => { const row = card.querySelector('.test-name-plan').getBoundingClientRect(), name = card.querySelector('h3').getBoundingClientRect(), plan = card.querySelector('.test-plan').getBoundingClientRect(); return { middle: Math.abs(name.y + name.height / 2 - plan.y - plan.height / 2), right: Math.abs(row.right - plan.right) }; });
  assert.ok(alignment.middle <= 1 && alignment.right <= 1, '套餐没有与实例名称同排靠右对齐');
  assert.doesNotMatch(await page.locator('#test-detail').innerText(), /检测到|本机指令|复制回答|导出回答|重新测试/);
  await page.screenshot({ path: path.join(output, 'mixed-progress.png') });
  await page.locator('[data-test-tab="new"]').click();
  await pane('new');
  await page.locator('#test-current').click();
  await pane('detail');
  await page.locator('#test-cancel').click();
  await until(() => page.locator('#test-results [data-status="cancelled"]').count().then((count) => count === 1), '停止没有保留完成的账号');
  assert.deepEqual(await heights(), initialHeight);
  await page.locator('[data-test-tab="history"]').click();
  await until(() => page.locator('.test-history-card').first().locator('.test-preview-state[data-state="cancelled"]').isVisible(), '取消状态没有显示在画框内');
  assert.doesNotMatch(await page.locator('.test-thumbnail-footer').first().innerText(), /已完成|生成中|已取消/);

  for (const home of homes) await fs.writeFile(path.join(home, 'mode'), 'normal');
  await page.locator('[data-test-tab="new"]').click();
  await choose('test-kind', 'custom');
  await page.locator('#test-prompt').fill('保持中文和两个账号的独立回答');
  await page.locator('#test-start').click();
  await completed();
  await pane('detail');
  assert.equal(await page.locator('#test-results iframe').count(), 0);
  for (const text of await page.locator('#test-results .test-output').allTextContents()) assert.equal(text, '中文回答：保持中文和两个账号的独立回答');
  await heights();

  await page.locator('[data-test-tab="new"]').click();
  await page.locator('#test-prompt').fill('创建一个完整 HTML');
  await page.locator('#test-start').click();
  await completed();
  for (const frame of await detailFrames()) await verifyPreview(frame);
  const exported = path.join(temporary, 'exported.json');
  await application.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }); }, exported);
  await page.locator('#test-export-run').click();
  await until(() => fs.access(exported).then(() => true, () => false), '测试记录未导出');
  const record = JSON.parse(await fs.readFile(exported, 'utf8'));
  await page.locator('[data-test-tab="new"]').click();
  await choose('test-kind', 'pelican');
  await fs.writeFile(path.join(homes[0], 'mode'), 'html-rate');
  await page.locator('#test-start').click();
  await until(async () => await page.locator('#test-results [data-status="failed"]').count() === 1 && await page.locator('#test-results [data-status="completed"]').count() === 1 && !await page.locator('#test-fields').isDisabled(), '失败结果没有正常结束');
  await page.locator('[data-test-tab="history"]').click();
  await until(() => page.locator('.test-history-card').first().locator('.test-preview-state[data-state="failed"]').isVisible(), '失败状态没有显示在画框内');
  assert.match(await page.locator('.test-preview-state[data-state="failed"]').first().innerText(), /失败.*限流/s);
  assert.doesNotMatch(await page.locator('.test-history-card').first().innerText(), /<!doctype|<html|生成中的源码/i);
  for (let i = 0; i < 8; i++) await fs.writeFile(path.join(data, 'account-tests', `${(record.id = randomUUID())}.json`), JSON.stringify(record));
  await page.locator('[data-test-tab="history"]').click();
  await pane('history');
  await until(() => page.locator('.test-history-card').count().then((count) => count === 10), '历史没有按每页十条展示');
  const buttons = await page.locator('.test-history-card').first().locator('.test-history-action').evaluateAll((items) => items.map((item) => { const style = getComputedStyle(item); return [style.height, style.width, style.fontSize, style.fontWeight, style.border, style.backgroundColor, style.color].join('|'); }));
  assert.equal(buttons[0], buttons[1], '查看和删除的按钮样式不同');
  assert.ok(await page.locator('.test-history-preview').count() >= 10, '记录中缺少缩略预览');
  assert.match(await page.locator('.test-thumbnail-footer').first().innerText(), /秒.*120 Tokens/s);
  assert.doesNotMatch(await page.locator('.test-thumbnail-footer').first().innerText(), /已完成/);
  const thumbnailLayout = await page.locator('.test-history-preview').first().evaluate((item) => {
    const row = item.querySelector('.test-name-plan').getBoundingClientRect(), plan = item.querySelector('.test-plan').getBoundingClientRect();
    const time = item.querySelector('.test-thumbnail-time').getBoundingClientRect(), tokens = item.querySelector('.test-thumbnail-tokens').getBoundingClientRect();
    return { right: Math.abs(row.right - plan.right), line: Math.abs(time.y - tokens.y) };
  });
  assert.ok(thumbnailLayout.right <= 1 && thumbnailLayout.line <= 1, '缩略图套餐靠右或底部单行排版不正确');
  await page.locator('#test-history-next').click();
  await until(() => page.locator('.test-history-card').count().then((count) => count === 2), '第二页记录数量不正确');
  await page.locator('#test-history-prev').click();
  await until(() => page.locator('.test-history-card').count().then((count) => count === 10), '上一页未恢复');
  await page.locator('.test-history-card').first().getByRole('button', { name: '查看', exact: true }).click();
  await pane('detail');
  await heights();
  await page.locator('#test-back-history').click();
  await pane('history');
  const removal = page.locator('.test-history-card').first();
  await removal.getByRole('button', { name: '删除', exact: true }).click();
  await removal.getByRole('button', { name: '确认删除', exact: true }).click();
  await until(() => page.locator('#test-history-page').textContent().then((text) => text.includes('共 11 条')), '删除未更新记录总数');

  // 可选地复用已有真实回答，整个验收不再额外消耗账号额度。
  let livePreview = null;
  if (process.argv.includes('--live-preview')) {
    const html = await fs.readFile(path.join(output, 'layout-reference.html'), 'utf8').catch(() => fs.readFile(path.join(output, 'live-pelican.html'), 'utf8'));
    await application.evaluate((_, html) => { globalThis.__dragonGirlApp.dashboard.tests.runner = async (_home, options) => ({ text: html, model: options.model, durationMs: 1000, usage: { totalTokens: 9854 }, instructionCount: 1 }); }, html);
    await page.locator('[data-test-tab="new"]').click();
    await choose('test-kind', 'pelican');
    await page.locator('#test-start').click();
    await completed();
    for (const width of [880, 1160, 1440]) {
      await application.evaluate((_, width) => globalThis.__dragonGirlApp.dashboard.window.setSize(width, 900), width);
      await until(() => page.evaluate((width) => innerWidth === width, width), '窗口尺寸未更新');
      await heights();
      for (const frame of await detailFrames()) await verifyPreview(frame);
      assert.equal(await page.evaluate(() => { const area = document.getElementById('content-scroll'); return area.scrollWidth > area.clientWidth + 1; }), false, `${width}px 窗口横向溢出`);
    }
    await page.locator('#toast').waitFor({ state: 'hidden', timeout: 6000 });
    await page.screenshot({ path: path.join(output, 'live-pelican-preview.png') });
    await page.locator('[data-test-tab="history"]').click();
    await until(() => page.locator('.test-history-card iframe').count().then((count) => count > 0), '真实 HTML 历史缩略图未加载');
    await page.screenshot({ path: path.join(output, 'history-previews.png') });
    livePreview = { passed: true, completePageFit: true };
  }
  await application.close();
  application = null;
  await launch();
  await pane('new');
  await page.locator('[data-test-tab="history"]').click();
  await until(() => page.locator('.test-history-card').count().then((count) => count === 10), '重启后记录未恢复');
  assert.deepEqual(errors, []);
  const result = { passed: true, livePreview, checks: ['Astra/中/并发1默认值', '账号在模型前与标签统一', '新建/记录/详情互斥', '生成/排队/完成/源码固定等高', '完整HTML缩放与沙箱', '加载动画实时切换且不显示源码', '失败取消显示在画框内', '套餐靠右与耗时Tokens同排', '详情提示词直接显示', '自定义文本与HTML自动展示', '十条分页与历史缩略图', '查看删除样式一致', '记录导出删除与重启恢复', '三种窗口宽度'] };
  await fs.writeFile(path.join(output, 'ui-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await application?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
