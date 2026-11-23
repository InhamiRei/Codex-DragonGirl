// 渲染器退出后在同一个原生窗口重新载入本地页面，保留窗口的位置、大小和用户选择的显隐状态。
export function recoverWindowRenderer(window, url, isStopping, onGone) {
  let timer, lastAttempt = 0;
  // 连续崩溃时放慢重载；关闭窗口或正在退出应用时不再启动渲染进程。
  function retry() {
    if (timer || isStopping() || window.isDestroyed()) return;
    timer = setTimeout(() => {
      timer = null;
      if (isStopping() || window.isDestroyed()) return;
      lastAttempt = Date.now();
      void window.loadURL(url).catch(() => {
        if (!window.isDestroyed() && window.webContents.isCrashed()) retry();
      });
    }, Math.max(0, lastAttempt + 5000 - Date.now()));
    timer.unref();
  }
  window.webContents.on('render-process-gone', (_event, { reason }) => {
    if (isStopping() || window.isDestroyed()) return;
    console.warn('窗口页面已退出，正在恢复：', reason);
    onGone?.();
    retry();
  });
  window.once('closed', () => clearTimeout(timer));
}
