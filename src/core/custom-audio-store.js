import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isCustomAudioId } from '../shared/audio-library.js';

// 主进程独立核验裁剪器提交的标准 PCM 头和实际帧数，时长由音频字节计算。
function readClipHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44)
    throw new Error('片段没有有效的 WAV 音频数据。');
  const wav = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = wav.readUInt16LE(22), rate = wav.readUInt32LE(24);
  const frameBytes = channels * 2, size = wav.readUInt32LE(40);
  if (wav.toString('latin1', 0, 4) !== 'RIFF' || !size || wav.readUInt32LE(4) !== size + 36 ||
      wav.toString('latin1', 8, 16) !== 'WAVEfmt ' || wav.readUInt32LE(16) !== 16 ||
      wav.readUInt16LE(20) !== 1 || ![1, 2].includes(channels) || rate < 8000 || rate > 96000 ||
      wav.readUInt32LE(28) !== rate * frameBytes || wav.readUInt16LE(32) !== frameBytes ||
      wav.readUInt16LE(34) !== 16 || wav.toString('latin1', 36, 40) !== 'data' ||
      size % frameBytes !== 0)
    throw new Error('片段不是有效的 PCM WAV 音频。');
  return { bytes: size + 44, duration: size / (rate * frameBytes) };
}

// 名称仅用作界面文本，允许同名片段和中文名称。
function clipLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label || label.length > 80) throw new Error('请输入 1–80 个字符的音效名称。');
  return label;
}

// 每段音效拥有独立目录。一次原子重命名同时提交声音与名称，中断导入不影响已有片段。
export async function importAudioClip(directory, { label, chunks }) {
  const id = 'clip-' + randomUUID().replaceAll('-', '');
  const name = clipLabel(label);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const pending = await fs.mkdtemp(path.join(directory, '.import-'));
  try {
    const file = await fs.open(path.join(pending, 'clip.wav'), 'wx', 0o600);
    let header, written = 0;
    try {
      for await (const chunk of chunks) {
        header ??= readClipHeader(chunk);
        if (!(chunk instanceof Uint8Array) || !chunk.byteLength || written + chunk.byteLength > header.bytes)
          throw new Error('音效数据与 WAV 长度不符。');
        await file.writeFile(chunk);
        written += chunk.byteLength;
      }
      if (written !== header?.bytes) throw new Error('音效数据尚未完整接收。');
      await file.sync();
    } finally {
      await file.close();
    }
    const info = { version: 1, label: name, duration: header.duration, createdAt: Date.now() };
    await fs.writeFile(path.join(pending, 'info.json'), JSON.stringify(info), { mode: 0o600, flush: true });
    await fs.rename(pending, path.join(directory, id));
    return { id, ...info };
  } catch (error) {
    await fs.rm(pending, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

// 目录和文件可以在枚举后被用户移动，单独处理缺失并保留其他磁盘错误。
async function existingStat(file) {
  try { return await fs.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

// 所有修改先确认固定编号对应的真实目录，缺失 WAV 的记录也能由用户移到回收站。
export async function resolveClipFolder(directory, id) {
  if (!isCustomAudioId(id)) return null;
  const folder = path.join(directory, id);
  return (await existingStat(folder))?.isDirectory() ? folder : null;
}

// 只解析目录内的普通音频文件，不跟随符号链接。
async function clipFile(folder) {
  const file = path.join(folder, 'clip.wav');
  return (await existingStat(file))?.isFile() ? file : null;
}

// 播放地址只接受有效编号，在访问时同时核对目录与录音。
export async function resolveCustomAudio(directory, id) {
  const folder = await resolveClipFolder(directory, id);
  return folder ? clipFile(folder) : null;
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
  const folders = entries.filter((entry) => entry.isDirectory() && isCustomAudioId(entry.name));
  const clips = [];
  // 限制同时打开的说明文件数，大型音效库也不会耗尽文件描述符。
  for (let offset = 0; offset < folders.length; offset += 24) {
    const batch = await Promise.all(folders.slice(offset, offset + 24).map(async ({ name: id }) => {
      let info = {}, available = false;
      try {
        info = await readClipInfo(directory, id);
        available = Boolean(await clipFile(path.join(directory, id)));
      } catch (error) {
        if (!['EACCES', 'EPERM', 'ENOTDIR'].includes(error.code)) throw error;
      }
      return {
        id, label: typeof info.label === 'string' && info.label.trim() ? info.label : `导入片段 · ${id.slice(-6)}`,
        duration: Number.isFinite(info.duration) ? info.duration : null,
        createdAt: Number.isFinite(info.createdAt) ? info.createdAt : 0,
        available,
      };
    }));
    clips.push(...batch);
  }
  return clips.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

// 重命名只原子替换这一段的说明文件，已有的分配和音频字节保持可用。
export async function renameAudioClip(directory, id, value) {
  const label = clipLabel(value);
  if (!await resolveClipFolder(directory, id)) throw new Error('找不到要重命名的音效。');
  const target = path.join(directory, id, 'info.json');
  const info = await readClipInfo(directory, id);
  const pending = target + '.' + randomUUID();
  try {
    await fs.writeFile(pending, JSON.stringify({ version: 1, ...info, label }), { mode: 0o600, flush: true });
    await fs.rename(pending, target);
  } catch (error) {
    await fs.rm(pending, { force: true }).catch(() => {});
    throw error;
  }
}
