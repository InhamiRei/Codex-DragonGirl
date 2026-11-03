import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldFaceLeft, FlipMotion, FLIP_DURATION } from '../src/shared/facing.js';
import { imagePoint, opaqueAt } from '../src/shared/hit-test.js';
import { gazeTarget } from '../src/shared/gaze.js';
import { normalizeSettings } from '../src/core/settings.js';

// 以所在区域的中心判断朝向，负坐标副屏和宿主窗口不能借用主屏原点。
test('自动朝向按所属区域判断左右，中线附近保留原方向', () => {
  const area = { x: -1600, width: 1400 };
  assert.equal(shouldFaceLeft({ x: -1550, width: 260 }, area), true);
  assert.equal(shouldFaceLeft({ x: -510, width: 260 }, area, true), false);
  const center = { x: -1030, width: 260 };
  assert.equal(shouldFaceLeft(center, area, true), true);
  assert.equal(shouldFaceLeft(center, area, false), false);
  assert.equal(shouldFaceLeft({ ...center, x: center.x - 8 }, area, false), false);
  assert.equal(shouldFaceLeft({ ...center, x: center.x + 8 }, area, true), true);
  assert.equal(shouldFaceLeft({ ...center, x: center.x - 20 }, area, false), true);
  assert.equal(shouldFaceLeft({ ...center, x: center.x + 20 }, area, true), false);
  assert.equal(shouldFaceLeft(center, null, true), true);
});

// 首次恢复无需入场翻转，后续翻转必须经过连续的中间帧并在固定时间结束。
test('翻转初始化直接落位，切换时连续经过零宽并稳定停止', () => {
  const flip = new FlipMotion();
  flip.setFlipped(false);
  assert.equal(flip.value, 1);
  assert.equal(flip.settled, true);
  flip.setFlipped(true);
  assert.equal(flip.value, 1);
  assert.equal(flip.settled, false);
  assert.ok(flip.step(FLIP_DURATION / 4) > 0);
  assert.ok(Math.abs(flip.step(FLIP_DURATION / 4)) < 1e-12);
  assert.ok(flip.step(FLIP_DURATION / 4) < 0);
  assert.equal(flip.step(FLIP_DURATION), -1);
  assert.equal(flip.settled, true);
});

// 频繁布局推送不延长翻转，连续反向从当前画面接续，不会跳回另一端。
test('重复布局不重计时，反向、长帧与无动画切换保持有界', () => {
  const flip = new FlipMotion();
  flip.setFlipped(false);
  flip.setFlipped(true);
  flip.step(.1);
  flip.setFlipped(true);
  flip.step(.21);
  assert.equal(flip.value, -1);
  flip.setFlipped(false);
  flip.step(.08);
  const middle = flip.value;
  flip.setFlipped(true);
  assert.equal(flip.value, middle);
  assert.equal(flip.step(10), -1);
  flip.setFlipped(false, true);
  assert.equal(flip.value, 1);
  assert.equal(flip.settled, true);
});

// 翻转中间帧的命中仍按实际缩放求逆，零宽时透明穿透且眼神计算不产生 NaN。
test('中间缩放命中与画面一致，零宽安全穿透并保持有限视线', () => {
  const rect = { x: -500, y: 20, width: 260, height: 230 };
  for (const scaleX of [.7, -.4]) {
    const pose = { scaleX, scaleY: 1, angle: 0 };
    const screen = { x: rect.x + rect.width / 2 + (.2 - .5) * rect.width * scaleX, y: rect.y + rect.height * .6 };
    const local = imagePoint(screen, rect, pose);
    assert.ok(Math.abs(local.x - .2) < 1e-10);
    assert.ok(Math.abs(local.y - .6) < 1e-10);
  }
  const point = { x: rect.x + rect.width / 2, y: rect.y + 100 };
  const zero = { scaleX: 0, scaleY: 1, angle: 0 };
  assert.equal(opaqueAt({ width: 1, height: 1, alpha: Uint8Array.of(255) }, imagePoint(point, rect, zero)), false);
  assert.deepEqual(gazeTarget(point, rect, zero), { x: 0, y: 0 });
});

// 自动朝向独立开关可保存、导入和关闭，原有手动镜像偏好仍保留。
test('自动朝向默认开启，显式关闭与手动镜像互不覆盖', () => {
  assert.equal(normalizeSettings({}).autoFlip, true);
  const settings = normalizeSettings({ autoFlip: false, flip: true });
  assert.equal(settings.autoFlip, false);
  assert.equal(settings.flip, true);
  assert.equal(normalizeSettings(settings).autoFlip, false);
});
