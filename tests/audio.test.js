import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { SoundEngine } from '../src/renderer/audio.js';
import { AUDIO_FILES, AUDIO_GROUPS, eventAudioId } from '../src/shared/audio-library.js';
import { normalizeSettings } from '../src/core/settings.js';
import { verifyAudioLibrary } from '../src/core/audio-library-store.js';

// 测试音频时钟记录真实的节点起止与增益参数，不调用系统扬声器。
class TestContext {
  // 初始化可手动推进的音频线程时间。
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    this.sources = [];
    this.resumes = 0;
  }
  // 测试不需要设备挂起定时器。
  startRendering() {}
  // 记录音频节点的排期及播放速率，禁止依赖合成振荡器。
  createBufferSource() {
    const node = {
      buffer: null,
      starts: [],
      stops: [],
      playbackRate: { value: 1 },
      connect() {},
      disconnect() {},
      start(at) {
        this.starts.push(at);
      },
      stop(at) {
        this.stops.push(at);
      },
    };
    this.sources.push(node);
    return node;
  }
  // 保留所有增益操作，以检测录音是否又被套上渐弱包络。
  createGain() {
    return {
      connect() {},
      disconnect() {},
      gain: {
        calls: [],
        setValueAtTime(...args) {
          this.calls.push(['value', ...args]);
        },
        setTargetAtTime(...args) {
          this.calls.push(['target', ...args]);
        },
        cancelScheduledValues(...args) {
          this.calls.push(['cancel', ...args]);
        },
      },
    };
  }
  // 异步解码由测试提供的缓冲数据完成。
  async decodeAudioData() {
    return { duration: 0.6 };
  }
  // 验证从长时间按住后的休眠状态恢复。
  async resume() {
    this.state = 'running';
    this.resumes++;
  }
}

// 用预热缓冲构建播放器，测试过程不读取用户的配置或素材。
function player() {
  const context = new TestContext();
  let now = 0;
  const engine = new SoundEngine({ createContext: () => context, now: () => now });
  engine.settings = normalizeSettings();
  engine.ctx = context;
  for (const file of AUDIO_FILES)
    engine.buffers.set(file.id, { duration: file.id === 'ya1' ? 0.6 : 0.4 });
  return {
    engine,
    context,
    tick(seconds) {
      context.currentTime = seconds;
      now = seconds * 1000;
    },
  };
}

// 素材清单严格等于原项目的九个文件，原始二进制摘要逐一核对。
test('音效库只有原项目的两组点击和九个原文件', async () => {
  assert.equal(AUDIO_GROUPS.length, 2);
  assert.equal(AUDIO_FILES.length, 9);
  assert.equal(new Set(AUDIO_FILES.map((f) => f.localFile)).size, 9);
  for (const file of AUDIO_FILES) {
    const bytes = await fs.readFile(path.join('.artifacts/reference-audio', file.sourceFile));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
});

// 旧版自制音色自动迁移到小黄鸭，其他偏好与用户非默认音量保留。
test('旧音色迁移为原声且没有额外音频选项', () => {
  const settings = normalizeSettings({
    soundTheme: 'crystal',
    volume: 0.22,
    eventVolumes: { press: 0.65, release: 0.5, complete: 0.8 },
  });
  assert.equal(settings.soundTheme, 'duck');
  assert.equal(settings.volume, 0.22);
  assert.equal(settings.eventVolumes.press, 1);
  assert.equal(settings.eventVolumes.release, 1);
  assert.equal(eventAudioId('press', settings), 'ya1');
  assert.equal(eventAudioId('release', { ...settings, soundTheme: 'fx1' }), 'd2');
  assert.equal(
    normalizeSettings({ eventSounds: { complete: 'not-a-clip' } }).eventSounds.complete,
    'cost_a',
  );
});

// 暖缓存的按下同步起播；短点击松开音提前四十毫秒进入，而不是截断前半段。
test('快速点击使用原声并在音频时间轴正确衔接', async () => {
  const { engine, context, tick } = player();
  const down = engine.play('press');
  assert.equal(context.sources.length, 1);
  await down;
  tick(0.1);
  await engine.play('release');
  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[0].starts[0], 0);
  assert.ok(Math.abs(context.sources[1].starts[0] - 0.56) < 1e-9);
  assert.deepEqual(context.sources[0].stops, []);
  assert.equal([...engine.active][0].node.playbackRate.value, 1);
  assert.deepEqual([...engine.active][0].gain.gain.calls, [['value', 0.35, 0]]);
});

