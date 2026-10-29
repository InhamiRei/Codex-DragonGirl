import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AUDIO_FILES, AUDIO_SOURCE } from '../src/shared/audio-library.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, '.artifacts/reference-audio');
await fs.mkdir(cache, { recursive: true });
// 固定原项目提交及摘要，只下载既定九个文件到被忽略的本机缓存。
for (const file of AUDIO_FILES) {
  const target = path.join(cache, file.sourceFile);
  const existing = await fs.readFile(target).catch(() => null);
  if (existing && createHash('sha256').update(existing).digest('hex') === file.sha256) continue;
  const response = await fetch(file.sourceUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`音频下载失败：${file.sourceFile}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
    throw new Error(`音频摘要不符：${file.sourceFile}`);
  await fs.writeFile(target, bytes, { mode: 0o600 });
}
await fs.writeFile(
  path.join(cache, 'manifest.json'),
  JSON.stringify({ ...AUDIO_SOURCE, files: AUDIO_FILES }, null, 2),
);
console.log('原项目九个音频文件已下载并通过校验。');
