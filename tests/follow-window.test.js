import test from 'node:test';
import assert from 'node:assert/strict';
import { followWindowFrame, followWindowStack, followWindowFloating } from '../src/shared/follow-window.js';

const main = { id: 1, x: 200, y: 125, width: 1100, height: 792 };
const picker = { id: 2, x: 310, y: 297, width: 880, height: 448 };

// 前台宿主不再依赖每次点击后的补偿排序；角色自身及其他实例角色不能改变前台判断。
test('macOS 未被遮挡的宿主保持浮动层，跨屏窗口与角色自身不触发层级切换', () => {
  const cover = { ...main, id: 9 };
  assert.equal(followWindowFloating([picker, main, cover], main, [2, 3]), true);
  assert.equal(followWindowFloating([main, cover], main, [2, 3]), true);
  assert.equal(followWindowFloating([{ ...main, id: 8 }, picker, main, cover], main, [2, 3, 8]), true);
  assert.equal(followWindowFloating([cover, picker, main], main, [2, 3]), false);
  assert.equal(followWindowFloating([cover, main], main, [2, 3]), false);
  assert.equal(followWindowFloating([{ ...cover, x: 1729 }, main], main, [2, 3]), true);
  assert.equal(followWindowFloating([{ ...cover, x: main.x + main.width }, main], main, [2, 3]), true);
  assert.equal(followWindowFloating([{ ...cover, x: 1729 }, main], main, [2, 3], [{ x: 1730, y: main.y, width: 200, height: 200 }]), false);
  const exposedCharacter = { x: main.x + 900, y: main.y + 550, width: 200, height: 200 };
  const partialCover = { ...cover, width: 500 };
  assert.equal(followWindowFloating([partialCover, main], main, [2, 3], [exposedCharacter]), true);
  assert.equal(followWindowFloating([cover, main], main, [2, 3], [exposedCharacter]), false);
  assert.equal(followWindowFloating([], main, [2, 3]), false);
  assert.equal(followWindowFloating(undefined, main, [2, 3]), false);
});

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

// 角色和气泡必须紧贴宿主上方，其他应用仍保留在整组窗口之前。
test('宿主被遮挡时把角色与气泡一起退到覆盖窗口后面', () => {
  assert.deepEqual(followWindowStack([3, 2, 9, 1], 1, [2, 3]), [
    { id: '2', above: '1', top: false }, { id: '3', above: '2', top: false },
  ]);
  assert.deepEqual(followWindowStack([9, 3, 2, 1], 1, [2, 3]), []);
});

// 重新置前时只提升本实例的窗口，多个宿主之间不会互相带起角色。
test('宿主重新置前后恢复层级，其他实例与应用顺序保持原样', () => {
  assert.deepEqual(followWindowStack([1, 8, 7, 6, 9, 3, 2], 1, [2, 3]), [
    { id: '2', above: '1', top: true }, { id: '3', above: '2', top: true },
  ]);
  assert.deepEqual(followWindowStack([1, 8, 7, 6, 9, 3, 2], 6, [7, 8]), []);
});

// 首次显示的窗口可能还没进入快照；显式显示仍可排序，旧桥无顺序信息时也能使用窗口编号。
test('支持首次显示、单个角色、字符串编号和缺失顺序的快照', () => {
  assert.deepEqual(followWindowStack([9, 1], 1, [2, 3]), [
    { id: '2', above: '1', top: false }, { id: '3', above: '2', top: false },
  ]);
  assert.deepEqual(followWindowStack(['9', '2', '1'], 1, [2]), []);
  assert.deepEqual(followWindowStack(null, 1, [2, 3]), [
    { id: '2', above: '1', top: false }, { id: '3', above: '2', top: false },
  ]);
});

// 宿主已从屏幕消失时拒绝重排，避免在最小化或关闭与显示之间的竞争中误置顶。
test('宿主不在当前屏幕顺序中时停止显示', () => {
  assert.equal(followWindowStack([9, 3, 2], 1, [2, 3]), null);
  assert.equal(followWindowStack([], 1, [2]), null);
});

// Windows 在置顶组之后调用相对排序会继承置顶，普通宿主位于组边界时必须使用普通组顶端。
test('Windows 置顶窗口之后的宿主不会把角色和气泡变成全局置顶', () => {
  assert.deepEqual(followWindowStack([9, 1, 3, 2], 1, [2, 3], { topmost: [9] }), [
    { id: '2', above: '1', top: true }, { id: '3', above: '2', top: true },
  ]);
  assert.deepEqual(followWindowStack([9, 8, 1, 3, 2], 1, [2, 3], { topmost: [9] }), [
    { id: '2', above: '1', top: false }, { id: '3', above: '2', top: false },
  ]);
  assert.deepEqual(followWindowStack([9, 3, 2, 1], 1, [2, 3], { topmost: [9], force: true }), [
    { id: '2', above: '1', top: true }, { id: '3', above: '2', top: true },
  ]);
});

// 宿主被用户设为置顶时跟随该属性；宿主恢复普通层级后，即使排列相邻也要撤销角色的置顶。
test('Windows 宿主置顶属性改变时修正角色与气泡的层级组', () => {
  assert.deepEqual(followWindowStack([1, 3, 2], 1, [2, 3], { topmost: [1] }), [
    { id: '2', above: '1', top: false }, { id: '3', above: '2', top: false },
  ]);
  assert.deepEqual(followWindowStack([3, 2, 1], 1, [2, 3], { topmost: [3, 2] }), [
    { id: '2', above: '1', top: true }, { id: '3', above: '2', top: true },
  ]);
});
