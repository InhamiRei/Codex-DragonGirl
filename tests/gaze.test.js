import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CHARACTER_ASSET, EYE_ARTWORK, eyeTrackingEnabled, eyeWarpWeight, gazeTarget, stepGaze, bodyFollowPose } from '../src/shared/gaze.js';
import { imagePoint } from '../src/shared/hit-test.js';
import { normalizeSettings } from '../src/core/settings.js';

// 构造绘制后的屏幕落点，验证坐标还原而不是重复目标计算公式。
function screenPoint(source, rect, pose) {
  const x = (source.x - 0.5) * rect.width * pose.scaleX;
  const y = (source.y - 1) * rect.height * pose.scaleY;
  const radians = pose.angle * Math.PI / 180;
  return {
    x: rect.x + rect.width / 2 + (pose.translateX || 0) + x * Math.cos(radians) - y * Math.sin(radians),
    y: rect.y + rect.height + (pose.translateY || 0) + x * Math.sin(radians) + y * Math.cos(radians),
  };
}

// 升级旧配置默认开启，明确关闭则持久保留，自定义角色绝不套用默认眼区。
test('眼睛跟随偏好兼容旧设置并限制内置角色', () => {
  assert.equal(normalizeSettings({}).eyeTracking, true);
  assert.equal(normalizeSettings({ eyeTracking: false }).eyeTracking, false);
  assert.equal(normalizeSettings({ eyeTracking: 'false' }).eyeTracking, true);
  assert.equal(eyeTrackingEnabled(), true);
  assert.equal(eyeTrackingEnabled(DEFAULT_CHARACTER_ASSET, { eyeTracking: false }), false);
  assert.equal(eyeTrackingEnabled('dragon://app/user-assets/example.png'), false);
});

// 身体比眼部移动更轻，翻转后仍按屏幕方向倾斜，不能看向右边却往左倒。
test('身体跟随幅度有限，水平翻转保持屏幕方向', () => {
  for (const scale of [0.5, 0.6, 1, 1.5]) {
    const rect = { width: 260 * scale, height: 260 * scale * EYE_ARTWORK.height / EYE_ARTWORK.width };
    const right = bodyFollowPose({ x: 1, y: 0 }, rect);
    const flipped = bodyFollowPose({ x: -1, y: 0 }, rect, true);
    assert.deepEqual(flipped, right);
    assert.ok(right.angle > 0 && right.angle <= 0.45);
    assert.ok(right.translateX + rect.height * Math.sin(right.angle * Math.PI / 180)
      < rect.width * EYE_ARTWORK.travel.x / EYE_ARTWORK.width);
    assert.ok(bodyFollowPose({ x: 0, y: -1 }, rect).translateY < 0);
    assert.ok(bodyFollowPose({ x: 0, y: 1 }, rect).translateY > 0);
  }
});

// 身体有轻微滞后，同时仍在有限帧内停稳，不形成常驻动画。
test('眼睛先响应，身体稍慢跟随并停止', () => {
  let eye = { x: 0, y: 0 }, body = { x: 0, y: 0 };
  const target = { x: 0.8, y: 0.6 };
  eye = stepGaze(eye, target, 1 / 60);
  body = stepGaze(body, target, 1 / 60, 0.18);
  assert.ok(body.x > 0 && body.x < eye.x && body.y < eye.y);
  for (let frame = 0; frame < 150; frame += 1) {
    eye = stepGaze(eye, target, 1 / 60);
    body = stepGaze(body, target, 1 / 60, 0.18);
  }
  assert.ok(eye.settled && body.settled);
  assert.equal(body.x, target.x);
  assert.equal(body.y, target.y);
});

// 身体平移、倾斜、点击压缩和镜像叠加后，绘制位置必须仍能准确反查素材。
test('身体跟随叠加按压与翻转时透明命中仍与画面一致', () => {
  const rect = { x: -350, y: 170, width: 260, height: 231 };
  for (const flip of [false, true]) {
    const body = bodyFollowPose({ x: 0.8, y: -0.6 }, rect, flip);
    const pose = { ...body, scaleX: 1.055 * (flip ? -1 : 1), scaleY: 0.91, angle: 0.9 + body.angle };
    for (const source of [{ x: 0.12, y: 0.55 }, { x: 0.92, y: 0.04 }, { x: 0.5, y: 1 }]) {
      const actual = imagePoint(screenPoint(source, rect, pose), rect, pose);
      assert.ok(Math.abs(actual.x - source.x) < 1e-10);
      assert.ok(Math.abs(actual.y - source.y) < 1e-10);
    }
  }
});

