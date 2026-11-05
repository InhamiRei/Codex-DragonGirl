import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Ledger } from '../src/core/ledger.js';
import { parserState, parseUsageEvent, estimateCost } from '../src/core/usage-parser.js';
import { normalizeQuota, AlertTracker } from '../src/core/quota.js';
import { discoverHomes } from '../src/core/instances.js';
import { normalizeSettings, isQuiet } from '../src/core/settings.js';
import { dayKey, midnight, nextDay, quotaResetTime } from '../src/shared/time.js';
import { quotaAvailableWindows, quotaDisplayWindows, tokenDisplayParts } from '../src/shared/presentation.js';
import { readAccount } from '../src/core/rpc.js';
import { readRecentQuota } from '../src/core/log-snapshot.js';

// 测试事件保留真实协议关键字段，不依赖任何用户历史内容。
const event = (type, payload, sec = 1) => ({
  type,
  payload,
  timestamp: `2026-10-28T01:00:${String(sec).padStart(2, '0')}Z`,
});
// 构造旧格式累计快照，验证新旧事件混用时不会重复计算。
const count = (n, sec) =>
  event(
    'event_msg',
    {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: n, output_tokens: 0, total_tokens: n } },
    },
    sec,
  );
// 每个数据库测试都隔离文件目录，并在结束后关闭 WAL。
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-test-'));
  const ledger = new Ledger(path.join(dir, 'usage.sqlite'));
  t.after(async () => {
    ledger.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, ledger };
}

// 五个独立账号、任意附加目录和符号链接归一化，防止双开数量写死。
test('自动发现五个目录并按 realpath 去重', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-homes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.codex'), { recursive: true });
  for (let i = 0; i < 4; i++)
    await fs.mkdir(path.join(root, '.cockpit_tools/instances/codex', String(i)), { recursive: true });
  const link = path.join(root, 'alias');
  await fs.symlink(path.join(root, '.codex'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const homes = await discoverHomes(normalizeSettings({ manualHomes: [link] }), [], root);
  assert.equal(homes.length, 5);
  assert.equal(new Set(homes.map((h) => h.id)).size, 5);
});

// 真正的服务端窗口必须保留；只有周窗口时不会补出伪造 5h。
test('多桶额度、空重置时间与明确的零值', () => {
  const q = normalizeQuota({
    rateLimits: {},
    rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: null } },
      other: { primary: { usedPercent: 0, windowDurationMins: 300 } },
    },
    ordinaryUsageAllowed: false,
    rateLimitResetCredits: { availableCount: 2, credits: null },
  });
  assert.equal(q.buckets.length, 2);
  assert.equal(q.buckets[0].windows.length, 1);
  assert.equal(q.buckets[0].windows[0].remaining, 0);
  assert.equal(q.buckets[0].windows[0].resetsAt, null);
  assert.equal(q.buckets[1].windows[0].remaining, 100);
  assert.equal(q.allowed, false);
  assert.equal(q.resetCredits.details, null);
});

// 周额度限制只作用于同桶真实 5h 的展示，原始使用量、重置时间与其他窗口均不变。
test('周额度耗尽时 5h 可用量归零，恢复后重新使用真实读数', () => {
  const fiveHour = Object.freeze({ id: 'primary', minutes: 300, remaining: 100,
    usedPercent: 0, resetsAt: 1900000000000 });
  const weekly = Object.freeze({ id: 'secondary', minutes: 10080, remaining: 0 });
  const daily = Object.freeze({ id: 'daily', minutes: 1440, remaining: 85 });
  const windows = Object.freeze([weekly, daily, fiveHour]);
  const blocked = quotaAvailableWindows(windows);
  assert.equal(blocked[2].remaining, 0);
  assert.equal(blocked[2].isBlockedByWeeklyLimit, true);
  assert.equal(blocked[2].usedPercent, fiveHour.usedPercent);
  assert.equal(blocked[2].resetsAt, fiveHour.resetsAt);
  assert.equal(blocked[0], weekly);
  assert.equal(blocked[1], daily);
  assert.equal(fiveHour.remaining, 100);
  assert.equal(fiveHour.isBlockedByWeeklyLimit, undefined);
  const recovered = [fiveHour, { ...weekly, remaining: 25 }];
  assert.equal(quotaAvailableWindows(recovered), recovered);
  assert.equal(quotaAvailableWindows(recovered)[0].remaining, 100);
  const otherBucket = [fiveHour, { ...weekly, remaining: 75 }];
  assert.equal(quotaAvailableWindows(otherBucket), otherBucket);
});

