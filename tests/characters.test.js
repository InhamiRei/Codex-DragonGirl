import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHARACTERS, MARO_ASSET, MARO_HAIR_ASSETS, MARO_FRAME_SIZE, characterById, characterByAsset, hairFrameAt,
  hairNodAt, HAIR_FRAME_TIMES, HAIR_DURATION, HAIR_FRAME_DURATIONS,
  isCharacterMenuPoint } from '../src/shared/characters.js';
import { SettingsStore, normalizeSettings } from '../src/core/settings.js';
import { imagePoint } from '../src/shared/hit-test.js';

// 防止打包时误换成旧的低清网格或缺帧；首尾必须与用户确认的待机原图完全一致。
test('三十帧均为 1254 像素且循环首尾复用待机原图', async () => {
  assert.equal(MARO_FRAME_SIZE, 1254);
  assert.equal(MARO_HAIR_ASSETS.length, 30);
  const frames = await Promise.all(MARO_HAIR_ASSETS.map((url) =>
    fs.readFile(new URL('../' + url.replace('dragon://app/', ''), import.meta.url))));
  for (const frame of frames) {
    assert.equal(frame.subarray(1, 4).toString(), 'PNG');
    assert.equal(frame.readUInt32BE(16), 1254);
    assert.equal(frame.readUInt32BE(20), 1254);
    assert.equal(frame[25], 6, 'PNG 必须保留 RGBA 透明通道');
  }
  const idle = await fs.readFile(new URL('../assets/characters/maro/idle.png', import.meta.url));
  assert.ok(frames[0].equals(idle) && frames.at(-1).equals(idle));
});

// 旧配置仍使用龙娘，任意路径或损坏角色编号不能被当作内置资源。
test('内置角色选择兼容旧配置并拒绝任意路径', () => {
  assert.equal(normalizeSettings().characterId, 'dragon');
  assert.equal(normalizeSettings({ characterId: 'maro' }).characterId, 'maro');
  assert.equal(normalizeSettings({ characterId: '../../auth.json' }).characterId, 'dragon');
  assert.equal(characterById('maro').name, '麻吕');
  assert.equal(characterByAsset(MARO_ASSET).id, 'maro');
  assert.equal(characterByAsset('dragon://app/user-assets/123.png'), null);
  assert.equal(CHARACTERS.length, 2);
});

// 切换角色通过局部保存保留位置和音量，重启后仍读取到所选角色。
test('角色选择持久化而不覆盖其他用户偏好', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maro-settings-'));
  try {
    const store = new SettingsStore(directory);
    await store.save({ volume: 0.17, followOffsets: { '/tmp/codex': { x: 0.2, y: 0.7 } } });
    await store.save((current) => ({ ...current, characterId: 'maro', characterAsset: '' }));
    const saved = await new SettingsStore(directory).load();
    assert.equal(saved.characterId, 'maro');
    assert.equal(saved.volume, 0.17);
    assert.deepEqual(saved.followOffsets['/tmp/codex'], { x: 0.2, y: 0.7 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// 抬手、慢慢捋发和放手使用不同节奏；覆盖每一帧边界，卡顿也不回放过期帧。
test('捋发三十帧在五秒内按慢速节奏播放', () => {
  assert.equal(HAIR_DURATION, 5000);
  assert.equal(HAIR_FRAME_DURATIONS.length, 30);
  assert.equal(hairFrameAt(-1), 0);
  assert.equal(hairFrameAt(0), 0);
  let start = 0;
  for (let frame = 0; frame < 30; frame += 1) {
    assert.equal(hairFrameAt(start), frame);
    assert.equal(hairFrameAt(start + HAIR_FRAME_DURATIONS[frame] - 1), frame);
    start += HAIR_FRAME_DURATIONS[frame];
  }
  assert.ok(HAIR_FRAME_DURATIONS[12] > HAIR_FRAME_DURATIONS[3]);
  assert.equal(hairFrameAt(4999), 29);
  assert.equal(hairFrameAt(99999), 29);
});

// 正常低头允许头部运动，但第十八到十九帧不能突然归零，首尾必须回到原始待机位置。
test('低头和抬头渐入渐出且跨帧没有突然跳回', () => {
  const offsets = HAIR_FRAME_TIMES.map((time) => hairNodAt(time) * MARO_FRAME_SIZE);
  assert.equal(offsets[0], 0);
  assert.equal(offsets.at(-1), 0);
  assert.ok(Math.max(...offsets) > 10 && Math.max(...offsets) < 16);
  assert.ok(offsets[18] > 10, '第十九帧提前跳回待机');
  assert.ok(Math.abs(offsets[18] - offsets[17]) < 2, '第十八、十九帧衔接跳动');
  assert.ok(offsets.every((value, index) => index === 0 || Math.abs(value - offsets[index - 1]) < 4.5));
  for (const boundary of [600, 1900, 2800, 4650]) {
    const difference = Math.abs(hairNodAt(boundary - 1) - hairNodAt(boundary + 1));
    assert.ok(difference < 1e-8, '缓动边界不平滑');
  }
  assert.ok(hairNodAt(1000) < hairNodAt(1500));
  assert.ok(hairNodAt(3200) > hairNodAt(4000));
});

// 发饰命中使用同一逆变换，翻转后点击左侧发饰仍能找到菜单，脸部则不会误开。
test('发饰入口正确处理翻转及非发饰点击', () => {
  const dragon = 'dragon://app/' + CHARACTERS[0].image;
  const rect = { x: 0, y: 0, width: 200, height: 200 };
  assert.ok(isCharacterMenuPoint(dragon, imagePoint({ x: 167, y: 101 }, rect)));
  assert.ok(isCharacterMenuPoint(dragon, imagePoint({ x: 33, y: 101 }, rect, { scaleX: -1, scaleY: 1, angle: 0 })));
  assert.equal(isCharacterMenuPoint(dragon, { x: 0.5, y: 0.7 }), false);
  assert.equal(isCharacterMenuPoint(MARO_ASSET, { x: 0.835, y: 0.505 }), false);
});
