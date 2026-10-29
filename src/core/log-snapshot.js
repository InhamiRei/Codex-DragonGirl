import fs from 'node:fs/promises';
import path from 'node:path';
import { quotaFromEvent } from './quota.js';
import { digest } from './usage-parser.js';
// 独立于完整索引读取近期日志尾部，首次历史扫描期间仍能提供新鲜额度观测。
export async function readRecentQuota(home) {
  const files = [];
  const root = path.join(home, 'sessions');
  // 仅枚举元数据并限制候选文件，读取量与多年历史总大小无关。
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const stat = await fs.stat(p).catch(() => null);
        if (stat) files.push({ p, stat });
      }
    }
  }
  await walk(root);
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let result = null;
  for (const { p, stat } of files.slice(0, 12)) {
    if (Date.now() - stat.mtimeMs > 180000) continue;
    let handle;
    try {
      handle = await fs.open(p, 'r');
      const size = Math.min(stat.size, 512 * 1024),
        bytes = Buffer.alloc(size);
      await handle.read(bytes, 0, size, stat.size - size);
      let text = bytes.toString('utf8');
      if (stat.size > size) text = text.slice(text.indexOf('\n') + 1);
      let quota = null;
      for (const line of text.split('\n').reverse()) {
        try {
          const event = JSON.parse(line);
          if (event.payload?.type === 'token_count') {
            quota = quotaFromEvent(event);
            if (quota) break;
          }
        } catch {}
      }
      if (!quota || Date.now() - quota.capturedAt > 120000) continue;
      let account = null;
      const prefix = Buffer.alloc(Math.min(stat.size, 512 * 1024));
      await handle.read(prefix, 0, prefix.length, 0);
      try {
        const meta = JSON.parse(prefix.toString('utf8').split('\n')[0]);
        if (meta.payload?.creator_account_id) account = digest(meta.payload.creator_account_id);
      } catch {}
      if (!result || quota.capturedAt > result.quota.capturedAt) result = { quota, account };
    } finally {
      await handle?.close();
    }
  }
  return result;
}