// 不足 1% 仍明确显示为不足 1，缺失或未知的周额度也不能误触发耗尽联动。
test('5h 可用量不受其他桶、未知或仍有余额的周窗口影响', () => {
  const fiveHour = { minutes: 300, remaining: 61 };
  for (const remaining of [0.4, 1, 100, null, undefined, NaN]) {
    const windows = [fiveHour, { minutes: 10080, remaining }];
    assert.equal(quotaAvailableWindows(windows), windows);
  }
  for (const windows of [[], [fiveHour], [fiveHour, { minutes: 1440, remaining: 0 }]])
    assert.equal(quotaAvailableWindows(windows), windows);
});

// 各档 Pro 的补位电量精确跟随周额度，零额度也同步归零，原始窗口始终不被改写。
test('Pro 单周额度生成明确标注无限制的 5h 展示行', () => {
  for (const plan of ['pro', 'prolite', 'promax']) {
    for (const remaining of [62, 0.4, 0]) {
      const weekly = Object.freeze({ label: '周额度', minutes: 10080, remaining,
        low: remaining <= 20, resetsAt: 1900000000000 });
      const windows = Object.freeze([weekly]);
      const result = quotaDisplayWindows(windows, plan);
      assert.equal(result.length, 2);
      assert.equal(result[0].label, '5 小时');
      assert.equal(result[0].minutes, 300);
      assert.equal(result[0].isUnlimited, true);
      assert.equal(result[0].resetsAt, null);
      assert.equal(result[0].remaining, weekly.remaining);
      assert.equal(result[0].low, weekly.low);
      assert.equal(result[1], weekly);
      assert.equal(windows.length, 1);
      assert.equal(weekly.isUnlimited, undefined);
    }
  }
});

// 未知套餐、非 Pro、多桶或已有真实 5h 时保留实际窗口，缺失字段不能被推断为无限制。
test('5h 展示补位不覆盖真实限制，也不扩展未知额度', () => {
  const weekly = { label: '周额度', minutes: 10080, remaining: 62 };
  const windows = [weekly];
  for (const plan of ['plus', 'unknown', 'apiKey', 'business', 'codex_future', undefined])
    assert.equal(quotaDisplayWindows(windows, plan), windows);
  for (const rows of [[], [{ ...weekly, minutes: null }],
    [{ label: '5 小时', minutes: 300 }, weekly], [weekly, { ...weekly }]])
    assert.equal(quotaDisplayWindows(rows, 'prolite'), rows);
});

// 数量单位仅改变排版，普通数值、万、亿、万亿及未知文案都不能丢失或被重新计量。
test('气泡用量数字与数量单位分开显示', () => {
  for (const [text, number, unit] of [
    ['2715万', '2715', '万'], ['123.4万', '123.4', '万'], ['2.7亿', '2.7', '亿'],
    ['1.234万亿', '1.234', '万亿'], ['12,345万', '12,345', '万'],
    ['0', '0', ''], ['123456789', '123456789', ''], ['暂未统计', '暂未统计', ''],
  ]) assert.deepEqual(tokenDisplayParts(text), { number, unit });
});

// 紧凑重置时间遵循统计时区，跨日显示完整时分，缺失与到期不能被误报为新周期。
test('气泡重置时间区分当天、跨日、未知和等待刷新', () => {
  const now = Date.parse('2026-11-05T10:00:00+08:00');
  assert.equal(quotaResetTime(Date.parse('2026-11-05T13:27:00+08:00'), 'Asia/Shanghai', now).text, '13:27 重置');
  const weekly = quotaResetTime(Date.parse('2026-11-09T13:33:00+08:00'), 'Asia/Shanghai', now);
  assert.equal(weekly.text, '11.09 13:33 重置');
  assert.match(weekly.title, /2026-11-09 13:33.*Asia\/Shanghai/);
  assert.equal(quotaResetTime(Date.parse('2026-11-05T10:00:00Z'), 'America/Los_Angeles', now).text, '11.05 02:00 重置');
  assert.equal(quotaResetTime(Date.parse('2026-11-05T16:05:00Z'), 'Asia/Shanghai', now).text, '11.06 00:05 重置');
  for (const value of [undefined, null, NaN, Infinity, 0])
    assert.equal(quotaResetTime(value, 'Asia/Shanghai', now).text, '重置时间未知');
  assert.equal(quotaResetTime(now, 'Asia/Shanghai', now).text, '重置待刷新');
});

