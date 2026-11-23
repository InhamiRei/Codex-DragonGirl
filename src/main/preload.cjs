const { contextBridge, ipcRenderer } = require('electron');

// 订阅固定的桌面消息并返回清理函数，渲染层拿不到 Electron 或任意 IPC 权限。
function subscribe(channel, listener) {
  const callback = (_event, value) => listener(value);
  ipcRenderer.on(channel, callback);
  return () => ipcRenderer.removeListener(channel, callback);
}

// 每收到一次磁盘端的请求才编码和转交下一块，独立端口随渲染进程关闭。
function importAudioClip(label, nextChunk) {
  return new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = ({ data }) => {
      try {
        if (data === 'next') {
          // 主进程的 MessagePortMain 只接收序列化的音频块，传输列表只支持消息端口。
          port1.postMessage(nextChunk());
          return;
        }
        port1.close();
        if (data.error) reject(new Error(data.error));
        else resolve(data.clip);
      } catch (error) {
        port1.close();
        reject(error);
      }
    };
    ipcRenderer.postMessage('dg:import-audio', label, [port2]);
  });
}

// 只暴露本轮交互需要的窄接口，角色和气泡共用这层受限桥接。
contextBridge.exposeInMainWorld(
  'dragonGirl',
  Object.freeze({
    command: (command, value) => ipcRenderer.invoke('dg:command', command, value),
    importAudioClip,
    onMonitor: (listener) => subscribe('dg:monitor', listener),
    // 更新窗口只订阅主进程已经筛选的发布状态。
    onAppUpdate: (listener) => subscribe('dg:update-state', listener),
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
    // 气泡只回报当前祈祷播放编号，角色动作由主进程统一收尾。
    prayerTyped: (typingId) => ipcRenderer.send('dg:prayer-typed', typingId),
    // 特效页只接收本地波心和回报动画结束。
    onPrayerWave: (listener) => subscribe('dg:prayer-wave', listener),
    prayerWaveFinished: () => ipcRenderer.send('dg:prayer-wave-finished'),
    measureBubble: (measurement) => ipcRenderer.send('dg:bubble-measured', measurement),
    assetError: () => ipcRenderer.send('dg:asset-error'),
    onCursor: (listener) => subscribe('dg:cursor', listener),
    // 轻戳事件来自主进程的手势判定，渲染层只订阅固定通道。
    onPoke: (listener) => subscribe('dg:poke', listener),
    onInputState: (listener) => subscribe('dg:input-state', listener),
    onLayout: (listener) => subscribe('dg:layout', listener),
    onDragging: (listener) => subscribe('dg:dragging', listener),
    onCancelled: (listener) => subscribe('dg:cancelled', listener),
    onBubble: (listener) => subscribe('dg:bubble', listener),
  }),
);
