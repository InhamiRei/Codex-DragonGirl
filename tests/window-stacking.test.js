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

// 模拟桥暂时不可用，检查重复快照仍会发出请求，并且不会回落到 Electron 的相对排序。
function fixture(t, order) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const calls = [];
  // 测试窗口只记录边界调用，不创建系统窗口或移动鼠标。
  function window(id) {
    return {
      isDestroyed: () => false,
      getMediaSourceId: () => `window:${id}:0`,
      // 只有显式模式切换才允许由 Electron 修改默认置顶属性。
      setAlwaysOnTop(value) { calls.push([id, 'topmost', value]); },
    };
  }
  const pet = Object.assign(Object.create(Companion.prototype), {
    windows: new Map([['character', window(2)], ['bubble', window(3)]]),
    followMode: true, followTarget: { id: 1 }, followOrder: order,
    delegate: {
      // 返回未送达模拟原生桥断线，下一次心跳必须重新尝试。
      stackWindows(host, overlays, owned) { calls.push({ host, overlays, owned }); return false; },
    },
    // 宿主失效时只记录隐藏请求，避免测试进入真实几何与手势处理。
    followFrame(frame) { calls.push(['follow', frame]); },
  });
  Companion.registry.add(pet);
  t.after(() => {
    Companion.registry.delete(pet);
    Object.defineProperty(process, 'platform', platform);
  });
  return { pet, calls };
}

// 相同快照不是确认回执，原生桥重启或调用被系统拒绝后仍要继续纠正。
test('Windows 同一静止快照会重试原生层级请求，不依赖 Electron 排序', (t) => {
  const { pet, calls } = fixture(t, [1, 2, 3]);
  pet.syncWindowStacking();
  pet.syncWindowStacking();
  const request = { host: 1, overlays: ['2', '3'], owned: ['2', '3'] };
  assert.deepEqual(calls, [request, request]);
});

// 桌面恢复必须排在旧跟随请求之后，不能被管道中尚未执行的旧请求降级。
test('Windows 切换桌面模式时发送有序恢复命令', (t) => {
  const { pet, calls } = fixture(t, [1, 2, 3]);
  pet.syncWindowStacking();
  pet.setFollowMode(false);
  assert.deepEqual(calls[0], { host: 1, overlays: ['2', '3'], owned: ['2', '3'] });
  assert.deepEqual(calls.at(-1), { host: 0, overlays: ['2', '3'], owned: [] });
  calls.length = 0;
  pet.syncWindowStacking();
  assert.deepEqual(calls, []);
});

// 宿主消失时不能为了恢复可见性而把角色留在桌面上。
test('Windows 宿主已最小化或关闭时停止排序并请求隐藏', (t) => {
  const { pet, calls } = fixture(t, [3, 2, 9]);
  pet.syncWindowStacking();
  assert.deepEqual(calls, [['follow', null]]);
});
