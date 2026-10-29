import test from 'node:test';
import assert from 'node:assert/strict';
import { DragGesture } from '../src/shared/gesture.js';
import { PressSpring } from '../src/shared/spring.js';
import { imagePoint, opaqueAt, roundedRectContains, ellipseContains } from '../src/shared/hit-test.js';

// 手抖不应变成拖动，超过阈值的手势也不应额外触发点击。
test('小幅移动仍是点击，真正拖动只提交总位移', () => {
  const gesture = new DragGesture();
  const rect = { x: 100, y: 200, width: 260, height: 231 };
  gesture.begin({ x: 150, y: 250 }, rect);
  assert.equal(gesture.end({ x: 153, y: 252 }).kind, 'click');
  gesture.begin({ x: 150, y: 250 }, rect);
  gesture.move({ x: 180, y: 270 });
  assert.deepEqual(gesture.end({ x: 200, y: 290 }), { kind: 'drag', rect: { ...rect, x: 150, y: 240 } });
  assert.equal(gesture.end({ x: 200, y: 290 }), null);
});

// 系统取消可能不带坐标，不能把角色错误移动到屏幕原点。
test('取消拖动恢复起点，重复取消不产生新操作', () => {
  const gesture = new DragGesture();
  const rect = { x: -900, y: 80, width: 260, height: 231 };
  gesture.begin({ x: -800, y: 120 }, rect);
  gesture.move({ x: -300, y: 400 });
  assert.deepEqual(gesture.cancel(), { kind: 'cancel', rect });
  assert.equal(gesture.cancel(), null);
});

// 弹簧应在长帧和连续点击后仍然收敛，不留永久缩放或倾斜。
test('连续按压与长帧后，回弹稳定收敛到原尺寸', () => {
  const spring = new PressSpring();
  for (let click = 0; click < 30; click += 1) {
    spring.press(click % 2 ? -1 : 1);
    for (let frame = 0; frame < 3; frame += 1) spring.step(1 / 60);
    spring.release();
    spring.step(click % 3 ? 1 / 60 : 2);
  }
  let result;
  for (let frame = 0; frame < 300; frame += 1) {
    result = spring.step(1 / 60);
    assert.ok(result.scaleX > 0.7 && result.scaleX < 1.3);
    assert.ok(result.scaleY > 0.7 && result.scaleY < 1.3);
  }
  assert.equal(result.settled, true);
  assert.deepEqual(spring.pose(), { scaleX: 1, scaleY: 1, angle: 0 });
});

// 将一个素材点正向变换到屏幕后，逆变换必须仍命中原来的像素。
test('旋转与按压后的像素命中与绘制保持一致', () => {
  const rect = { x: 32, y: 32, width: 260, height: 231 };
  const pose = { scaleX: 1.055, scaleY: 0.91, angle: 0.9 };
  const source = { x: 0.12, y: 0.55 };
  const localX = (source.x - 0.5) * rect.width * pose.scaleX;
  const localY = (source.y - 1) * rect.height * pose.scaleY;
  const angle = pose.angle * Math.PI / 180;
  const screen = { x: rect.x + rect.width / 2 + localX * Math.cos(angle) - localY * Math.sin(angle),
    y: rect.y + rect.height + localX * Math.sin(angle) + localY * Math.cos(angle) };
  const inverse = imagePoint(screen, rect, pose);
  assert.ok(Math.abs(inverse.x - source.x) < 1e-10);
  assert.ok(Math.abs(inverse.y - source.y) < 1e-10);
});

// 白色不是透明色；命中只取决于 Alpha，包括角色内部的透明空洞。
test('透明空隙穿透，白色不透明像素接收点击', () => {
  const mask = { width: 3, height: 1, alpha: Uint8Array.from([255, 0, 255]) };
  assert.equal(opaqueAt(mask, { x: 0.1, y: 0.5 }), true);
  assert.equal(opaqueAt(mask, { x: 0.5, y: 0.5 }), false);
  assert.equal(opaqueAt(mask, { x: 0.9, y: 0.5 }), true);
  assert.equal(opaqueAt(mask, { x: 1, y: 0.5 }), false);
  assert.equal(opaqueAt(null, { x: 0.5, y: 0.5 }), false);
});

// 气泡的透明圆角不能变成不可见的点击障碍。
test('气泡中心接收点击，透明圆角和边界之外穿透', () => {
  const rect = { x: 12, y: 12, width: 280, height: 116 };
  assert.equal(roundedRectContains({ x: 100, y: 60 }, rect, 20), true);
  assert.equal(roundedRectContains({ x: 13, y: 13 }, rect, 20), false);
  assert.equal(roundedRectContains({ x: 11, y: 60 }, rect, 20), false);
});

// 椭圆比圆角矩形有更多透明区域，副屏负坐标和零尺寸也必须得到正确命中结果。
test('漫画气泡按椭圆命中，四角空白与装饰泡穿透', () => {
  const rect = { x: -240, y: 20, width: 240, height: 140 };
  assert.equal(ellipseContains({ x: -120, y: 90 }, rect), true);
  assert.equal(ellipseContains({ x: -210, y: 37.5 }, rect), false);
  assert.equal(ellipseContains({ x: -120, y: 155 }, rect), true);
  assert.equal(ellipseContains({ x: -120, y: 175 }, rect), false);
  assert.equal(ellipseContains({ x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 0 }), false);
});
