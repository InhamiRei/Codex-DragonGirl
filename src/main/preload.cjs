const { contextBridge, ipcRenderer } = require('electron');

// 订阅固定的桌面消息并返回清理函数，渲染层拿不到 Electron 或任意 IPC 权限。
function subscribe(channel, listener) {
  const callback = (_event, value) => listener(value);
  ipcRenderer.on(channel, callback);
  return () => ipcRenderer.removeListener(channel, callback);
}

// 只暴露本轮交互需要的窄接口，角色和气泡共用这层受限桥接。
contextBridge.exposeInMainWorld(
  'dragonGirl',
  Object.freeze({
    command: (command, value) => ipcRenderer.invoke('dg:command', command, value),
    onMonitor: (listener) => subscribe('dg:monitor', listener),
    onAccountTests: (listener) => subscribe('dg:account-tests', listener),
    onSound: (listener) => subscribe('dg:sound', listener),
    onExpression: (listener) => subscribe('dg:expression', listener),
    onAudioReady: (listener) => subscribe('dg:audio-ready', listener),
    bootstrap: () => ipcRenderer.invoke('dg:bootstrap'),
    ready: () => ipcRenderer.send('dg:ready'),
    interactive: (enabled) => ipcRenderer.send('dg:interactive', enabled),
    beginGesture: (point) => ipcRenderer.send('dg:gesture-start', point),
    moveGesture: (point) => ipcRenderer.send('dg:gesture-move', point),
    endGesture: (point) => ipcRenderer.send('dg:gesture-end', point),
    cancelGesture: () => ipcRenderer.send('dg:gesture-cancel'),
    menu: (point) => ipcRenderer.send('dg:menu', point),
    // 发饰只请求受限的角色菜单，不提供任意命令或脚本执行入口。
    characterMenu: (point) => ipcRenderer.send('dg:character-menu', point),
    closeBubble: () => ipcRenderer.send('dg:close-bubble'),
    // 仅发送气泡交互意图，由主进程根据当前内容决定显示语录还是收起。
    advanceBubble: () => ipcRenderer.send('dg:advance-bubble'),
    measureBubble: (measurement) => ipcRenderer.send('dg:bubble-measured', measurement),
    assetError: () => ipcRenderer.send('dg:asset-error'),
    onCursor: (listener) => subscribe('dg:cursor', listener),
    onInputState: (listener) => subscribe('dg:input-state', listener),
    onLayout: (listener) => subscribe('dg:layout', listener),
    onDragging: (listener) => subscribe('dg:dragging', listener),
    onCancelled: (listener) => subscribe('dg:cancelled', listener),
    onBubble: (listener) => subscribe('dg:bubble', listener),
  }),
);
