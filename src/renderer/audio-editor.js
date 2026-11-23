import { clipFrames, encodeClip } from '../shared/audio-clip.js';

// 通过固定编号取得裁剪器控件。
const $ = (id) => document.getElementById(id);
// 将指针位置与选区边界约束在音频的时间范围内。
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 每根波形柱对应全曲的一段采样，拖动选区时复用各声道的峰值。
function waveformPeaks(buffer, count) {
  const peaks = new Float32Array(count);
  let maximum = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let block = 0; block < peaks.length; block++) {
      const first = Math.floor(block * samples.length / count);
      const end = Math.max(first + 1, Math.floor((block + 1) * samples.length / count));
      let peak = peaks[block];
      for (let frame = first; frame < end; frame++) peak = Math.max(peak, Math.abs(samples[frame]));
      peaks[block] = peak;
      maximum = Math.max(maximum, peak);
    }
  }
  return { peaks, maximum };
}

// 按固定采样率解码以保持跨设备一致；环绕声按 Web Audio 的扬声器布局混合成立体声。
async function decodeSource(bytes) {
  const decoded = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(bytes);
  if (decoded.numberOfChannels <= 2) return decoded;
  const mixer = new OfflineAudioContext(2, decoded.length, decoded.sampleRate);
  const source = mixer.createBufferSource();
  source.buffer = decoded;
  source.connect(mixer.destination);
  source.start();
  return mixer.startRendering();
}

// 波形、精确时间输入、试听与最终写盘共享同一份选区。
export class AudioEditor {
  // 对话框只绑定一次事件，关闭后释放当前录音和系统音频设备。
  constructor({ save, saved, volume }) {
    this.save = save;
    this.saved = saved;
    this.volume = volume;
    this.dialog = $('audio-editor');
    this.wave = $('audio-wave');
    this.canvas = this.wave.querySelector('canvas');
    this.handles = [...this.wave.querySelectorAll('[data-edge]')];
    this.token = 0;
    for (const id of ['audio-cancel', 'audio-editor-close']) $(id).onclick = () => this.dialog.close();
    this.dialog.addEventListener('cancel', (event) => { if (this.saving) event.preventDefault(); });
    this.dialog.addEventListener('close', () => this.release());
    $('audio-preview').onclick = () => void this.preview().catch(() => {
      this.stopPreview();
      this.message('无法使用音频设备。', true);
    });
    $('audio-save').onclick = () => void this.commit();
    $('audio-clip-name').oninput = () => this.validate();
    for (const edge of ['start', 'end']) $('audio-' + edge).oninput = () => this.readTimes();
    this.wave.onpointerdown = (event) => this.beginDrag(event);
    this.wave.onpointermove = (event) => this.dragTo(event);
    this.wave.onpointerup = (event) => this.endDrag(event);
    this.wave.onpointercancel = (event) => this.endDrag(event);
    for (const handle of this.handles) handle.onkeydown = (event) => this.moveHandle(event, handle.dataset.edge);
    new ResizeObserver(() => { if (this.buffer) this.draw(); }).observe(this.wave);
  }

  // 先显示载入状态，取消后迟到的解码结果不会写进下一次编辑。
  async open(label, read) {
    const token = ++this.token;
    this.buffer = this.envelope = null;
    this.invalidTimes = false;
    this.saving = false;
    $('audio-clip-name').value = label.slice(0, 80);
    $('audio-start').value = $('audio-end').value = '';
    this.wave.dataset.ready = 'false';
    for (const tick of this.dialog.querySelectorAll('.wave-ruler span')) tick.textContent = '';
    this.dialog.showModal();
    this.validate();
    this.message('正在读取音频…');
    try {
      const bytes = await read();
      if (token !== this.token || !this.dialog.open) return;
      const buffer = await decodeSource(bytes);
      if (token !== this.token || !this.dialog.open) return;
      if (!buffer.length) throw new Error();
      this.buffer = buffer;
      // 打开文件或再次裁剪时默认选中整段，波形始终覆盖原录音的完整时长。
      this.start = 0;
      this.end = buffer.duration;
      this.wave.dataset.ready = 'true';
      this.sync();
      $('audio-clip-name').focus();
      $('audio-clip-name').select();
    } catch {
      if (token === this.token) this.message('无法解码此文件，请选择可播放的音频。', true);
    }
  }

