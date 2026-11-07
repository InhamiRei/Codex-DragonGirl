import test from 'node:test';
import assert from 'node:assert/strict';
import { spritePalette, spriteColorLookup, applySpritePalette, spriteBounds, spriteCrown,
  spriteLandmarks, spriteRegistration, registeredSpriteRow } from '../src/shared/sprite-calibration.js';

// 构造已知材质色板，独立验证调色结果，不依赖截图或测试机的屏幕色彩配置。
function pixels(colors, count = 32) {
  return new Uint8ClampedArray(colors.flatMap((color) => Array.from({ length: count }, () => [...color, 253]).flat()));
}

// 配色修正保持发色、衣领、蓝眼分别对应，不允许全局滤镜产生明显串色。
test('连续色板校准让主要颜色贴近待机并保留渐变', () => {
  const source = pixels([[70, 83, 62], [65, 85, 112], [100, 80, 65], [248, 174, 149], [245, 226, 216], [236, 231, 220]]);
  const target = pixels([[82, 101, 79], [78, 105, 132], [100, 85, 70], [244, 185, 158], [248, 231, 220], [242, 237, 226]]);
  const lookup = spriteColorLookup(spritePalette(source), spritePalette(target));
  const sample = pixels([[70, 83, 62], [65, 85, 112], [248, 174, 149]], 1);
  applySpritePalette(sample, lookup);
  assert.deepEqual([...sample.slice(0, 3)], [82, 101, 79]);
  assert.deepEqual([...sample.slice(4, 7)], [78, 105, 132]);
  assert.deepEqual([...sample.slice(8, 11)], [244, 185, 158]);
  const neighboring = pixels([[220, 188, 155], [221, 188, 155]], 1);
  applySpritePalette(neighboring, lookup);
  for (let channel = 0; channel < 3; channel += 1)
    assert.ok(Math.abs(neighboring[channel] - neighboring[channel + 4]) <= 4, '色组边界产生跳色');
  const tones = pixels([[225, 150, 125], [248, 174, 149]], 1);
  applySpritePalette(tones, lookup);
  assert.ok(tones[0] < tones[4] && tones[1] < tones[5] && tones[2] < tones[6], '阴影被抹平成纯色');
});

// 淡杂点不能扩展可见边界，真实半透明发丝仍保留自己的透明度。
test('透明噪点不进入色板或命中区域', () => {
  const data = new Uint8ClampedArray([255, 0, 0, 7, 200, 150, 120, 120]);
  assert.equal(spritePalette(data).reduce((sum, group) => sum + group.count, 0), 0);
  applySpritePalette(data, Array(6).fill(null));
  assert.deepEqual([...data.slice(0, 4)], [0, 0, 0, 0]);
  assert.equal(data[7], 120);
});

// 位置测量依据透明轮廓，不因同一帧的发色被校准而发生变化。
test('主体边界和头顶测量与 RGB 无关', () => {
  const data = new Uint8ClampedArray(20 * 20 * 4);
  for (let y = 2; y < 18; y += 1) for (let x = 4; x < 16; x += 1)
    data.set([240, 180, 150, 253], (y * 20 + x) * 4);
  const bounds = spriteBounds(data, 20, 20);
  assert.deepEqual(bounds, { left: 0.2, top: 0.1, width: 0.6, height: 0.8 });
  const crown = spriteCrown(data, 20, 20, { top: bounds.top });
  for (let index = 0; index < data.length; index += 4) data[index] = 20;
  assert.deepEqual(spriteCrown(data, 20, 20, { top: bounds.top }), crown);
  assert.throws(() => spriteBounds(new Uint8ClampedArray(16), 2, 2));
});

// 单独移动手臂时，头部和衣服基准必须保持不变，不能用整帧外框反推角色大小。
test('头身量测不把抬起的手臂算入尺寸', () => {
  const data = new Uint8ClampedArray(400 * 400 * 4);
  // 构造具有明确头部、脸部和衣服边界的已知标尺。
  const fill = (left, top, right, bottom, color) => {
    for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1)
      data.set([...color, 255], (y * 400 + x) * 4);
  };
  fill(80, 20, 300, 270, [240, 180, 150]);
  fill(120, 180, 250, 260, [250, 230, 219]);
  fill(125, 280, 275, 390, [240, 238, 230]);
  const original = spriteLandmarks(data, 400, 400);
  fill(10, 130, 80, 300, [250, 230, 219]);
  fill(300, 140, 385, 320, [250, 230, 219]);
  assert.deepEqual(spriteLandmarks(data, 400, 400), original);
  assert.equal(original.coreWidth, 220 / 400);
  assert.equal(original.hem, 390 / 400);
});

// 回归原先“头顶没动但下巴与下摆跳变”的缺陷，同时检查分段映射没有断层。
test('头宽下巴与下摆分别对齐且接缝连续', () => {
  const reference = { top: 0.02, crownX: 0.5, coreY: 0.18, coreX: 0.48, coreWidth: 0.52,
    chin: 0.66, chinX: 0.45, hem: 0.98 };
  const source = { top: 0.01, crownX: 0.51, coreY: 0.19, coreX: 0.49, coreWidth: 0.53,
    chin: 0.68, chinX: 0.46, hem: 0.99 };
  const rows = spriteRegistration(reference, source);
  for (const [from, to, x, targetX] of [
    [source.coreY, reference.coreY, source.coreX, reference.coreX],
    [source.chin, reference.chin, source.chinX, reference.chinX],
    [source.hem, reference.hem, 0.5, 0.5],
  ]) {
    const row = registeredSpriteRow(rows, to);
    assert.ok(Math.abs(row.sourceY - from) < 1e-9);
    assert.ok(Math.abs(row.x + row.scale * x - targetX) < 1e-9);
    const left = registeredSpriteRow(rows, to - 1e-8);
    const right = registeredSpriteRow(rows, to + 1e-8);
    assert.ok(Math.abs(left.sourceY - right.sourceY) < 1e-6);
    assert.ok(Math.abs(left.scale - right.scale) < 1e-6);
    assert.ok(Math.abs(left.x - right.x) < 1e-6);
  }
  assert.throws(() => spriteRegistration(reference, { ...source, coreWidth: 0.7 }), /重新生图/);
});

// 低头只平移头部，不改变头部宽高；领口以下的每个取样行应与固定姿势完全一致。
test('自然低头保留头部尺寸且不移动身体下部', () => {
  const reference = { top: 0.02, crownX: 0.5, coreY: 0.18, coreX: 0.48, coreWidth: 0.52,
    chin: 0.66, chinX: 0.45, hem: 0.98 };
  const source = { ...reference, coreWidth: 0.53, chin: 0.68, hem: 0.99 };
  const fixed = spriteRegistration(reference, source);
  for (const headOffsetY of [0.003, 0.008, 0.012]) {
    const moving = spriteRegistration(reference, source, { headOffsetY });
    for (const targetY of [reference.top, reference.coreY, reference.chin]) {
      const original = registeredSpriteRow(fixed, targetY);
      const actual = registeredSpriteRow(moving, targetY + headOffsetY);
      assert.ok(Math.abs(actual.sourceY - original.sourceY) < 1e-9);
      assert.ok(Math.abs(actual.scale - original.scale) < 1e-9);
      assert.ok(Math.abs(actual.x - original.x) < 1e-9);
    }
    for (let y = 0.8; y <= 1; y += 0.01)
      assert.deepEqual(registeredSpriteRow(moving, y), registeredSpriteRow(fixed, y));
  }
});
