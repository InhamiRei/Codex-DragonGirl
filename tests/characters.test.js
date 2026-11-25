import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHARACTERS, MARO_ASSET, MARO_HAIR_ASSETS, MARO_FRAME_SIZE, characterById, characterByAsset, hairFrameAt,
  hairNodAt, HAIR_FRAME_TIMES, HAIR_DURATION, HAIR_FRAME_DURATIONS,
  isCharacterMenuPoint } from '../src/shared/characters.js';
import { SettingsStore, normalizeSettings } from '../src/core/settings.js';
import { KANNA_OUTFITS, KANNA_OUTFIT_REGION } from '../src/shared/kanna-outfits.js';
import { MARO_OUTFITS, MARO_OUTFIT_OFFSETS, findMaroOutfit, maroGroomingPose, maroOutfitLayer } from '../src/shared/maro-outfits.js';
import { imagePoint } from '../src/shared/hit-test.js';
import { dialogueLine } from '../src/shared/dialogue.js';
import { KOKKORO_DIALOGUE } from '../src/shared/kokkoro-dialogue.js';
import { KANNA_DIALOGUE } from '../src/shared/kanna-dialogue.js';
import { KANNA_PORTRAIT, KOKKORO_PORTRAIT } from '../src/renderer/portrait-artwork.js';

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
  for (const frame of frames.slice(1, -1)) {
    // VP8L 的尺寸位和 Alpha 标志可直接验证，不需要给单元测试引入图片工具。
    assert.equal(frame.toString('ascii', 0, 4), 'RIFF');
    assert.equal(frame.toString('ascii', 8, 16), 'WEBPVP8L');
    assert.equal(frame[20], 0x2f);
    const header = frame.readUInt32LE(21);
    assert.equal((header & 0x3fff) + 1, 1254);
    assert.equal(((header >>> 14) & 0x3fff) + 1, 1254);
    assert.equal((header >>> 28) & 1, 1, '无损帧必须保留透明通道');
  }
});

// 发布资源必须覆盖全部原表情和捋发中间姿势，尺寸、裁切偏移与透明通道一一对应。
test('麻吕服饰保留原版默认值并为每个现有姿势提供无损图层', async () => {
  assert.equal(normalizeSettings().maroOutfitId, 'original');
  assert.equal(normalizeSettings({ maroOutfitId: 'winter' }).maroOutfitId, 'original');
  assert.deepEqual(MARO_OUTFITS.map(({ id, name }) => [id, name]), [
    ['original', '原版服饰'], ['cardigan-redraw', '焦糖开衫'], ['bun-hoodie-redraw', '红豆包卫衣'],
  ]);
  // 保留款沿用原选款，已移除款和陌生编号回退到原版服饰。
  for (const id of ['cardigan', 'bun-hoodie']) {
    const replacement = id + '-redraw';
    assert.equal(normalizeSettings({ maroOutfitId: id }).maroOutfitId, replacement);
    assert.equal(findMaroOutfit(id), findMaroOutfit(replacement));
  }
  for (const id of ['gym', 'gym-redraw']) {
    assert.equal(normalizeSettings({ maroOutfitId: id }).maroOutfitId, 'original');
    assert.equal(findMaroOutfit(id), undefined);
  }
  assert.equal(findMaroOutfit('winter'), undefined);
  const poses = ['idle', 'success', 'failure', ...MARO_HAIR_ASSETS.slice(1, -1)
    .map((_, index) => maroGroomingPose(index + 1))];
  assert.deepEqual(Object.keys(MARO_OUTFIT_OFFSETS), poses);
  for (const outfit of MARO_OUTFITS.slice(1)) {
    assert.equal(normalizeSettings({ maroOutfitId: outfit.id }).maroOutfitId, outfit.id);
    for (const pose of poses) {
      const [x, y, width, height] = MARO_OUTFIT_OFFSETS[pose];
      assert.ok(x >= 0 && y >= 0 && x + width <= MARO_FRAME_SIZE && y + height <= MARO_FRAME_SIZE, pose);
      const layer = await fs.readFile(new URL('../' + maroOutfitLayer(outfit, pose), import.meta.url));
      assert.equal(layer.toString('ascii', 8, 16), 'WEBPVP8L', pose);
      assert.equal(layer[20], 0x2f, pose);
      const header = layer.readUInt32LE(21);
      assert.deepEqual([(header & 0x3fff) + 1, ((header >>> 14) & 0x3fff) + 1, (header >>> 28) & 1],
        [width, height, 1], pose);
    }
  }
});

// 表情只保存实际取样的脸部区域，仍以原图分辨率和 RGBA 格式交给合成器。
for (const { id, face } of [KOKKORO_PORTRAIT, KANNA_PORTRAIT]) {
  test(id + ' 的表情帧保留原生脸部尺寸和透明通道', async () => {
    for (const name of ['blink-half', 'blink-closed', 'success', 'failure']) {
      const url = new URL(`../assets/characters/${id}/${name}.png`, import.meta.url);
      const frame = await fs.readFile(url);
      assert.equal(frame.subarray(1, 4).toString(), 'PNG', name);
      assert.deepEqual([frame.readUInt32BE(16), frame.readUInt32BE(20), frame[24], frame[25]], [face.width, face.height, 8, 6], name);
    }
  });
}

// 发布版康娜的衣料区域避开表情，三套合成图保留原画尺寸和透明通道。
test('康娜服饰兼容旧设置并包含原版与三套透明合成图', async () => {
  assert.equal(normalizeSettings().kannaOutfitId, 'original');
  assert.equal(normalizeSettings({ kannaOutfitId: 'apron' }).kannaOutfitId, 'original');
  assert.deepEqual(KANNA_OUTFITS.map(({ id }) => id), ['original', 'school', 'sports', 'yukata']);
  const { x, y, width, height, mask } = KANNA_OUTFIT_REGION;
  assert.ok(x >= 0 && y >= KANNA_PORTRAIT.face.y + KANNA_PORTRAIT.face.height);
  assert.ok(x + width <= KANNA_PORTRAIT.width && y + height <= KANNA_PORTRAIT.height);
  for (const { id } of KANNA_OUTFITS) assert.equal(normalizeSettings({ kannaOutfitId: id }).kannaOutfitId, id);
  for (const file of [mask, ...KANNA_OUTFITS.slice(1).map(({ image }) => image)]) {
    const image = await fs.readFile(new URL('../' + file, import.meta.url));
    const size = file === mask ? [width, height] : [KANNA_PORTRAIT.width, KANNA_PORTRAIT.height];
    assert.equal(image.subarray(1, 4).toString(), 'PNG', file);
    assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20), image[24], image[25]], [...size, 8, 6], file);
  }
});

// 旧配置仍使用龙娘，任意路径或损坏角色编号不能被当作内置资源。
test('内置角色选择兼容旧配置并拒绝任意路径', () => {
  assert.equal(normalizeSettings().characterId, 'dragon');
  assert.equal(normalizeSettings({ characterId: 'maro' }).characterId, 'maro');
  // 读取保存过游侠装的设置时，角色选择和其他偏好继续生效。
  const restored = normalizeSettings({ characterId: 'kokkoro', kokkoroOutfitId: 'ranger', kannaOutfitId: 'school' });
  assert.equal(restored.characterId, 'kokkoro');
  assert.equal(restored.kannaOutfitId, 'school');
  assert.equal(Object.hasOwn(restored, 'kokkoroOutfitId'), false);
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
