import test from 'node:test';
import assert from 'node:assert/strict';
import { activityCalendar, activityLevel } from '../src/shared/activity.js';

// 跨年周只纳入当前年，未来日期不冒充零用量，累计值不重复计算周内记录。
test('活动图日、周和累计采用一致的年度范围', () => {
  const weeks = activityCalendar({ '2025-12-31': 50, '2026-01-01': 10, '2026-01-04': 20, '2026-01-05': 30, '2026-12-31': 40 }, 2026, '2026-10-28');
  assert.equal(weeks[0].days[0].day, '2025-12-29');
  assert.equal(weeks[0].value, 30);
  assert.equal(weeks[1].value, 30);
  assert.equal(weeks[1].cumulative, 60);
  assert.equal(weeks.at(-1).cumulative, 60);
  assert.equal(weeks.flatMap((week) => week.days).filter((day) => day.available).length, 301);
  assert.equal(weeks.at(-1).days.find((day) => day.day === '2026-12-31').available, false);
});

// 闰年应有完整的 366 天，缺失记录补零但不改变已存在的数值。
test('活动图覆盖闰日和空年份', () => {
  const days = activityCalendar({ '2024-02-29': 8 }, 2024, '2026-10-28').flatMap((week) => week.days);
  assert.equal(days.filter((day) => day.available).length, 366);
  assert.equal(days.find((day) => day.day === '2024-02-29').value, 8);
  assert.equal(activityCalendar({}, 2026, '2026-10-28').at(-1).cumulative, 0);
  assert.equal(activityLevel(0, 10), 0);
  assert.equal(activityLevel(0.01, 10), 1);
  assert.equal(activityLevel(10, 10), 4);
});
