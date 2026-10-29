import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AUDIO_FILES } from '../shared/audio-library.js';

// 校验本机音效库与固定来源版本逐字节一致，不读取其他用户素材。
export async function verifyAudioLibrary(directory) {
  const missing = [],
    invalid = [];
  let installed = 0;
  for (const file of AUDIO_FILES) {
    let bytes;
    try {
      bytes = await fs.readFile(path.join(directory, file.localFile));
    } catch {
      missing.push(file.label);
      continue;
    }
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      invalid.push(file.label);
    else installed++;
  }
  return {
    total: AUDIO_FILES.length,
    groups: 2,
    installed,
    missing,
    invalid,
    complete: installed === AUDIO_FILES.length,
  };
}

// 用户点击后下载固定的九段原声，先全部核验，再写入本应用目录。
export async function downloadAudioLibrary(directory, fetcher = fetch) {
  const files = [];
  for (const file of AUDIO_FILES) {
    const response = await fetcher(file.sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`下载失败：${file.label}，请检查网络后重试。`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new Error(`音频校验失败：${file.label}，本机音效未被覆盖。`);
    files.push([file, bytes]);
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [file, bytes] of files) {
    const target = path.join(directory, file.localFile);
    await fs.writeFile(target + '.tmp', bytes, { mode: 0o600 });
    await fs.rename(target + '.tmp', target);
  }
  return verifyAudioLibrary(directory);
}
