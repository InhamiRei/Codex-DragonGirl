import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AccountTests } from '../src/core/account-tests.js';
import { listAccountTestModels, runAccountTest, AccountTestError } from '../src/core/account-test-rpc.js';
import { extractTestHtml, testPreviewDocument } from '../src/shared/account-tests.js';
import { accountTestPreview } from '../src/main/test-preview.js';
const fixture = fileURLToPath(new URL('./fixtures/account-test-server.mjs', import.meta.url));

// 每条测试单独创建账号与数据目录，测试完成后只清理这些生成物。
async function environment(t, mode = 'normal') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-test-unit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'mode'), mode);
  return { directory, options: { executable: process.execPath, prefixArgs: [fixture] } };
}

// 可控 Promise 验证队列和取消的时序，不依赖外部请求速度。
function gate() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// 实际子进程覆盖 JSON-RPC 分页、中文拆包和会话配置，不模拟被测解析器。
test('模型分页与真实流式协议保留中文、用量和独立会话配置', async (t) => {
  const { directory, options } = await environment(t);
  const models = await listAccountTestModels(directory, options);
  assert.deepEqual(models.map((m) => m.id), ['fixture-model', 'gpt-6-astra', 'second-model']);
  let partial = '';
  const answer = await runAccountTest(directory, { ...options, model: 'fixture-model', effort: 'medium', prompt: '请回答测试', onProgress: (value) => { partial = value.text; } });
  assert.equal(answer.text, '中文回答：请回答测试');
  assert.equal(partial, answer.text);
  assert.equal(answer.usage.totalTokens, 120);
  const calls = JSON.parse(await fs.readFile(path.join(directory, 'calls.json')));
  const start = calls.find((c) => c.method === 'thread/start').params;
  assert.equal(start.ephemeral, true);
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.config['mcp_servers.fixture.enabled'], false);
  assert.equal(start.config['features.shell_tool'], false);
  assert.equal(start.config.project_doc_max_bytes, 0);
  assert.notEqual(start.cwd, process.cwd());
  await assert.rejects(fs.stat(start.cwd), /ENOENT/);
  const pid = Number(await fs.readFile(path.join(directory, 'pid')));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

// 工具调用立即结束；限流错误脱敏，部分回答仍交给记录层保存。
test('工具请求与失败回复不会被当作完整回答', async (t) => {
  for (const mode of ['tool', 'rate']) {
    const { directory, options } = await environment(t, mode);
    let partial = '';
    await assert.rejects(runAccountTest(directory, { ...options, model: 'fixture-model', effort: 'medium', prompt: 'test', onProgress: (v) => { partial = v.text; } }), (error) => {
      assert.match(error.message, mode === 'tool' ? /工具/ : /限流/);
      assert.doesNotMatch(error.message, /hidden-sensitive/);
      return true;
    });
    if (mode === 'rate') assert.equal(partial, '保留部分内容');
    const calls = JSON.parse(await fs.readFile(path.join(directory, 'calls.json')));
    assert.ok(calls.some((c) => c.method === 'turn/interrupt'));
  }
});

// 中断会发出协议取消并回收子进程，等待中的请求不会遗留到下一次测试。
test('取消流式回答后子进程退出并保留取消类别', async (t) => {
  const { directory, options } = await environment(t, 'slow');
  const controller = new AbortController();
  await assert.rejects(runAccountTest(directory, {
    ...options, model: 'fixture-model', effort: 'medium', prompt: 'test', signal: controller.signal,
    onProgress: (value) => { if (value.text) controller.abort(); },
  }), (error) => error.code === 'cancelled');
  const calls = JSON.parse(await fs.readFile(path.join(directory, 'calls.json')));
  assert.ok(calls.some((c) => c.method === 'turn/interrupt'));
  const pid = Number(await fs.readFile(path.join(directory, 'pid')));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

// 不支持的参数必须在发送生成请求前拒绝，不能静默切模型或降低思考强度。
test('不支持的模型和强度在生成前拒绝', async (t) => {
  const { directory, options } = await environment(t);
  await assert.rejects(runAccountTest(directory, { ...options, model: 'fixture-model', effort: 'unknown', prompt: 'test' }), /不支持/);
  const calls = JSON.parse(await fs.readFile(path.join(directory, 'calls.json')));
  assert.equal(calls.some((c) => c.method === 'turn/start'), false);
});

// 账号目录中的全局指令不能被默默忽略，应记录数量并发送统一的高优先级规则。
test('全局指令差异显式记录且输出格式进入测试规则', async (t) => {
  const { directory, options } = await environment(t, 'global');
  const output = await runAccountTest(directory, { ...options, model: 'fixture-model', effort: 'medium', prompt: 'HTML', format: 'html' });
  assert.equal(output.instructionCount, 1);
  const calls = JSON.parse(await fs.readFile(path.join(directory, 'calls.json')));
  const rules = calls.find((item) => item.method === 'thread/start').params.developerInstructions;
  assert.match(rules, /忽略自动加载的 AGENTS/);
  assert.match(rules, /完整独立 HTML/);
});

// 进程启动失败也必须完成资源清理，不能让“开始测试”一直卡住。
test('无法启动的 CLI 及时返回失败', async (t) => {
  const { directory } = await environment(t);
  await assert.rejects(listAccountTestModels(directory, { executable: path.join(directory, 'missing-cli') }), /失败/);
});

// 测试账号是总览中的映射，伪造 home、重复点击和非法记录路径都必须被拒绝。
test('并发上限、账号隔离、重测和历史恢复走同一服务', async (t) => {
  const { directory } = await environment(t);
  const pending = gate();
  let active = 0, maximum = 0;
  const targets = [0, 1, 2].map((n) => ({ id: `instance-${n}`, home: `/fake/home-${n}`, name: `实例 ${n}`, account: { planType: 'plus' } }));
  const service = new AccountTests(directory, {
    getInstances: () => targets, getRuntime: () => ({}),
    run: async (home, options) => {
      active++;
      maximum = Math.max(maximum, active);
      options.onProgress({ text: home });
      await pending.promise;
      active--;
      return { text: home, durationMs: 25, model: options.model, usage: null };
    },
  });
  t.after(() => service.stop());
  const value = { kind: 'custom', prompt: '统一问题', model: 'fixture-model', effort: 'medium', concurrency: 2, format: 'text', instanceIds: targets.map((i) => i.id) };
  await assert.rejects(service.start({ ...value, instanceIds: ['/unauthorized/home'] }), /总览/);
  const started = await service.start(value);
  await assert.rejects(service.start(value), /已有测试/);
  assert.equal(maximum, 2);
  pending.resolve();
  await service.active.promise;
  const saved = await service.read(started.id);
  assert.equal(saved.status, 'completed');
  assert.deepEqual(saved.results.map((r) => r.text), targets.map((i) => i.home));
  assert.equal(maximum, 2);
  assert.equal(JSON.stringify(saved).includes('networkEnv'), false);
  await assert.rejects(service.read('../../auth.json'), /无效/);
  const retried = await service.retry({ id: saved.id, instanceId: targets[1].id });
  await service.active.promise;
  assert.notEqual(retried.id, saved.id);
  assert.equal(retried.results.length, 1);
  assert.equal((await service.list()).total, 2);
  await service.stop();
  const restored = new AccountTests(directory, { getInstances: () => targets, getRuntime: () => ({}) });
  assert.equal((await restored.read(saved.id)).results.length, 3);
  await restored.remove(retried.id);
  assert.equal((await restored.list()).total, 1);
  const interrupted = { ...saved, id: randomUUID(), status: 'running', results: saved.results.map((r) => ({ ...r, status: 'running' })) };
  await restored.save(interrupted);
  assert.equal((await restored.read(interrupted.id)).status, 'interrupted');
  assert.ok((await restored.read(interrupted.id)).results.every((r) => r.status === 'interrupted'));
  await restored.stop();
});

// 取消后排队账号不运行，已输出的文本随取消记录原子保存。
test('停止队列保留部分回答并跳过尚未执行的账号', async (t) => {
  const { directory } = await environment(t);
  const entered = gate();
  const executed = [];
  const targets = [0, 1].map((n) => ({ id: String(n), home: `/test-${n}` }));
  const service = new AccountTests(directory, {
    getInstances: () => targets, getRuntime: () => ({}),
    run: (home, { signal, onProgress }) => new Promise((resolve, reject) => {
      executed.push(home);
      onProgress({ text: '部分回答' });
      entered.resolve();
      signal.addEventListener('abort', () => reject(new AccountTestError('已取消', 'cancelled')), { once: true });
    }),
  });
  const started = await service.start({ kind: 'custom', prompt: 'test', model: 'm', effort: '', format: 'text', concurrency: 1, instanceIds: ['0', '1'] });
  await entered.promise;
  const runningPreview = (await service.list()).records[0].previews[0];
  assert.equal(runningPreview.status, 'running');
  assert.equal(runningPreview.text, '', '缩略摘要不应公开生成中的部分回答');
  assert.ok(runningPreview.startedAt);
  await service.cancel(started.id);
  const record = await service.read(started.id);
  assert.deepEqual(executed, ['/test-0']);
  assert.deepEqual(record.results.map((r) => r.status), ['cancelled', 'cancelled']);
  assert.equal(record.results[0].text, '部分回答');
  assert.equal(record.status, 'cancelled');
  await service.stop();
});

// 各账号目录的模型和强度必须求交集，失败账号不允许沿用上一次的目录。
test('共同模型与共同强度按所选账号计算', async (t) => {
  const { directory } = await environment(t);
  const targets = [{ id: 'a', home: 'a' }, { id: 'b', home: 'b' }];
  const service = new AccountTests(directory, {
    getInstances: () => targets, getRuntime: () => ({}),
    models: async (home) => [{ id: 'common', efforts: home === 'a' ? ['medium', 'high'] : ['medium'] }, { id: home, efforts: [] }],
  });
  const catalog = await service.models(['a', 'b']);
  assert.deepEqual(catalog.models.map((m) => [m.id, m.efforts]), [['common', ['medium']]]);
  await service.stop();
});

// 一页十条摘要携带缩略预览信息，既有记录不用迁移就能显示。
test('历史默认每页十条并返回账号预览、耗时和用量', async (t) => {
  const { directory } = await environment(t);
  const service = new AccountTests(directory, { getInstances: () => [], getRuntime: () => ({}) });
  for (let i = 0; i < 11; i++) await service.save({ id: randomUUID(), prompt: 'HTML', kind: 'pelican', status: 'completed', results: [{ instanceId: 'a', name: '账号', plan: 'Plus', status: 'completed', durationMs: 1000, usage: { totalTokens: 120 }, text: '<html><body>预览</body></html>' }] });
  const first = await service.list();
  assert.equal(first.records.length, 10);
  assert.equal(first.pages, 2);
  assert.equal((await service.list(2)).records.length, 1);
  const preview = first.records[0].previews[0];
  assert.equal(preview.html, true);
  assert.equal(preview.text, '', '完整 HTML 应通过受限预览协议加载，不混入摘要正文');
  assert.equal(preview.durationMs, 1000);
  assert.equal(preview.totalTokens, 120);
  await service.stop();
});

// 沙箱协议只接受完整且结束的 HTML，编码路径和普通回答无法获得可执行预览。
test('HTML 提取与预览协议限制不完整回答、路径和外部资源', async () => {
  const html = '<html><body><script>window.example=true</script></body></html>';
  assert.equal(extractTestHtml('```html\n' + html + '\n```'), html);
  assert.equal(extractTestHtml('<html>未完成'), null);
  assert.equal(extractTestHtml('普通回答'), null);
  assert.match(testPreviewDocument(html), /connect-src 'none'/);
  const id = '12345678-1234-4123-8123-123456789012';
  const instanceId = '12345678901234567890';
  const tests = { read: async () => ({ results: [{ instanceId, status: 'completed', text: html }] }) };
  const response = await accountTestPreview(`dragon-preview://test/${id}/${instanceId}`, tests);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-src 'none'/);
  assert.equal((await accountTestPreview(`dragon-preview://other/${id}/${instanceId}`, tests)).status, 404);
  assert.equal((await accountTestPreview('dragon-preview://test/../../auth.json', tests)).status, 404);
  tests.read = async () => ({ results: [{ instanceId, status: 'cancelled', text: html }] });
  assert.equal((await accountTestPreview(`dragon-preview://test/${id}/${instanceId}`, tests)).status, 409);
});