// 相同账户在多个实例出现，只触发一次额度提醒；旧数据不触发。
test('提醒按账户窗口去重且拒绝过期快照', () => {
  const q = normalizeQuota({
    rateLimits: { primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1900000000 } },
  });
  const alerts = new AlertTracker();
  assert.equal(alerts.evaluate('a', q, 20).length, 1);
  assert.equal(alerts.evaluate('a', q, 20).length, 0);
  assert.equal(alerts.evaluate('b', q, 20).length, 1);
  assert.equal(alerts.evaluate('c', { ...q, capturedAt: 0 }, 20).length, 0);
});

// 增量、部分行、重复扫描和不同账号隔离采用真实文件写入验证。
test('增量账本处理半行和重复扫描，不串账号', async (t) => {
  const { dir, ledger } = await fixture(t);
  const file = path.join(dir, 'one.jsonl');
  const rows = [
    event('session_meta', { id: 'one', creator_account_id: 'account-a' }, 0),
    event('event_msg', { type: 'task_started', turn_id: 't' }),
    count(100, 2),
    count(100, 3),
  ];
  await fs.writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
  await ledger.scanFile(file, 'a');
  assert.equal(ledger.report().total, 100);
  await ledger.scanFile(file, 'a');
  assert.equal(ledger.report().total, 100);
  const tail = JSON.stringify(count(170, 4));
  await fs.appendFile(file, tail.slice(0, 40));
  await ledger.scanFile(file, 'a');
  assert.equal(ledger.report().total, 100);
  await fs.appendFile(file, tail.slice(40) + '\n');
  await ledger.scanFile(file, 'a');
  assert.equal(ledger.report().total, 170);
  const second = path.join(dir, 'two.jsonl');
  await fs.writeFile(
    second,
    [event('session_meta', { id: 'two', creator_account_id: 'account-b' }, 0), count(250, 2)]
      .map(JSON.stringify)
      .join('\n') + '\n',
  );
  await ledger.scanFile(second, 'b');
  assert.equal(ledger.report({ home: 'a' }).total, 170);
  assert.equal(ledger.report({ home: 'b' }).total, 250);
  assert.equal(ledger.report().total, 420);
});

// 明细记录与累计快照同存时只算一份；更早的旧格式用量必须保留。
test('请求记录去重，混合格式不丢旧用量', async (t) => {
  const { dir, ledger } = await fixture(t);
  const file = path.join(dir, 'mixed.jsonl');
  const rows = [
    event('session_meta', { id: 'one', creator_account_id: 'a' }, 0),
    count(40, 1),
    event(
      'token_usage_record',
      { thread_id: 'one', response_id: 'r1', usage: { input_tokens: 100, total_tokens: 100 } },
      5,
    ),
    count(140, 5),
  ];
  await fs.writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
  await ledger.scanFile(file, 'a');
  assert.equal(ledger.report().total, 140);
  const copy = path.join(dir, 'archived.jsonl');
  await fs.copyFile(file, copy);
  await ledger.scanFile(copy, 'a');
  assert.equal(ledger.report().total, 140);
});

// 文件被重写时从新内容重建，同一请求的归档副本不被误删。
test('截断重建保留其他副本的事件', async (t) => {
  const { dir, ledger } = await fixture(t);
  const a = path.join(dir, 'a.jsonl'),
    b = path.join(dir, 'b.jsonl');
  const text =
    [event('session_meta', { id: 'a' }, 0), count(100, 1)].map(JSON.stringify).join('\n') + '\n';
  await fs.writeFile(a, text);
  await fs.writeFile(b, text);
  await ledger.scanFile(a, 'home');
  await ledger.scanFile(b, 'home');
  await fs.writeFile(a, '');
  await ledger.scanFile(a, 'home');
  assert.equal(ledger.report().total, 100);
});