// 原点与远距离方向都有限幅，副屏负坐标同样是有效目标。
test('视线支持全屏方向、近距离与负坐标，斜向不会超过活动范围', () => {
  const rect = { x: 30, y: 30, width: 266, height: 236.4 };
  const center = { x: rect.x + EYE_ARTWORK.center.x * 0.2, y: rect.y + EYE_ARTWORK.center.y * 0.2 };
  assert.ok(Math.hypot(...Object.values(gazeTarget(center, rect))) < 1e-10);
  for (const [x, y] of [[10000, 10000], [-10000, -10000], [-10000, 10000], [10000, -10000]]) {
    const gaze = gazeTarget({ x, y }, rect);
    assert.equal(Math.sign(gaze.x), Math.sign(x));
    assert.equal(Math.sign(gaze.y), Math.sign(y));
    assert.ok(Math.hypot(gaze.x, gaze.y) <= 1.0000001);
  }
  assert.deepEqual(gazeTarget(null, rect), { x: 0, y: 0 });
  assert.deepEqual(gazeTarget({ x: NaN, y: 0 }, rect), { x: 0, y: 0 });
});

// 不同大小、屏幕位置、镜像与弹簧姿态下，同一个原画方向应得到相同视线。
test('缩放、翻转、按压和旋转后仍正确还原鼠标方向', () => {
  const source = { x: 0.82, y: 0.3 };
  const expected = gazeTarget(source, { x: 0, y: 0, width: 1, height: 1 });
  for (const scale of [0.5, 1, 1.5]) for (const flip of [1, -1]) {
    const rect = { x: -800, y: 300, width: 260 * scale, height: 260 * scale };
    const pose = { scaleX: 1.055 * flip, scaleY: 0.91, angle: 0.9 };
    const actual = gazeTarget(screenPoint(source, rect, pose), rect, pose);
    assert.ok(Math.abs(actual.x - expected.x) < 1e-10);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-10);
  }
});

// 原画眼眶、睫毛尖和高光的取样点必须整体平移，包括四向移动后的目的位置。
test('眼眶、睫毛和虹膜统一移动，眼区外平滑归零', () => {
  const landmarks = [
    [[370, 681], [493, 647], [571, 650], [491, 804], [478, 687]],
    [[747, 663], [835, 676], [975, 728], [833, 837], [810, 710]],
  ];
  EYE_ARTWORK.eyes.forEach((eye, index) => {
    for (const [x, y] of landmarks[index]) for (const [dx, dy] of [[0, 0], [14, 0], [-14, 0], [0, 10], [0, -10]])
      assert.equal(eyeWarpWeight(x + dx, y + dy, eye), 1);
  });
  for (const eye of EYE_ARTWORK.eyes) {
    for (let x = eye.x; x <= eye.x + eye.width; x += 1) {
      assert.equal(eyeWarpWeight(x, eye.y, eye), 0);
      assert.equal(eyeWarpWeight(x, eye.y + eye.height, eye), 0);
    }
    for (let y = eye.y; y <= eye.y + eye.height; y += 1) {
      assert.equal(eyeWarpWeight(eye.x, y, eye), 0);
      assert.equal(eyeWarpWeight(eye.x + eye.width, y, eye), 0);
    }
  }
});

// 快速改变目标与长帧后仍单调收敛，静止后必须结束动画。
test('视线在连续转向与长帧后收敛，不越界或永久空转', () => {
  let current = { x: 0, y: 0 };
  const first = stepGaze(current, { x: 1, y: 0 }, 1 / 60);
  assert.ok(first.x > 0 && first.x < 1);
  for (const target of [{ x: 1, y: 0 }, { x: -0.6, y: 0.8 }, { x: 0, y: 0 }]) {
    for (let frame = 0; frame < 100; frame += 1) {
      current = stepGaze(current, target, frame % 10 ? 1 / 60 : 2);
      assert.ok(Math.hypot(current.x, current.y) <= 1.0000001);
    }
    assert.equal(current.settled, true);
    assert.equal(current.x, target.x);
    assert.equal(current.y, target.y);
  }
});
