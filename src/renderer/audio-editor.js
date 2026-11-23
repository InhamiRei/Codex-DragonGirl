import { clipFrames, encodeClip } from '../shared/audio-clip.js';
import { MAX_CLIP_SECONDS } from '../shared/audio-library.js';

// 编辑器的控件由固定编号引用，时间和视窗坐标统一限制在给定区间。
const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const PEAK_BLOCK = 128;

// 索引每一小段中所有声道的最大振幅，缩放和拖动时只需重画当前视窗。
function waveformPeaks(buffer) {
  const peaks = new Float32Array(Math.ceil(buffer.length / PEAK_BLOCK));
  let maximum = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let block = 0; block < peaks.length; block++) {
      const end = Math.min(samples.length, (block + 1) * PEAK_BLOCK);
      let peak = peaks[block];
      for (let frame = block * PEAK_BLOCK; frame < end; frame++) peak = Math.max(peak, Math.abs(samples[frame]));
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
      this.message('无法使用音频设备。');
    });
    $('audio-save').onclick = () => void this.commit();
    $('audio-clip-name').oninput = () => this.validate();
    for (const edge of ['start', 'end']) $('audio-' + edge).oninput = () => this.readTimes(edge);
    $('audio-zoom').oninput = () => this.zoom();
    $('audio-pan').oninput = () => {
      this.offset = Number($('audio-pan').value) * (this.buffer.duration - this.span);
      this.draw();
    };
    this.wave.onpointerdown = (event) => this.beginDrag(event);
    this.wave.onpointermove = (event) => this.dragTo(event);
    this.wave.onpointerup = (event) => this.endDrag(event);
    this.wave.onpointercancel = (event) => this.endDrag(event);
    for (const handle of this.handles) handle.onkeydown = (event) => this.moveHandle(event, handle.dataset.edge);
    new ResizeObserver(() => { if (this.buffer) this.draw(); }).observe(this.wave);
  }

  // 先显示载入状态，取消后迟到的解码结果不会写进下一次编辑。
  async open(sourceName, label, read) {
    const token = ++this.token;
    this.buffer = null;
    this.invalidTimes = false;
    this.saving = false;
    $('audio-source-name').textContent = sourceName;
    $('audio-clip-name').value = label.slice(0, 80);
    $('audio-start').value = $('audio-end').value = '';
    $('audio-zoom').value = '0';
    $('audio-zoom-value').textContent = '1×';
    $('audio-pan-row').hidden = true;
    $('audio-selection-length').textContent = '';
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
      this.envelope = waveformPeaks(buffer);
      this.start = this.offset = 0;
      this.span = buffer.duration;
      this.end = Math.min(buffer.duration, MAX_CLIP_SECONDS);
      this.wave.dataset.ready = 'true';
      this.sync();
      $('audio-clip-name').focus();
      $('audio-clip-name').select();
    } catch {
      if (token === this.token) this.message('无法解码此文件，请选择可播放的 WAV、MP3、M4A、OGG 或 FLAC 音频。');
    }
  }

  // 编辑器关闭时撤销试听、异步结果和大缓冲，即使用户在解码途中取消也可重新导入。
  release() {
    this.token++;
    this.stopPreview();
    if (this.context) void this.context.close().catch(() => {});
    this.context = this.buffer = this.envelope = this.drag = null;
  }

  // 状态保留稳定高度，加载错误或无效选区都能就地看到。
  message(text) {
    $('audio-editor-message').textContent = text;
  }

  // 只有已命名、有实际采样且符合时长的选区才可保存。
  validate() {
    const duration = this.buffer ? clipFrames(this.buffer, this.start, this.end).duration : 0;
    const invalid = this.invalidTimes || duration <= 0 || duration > MAX_CLIP_SECONDS;
    $('audio-preview').disabled = !this.buffer || this.saving || invalid;
    $('audio-save').disabled = $('audio-preview').disabled || !$('audio-clip-name').value.trim();
    for (const id of ['audio-zoom', 'audio-pan', 'audio-start', 'audio-end', 'audio-clip-name'])
      $(id).disabled = !this.buffer || this.saving;
    for (const id of ['audio-editor-close', 'audio-cancel']) $(id).disabled = this.saving;
    if (!this.buffer) return;
    $('audio-selection-length').textContent = `已选 ${duration.toFixed(3)} 秒`;
    const message = this.invalidTimes ? '开始时间须早于结束时间，且两者都在原音频范围内。'
      : (invalid ? `请选择大于 0 且不超过 ${MAX_CLIP_SECONDS} 秒的片段。` : `原音频 ${this.buffer.duration.toFixed(3)} 秒 · 片段最长 ${MAX_CLIP_SECONDS} 秒`);
    this.message(this.saving ? '正在保存片段…' : message);
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
  readTimes(edge) {
    this.stopPreview();
    const start = $('audio-start').valueAsNumber, end = $('audio-end').valueAsNumber;
    if (!(start >= 0 && start < end && end <= this.buffer.duration + 0.0005)) {
      this.invalidTimes = true;
      this.validate();
      return;
    }
    this.start = start;
    this.end = Math.min(end, this.buffer.duration);
    const time = this[edge];
    if (time < this.offset || time > this.offset + this.span) this.center(time);
    this.sync(false);
  }

  // 视窗围绕选区缩放，平移只改变可视范围。
  center(time) {
    this.offset = clamp(time - this.span / 2, 0, this.buffer.duration - this.span);
  }

  // 放大后用位置滑块浏览原录音的任意部分。
  zoom() {
    const factor = 2 ** Number($('audio-zoom').value);
    this.span = this.buffer.duration / factor;
    this.center((this.start + this.end) / 2);
    $('audio-zoom-value').textContent = Number(factor.toFixed(1)) + '×';
    $('audio-pan-row').hidden = factor === 1;
    this.draw();
  }

  // 取当前像素范围的峰值，高倍缩放时读取原始采样以显示极短的瞬态。
  peak(first, last) {
    let peak = 0;
    if (last - first >= PEAK_BLOCK) {
      for (let i = Math.floor(first / PEAK_BLOCK); i < Math.ceil(last / PEAK_BLOCK); i++)
        peak = Math.max(peak, this.envelope.peaks[i]);
    } else {
      for (let channel = 0; channel < this.buffer.numberOfChannels; channel++) {
        const samples = this.buffer.getChannelData(channel);
        for (let i = first; i < last; i++) peak = Math.max(peak, Math.abs(samples[i]));
      }
    }
    return peak;
  }

  // 以设备像素绘制可见波形，选区、两端把手与刻度共用同一时间坐标。
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
    const rate = this.buffer.sampleRate, limit = this.buffer.length;
    for (let x = 0; x < width; x += 3) {
      const time = this.offset + x / width * this.span;
      const first = Math.min(limit - 1, Math.floor(time * rate));
      const last = Math.min(limit, Math.max(first + 1, Math.floor((time + 3 / width * this.span) * rate)));
      const bar = Math.max(1, this.peak(first, last) / (this.envelope.maximum || 1) * (height - 24));
      ctx.fillStyle = time >= this.start && time <= this.end ? '#7561ad' : '#bab8c6';
      ctx.fillRect(x, (height - bar) / 2, 2, bar);
    }
    const position = (time) => 100 * (time - this.offset) / this.span;
    const left = position(this.start), right = position(this.end);
    const selection = this.wave.querySelector('.wave-selection');
    selection.style.left = clamp(left, 0, 100) + '%';
    selection.style.width = (clamp(right, 0, 100) - clamp(left, 0, 100)) + '%';
    for (const handle of this.handles) {
      const time = this[handle.dataset.edge], pos = position(time);
      handle.hidden = pos < -0.001 || pos > 100.001;
      handle.style.left = `clamp(7px, ${pos}%, calc(100% - 7px))`;
      handle.setAttribute('aria-valuemin', '0');
      handle.setAttribute('aria-valuemax', this.buffer.duration.toFixed(3));
      handle.setAttribute('aria-valuenow', time.toFixed(3));
      handle.setAttribute('aria-valuetext', time.toFixed(3) + ' 秒');
    }
    this.dialog.querySelectorAll('.wave-ruler span').forEach((tick, i) => {
      tick.textContent = (this.offset + this.span * i / 2).toFixed(3) + ' s';
    });
    const range = this.buffer.duration - this.span;
    $('audio-pan').value = range > 0 ? this.offset / range : 0;
    for (const id of ['audio-pan', 'audio-zoom']) {
      const slider = $(id);
      slider.style.setProperty('--range-progress', (100 * slider.value / slider.max) + '%');
    }
  }

  // 指针坐标限制在当前可见时间段内。
  timeAt(event) {
    const rect = this.wave.getBoundingClientRect();
    return this.offset + clamp((event.clientX - rect.left) / rect.width, 0, 1) * this.span;
  }

  // 拖动空白或波形重选区间，拖动两端的把手只移动对应边界。
  beginDrag(event) {
    if (event.button !== 0 || !this.buffer || this.saving || this.drag) return;
    this.stopPreview();
    this.drag = { id: event.pointerId, edge: event.target.dataset.edge, anchor: this.timeAt(event) };
    this.wave.setPointerCapture(event.pointerId);
  }

  // 捕获本次指针，离开波形仍可向两端拖到原录音边界。
  dragTo(event) {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const time = this.timeAt(event);
    if (this.drag.edge) this.setEdge(this.drag.edge, time);
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
    if (this[edge] < this.offset || this[edge] > this.offset + this.span) {
      this.center(this[edge]);
      this.draw();
    }
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
    // 播放位置取自音频时钟，缩放或平移视口后也能保持同步。
    const tick = () => {
      const fraction = (offset + ctx.currentTime - at - this.offset) / this.span;
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
      this.message(error.message || '片段保存失败，请重试。');
    }
  }
}
