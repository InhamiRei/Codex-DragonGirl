import fs from 'node:fs/promises';
import path from 'node:path';
import { Ledger } from '../src/core/ledger.js';
import { discoverHomes } from '../src/core/instances.js';
import { normalizeSettings } from '../src/core/settings.js';
const settings = normalizeSettings();
const homes = await discoverHomes(settings);
const target = path.resolve('.artifacts/live-usage-validation');
await fs.mkdir(target, { recursive: true });
const ledger = new Ledger(path.join(target, 'usage.sqlite'));
const started = Date.now(),
  result = [];
// 真实日志只读验收：输出规模、计数和错误数量，不输出会话正文或账户标识。
for (const [index, home] of homes.entries()) {
  const files = await ledger.filesFor(home.home);
  let errors = 0,
    done = 0;
  for (const file of files) {
    try {
      await ledger.scanFile(file, home.id);
    } catch {
      errors++;
    }
    if (++done % 80 === 0) console.log(`实例 ${index + 1} 索引 ${done}/${files.length}`);
  }
  const report = ledger.report({ home: home.id }, settings);
  result.push({
    instance: index + 1,
    files: files.length,
    errors,
    total: report.total,
    requests: report.requests,
    models: report.models,
    threadCount: report.threads.length,
  });
  console.log(`实例 ${index + 1} 索引完成，${report.requests} 条记录，${errors} 个文件错误`);
}
const before = ledger.report({}, settings).total;
for (const home of homes)
  for (const file of await ledger.filesFor(home.home))
    await ledger.scanFile(file, home.id).catch(() => {});
const after = ledger.report({}, settings).total;
const output = {
  instances: result,
  seconds: (Date.now() - started) / 1000,
  before,
  after,
  incrementalNondecreasing: after >= before,
};
await fs.writeFile(path.join(target, 'report.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output));
ledger.close();
