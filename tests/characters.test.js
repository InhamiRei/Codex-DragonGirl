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
import { dialogueLine } from '../src/shared/dialogue.js';
import { KOKKORO_DIALOGUE } from '../src/shared/kokkoro-dialogue.js';
import { KANNA_DIALOGUE } from '../src/shared/kanna-dialogue.js';
import { KANNA_PORTRAIT, KOKKORO_PORTRAIT } from '../src/renderer/portrait-artwork.js';

// 直接读取 VP8L 文件头，在没有外部图像工具的系统上也能核对无损格式、尺寸和透明通道。
function assertLosslessFrame(frame, width, height) {
  assert.equal(frame.toString('ascii', 0, 4), 'RIFF');
  assert.equal(frame.toString('ascii', 8, 16), 'WEBPVP8L');
  assert.equal(frame[20], 0x2f);
  const bits = frame.readUInt32LE(21);
  assert.equal((bits & 0x3fff) + 1, width);
  assert.equal(((bits >>> 14) & 0x3fff) + 1, height);
  assert.equal((bits >>> 28) & 1, 1, '无损帧必须保留透明通道');
}

// 防止打包时误换成旧的低清网格或缺帧；首尾必须与用户确认的待机原图完全一致。
test('三十帧均为 1254 像素且循环首尾复用待机原图', async () => {
  assert.equal(MARO_FRAME_SIZE, 1254);
  assert.equal(MARO_HAIR_ASSETS.length, 30);
  const frames = await Promise.all(MARO_HAIR_ASSETS.map((url) =>
    fs.readFile(new URL('../' + url.replace('dragon://app/', ''), import.meta.url))));
  const idle = frames[0];
  assert.equal(idle.subarray(1, 4).toString(), 'PNG');
  assert.equal(idle.readUInt32BE(16), 1254);
  assert.equal(idle.readUInt32BE(20), 1254);
  assert.equal(idle[25], 6, '待机 PNG 必须保留 RGBA 透明通道');
  assert.ok(frames.at(-1).equals(idle));
  for (const frame of frames.slice(1, -1)) assertLosslessFrame(frame, MARO_FRAME_SIZE, MARO_FRAME_SIZE);
});

// 表情只保存实际取样的脸部区域，仍以原图分辨率和 RGBA 格式交给合成器。
for (const { id, face } of [KOKKORO_PORTRAIT, KANNA_PORTRAIT]) {
  test(id + ' 的表情帧保留原生脸部尺寸和透明通道', async () => {
    for (const name of ['blink-half', 'blink-closed', 'success', 'failure']) {
      const extension = id === 'kanna' ? 'webp' : 'png';
      const url = new URL(`../assets/characters/${id}/${name}.${extension}`, import.meta.url);
      const frame = await fs.readFile(url);
      if (extension === 'webp') {
        assertLosslessFrame(frame, face.width, face.height);
        continue;
      }
      assert.equal(frame.subarray(1, 4).toString(), 'PNG', name);
      assert.deepEqual([frame.readUInt32BE(16), frame.readUInt32BE(20), frame[24], frame[25]], [face.width, face.height, 8, 6], name);
    }
  });
}

// 旧配置仍使用龙娘，任意路径或损坏角色编号不能被当作内置资源。
test('内置角色选择兼容旧配置并拒绝任意路径', () => {
  assert.equal(normalizeSettings().characterId, 'dragon');
  assert.equal(normalizeSettings({ characterId: 'maro' }).characterId, 'maro');
  assert.equal(normalizeSettings({ characterId: 'kokkoro' }).characterId, 'kokkoro');
  assert.equal(normalizeSettings({ characterId: 'kanna' }).characterId, 'kanna');
  assert.equal(normalizeSettings({ characterId: '../../auth.json' }).characterId, 'dragon');
  assert.equal(characterById('maro').name, '麻吕');
  assert.equal(characterByAsset(MARO_ASSET).id, 'maro');
  assert.equal(characterByAsset('dragon://app/assets/characters/kokkoro/idle.png').name, '可可萝');
  assert.equal(characterByAsset('dragon://app/assets/characters/kanna/idle.png').name, '康娜');
  assert.equal(characterByAsset('dragon://app/user-assets/123.png'), null);
  assert.deepEqual(CHARACTERS.map(({ id }) => id), ['dragon', 'maro', 'kokkoro', 'kanna']);
});

// 切换角色通过局部保存保留位置和音量，重启后仍读取到所选角色。
test('角色选择持久化而不覆盖其他用户偏好', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maro-settings-'));
  try {
    const store = new SettingsStore(directory);
    await store.save({ volume: 0.17, followOffsets: { '/tmp/codex': { x: 0.2, y: 0.7 } } });
    for (const characterId of ['maro', 'kokkoro', 'kanna', 'dragon']) {
      await store.save((current) => ({ ...current, characterId, characterAsset: '' }));
      const saved = await new SettingsStore(directory).load();
      assert.equal(saved.characterId, characterId);
      assert.equal(saved.volume, 0.17);
      assert.deepEqual(saved.followOffsets['/tmp/codex'], { x: 0.2, y: 0.7 });
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// 日常和三类任务分别轮换，切换角色时不能混用其他角色的气泡。
for (const [id, dialogue] of Object.entries({ kokkoro: KOKKORO_DIALOGUE, kanna: KANNA_DIALOGUE })) {
  test(id + ' 使用独立的日常、完成、失败和取消台词', () => {
    assert.equal(dialogue.chat.length, 24);
    assert.equal(dialogue.complete.length + dialogue.error.length + dialogue.cancelled.length, 10);
    for (const [kind, lines] of Object.entries(dialogue)) {
      assert.deepEqual(lines.map((_, index) => dialogueLine(kind, index, id)), lines);
      assert.equal(dialogueLine(kind, lines.length, id), lines[0]);
      for (const other of CHARACTERS.filter((character) => character.id !== id))
        assert.notEqual(lines[0], dialogueLine(kind, 0, other.id));
      assert.equal(new Set(lines).size, lines.length);
    }
  });
}

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
