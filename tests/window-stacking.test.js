import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// 只替换 Electron 边界，让实际 Companion 层级逻辑能在 macOS/CI 上验证 Windows 的失败恢复路径。
const hook = registerHooks({
  // 仅拦截原生 Electron 模块，其余项目依赖仍按真实源码加载。
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return {
      url: 'data:text/javascript,export const BrowserWindow={},Menu={},Tray={},nativeImage={},ipcMain={},screen={},powerMonitor={},globalShortcut={},app={};',
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
});
let Companion;
try { ({ Companion } = await import('../src/main/companion.js')); }
finally { hook.deregister(); }

// 原生快照与 Electron 缓存分别控制，模拟系统拒绝调用但 Electron 没有抛错的偶发情况。
function fixture(t, { order, topmost = [], cached = false }) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const calls = [];
  // 测试窗口只记录边界调用，不在宿主操作系统创建窗口或移动鼠标。
  function window(id) {
    let raised = cached;
    return {
      isDestroyed: () => false,
      isVisible: () => true,
      getMediaSourceId: () => `window:${id}:0`,
      getBounds: () => ({ x: 100, y: 100, width: 200, height: 200 }),
      isAlwaysOnTop: () => raised,
      // 缓存接受新值，但实际系统状态仅由下一份测试快照确认。
      setAlwaysOnTop(value) { raised = value; calls.push([id, 'topmost', value]); },
      // 相对排序保留目标编号，便于核对覆盖应用仍位于整组之前。
      moveAbove(above) { calls.push([id, 'above', above]); },
      // 单独记录普通组置前，检测是否重新走入受系统限制的路径。
      moveTop() { calls.push([id, 'top']); },
    };
  }
  const pet = Object.assign(Object.create(Companion.prototype), {
    windows: new Map([['character', window(2)], ['bubble', window(3)]]),
    followMode: true, followTarget: { id: 1 }, followOrder: order, followTopmost: topmost,
    character: { x: 100, y: 100, width: 200, height: 200 }, bubbleVisible: true,
    // 宿主失效时只记录隐藏请求，避免测试落入真实窗口位置与手势处理。
    followFrame(frame) { calls.push(['follow', frame]); },
  });
  Companion.registry.add(pet);
  t.after(() => {
    Companion.registry.delete(pet);
    Object.defineProperty(process, 'platform', platform);
  });
  return { pet, calls };
}

// 松手后系统状态不再变化，重复心跳仍要纠正失败的置顶调用；成功后则不再重复设置或排序。
test('Windows 层级调用未生效时，同一快照可重试并在实际恢复后停止补偿', (t) => {
  const { pet, calls } = fixture(t, { order: [1, 2, 3] });
  pet.syncWindowStacking();
  calls.length = 0;
  // 原生排序没有生效，窗口顺序和置顶样式仍与之前完全相同。
  pet.syncWindowStacking();
  for (const [id, above] of [[2, 1], [3, 2]])
    assert.deepEqual(calls.filter(([target]) => target === id), [
      [id, 'topmost', false], [id, 'topmost', true], [id, 'above', `window:${above}:0`],
    ]);
  calls.length = 0;
  pet.followOrder = [3, 2, 1];
  pet.followTopmost = [3, 2];
  pet.syncWindowStacking();
  pet.syncWindowStacking();
  assert.deepEqual(calls, [], '稳定状态不应反复切换层级或重新显示窗口');
});

// 后台恢复也必须核对系统样式，不能让缓存里的普通窗口实际上一直覆盖其他应用。
test('Windows 缓存已降级但系统仍置顶时重试降级，并恢复到覆盖应用后面', (t) => {
  const { pet, calls } = fixture(t, { order: [3, 2, 9, 1], topmost: [3, 2] });
  pet.syncWindowStacking();
  for (const [id, above] of [[2, 1], [3, 2]])
    assert.deepEqual(calls.filter(([target]) => target === id), [
      [id, 'topmost', true], [id, 'topmost', false], [id, 'above', `window:${above}:0`],
    ]);
  calls.length = 0;
  pet.followOrder = [9, 3, 2, 1];
  pet.followTopmost = [];
  pet.syncWindowStacking();
  assert.deepEqual(calls, []);
});

// 宿主消失时不能为了恢复可见性而把角色留在桌面上。
test('Windows 宿主已最小化或关闭时停止排序并请求隐藏', (t) => {
  const { pet, calls } = fixture(t, { order: [3, 2, 9], topmost: [3, 2], cached: true });
  pet.syncWindowStacking();
  assert.deepEqual(calls, [['follow', null]]);
});
