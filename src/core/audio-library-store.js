import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AUDIO_FILES } from '../shared/audio-library.js';

// 原声必须同时符合长度和摘要，损坏的本机副本不能遮蔽安装包里的有效音频。
function matchesOriginal(bytes, file) {
  return (
    !!bytes &&
    bytes.length === file.bytes &&
    createHash('sha256').update(bytes).digest('hex') === file.sha256
  );
}

// 只读取清单中的固定文件，缺失或不可读时允许继续检查内置副本。
async function readAudioFile(directory, file) {
  if (!directory) return null;
  return fs.readFile(path.join(directory, file.localFile)).catch(() => null);
}

// 已安装的原声优先，缺失或损坏时使用内置原声，并记录实际来源供界面展示。
async function locateAudioFile(directory, file, bundledDirectory) {
  let invalid = false;
  for (const source of new Set([directory, bundledDirectory].filter(Boolean))) {
    const bytes = await readAudioFile(source, file);
    if (matchesOriginal(bytes, file))
      return { path: path.join(source, file.localFile), bundled: source === bundledDirectory };
    if (bytes) invalid = true;
  }
  return { path: null, invalid };
}

// 播放地址只能解析到九段经过核验的原声，禁止把任意文件名作为磁盘路径。
export async function resolveAudioPath(directory, filename, bundledDirectory) {
  const file = AUDIO_FILES.find((entry) => entry.localFile === filename);
  if (!file) return null;
  return (await locateAudioFile(directory, file, bundledDirectory)).path;
}

// 合并检查本机与内置音效，新电脑无需先向用户目录下载一份才能报告就绪。
export async function verifyAudioLibrary(directory, bundledDirectory) {
  const missing = [],
    invalid = [];
  let installed = 0,
    bundled = 0;
  for (const file of AUDIO_FILES) {
    const result = await locateAudioFile(directory, file, bundledDirectory);
    if (result.path) {
      installed++;
      if (result.bundled) bundled++;
    } else {
      (result.invalid ? invalid : missing).push(file.label);
    }
  }
  return {
    total: AUDIO_FILES.length,
    groups: 2,
    installed,
    bundled,
    missing,
    invalid,
    complete: installed === AUDIO_FILES.length,
  };
}

// 修复优先复用内置原声，仅在两份都不可用时联网；全部核验后才替换本机文件。
export async function downloadAudioLibrary(directory, fetcher = fetch, bundledDirectory) {
  const files = [];
  for (const file of AUDIO_FILES) {
    if (matchesOriginal(await readAudioFile(directory, file), file)) continue;
    let bytes = await readAudioFile(bundledDirectory, file);
    if (!matchesOriginal(bytes, file)) {
      const response = await fetcher(file.sourceUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`下载失败：${file.label}，请检查网络后重试。`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (!matchesOriginal(bytes, file))
      throw new Error(`音频校验失败：${file.label}，本机音效未被覆盖。`);
    files.push([file, bytes]);
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [file, bytes] of files) {
    const target = path.join(directory, file.localFile);
    await fs.writeFile(target + '.tmp', bytes, { mode: 0o600 });
    await fs.rename(target + '.tmp', target);
  }
  const status = await verifyAudioLibrary(directory);
  if (!status.complete) throw new Error('原声音效修复后校验失败，请重试。');
  return status;
}