// 按下录音结束之后松手，松开音立即播放，不等待另一轮排期。
test('长按与重复松开不会产生重复声音', async () => {
  const { engine, context, tick } = player();
  await engine.play('press');
  tick(2);
  await engine.play('release');
  await engine.play('release');
  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[1].starts[0], 2);
});

// 拖动取消会停止未来松开音，但不打断任务提示。
test('取消手势清理交互排期并保留任务提示', async () => {
  const { engine, context, tick } = player();
  await engine.play('complete');
  await engine.play('press');
  tick(0.1);
  await engine.play('release');
  engine.cancelInteraction();
  assert.deepEqual(context.sources[0].stops, []);
  assert.ok(context.sources[1].stops.length);
  assert.ok(context.sources[2].stops.length);
  assert.equal([...engine.active].filter((v) => v.channel === 'interaction').length, 0);
});

// 新点击替换上一轮，不因连续点击积累待播放的松开声。
test('连点始终只保留当前一对交互声音', async () => {
  const { engine, context, tick } = player();
  for (let i = 0; i < 30; i++) {
    tick(i * 0.05);
    await engine.play('press');
    await engine.play('release');
    assert.ok([...engine.active].filter((v) => v.channel === 'interaction').length <= 2);
  }
  assert.ok(context.sources.slice(0, -2).every((n) => n.stops.length));
});

// 同时预加载和点击只请求同一文件一次，取消后解码完成也不会补播。
test('冷加载共享请求且取消后不补叫', async () => {
  const context = new TestContext();
  let releaseFetch,
    count = 0;
  const response = new Promise((resolve) => (releaseFetch = resolve));
  const engine = new SoundEngine({
    createContext: () => context,
    fetchFile: () => {
      count++;
      return response;
    },
    now: () => 0,
  });
  engine.settings = normalizeSettings();
  const warm = engine.load('ya1');
  const click = engine.play('press');
  engine.cancelInteraction();
  releaseFetch({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  await Promise.all([warm, click]);
  assert.equal(count, 1);
  assert.equal(context.sources.length, 0);
});

// 播放过程中静音会取消已排期节点，不会从合成音回退继续发声。
test('静音停止原声及尚未触发的松开音', async () => {
  const { engine, context, tick } = player();
  await engine.play('press');
  tick(0.1);
  await engine.play('release');
  await engine.configure({ ...engine.settings, soundEnabled: false });
  assert.equal(engine.active.size, 0);
  assert.ok(context.sources.every((n) => n.stops.length));
  assert.equal(await engine.play('press'), false);
});

// 原声缺失的状态明确可见，错误路径不会生成替代声音。
test('本机音效缺失时报告不足而不增加音色', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-audio-missing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const status = await verifyAudioLibrary(directory);
  assert.equal(status.installed, 0);
  assert.equal(status.missing.length, 9);
  assert.equal(status.complete, false);
  const engine = new SoundEngine({
    createContext: () => new TestContext(),
    fetchFile: async () => ({ ok: false }),
  });
  await engine.configure(normalizeSettings());
  assert.ok(engine.lastError);
  assert.equal(engine.played, 0);
});

// 持续按住超过空闲挂起时间后松手，仍会恢复设备并立即播放松开原声。
test('长时间按住后的松开会恢复已挂起音频设备', async () => {
  const { engine, context, tick } = player();
  context.startRendering = undefined;
  await engine.play('press');
  tick(20);
  context.state = 'suspended';
  await engine.play('release');
  assert.equal(context.resumes, 1);
  assert.equal(context.sources[1].starts[0], 20);
  engine.stop();
  clearTimeout(engine.idle);
});

// 下载过慢的交互音不在几秒后补播，及时完成后的下一次点击仍可使用缓存。
test('超时的冷加载交互丢弃，下一次点击使用已解码原声', async () => {
  const context = new TestContext();
  let now = 0,
    finish;
  const response = new Promise((resolve) => (finish = resolve));
  const engine = new SoundEngine({
    createContext: () => context,
    fetchFile: () => response,
    now: () => now,
  });
  engine.settings = normalizeSettings();
  const pending = engine.play('press');
  now = 500;
  finish({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  await pending;
  assert.equal(context.sources.length, 0);
  await engine.play('press');
  assert.equal(context.sources.length, 1);
});
