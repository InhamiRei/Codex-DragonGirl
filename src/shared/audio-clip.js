// 片段统一存为无损 PCM WAV，试听与导出使用同一对采样帧边界。
export function clipFrames(buffer, start, end) {
  const first = Math.max(0, Math.min(buffer.length, Math.round(start * buffer.sampleRate)));
  const last = Math.max(first, Math.min(buffer.length, Math.round(end * buffer.sampleRate)));
  return { first, last, duration: (last - first) / buffer.sampleRate };
}

// 写入标准的 16 位小端 WAV，逐帧交错保存左右声道。
export function encodeClip(buffer, start, end) {
  const { first, last, duration } = clipFrames(buffer, start, end);
  const channels = buffer.numberOfChannels;
  if (!Number.isFinite(duration) || duration <= 0 || ![1, 2].includes(channels))
    throw new Error('请选择有效的音频片段。');
  const frameBytes = channels * 2;
  const dataBytes = (last - first) * frameBytes;
  // 标准 RIFF 头用四字节记录长度，在分配内存前检查格式能否表示整个选区。
  if (dataBytes + 36 > 0xffffffff) throw new Error('所选音频超出 WAV 文件容量，请缩短选区。');
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode('RIFF'), 0);
  view.setUint32(4, dataBytes + 36, true);
  bytes.set(encoder.encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * frameBytes, true);
  view.setUint16(32, frameBytes, true);
  view.setUint16(34, 16, true);
  bytes.set(encoder.encode('data'), 36);
  view.setUint32(40, dataBytes, true);
  for (let channel = 0; channel < channels; channel++) {
    const samples = buffer.getChannelData(channel);
    let offset = 44 + channel * 2;
    for (let frame = first; frame < last; frame++, offset += frameBytes) {
      const sample = Math.max(-1, Math.min(1, samples[frame]));
      view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
  }
  return bytes;
}