// 子代理继承的父任务历史不属于新消耗，累积基线仍需要更新。
test('子代理继承前缀只作基线，不重复计费', () => {
  const s = parserState();
  parseUsageEvent(
    event(
      'session_meta',
      {
        id: 'child',
        parent_thread_id: 'parent',
        timestamp: '2026-10-28T01:00:10Z',
        source: { subagent: {} },
      },
      10,
    ),
    s,
    'home',
  );
  assert.deepEqual(parseUsageEvent(count(1000, 5), s, 'home'), {});
  const r = parseUsageEvent(count(1150, 11), s, 'home');
  assert.equal(r.usage.total_tokens, 150);
  assert.equal(r.usage.source, '子代理');
});

// 缓存与推理属于已有输入/输出，单独展示不会二次加价。
test('费用包含长上下文和实际速度，未知模型保持未定价', () => {
  const row = {
    model: 'gpt-6.1-sol',
    time: Date.parse('2026-10-28T10:00:00Z'),
    tier: 'priority',
    input_tokens: 1000,
    cached_input_tokens: 800,
    cache_write_input_tokens: 0,
    output_tokens: 100,
  };
  assert.equal(estimateCost(row), (0.0004 + 0.00008 + 0.001) * 2);
  assert.equal(estimateCost({ ...row, model: 'unknown' }), null);
  assert.equal(estimateCost({ ...row, time: 0 }), null);
  const long = {
    ...row,
    input_tokens: 300000,
    cached_input_tokens: 0,
    output_tokens: 1000,
    tier: 'default',
  };
  assert.ok(Math.abs(estimateCost(long) - 1.215) < 1e-12);
});

// 亚洲时区与夏令时切换日使用自然日跨度，避免漏记凌晨请求。
test('日期筛选与跨午夜免打扰', () => {
  assert.equal(dayKey(Date.parse('2026-10-27T16:00:00Z')), '2026-10-28');
  assert.equal(midnight('2026-10-28'), Date.parse('2026-10-27T16:00:00Z'));
  assert.equal(
    midnight(nextDay('2026-11-01'), 'America/Los_Angeles') -
      midnight('2026-11-01', 'America/Los_Angeles'),
    25 * 3600000,
  );
  assert.equal(
    isQuiet(
      normalizeSettings({ quietStart: '23:00', quietEnd: '08:00' }),
      new Date('2026-10-28T17:00:00Z'),
    ),
    true,
  );
});

// 导入配置中的资源路径不能穿越到任意用户文件。
test('设置校验拒绝异常路径、错误价格和高频轮询', () => {
  const settings = normalizeSettings({
    refreshSeconds: 0,
    characterAsset: '../../secret.png',
    prices: {
      bad: { input: -1, cached: 1, output: 1 },
      invalidDate: { input: 1, cached: 1, output: 1, effective: '不是日期' },
      invalidType: { input: 1, cached: 1, output: 1, effective: { toString: '无效' } },
    },
  });
  assert.equal(settings.refreshSeconds, 30);
  assert.equal(settings.characterAsset, '');
  assert.deepEqual(settings.prices, {});
});

