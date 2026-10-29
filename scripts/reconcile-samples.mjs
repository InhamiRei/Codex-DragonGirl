import { Ledger } from '../src/core/ledger.js';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const ledger = new Ledger('.artifacts/live-usage-validation/usage.sqlite');
const files = ledger.db
  .prepare("SELECT * FROM files WHERE path LIKE '%.jsonl' ORDER BY mtime DESC LIMIT 6")
  .all();
const checks = [];
// 冻结在数据库提交偏移，避免正在进行的聊天追加影响独立对账。
for (const f of files) {
  const handle = await fs.open(f.path, 'r');
  const buffer = Buffer.alloc(f.offset);
  await handle.read(buffer, 0, buffer.length, 0);
  await handle.close();
  let meta;
  const responses = new Map();
  for (const line of buffer.toString('utf8').split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'session_meta') meta = e.payload;
    if (
      e.type === 'token_usage_record' &&
      meta &&
      e.payload.thread_id === meta.id &&
      e.payload.response_id
    )
      responses.set(e.payload.response_id, e.payload.usage.total_tokens || 0);
  }
  const state = JSON.parse(f.state),
    indexed = ledger.rows({ home: f.home, thread: state.thread });
  const indexedRequests = indexed
      .filter((r) => r.kind !== 'delta')
      .reduce((sum, r) => sum + r.total_tokens, 0),
    delta = indexed.filter((r) => r.kind === 'delta').reduce((sum, r) => sum + r.total_tokens, 0),
    expected = [...responses.values()].reduce((a, b) => a + b, 0);
  checks.push({
    requests: responses.size,
    expected,
    indexedRequests,
    unmatchedDelta: delta,
    matched: expected === indexedRequests,
  });
}
ledger.close();
assert.ok(checks.every((c) => c.matched));
assert.ok(
  checks.every((c) => c.unmatchedDelta === 0),
  '新版样本不应再叠加累计快照',
);
await fs.writeFile('.artifacts/ledger-reconciliation.json', JSON.stringify(checks, null, 2));
console.log(`独立对账通过：${checks.length} 份真实新格式样本，请求明细一致，累计快照额外计数为零。`);
