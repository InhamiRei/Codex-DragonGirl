import test from 'node:test';
import assert from 'node:assert/strict';
import { BLINK_DURATION, blinkAmount, nextBlinkDelay, blinkColumn, blinkSourceY, blinkSkinCoverage } from '../src/shared/blink.js';
import { EYE_ARTWORK } from '../src/shared/gaze.js';
import { normalizeSettings } from '../src/core/settings.js';

// 默认迁移开启自然眨眼，明确关闭仍保留；与视线开关互不覆盖。
test('自然眨眼偏好独立保存，兼容旧配置', () => {
  assert.equal(normalizeSettings({}).blinkEnabled, true);
  assert.equal(normalizeSettings({ blinkEnabled: false }).blinkEnabled, false);
  assert.equal(normalizeSettings({ eyeTracking: false }).blinkEnabled, true);
  assert.equal(normalizeSettings({ blinkEnabled: false }).eyeTracking, true);
});

// 闭眼比睁眼更快，结束或后台长帧后恢复睁开，不留下永久闭眼。
test('轻眨连续闭合、短暂停留、稍慢睁开并结束', () => {
  assert.equal(blinkAmount(-1), 0);
  assert.equal(blinkAmount(0), 0);
  assert.equal(blinkAmount(45), 0.5);
  assert.equal(blinkAmount(90), 1);
  assert.equal(blinkAmount(110), 1);
  assert.equal(blinkAmount(187.5), 0.5);
  assert.equal(blinkAmount(BLINK_DURATION), 0);
  assert.equal(blinkAmount(60000), 0);
  let previous = 0;
  for (let time = 0; time <= 90; time += 1) {
    const value = blinkAmount(time);
    assert.ok(value >= previous && value <= 1); previous = value;
  }
  previous = 1;
  for (let time = 115; time <= BLINK_DURATION; time += 1) {
    const value = blinkAmount(time);
    assert.ok(value <= previous && value >= 0); previous = value;
  }
});

// 变化的等待间隔保持在温和范围，不产生频闪或很长时间不眨眼。
test('眨眼间隔有变化且保持有界', () => {
  const intervals = [0, 0.25, 0.5, 0.75, 1].map(nextBlinkDelay);
  assert.equal(new Set(intervals).size, 5);
  assert.ok(intervals.every((value) => value >= 3200 && value <= 7200));
});

// 眼皮内部可以压缩，睫毛厚度和远处像素必须保留，采样始终单调且有限。
test('闭眼收起虹膜并保留睫毛厚度，周围像素平滑衔接', () => {
  for (const eye of EYE_ARTWORK.eyes) {
    const column = blinkColumn(eye.blink.cx, eye);
    for (const closure of [0, 0.25, 0.5, 0.9, 1]) {
      let previous = -Infinity;
      for (let y = column.upper - 5; y <= column.lower + 5; y += 0.25) {
        const source = blinkSourceY(y, column, closure);
        assert.ok(Number.isFinite(source) && source >= previous);
        if (closure === 0 || y < column.upper || y > column.lower) assert.equal(source, y);
        previous = source;
      }
      const movedTop = column.top + (column.bottom - column.lashBottom) * 0.45 * closure;
      const first = blinkSourceY(movedTop + 2, column, closure);
      const last = blinkSourceY(movedTop + eye.blink.thickness - 2, column, closure);
      assert.ok(Math.abs(last - first - (eye.blink.thickness - 4)) < 1e-9);
    }
    const outside = blinkColumn(eye.blink.cx + eye.blink.rx + 20, eye);
    assert.equal(outside.reach, 0);
    assert.equal(blinkSourceY(eye.blink.cy, outside, 1), eye.blink.cy);
    assert.equal(blinkSkinCoverage(column.upper, column, 1), 0);
    assert.equal(blinkSkinCoverage(column.lower, column, 1), 0);
    assert.equal(blinkSkinCoverage(column.top + 10, column, 1), 1);
    assert.equal(blinkSkinCoverage(column.bottom - 10, column, 1), 1);
    assert.equal(blinkSkinCoverage(column.top + 10, column, 0), 0);
  }
});
