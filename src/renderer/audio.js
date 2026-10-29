import { AUDIO_FILES, audioFile, eventAudioId, RELEASE_LEAD_SECONDS } from '../shared/audio-library.js';

// 播放原项目的九段原声；不变调、不叠加合成音，也不改变录音自身的音量包络。
export class SoundEngine {
  // 音频设备和时钟可替换，便于验证同步起播、取消和音频线程排期。
  constructor({
    createContext = () => new AudioContext({ latencyHint: 'interactive' }),
    fetchFile = (url) => fetch(url),
    now = () => performance.now(),
  } = {}) {
    this.createContext = createContext;
    this.fetchFile = fetchFile;
    this.now = now;
    this.settings = {};
    this.buffers = new Map();
    this.pending = new Map();
    this.active = new Set();
    this.generation = 0;
    this.sequence = 0;
    this.played = 0;
    this.interaction = null;
  }

  // 选项变化时废弃旧排期，预热只下载并解码清单中已有的原音频。
  configure(settings) {
    const signature = JSON.stringify([settings.soundTheme, settings.eventSounds]);
    if (this.signature !== undefined && this.signature !== signature) this.stop();
    this.signature = signature;
    this.settings = settings;
    if (!settings.soundEnabled || settings.volume === 0) {
      this.stop();
      return Promise.resolve(false);
    }
    for (const voice of this.active) {
      voice.gain.gain.setTargetAtTime(this.volume(voice.event), this.ctx.currentTime, 0.008);
    }
    return this.warm();
  }

  // 独立缓存加载中的承诺，连续点击或多个配置更新不会重复读取相同文件。
  load(id) {
    const file = audioFile(id);
    if (!file) return Promise.reject(new Error('音频不在原声音效库中'));
    if (this.buffers.has(id)) return Promise.resolve(this.buffers.get(id));
    if (this.pending.has(id)) return this.pending.get(id);
    const loading = this.fetchFile(`dragon://app/user-assets/${file.localFile}`)
      .then((response) => {
        if (!response.ok) throw new Error('本机原声音效文件缺失');
        return response.arrayBuffer();
      })
      .then((bytes) => this.context(false).decodeAudioData(bytes))
      .then((buffer) => {
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 15)
          throw new Error('原声音频格式无效');
        this.buffers.set(id, buffer);
        this.lastError = null;
        return buffer;
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, loading);
    return loading;
  }

  // 预热全部九段音频；失败会留下明确状态，绝不回退成其他电子音。
  warm() {
    if (this.warming) return this.warming;
    this.warming = Promise.all(AUDIO_FILES.map((file) => this.load(file.id)))
      .then(() => true)
      .catch(() => {
        this.lastError = '原声音效未就绪，请检查本机音效库';
        return false;
      })
      .finally(() => {
        this.warming = null;
      });
    return this.warming;
  }

  // 只有播放时恢复设备，空闲时主动交还系统音频资源。
  context(activate = true) {
    this.ctx ??= this.createContext();
    if (activate && this.ctx.state === 'suspended' && typeof this.ctx.startRendering !== 'function')
      void this.ctx.resume().catch(() => {});
    clearTimeout(this.idle);
    if (typeof this.ctx.startRendering !== 'function') {
      this.idle = setTimeout(() => {
        if (this.active.size === 0) void this.ctx.suspend().catch(() => {});
      }, 15000);
      this.idle.unref?.();
    }
    return this.ctx;
  }

  // 保留用户的总音量和事件音量，录音内的强弱变化不再被渐弱包络覆盖。
  volume(event) {
    return (
      Math.max(0, Math.min(1, this.settings.volume ?? 0.35)) *
      Math.max(0, Math.min(1, this.settings.eventVolumes?.[event] ?? 1))
    );
  }

  // 已预热的音频同步开始，未预热时只接受仍有效且未过时的请求。
  readyBuffer(id, requestedAt, valid, start) {
    if (this.buffers.has(id)) {
      if (valid()) return Promise.resolve(start(this.buffers.get(id)));
      return Promise.resolve(false);
    }
    return this.load(id)
      .then((buffer) => {
        if (!valid() || this.now() - requestedAt > 250) return false;
        return start(buffer);
      })
      .catch(() => {
        this.lastError = '原声音效无法播放，请检查本机音效库';
        return false;
      });
  }

