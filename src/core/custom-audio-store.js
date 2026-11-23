import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isCustomAudioId } from '../shared/audio-library.js';

// 主进程独立核验裁剪器提交的标准 PCM 头和实际帧数，时长由音频字节计算。
function readClipDuration(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength <= 44)
    throw new Error('片段没有有效的 WAV 音频数据。');
  const wav = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = wav.readUInt16LE(22), rate = wav.readUInt32LE(24);
  const frameBytes = channels * 2, size = wav.length - 44;
  if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.readUInt32LE(4) !== wav.length - 8 ||
      wav.toString('latin1', 8, 16) !== 'WAVEfmt ' || wav.readUInt32LE(16) !== 16 ||
      wav.readUInt16LE(20) !== 1 || ![1, 2].includes(channels) || rate < 8000 || rate > 96000 ||
      wav.readUInt32LE(28) !== rate * frameBytes || wav.readUInt16LE(32) !== frameBytes ||
      wav.readUInt16LE(34) !== 16 || wav.toString('latin1', 36, 40) !== 'data' ||
      wav.readUInt32LE(40) !== size || size % frameBytes !== 0)
    throw new Error('片段不是有效的 PCM WAV 音频。');
  return size / (rate * frameBytes);
}

// 名称仅用作界面文本，允许同名片段和中文名称。
function clipLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label || label.length > 80) throw new Error('请输入 1–80 个字符的音效名称。');
  return label;
}

// 每段音效拥有独立目录。一次原子重命名同时提交声音与名称，中断导入不影响已有片段。
export async function importAudioClip(directory, { label, bytes }) {
  const id = 'clip-' + randomUUID().replaceAll('-', '');
  const info = { version: 1, label: clipLabel(label), duration: readClipDuration(bytes), createdAt: Date.now() };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const pending = await fs.mkdtemp(path.join(directory, '.import-'));
  try {
    await fs.writeFile(path.join(pending, 'clip.wav'), bytes, { mode: 0o600, flush: true });
    await fs.writeFile(path.join(pending, 'info.json'), JSON.stringify(info), { mode: 0o600, flush: true });
    await fs.rename(pending, path.join(directory, id));
  } catch (error) {
    await fs.rm(pending, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { id, ...info };
}

// 只解析固定编号下的普通 WAV 文件，不跟随导入目录或音频文件的符号链接。
export async function resolveCustomAudio(directory, id) {
  if (!isCustomAudioId(id)) return null;
  const folder = path.join(directory, id);
  const file = path.join(folder, 'clip.wav');
  try {
    return (await fs.lstat(folder)).isDirectory() && (await fs.lstat(file)).isFile() ? file : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// 说明文件缺失或损坏时保留可播放的 WAV，重命名时也可重新生成这份说明。
async function readClipInfo(directory, id) {
  try {
    const info = JSON.parse(await fs.readFile(path.join(directory, id, 'info.json'), 'utf8'));
    return info && typeof info === 'object' && !Array.isArray(info) ? info : {};
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

// 从独立记录重建音效列表，单个名称文件损坏时仍可找到和播放其音频。
export async function listAudioClips(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const clips = await Promise.all(entries.filter((entry) => entry.isDirectory() && isCustomAudioId(entry.name))
    .map(async ({ name: id }) => {
      const info = await readClipInfo(directory, id);
      return {
        id, label: typeof info.label === 'string' && info.label.trim() ? info.label : `导入片段 · ${id.slice(-6)}`,
        duration: Number.isFinite(info.duration) ? info.duration : null,
        createdAt: Number.isFinite(info.createdAt) ? info.createdAt : 0,
        available: Boolean(await resolveCustomAudio(directory, id)),
      };
    }));
  return clips.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

// 重命名只原子替换这一段的说明文件，已有的分配和音频字节保持可用。
export async function renameAudioClip(directory, id, value) {
  const label = clipLabel(value);
  if (!await resolveCustomAudio(directory, id)) throw new Error('找不到要重命名的音效。');
  const target = path.join(directory, id, 'info.json');
  const info = await readClipInfo(directory, id);
  const pending = target + '.' + randomUUID();
  try {
    await fs.writeFile(pending, JSON.stringify({ version: 1, ...info, label }), { mode: 0o600, flush: true });
    await fs.rename(pending, target);
  } finally {
    await fs.rm(pending, { force: true });
  }
}
