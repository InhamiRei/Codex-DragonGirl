import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AUDIO_FILES, AUDIO_SOURCE } from '../src/shared/audio-library.js';
import { verifyAudioLibrary } from '../src/core/audio-library-store.js';
const root = fileURLToPath(new URL('../', import.meta.url));

// 仅把已核验的九个原文件安装到指定本机音效目录，保留其他角色与用户文件。
export async function installReferenceAudio(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of AUDIO_FILES) {
    const bytes = await fs.readFile(path.join(root, '.artifacts/reference-audio', file.sourceFile));
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new Error(`原音频校验失败：${file.sourceFile}`);
    const target = path.join(directory, file.localFile);
    const existing = await fs.readFile(target).catch(() => null);
    if (existing && !existing.equals(bytes))
      await fs.copyFile(target, target + '.recovered-' + Date.now());
    if (!existing?.equals(bytes)) await fs.writeFile(target, bytes, { mode: 0o600 });
  }
  await fs.writeFile(
    path.join(directory, 'original-audio-sources.json'),
    JSON.stringify({ ...AUDIO_SOURCE, files: AUDIO_FILES }, null, 2),
    { mode: 0o600 },
  );
  const status = await verifyAudioLibrary(directory);
  if (!status.complete) throw new Error('原声音效库安装后校验失败');
  return status;
}

// 命令行必须明确传入目标目录，测试和真实安装不会混用数据。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !path.isAbsolute(process.argv[2])) throw new Error('请指定音效目录的绝对路径');
  console.log(JSON.stringify(await installReferenceAudio(process.argv[2])));
}