  // 编辑器关闭时撤销试听、异步结果和大缓冲，即使用户在解码途中取消也可重新导入。
  release() {
    this.token++;
    this.stopPreview();
    if (this.context) void this.context.close().catch(() => {});
    this.context = this.buffer = this.envelope = this.drag = null;
  }

  // 波形右上角同时承载选区时长和操作反馈，错误使用醒目的颜色。
  message(text, error = false) {
    const status = $('audio-selection-length');
    status.textContent = text;
    status.dataset.error = String(error);
  }

  // 只要选区包含有效采样就可试听，填好名称后即可保存整段或片段。
  validate() {
    const duration = this.buffer ? clipFrames(this.buffer, this.start, this.end).duration : 0;
    const invalid = this.invalidTimes || duration <= 0;
    $('audio-preview').disabled = !this.buffer || this.saving || invalid;
    $('audio-save').disabled = $('audio-preview').disabled || !$('audio-clip-name').value.trim();
    for (const id of ['audio-start', 'audio-end', 'audio-clip-name'])
      $(id).disabled = !this.buffer || this.saving;
    for (const id of ['audio-editor-close', 'audio-cancel']) $(id).disabled = this.saving;
    if (!this.buffer) return;
    if (invalid) this.message('请在音频范围内选择有效的起止时间。', true);
    else this.message(this.saving ? '正在保存片段…' : `已选 ${duration.toFixed(3)} 秒`);
  }

  // 用实际采样帧保留文件末尾，输入栏以毫秒显示且可用键盘微调。
  sync(writeTimes = true) {
    this.stopPreview();
    this.invalidTimes = false;
    if (writeTimes) {
      $('audio-start').value = this.start.toFixed(3);
      $('audio-end').value = this.end.toFixed(3);
    }
    this.validate();
    this.draw();
  }

  // 输入未完成时保留文本和上一份有效波形，修正后再启用试听与保存。
  readTimes() {
    this.stopPreview();
    const start = $('audio-start').valueAsNumber, end = $('audio-end').valueAsNumber;
    if (!(start >= 0 && start < end && end <= this.buffer.duration + 0.0005)) {
      this.invalidTimes = true;
      this.validate();
      return;
    }
    this.start = start;
    this.end = Math.min(end, this.buffer.duration);
    this.sync(false);
  }

  // 以固定的全曲时间轴绘制波形、选区和刻度，窗口宽度改变后才重新计算峰值。
  draw() {
    const width = this.wave.clientWidth, height = this.wave.clientHeight;
    if (!width || !height || !this.buffer) return;
    const dpr = window.devicePixelRatio;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const duration = this.buffer.duration, count = Math.ceil(width / 3);
    if (this.envelope?.peaks.length !== count) this.envelope = waveformPeaks(this.buffer, count);
    for (let i = 0; i < count; i++) {
      const time = i / count * duration;
      const bar = Math.max(1, this.envelope.peaks[i] / (this.envelope.maximum || 1) * (height - 24));
      ctx.fillStyle = time >= this.start && time <= this.end ? '#7561ad' : '#bab8c6';
      ctx.fillRect(i / count * width, (height - bar) / 2, 2, bar);
    }
    const position = (time) => 100 * time / duration;
    const left = position(this.start), right = position(this.end);
    const selection = this.wave.querySelector('.wave-selection');
    selection.style.left = left + '%';
    selection.style.width = (right - left) + '%';
    // 整首歌中的短选区可能窄于一个把手，此时上下错开，两个边界都可以点到。
    const handleWidth = this.handles[0].offsetWidth;
    const handleX = (percent) => clamp(width * percent / 100, handleWidth / 2, width - handleWidth / 2);
    this.wave.classList.toggle('stacked-handles', handleX(right) - handleX(left) < handleWidth);
    for (const handle of this.handles) {
      const time = this[handle.dataset.edge], pos = position(time);
      handle.style.left = handleX(pos) + 'px';
      handle.setAttribute('aria-valuemin', '0');
      handle.setAttribute('aria-valuemax', this.buffer.duration.toFixed(3));
      handle.setAttribute('aria-valuenow', time.toFixed(3));
      handle.setAttribute('aria-valuetext', time.toFixed(3) + ' 秒');
    }
    this.dialog.querySelectorAll('.wave-ruler span').forEach((tick, i) => {
      tick.textContent = (duration * i / 2).toFixed(3) + ' s';
    });
  }