// 真实子进程只接受保留的两项账户查询，防止已移除的接口被悄悄恢复。
test('RPC 只使用指定 home，并且只查询账户和额度', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-rpc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'fake-codex.cjs');
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node\nconst readline=require('node:readline');const fs=require('node:fs');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;fs.appendFileSync(__filename+'.calls',m.method+'\\n');const result=m.id===1?{}:m.id===2?{account:{type:'chatgpt',planType:process.env.CODEX_HOME}}:m.id===3?{rateLimits:{primary:{usedPercent:25,windowDurationMins:300}}}:null;console.log(JSON.stringify(result?{id:m.id,result}:{id:m.id,error:{code:-32601,message:'method not found'}}));});\n`,
    { mode: 0o755 },
  );
  const result = await readAccount('/chosen/account', { executable: process.execPath, prefixArgs: [executable], timeout: 5000 });
  assert.equal(result.account.planType, '/chosen/account');
  assert.equal(result.quota.rateLimits.primary.usedPercent, 25);
  assert.deepEqual(result.errors, { quota: null });
  assert.deepEqual((await fs.readFile(executable + '.calls', 'utf8')).trim().split('\n'), [
    'initialize', 'account/read', 'account/rateLimits/read',
  ]);
});

// 请求额度接口的普通网络错误不能因为包含 rate limits 被误判成限流。
test('网络错误与限流错误分别分类', async () => {
  const { rpcError } = await import('../src/core/rpc.js');
  assert.match(
    rpcError({ message: 'failed to fetch codex rate limits: error sending request for url' }),
    /连接/,
  );
  assert.match(rpcError({ message: 'HTTP 429 too many requests' }), /限流/);
});

// 压缩归档可独立读取，明文与压缩副本同时存在时只扫描明文。
test('压缩归档与重复副本的用量保持一致', async (t) => {
  const { dir, ledger } = await fixture(t);
  const { zstdCompressSync } = await import('node:zlib');
  const home = path.join(dir, 'home');
  await fs.mkdir(path.join(home, 'archived_sessions'), { recursive: true });
  const plain = path.join(home, 'archived_sessions/a.jsonl');
  const text =
    [event('session_meta', { id: 'compressed' }, 0), count(321, 1)].map(JSON.stringify).join('\n') +
    '\n';
  await fs.writeFile(plain + '.zst', zstdCompressSync(Buffer.from(text)));
  await ledger.scanFile(plain + '.zst', 'home');
  assert.equal(ledger.report().total, 321);
  await ledger.scanFile(plain + '.zst', 'home');
  assert.equal(ledger.report().total, 321);
  await fs.writeFile(plain, text);
  assert.deepEqual(await ledger.filesFor(home), [plain]);
  await ledger.scanFile(plain, 'home');
  assert.equal(ledger.report().total, 321);
});

// 新格式请求明细有轮次和线程总量时具有权威性，累计快照分项不同也不再重复计数。
test('原生请求覆盖同轮不一致的累计快照，其他旧轮次仍计数', async (t) => {
  const { dir, ledger } = await fixture(t);
  const file = path.join(dir, 'canonical.jsonl');
  const usage = { input_tokens: 100, cached_input_tokens: 30, output_tokens: 20, total_tokens: 120 };
  const rows = [
    event('session_meta', { id: 'one', creator_account_id: 'a' }, 0),
    event('event_msg', { type: 'task_started', turn_id: 'old' }, 1),
    count(50, 2),
    event('event_msg', { type: 'task_started', turn_id: 'new' }, 3),
    event(
      'token_usage_record',
      {
        thread_id: 'one',
        turn_id: 'new',
        response_id: 'native',
        usage,
        turn_token_usage: usage,
        thread_token_usage: usage,
      },
      4,
    ),
    count(900, 6),
  ];
  await fs.writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
  await ledger.scanFile(file, 'a');
  assert.equal(ledger.report().total, 170);
  assert.equal(ledger.report().requests, 2);
});

// 升级只替换旧默认气泡，不覆盖用户自行填写的内容。
test('默认气泡移除实例名与状态行、升级 Tokens 单位并保留自定义模板', () => {
  for (const old of [
    '{name} · {plan}\n{quota}\n今日 {tokens} tokens · {status}',
    '{实例} · {套餐}\n{额度}\n今日 {今日用量} 词元 · {任务状态}',
    '{实例} · {套餐}\n{额度}\n今日 {今日用量} Tokens · {任务状态}',
    '{套餐}\n{额度}\n今日 {今日用量} Tokens · {任务状态}',
  ])
    assert.equal(
      normalizeSettings({ bubbleTemplate: old }).bubbleTemplate,
      '{套餐}\n{额度}\n今日 {今日用量} Tokens',
    );
  const custom = '正在观察 {name}，已用 {tokens} 词元，还有 {quota}';
  assert.equal(normalizeSettings({ bubbleTemplate: custom }).bubbleTemplate, custom);
  const customStatus = '自定义状态：{任务状态}';
  assert.equal(normalizeSettings({ bubbleTemplate: customStatus }).bubbleTemplate, customStatus);
});

// 未知模型名即使与对象原型重名，也只能显示未定价，不能污染金额和模型分布。
test('原型同名模型保持未定价并正常汇总', async (t) => {
  const { dir, ledger } = await fixture(t);
  for (const [index, model] of ['constructor', '__proto__', 'toString'].entries()) {
    const row = { type: 'token_usage_record', timestamp: '2026-10-30T01:00:00Z',
      payload: { response_id: `prototype-${index}`, usage: { input_tokens: 10, total_tokens: 10 } } };
    const file = path.join(dir, `${index}.jsonl`);
    await fs.writeFile(file, [event('session_meta', { id: `prototype-${index}` }),
      event('turn_context', { model }), row].map(JSON.stringify).join('\n') + '\n');
    await ledger.scanFile(file, 'fixture');
    assert.equal(estimateCost({ model, time: Date.now() }), null);
  }
  const report = ledger.report();
  assert.equal(report.total, 30);
  assert.equal(report.cost, null);
  for (const model of ['constructor', '__proto__', 'toString']) assert.equal(report.models[model], 10);
});

// 账户协议与生成协议一样需要跨块解码；取消发生在启动之前时不得创建子进程。
test('账户 RPC 保留跨块中文并在启动前响应取消', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-rpc-utf8-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'fixture.cjs');
  await fs.writeFile(executable, `const readline = require('node:readline');
