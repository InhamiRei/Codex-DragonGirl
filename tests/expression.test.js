import test from 'node:test';
import assert from 'node:assert/strict';
import { happyFrame, happySparkles, HAPPY_DURATION } from '../src/shared/expression.js';
import { normalizeSettings } from '../src/core/settings.js';
import { Monitor } from '../src/main/monitor.js';
import os from 'node:os';
import { SAD_DURATION, sadFrame, sadEyeWeight, sadTear, sadBodyPose } from '../src/shared/sad.js';

// 表情独立于声音、跟随和眨眼，旧设置默认开启，明确关闭仍会保留。
test('动态表情设置独立迁移和关闭', () => {
  assert.equal(normalizeSettings().expressionsEnabled, true);
  assert.equal(normalizeSettings({ expressionsEnabled: false }).expressionsEnabled, false);
  assert.equal(normalizeSettings({ soundEnabled: false, eyeTracking: false, blinkEnabled: false }).expressionsEnabled, true);
});

// 两秒内完整进入、保持和退出；身体只轻弹一次，不留下持续绘制的尾巴。
test('开心表情柔和进入、轻弹并按时恢复', () => {
  assert.equal(happyFrame(0).amount, 0);
  assert.deepEqual(happyFrame(-2), happyFrame(0));
  assert.equal(happyFrame(90).amount, 0.5);
  assert.equal(happyFrame(180).amount, 1);
  assert.equal(happyFrame(1200).amount, 1);
  assert.equal(happyFrame(1750).amount, 0.5);
  assert.ok(happyFrame(280).hop > 0.99);
  assert.equal(happyFrame(560).hop, 0);
  assert.deepEqual(happyFrame(HAPPY_DURATION), { amount: 0, hop: 0, finished: true });
  assert.deepEqual(happyFrame(60000), happyFrame(HAPPY_DURATION));
  for (let time = 0; time < HAPPY_DURATION; time += 1) {
    const value = happyFrame(time);
    assert.ok(value.amount >= 0 && value.amount <= 1 && value.hop >= 0 && value.hop <= 1);
  }
});

// 多个任务接连完成时续接当前亮度，不突然熄灭或把动画排成长队。
test('连续触发从当前亮度与弹动接续，仍在新一轮结束后恢复', () => {
  const current = happyFrame(140);
  const next = happyFrame(0, current);
  assert.equal(next.amount, current.amount);
  assert.equal(next.hop, current.hop);
  assert.equal(happyFrame(180, current).amount, 1);
  assert.deepEqual(happyFrame(HAPPY_DURATION, current), { amount: 0, hop: 0, finished: true });
});

// 表情保持期间光点仍在移动和变亮，不能退化成一张静态贴图或整体眼球平移。
test('虹膜星光拥有持续变化且有界的独立轨迹', () => {
  const first = happySparkles(500), next = happySparkles(1100);
  assert.notEqual(first[0].x, next[0].x);
  assert.notEqual(first[0].y, next[0].y);
  assert.notEqual(first[0].alpha, next[0].alpha);
  for (const eye of [0, 1]) for (let time = 0; time <= HAPPY_DURATION; time += 17)
    for (const point of happySparkles(time, eye)) {
      assert.ok(Math.hypot(point.x, point.y) + point.radius < 1);
      assert.ok(point.alpha >= 0.3 && point.alpha <= 1);
      assert.ok(point.radius > 0 && point.radius < 0.5);
    }
});

// 主任务成功和失败各自触发表情，取消、子任务和未知状态不能冒充失败。
test('主任务成功开心、失败伤心，取消与子任务不触发表情', () => {
  const monitor = new Monitor(os.tmpdir(), { testMode: true });
  monitor.settings = normalizeSettings({ soundEnabled: false, notifications: false });
  monitor.instances = [{ id: 'test-home', name: '测试实例' }];
  monitor.publish = () => {};
  const notices = [];
  monitor.on('notice', (notice) => notices.push(notice));
  for (const status of ['complete', 'cancelled', 'error', 'unknown'])
    monitor.workerMessage({ type: 'task', task: { home: 'test-home', source: '主任务', status } });
  for (const status of ['complete', 'error'])
    monitor.workerMessage({ type: 'task', task: { home: 'test-home', source: '子任务', status } });
  assert.deepEqual(notices.map((notice) => notice.expression), ['happy', null, 'sad', null]);
  assert.deepEqual(notices.map((notice) => notice.event), ['complete', 'complete', 'error', 'complete']);
  assert.ok(notices.every((notice) => notice.system === false));
});

// 含泪动作有明确终点，重复失败可续接强度，但不会留下永久伤心或队列。
test('伤心柔和进入并按时恢复，连续失败续接当前强度', () => {
  assert.deepEqual(sadFrame(-5), sadFrame(0));
  assert.equal(sadFrame(450).amount, 0);
  assert.equal(sadFrame(1200).amount, 1);
  assert.equal(sadFrame(4500).amount, 1);
  assert.equal(sadFrame(5050).amount, 0.5);
  assert.deepEqual(sadFrame(SAD_DURATION), { amount: 0, hop: 0, finished: true });
  const current = sadFrame(800);
  assert.equal(sadFrame(0, current).amount, current.amount);
  for (let time = 0; time <= SAD_DURATION + 100; time += 17) {
    const frame = sadFrame(time);
    assert.ok(frame.amount >= 0 && frame.amount <= 1);
    assert.equal(frame.hop, 0);
  }
});

// 泪珠会实际下落且在结束前淡去，头部轻垂不改变位置锚点或无口区域。
test('泪珠与低头保持有界，嘴部不进入眼神遮罩', () => {
  assert.equal(sadTear(2000, 1).alpha, 0);
  assert.ok(sadTear(3500, 1).y > sadTear(2500, 1).y + 20);
  assert.equal(sadTear(4300, 1).alpha, 0);
  for (let time = 0; time <= SAD_DURATION; time += 17) {
    const tear = sadTear(time, sadFrame(time).amount);
    assert.ok(tear.x >= 901 && tear.x <= 904 && tear.y >= 821 && tear.y <= 879);
    assert.ok(tear.alpha >= 0 && tear.alpha <= 1);
    const body = sadBodyPose(time, sadFrame(time).amount, 500);
    const flipped = sadBodyPose(time, sadFrame(time).amount, 500, true);
    assert.ok(body.translateY <= 1.2 && Math.abs(body.angle) < 0.27);
    assert.equal(flipped.angle, -body.angle);
  }
  for (const index of [0, 1]) {
    assert.equal(sadEyeWeight(660, 910, index), 0);
    assert.equal(sadEyeWeight(650, 1000, index), 0);
  }
});
