import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// 模拟系统事件和窗口边界，运行真实的角色跟随逻辑，不打开桌面窗口。
const electron = 'data:text/javascript,' + encodeURIComponent(`
  import { EventEmitter } from 'node:events';
  export const screen = new EventEmitter(), powerMonitor = new EventEmitter();
  export const BrowserWindow = {}, Menu = {}, Tray = {}, globalShortcut = {}, app = {}, ipcMain = {};
  export const nativeImage = { createFromPath: () => ({ isEmpty: () => false,
    getSize: () => ({ width: 400, height: 350 }) }) };
`);
const hook = registerHooks({
  // 其他依赖仍使用源码，避免把跟随逻辑本身换成模拟实现。
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: electron, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
let Companion;
try { ({ Companion } = await import('../src/main/companion.js')); }
finally { hook.deregister(); }
const { screen, powerMonitor } = await import(electron);

// 记录原生窗口收到的几何与可见性，便于检查两份宿主快照之间的状态。
function mockWindow(initialBounds) {
  let bounds = initialBounds, visible = false;
  return {
    loadURL: async () => {},
    isDestroyed: () => false,
    isVisible: () => visible,
    getBounds: () => bounds,
    setBounds: (next) => { bounds = next; },
    setAlwaysOnTop: () => {},
    setIgnoreMouseEvents: () => {},
    showInactive: () => { visible = true; },
    hide: () => { visible = false; },
    destroy: () => {},
    webContents: { send: () => {} },
  };
}

// 独立桌面锚点留在主屏，Codex 宿主始终位于副屏。
async function fixture(t) {
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } };
  primary.workArea = { ...primary.bounds, y: 24, height: 876 };
  const secondary = { id: 2, bounds: { x: 1440, y: 0, width: 1280, height: 900 } };
  secondary.workArea = { ...secondary.bounds, y: 24, height: 876 };
  let displays = [primary, secondary];
  screen.getAllDisplays = () => displays;
  screen.getPrimaryDisplay = () => primary;
  screen.getDisplayMatching = (frame) => displays.includes(secondary) && frame.x >= secondary.bounds.x ? secondary : primary;
  const pet = new Companion('placement-test', { secondary: true, initiallySuppressed: true });
  t.after(() => pet.stop());
  pet.store.load = async () => ({ scale: 1, placement: null });
  pet.store.flush = async () => {};
  pet.registerIpc = () => {};
  pet.pollCursor = () => {};
  // 跳过素材与 IPC 握手，保留 start 中真实的显示器和电源事件注册。
  pet.createWindow = (view, bounds) => {
    pet.windows.set(view, mockWindow(bounds));
    pet.ready.add(view);
    if (pet.ready.size === 2) {
      clearTimeout(pet.startupTimer);
      pet.resolveReady();
    }
  };
  await pet.start();
  pet.setFollowMode(true);
  const host = { x: 1550, y: 60, width: 900, height: 800 };
  const offset = { x: 0.85, y: 0.9 };
  pet.followFrame(host, offset);
  return { pet, primary, secondary, host, offset, setDisplays: (value) => { displays = value; } };
}

// 工作区更新和唤醒不应先把角色送回桌面锚点，再等待原生桥纠正。
test('跟随副屏时，工作区变化和唤醒不会移动角色或翻转朝向', async (t) => {
  const { pet, primary, secondary, host, offset } = await fixture(t);
  pet.showBubble('位置回归验证', 'speech');
  // 同时记录实际窗口位置和朝向，确认下一份宿主快照前也没有短暂回跳。
  const sample = () => ({ ...pet.snapshot(), facing: pet.facingLeft });
  const original = sample();
  assert.equal(original.facing, false, '初始角色位于副屏宿主的右半边');
  screen.emit('display-metrics-changed', {}, primary, ['workArea']);
  const during = sample();
  pet.followFrame({ ...host }, offset);
  assert.deepEqual(sample(), original, '宿主未移动，下一份快照应保持副屏位置与朝向');
  assert.deepEqual(during, original, '主屏工作区变化把角色或气泡移出了副屏');
  powerMonitor.emit('resume');
  assert.deepEqual(sample(), original, '唤醒时不应写入独立桌面坐标');

  // 副屏工作区确实变小时，按原来的跟随锚点重新约束角色。
  secondary.workArea = { ...secondary.workArea, height: 650 };
  screen.emit('display-metrics-changed', {}, secondary, ['workArea']);
  assert.equal(pet.character.x, original.character.x);
  assert.equal(pet.character.y + pet.character.height, secondary.workArea.y + secondary.workArea.height);
  assert.equal(pet.facingLeft, original.facing);
  pet.followFrame({ ...host, x: host.x + 80 }, offset);
  assert.equal(pet.character.x, original.character.x + 80, '另一份副屏窗口快照仍能更新位置');
});

// 断开时原生桥可能还保留旧快照，只有宿主确实出现在主屏才可以跟过去。
test('副屏断开时收起角色，恢复副屏或宿主真正移屏后继续跟随', async (t) => {
  const { pet, primary, secondary, host, offset, setDisplays } = await fixture(t);
  const character = pet.windows.get('character');
  const original = character.getBounds();
  assert.equal(character.isVisible(), true);
  setDisplays([primary]);
  screen.emit('display-removed', {}, secondary);
  assert.equal(character.isVisible(), false);
  assert.deepEqual(character.getBounds(), original, '不能把已失效的副屏坐标钳到主屏');
  pet.followFrame(host, offset);
  assert.equal(character.isVisible(), false);

  setDisplays([primary, secondary]);
  screen.emit('display-added', {}, secondary);
  assert.equal(character.isVisible(), true, '不需要等待内容相同的宿主快照再次发出');
  assert.deepEqual(character.getBounds(), original);

  pet.followFrame({ ...host, x: 150 }, offset);
  assert.equal(pet.display.id, primary.id);
  assert.equal(character.isVisible(), true);
});