let queue = Promise.resolve();
// 将中文字符的 UTF-8 字节拆开，模拟真实管道的任意边界。
readline.createInterface({ input: process.stdin }).on('line', line => { queue = queue.then(() => new Promise(resolve => {
  const m = JSON.parse(line); if (!m.id) { resolve(); return; }
  const result = m.id === 1 ? {} : m.id === 2 ? { account: { planType: '测试中文套餐' } } : { rateLimits: {} };
  const bytes = Buffer.from(JSON.stringify({ id: m.id, result }) + String.fromCharCode(10));
  const index = bytes.indexOf(Buffer.from('中'));
  if (index < 0) { process.stdout.write(bytes); resolve(); }
  else { process.stdout.write(bytes.subarray(0, index + 1)); setTimeout(() => { process.stdout.write(bytes.subarray(index + 1)); resolve(); }, 20); }
})); });`);
  const result = await readAccount(dir, { executable: process.execPath, prefixArgs: [executable] });
  assert.equal(result.account.planType, '测试中文套餐');
  await assert.rejects(readAccount(dir, { executable: path.join(dir, 'must-not-start'),
    signal: AbortSignal.abort() }), /查询已取消/);
});

// 文件轮转可能发生在枚举与打开之间，仍要继续读取其他有效日志。
test('近期额度跳过已被归档的文件并保留其他新鲜读数', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-recent-quota-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const folder = path.join(directory, 'sessions');
  await fs.mkdir(folder);
  const timestamp = new Date().toISOString();
  const lines = [
    { type: 'session_meta', timestamp, payload: { creator_account_id: 'fixture' } },
    { type: 'event_msg', timestamp, payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: 30, window_minutes: 300 } } } },
  ].map(JSON.stringify).join('\n') + '\n';
  const missing = path.join(folder, 'rotated.jsonl');
  const valid = path.join(folder, 'valid.jsonl');
  await fs.writeFile(valid, lines);
  await fs.writeFile(missing, lines);
  await fs.utimes(missing, new Date(), new Date(Date.now() + 1000));
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === missing) throw Object.assign(new Error('已轮转'), { code: 'ENOENT' });
    return open(file, ...args);
  });
  const result = await readRecentQuota(directory);
  assert.equal(result.quota.buckets[0].windows[0].remaining, 70);
  assert.equal(result.quota.source, '会话快照');
});

// 退出中断读取时回滚当前事务，之后仍能重新扫描同一份文件。
test('中断日志读取会关闭流并允许后续重新扫描', async (t) => {
  const { dir, ledger } = await fixture(t);
  const file = path.join(dir, 'aborted.jsonl');
  await fs.writeFile(file, [event('session_meta', { id: 'abort' }), count(100, 2)].map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(ledger.scanFile(file, 'fixture', () => {}, AbortSignal.abort()), /aborted/i);
  assert.equal(ledger.report().total, 0);
  await ledger.scanFile(file, 'fixture');
  assert.equal(ledger.report().total, 100);
});