  // 波形左右边缘分别对应原音频起点和终点。
  timeAt(event) {
    const rect = this.wave.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / rect.width, 0, 1) * this.buffer.duration;
  }

  // 拖动空白或波形重选区间，拖动两端的把手只移动对应边界。
  beginDrag(event) {
    if (event.button !== 0 || !this.buffer || this.saving || this.drag) return;
    this.stopPreview();
    const edge = event.target.dataset.edge, anchor = this.timeAt(event);
    this.drag = { id: event.pointerId, edge, anchor, offset: edge ? this[edge] - anchor : 0 };
    this.wave.setPointerCapture(event.pointerId);
  }

  // 捕获本次指针，离开波形仍可向两端拖到原录音边界。
  dragTo(event) {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const time = this.timeAt(event);
    if (this.drag.edge) {
      // 从按住的位置连续移动边界，拖到波形两端时精确对齐文件的首尾。
      const atBoundary = time === 0 || time === this.buffer.duration;
      this.setEdge(this.drag.edge, atBoundary ? time : time + this.drag.offset);
    }
    else {
      this.start = Math.min(time, this.drag.anchor);
      this.end = Math.max(time, this.drag.anchor);
      this.sync();
    }
  }

  // 指针释放后结束手势，保留最后一次明确选取的区间。
  endDrag(event) {
    if (this.drag?.id === event.pointerId) this.drag = null;
  }

  // 单个把手不可越过另一端，最小可选区间为一个采样帧。
  setEdge(edge, time) {
    const step = 1 / this.buffer.sampleRate;
    if (edge === 'start') this.start = clamp(time, 0, Math.max(0, this.end - step));
    else this.end = clamp(time, Math.min(this.buffer.duration, this.start + step), this.buffer.duration);
    this.sync();
  }

  // 方向键以毫秒移动，按住 Shift 可一次移动十分之一秒。
  moveHandle(event, edge) {
    if (!this.buffer || this.saving || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const delta = (event.shiftKey ? 0.1 : 0.001) * (event.key === 'ArrowLeft' ? -1 : 1);
    const time = event.key === 'Home' ? 0 : event.key === 'End' ? this.buffer.duration : this[edge] + delta;
    this.setEdge(edge, time);
  }

  // 试听只播放将要保存的采样范围，使用总音量并实时标出播放位置。
  async preview() {
    if (this.source) { this.stopPreview(); return; }
    this.context ??= new AudioContext();
    const ctx = this.context, source = ctx.createBufferSource(), gain = ctx.createGain();
    this.source = source;
    source.buffer = this.buffer;
    gain.gain.value = this.volume();
    source.connect(gain).connect(ctx.destination);
    const { first, duration } = clipFrames(this.buffer, this.start, this.end);
    const offset = first / this.buffer.sampleRate;
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      if (this.source === source) this.stopPreview();
    };
    await ctx.resume();
    if (this.source !== source) return;
    const at = ctx.currentTime;
    source.start(at, offset, duration);
    $('audio-preview').textContent = '停止试听';
    const head = this.wave.querySelector('.wave-playhead');
    // 用音频时钟把当前采样位置映射到整段录音的波形上。
    const tick = () => {
      const fraction = (offset + ctx.currentTime - at) / this.buffer.duration;
      head.hidden = fraction < 0 || fraction > 1;
      head.style.left = 100 * fraction + '%';
      this.animation = requestAnimationFrame(tick);
    };
    tick();
  }

  // 取消、重新选择和保存均立即停止旧试听。
  stopPreview() {
    cancelAnimationFrame(this.animation);
    if (this.source) {
      const source = this.source;
      this.source = null;
      try { source.stop(); } catch {}
    }
    this.wave.querySelector('.wave-playhead').hidden = true;
    $('audio-preview').textContent = '试听选区';
  }

  // 保存失败保留波形和选区供重试，成功后只刷新音效库。
  async commit() {
    if ($('audio-save').disabled || this.saving) return;
    this.stopPreview();
    this.saving = true;
    this.validate();
    try {
      const bytes = encodeClip(this.buffer, this.start, this.end);
      const clip = await this.save({ label: $('audio-clip-name').value.trim(), bytes });
      this.dialog.close();
      this.saved(clip);
    } catch (error) {
      this.saving = false;
      this.validate();
      this.message(error.message || '片段保存失败，请重试。', true);
    }
  }
}
