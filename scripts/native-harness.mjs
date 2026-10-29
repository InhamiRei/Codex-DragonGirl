import { BrowserWindow, screen, app } from 'electron';
import fs from 'node:fs/promises';

// 仅由显式测试模式调用；真实鼠标动作下，角色的输入路由保持原样运行。
export async function startNativeHarness(companion, report) {
  const area = screen.getPrimaryDisplay().workArea;
  companion.character = { ...companion.character, x: area.x + 420, y: area.y + 240 };
  companion.applyCharacter();
  const bounds = companion.windows.get('character').getBounds();
  const target = new BrowserWindow({ x: bounds.x - 80, y: bounds.y - 100,
    width: bounds.width + 160, height: bounds.height + 180, show: false,
    frame: false, title: '龙娘原生穿透验收',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  // 两个标记分别位于透明角落与面部下方，点击只会影响本测试的计数。
  await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>龙娘原生穿透验收</title><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font:14px system-ui;background:#e9e1f3;color:#49345f}h1{font-size:16px;margin:22px}p{margin:22px}button{position:absolute;border:1px solid #a38ab9;border-radius:8px;background:#fff9ff;color:#614579}#clear{left:82px;top:102px;width:40px;height:40px}#face{left:212px;top:272px;width:60px;height:60px}footer{position:absolute;bottom:20px;left:22px}</style></head><body><h1>仅用于龙娘鼠标穿透验收</h1><p>透明处应点到底板，角色处应打开气泡。</p><button id="clear">透</button><button id="face">实</button><footer id="counter">底板收到点击：0</footer><script>window.clicks=0;document.addEventListener('click',()=>{window.clicks++;document.getElementById('counter').textContent='底板收到点击：'+window.clicks})</script></body></html>`));
  app.dock?.show();
  target.show();
  target.focus();
  companion.windows.get('character').showInactive();
  app.focus({ steal: true });
  let writing = false;
  // 只读保存本测试的状态，不采集桌面或其他应用的信息。
  const record = async () => {
    if (writing || target.isDestroyed()) return;
    writing = true;
    try {
      const value = { companion: companion.snapshot(), background: target.getBounds(), cursor: screen.getCursorScreenPoint(),
        backgroundClicks: await target.webContents.executeJavaScript('window.clicks') };
      await fs.writeFile(report, JSON.stringify(value, null, 2));
    } catch (error) { if (!companion.stopping) console.error('验收记录暂不可用：', error.message); }
    finally { writing = false; }
  };
  const timer = setInterval(() => void record(), 120);
  app.once('before-quit', () => clearInterval(timer));
  setTimeout(() => app.quit(), 180000).unref();
  await record();
  console.log('原生验收就绪，三分钟后自动退出。状态记录：' + report);
}
