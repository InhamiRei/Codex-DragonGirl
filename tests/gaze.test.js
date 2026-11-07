import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CHARACTER_ASSET, EYE_ARTWORK, eyeTrackingEnabled, eyeWarpWeight, gazeTarget, stepGaze, bodyFollowPose } from '../src/shared/gaze.js';
import { imagePoint } from '../src/shared/hit-test.js';
import { normalizeSettings } from '../src/core/settings.js';
import { MARO_ASSET } from '../src/shared/characters.js';
import { MARO_EYE_ARTWORK, maroEyeForeground, maroEyeMask, maroGazeWeight } from '../src/shared/maro-eyes.js';

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
  assert.equal(eyeTrackingEnabled(MARO_ASSET), true);
  assert.equal(eyeTrackingEnabled(MARO_ASSET, { eyeTracking: false }), false);
  assert.equal(eyeTrackingEnabled('dragon://app/user-assets/example.png'), false);
});

// 麻吕以自己的双眼中心计算方向，刘海与腮红的暖色像素不随眼睛位移。
test('麻吕使用独立眼部标定并保护前景', () => {
  const rect = { x: 0, y: 0, width: 1254, height: 1254 };
  assert.deepEqual(gazeTarget(MARO_EYE_ARTWORK.center, rect, undefined, MARO_EYE_ARTWORK), { x: 0, y: 0 });
  assert.ok(gazeTarget({ x: 2000, y: 620 }, rect, undefined, MARO_EYE_ARTWORK).x > 0);
  assert.ok(gazeTarget({ x: 2000, y: 620 }, rect, { scaleX: -1, scaleY: 1, angle: 0 }, MARO_EYE_ARTWORK).x < 0);
  assert.equal(maroEyeForeground(244, 185, 157), true);
  assert.equal(maroEyeForeground(130, 92, 68), true);
  assert.equal(maroEyeForeground(70, 105, 145), false);
  assert.equal(maroEyeForeground(63, 61, 52), false);
  assert.equal(maroEyeForeground(250, 232, 221), false);
});

// 手绘高光不应在遮挡层挖洞，孤立的暖色肤色也不能形成随机静止碎点。
test('麻吕刘海遮挡按连续轮廓生成而不是逐像素分类', () => {
  const data = new Uint8ClampedArray(20 * 20 * 4);
  for (let index = 0; index < 400; index += 1) data.set([250, 232, 221, 255], index * 4);
  for (let y = 0; y < 7; y += 1) for (let x = 3; x < 8; x += 1)
    data.set([244, 185, 157, 255], (y * 20 + x) * 4);
  data.set([255, 240, 210, 255], (3 * 20 + 5) * 4);
  data.set([244, 185, 157, 255], (15 * 20 + 18) * 4);
  const mask = maroEyeMask(data, 20, 20, { width: 20, height: 20, y: 0, fixedTop: -20, fixedBottom: 40 });
  assert.equal(mask[3 * 20 + 5], 1, '发束高光形成遮挡破洞');
  assert.equal(mask[4 * 20 + 2], 1, '发束描边没有被保护');
  assert.equal(mask[15 * 20 + 18], 0, '肤色噪点变成静止碎块');
});

// 鼠标再远也只允许虹膜轻微活动，眼眶和脸颊的源坐标必须保持原样。
test('麻吕视线限于眼白内部并固定边缘', () => {
  assert.equal(MARO_EYE_ARTWORK.travel.x, 6);
  assert.equal(MARO_EYE_ARTWORK.travel.y, 3);
  const centers = [[435, 630], [680, 620]];
  MARO_EYE_ARTWORK.eyes.forEach((eye, index) => {
    assert.equal(maroGazeWeight(...centers[index], eye), 1);
    for (const point of eye.aperture) assert.equal(maroGazeWeight(...point, eye), 0);
    assert.equal(maroGazeWeight(eye.x, eye.y, eye), 0);
    assert.equal(maroGazeWeight(eye.x + eye.width / 2, 700, eye), 0);
  });
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
