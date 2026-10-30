import test from 'node:test';
import assert from 'node:assert/strict';
import { followWindowFrame } from '../src/shared/follow-window.js';

const main = { id: 1, x: 200, y: 125, width: 1100, height: 792 };
const picker = { id: 2, x: 310, y: 297, width: 880, height: 448 };

// 原生面板开关时只改变显示许可，关闭后的目标继续使用主窗口当前位置。
test('文件夹选择框出现时隐藏，关闭后恢复主窗口', () => {
  const process = { platform: 'darwin', windows: [main], modalOpen: false };
  assert.equal(followWindowFrame(process), main);
  process.windows = [picker, main];
  process.modalOpen = true;
  assert.equal(followWindowFrame(process), null);
  process.windows = [{ ...main, x: 400 }];
  process.modalOpen = false;
  assert.equal(followWindowFrame(process), process.windows[0]);
});

// 不要求新增辅助功能或录屏权限，几何兜底也不读取依赖语言的窗口标题。
test('无模态权限信息时识别居中或顶部附着的系统 sheet', () => {
  for (const panel of [picker, { ...picker, y: main.y + 32 }, { ...picker, x: 100, width: 1300 }])
    assert.equal(followWindowFrame({ platform: 'darwin', windows: [panel, main] }), null);
  assert.equal(followWindowFrame({ platform: 'darwin', windows: [main] }), main);
});

// 已经打开选择框再启动龙娘也必须隐藏，不依赖之前记住的窗口编号。
test('首次快照就是选择框时也不会把它当主窗口', () => {
  assert.equal(followWindowFrame({ platform: 'darwin', windows: [picker, main] }), null);
  assert.equal(followWindowFrame({ platform: 'darwin', windows: [picker], modalOpen: true }), null);
});

// 确认非模态的独立窗口可以正常切换，不能简单按窗口大小或窗口数量隐藏。
test('多个正常窗口保留最前方跟随目标', () => {
  assert.equal(followWindowFrame({ platform: 'darwin', windows: [picker, main], modalOpen: false }), picker);
  const separate = { ...picker, x: main.x + main.width + 10 };
  assert.equal(followWindowFrame({ platform: 'darwin', windows: [separate, main] }), separate);
  assert.equal(followWindowFrame({ platform: 'darwin', windows: [main, picker] }), main);
});

// macOS 的几何兜底不改变 Windows 的物理坐标窗口选择，最小化和退出仍返回空目标。
test('保留其他平台和空窗口的跟随行为', () => {
  assert.equal(followWindowFrame({ coordinateSpace: 'physical', windows: [picker, main] }), picker);
  assert.equal(followWindowFrame({ platform: 'darwin', windows: [] }), null);
  assert.equal(followWindowFrame(undefined), null);
});