  // 开始新的按压时取消上一轮声音，只保留当前手势的成对原声。
  beginPress() {
    this.cancelInteraction();
    const session = {
      id: ++this.sequence,
      generation: this.generation,
      press: eventAudioId('press', this.settings),
      release: eventAudioId('release', this.settings),
      requestedAt: this.now(),
      released: false,
      releaseScheduled: false,
      ready: false,
    };
    this.interaction = session;
    this.context();
    const valid = () =>
      this.interaction === session &&
      this.generation === session.generation &&
      !!this.settings.soundEnabled;
    return this.readyBuffer(session.press, session.requestedAt, valid, (buffer) => {
      session.ready = true;
      if (this.volume('press') > 0)
        session.voice = this.startBuffer(
          session.press,
          buffer,
          'press',
          this.ctx.currentTime,
          'interaction',
        );
      if (session.released) void this.scheduleRelease(session);
      return true;
    });
  }

  // 松开音在按压音结束前四十毫秒衔接；长按超过录音长度后则立即播放。
  scheduleRelease(session) {
    if (!session.ready || session.releaseScheduled || this.interaction !== session)
      return Promise.resolve(false);
    session.releaseScheduled = true;
    if (this.volume('release') === 0) return Promise.resolve(false);
    const requestedAt = this.now();
    const startAt = Math.max(
      this.ctx.currentTime,
      (session.voice?.endsAt ?? this.ctx.currentTime) - RELEASE_LEAD_SECONDS,
    );
    const valid = () =>
      this.interaction === session &&
      this.generation === session.generation &&
      !!this.settings.soundEnabled;
    return this.readyBuffer(session.release, requestedAt, valid, (buffer) =>
      this.startBuffer(
        session.release,
        buffer,
        'release',
        Math.max(this.ctx.currentTime, startAt),
        'interaction',
      ),
    );
  }

  // 点击交互、提示和试听使用独立通道，拖动不会打断正在播放的任务提示。
  play(event, preview = false) {
    if (!this.settings.soundEnabled && !preview) return Promise.resolve(false);
    const id = eventAudioId(event, this.settings);
    if (!id) return Promise.resolve(false);
    if (!preview && event === 'press') return this.beginPress();
    if (!preview && event === 'release') {
      this.context();
      if (!this.interaction || this.interaction.released) return Promise.resolve(false);
      this.interaction.released = true;
      return this.scheduleRelease(this.interaction);
    }
    if (this.volume(event) === 0) return Promise.resolve(false);
    const channel = preview ? 'preview' : 'notice';
    this.stopChannel(channel);
    const generation = this.generation,
      request = ++this.sequence,
      at = this.now();
    this[channel + 'Request'] = request;
    this.context();
    return this.readyBuffer(
      id,
      at,
      () => generation === this.generation && this[channel + 'Request'] === request,
      (buffer) => this.startBuffer(id, buffer, event, this.ctx.currentTime, channel),
    );
  }

  // 原录音按正常速率和完整长度播放，仅施加用户选择的线性音量。
  startBuffer(id, buffer, event, startAt, channel) {
    const node = this.ctx.createBufferSource(),
      gain = this.ctx.createGain();
    node.buffer = buffer;
    gain.gain.setValueAtTime(this.volume(event), startAt);
    node.connect(gain);
    gain.connect(this.ctx.destination);
    const voice = {
      id,
      node,
      gain,
      event,
      channel,
      startsAt: startAt,
      endsAt: startAt + buffer.duration,
    };
    this.active.add(voice);
    node.onended = () => {
      node.disconnect();
      gain.disconnect();
      this.active.delete(voice);
    };
    node.start(startAt);
    this.played++;
    return voice;
  }

  // 取消时短淡出避免爆音，同时停止尚未到时间的声音，禁止松手后补播。
  stopChannel(channel) {
    if (!this.ctx) return;
    for (const voice of this.active)
      if (voice.channel === channel) {
        try {
          const now = this.ctx.currentTime;
          voice.gain.gain.cancelScheduledValues(now);
          voice.gain.gain.setTargetAtTime(0, now, 0.003);
          voice.node.stop(now + 0.008);
        } catch {}
        this.active.delete(voice);
      }
  }

  // 只取消当前手势的排期，任务结束音与试听不受拖动干扰。
  cancelInteraction() {
    this.interaction = null;
    this.stopChannel('interaction');
  }

  // 静音、切换音效或退出时废弃全部异步请求和已排期节点。
  stop() {
    this.generation++;
    this.interaction = null;
    for (const channel of ['interaction', 'notice', 'preview']) this.stopChannel(channel);
  }
}
