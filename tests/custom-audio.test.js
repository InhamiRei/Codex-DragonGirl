import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { importAudioClip, listAudioClips, renameAudioClip, resolveCustomAudio } from '../src/core/custom-audio-store.js';
import { downloadAudioLibrary } from '../src/core/audio-library-store.js';
import { SettingsStore } from '../src/core/settings.js';
import { encodeClip } from '../src/shared/audio-clip.js';
import { audioUrl } from '../src/shared/audio-library.js';

// 两个声道在指定位置播放相反的样本，以检查裁剪边界、声道顺序和 PCM 精度。
function fixtureClip() {
  const left = new Float32Array(8000), right = new Float32Array(8000);
  left[31] = 0.9;
  left[32] = 0.5;
  right[32] = -0.5;
  return encodeClip({ sampleRate: 8000, length: 8000, numberOfChannels: 2,
    getChannelData: (channel) => channel ? right : left }, 32 / 8000, 432 / 8000);
}

// 每次验收都使用临时用户目录，可安全测试跨版本恢复及写入失败。
async function profile(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘音效升级-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('精确裁剪、并行同名导入、修复、迁移和重启保留片段及分配', async (t) => {
  const root = await profile(t), directory = path.join(root, 'sound-library');
  const bytes = fixtureClip(), wav = Buffer.from(bytes);
  assert.equal(wav.length, 44 + 400 * 4);
  assert.equal(wav.readInt16LE(44), 16384);
  assert.equal(wav.readInt16LE(46), -16384);
  const [a, b] = await Promise.all([1, 2].map(() => importAudioClip(directory, { bytes, label: '同名片段' })));
  assert.notEqual(a.id, b.id);
  assert.equal(a.duration, 0.05);
  await renameAudioClip(directory, a.id, '轻声');
  const store = new SettingsStore(root);
  const saved = await store.save({ soundTheme: 'fx1', eventSounds: { press: a.id, complete: b.id } });
  assert.equal(saved.eventSounds.release, 'd2');
  await downloadAudioLibrary(path.join(root, 'assets'), () => { throw new Error('禁止联网'); }, path.resolve('assets/audio'));
  const restored = await new SettingsStore(root).load();
  assert.deepEqual(restored, saved);
  const catalog = await listAudioClips(directory);
  assert.equal(catalog.length, 2);
  assert.equal(catalog.find((clip) => clip.id === a.id).label, '轻声');
  for (const clip of catalog) assert.deepEqual(await fs.readFile(await resolveCustomAudio(directory, clip.id)), wav);
  await store.save({});
  assert.deepEqual(await listAudioClips(directory), catalog);
});

test('无效或中断的导入不会替换已保存的音效，单段说明损坏仍能恢复播放', async (t) => {
  const directory = await profile(t), bytes = fixtureClip();
  const { id } = await importAudioClip(directory, { label: '保留', bytes });
  await assert.rejects(importAudioClip(directory, { label: '无效', bytes: bytes.slice(0, 44) }));
  const corrupt = bytes.slice();
  corrupt[20] = 3;
  await assert.rejects(importAudioClip(directory, { label: '错误编码', bytes: corrupt }));
  await assert.rejects(importAudioClip(directory, { label: '   ', bytes }));
  await fs.mkdir(path.join(directory, '.import-interrupted'));
  await fs.writeFile(path.join(directory, id, 'info.json'), '{');
  const [clip] = await listAudioClips(directory);
  assert.equal(clip.id, id);
  assert.equal(clip.available, true);
  await renameAudioClip(directory, id, '恢复的名称');
  assert.equal((await listAudioClips(directory))[0].label, '恢复的名称');
  assert.deepEqual(await fs.readFile(await resolveCustomAudio(directory, id)), Buffer.from(bytes));
  assert.equal(audioUrl(id), `dragon://app/sound-library/${id}.wav`);
  for (const bad of ['../settings.json', 'clip-../escape', id + '.wav', '/tmp/file']) {
    assert.equal(audioUrl(bad), null);
    assert.equal(await resolveCustomAudio(directory, bad), null);
  }
});
