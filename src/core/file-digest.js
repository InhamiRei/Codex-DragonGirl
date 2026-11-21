import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// 下载缓存和两端的发行包按块核对实际长度与摘要，文件再大也只需保留当前数据块。
export async function fileDigest(file, signal) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file, { signal })) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}
