import { app, protocol, net, dialog, shell } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Monitor } from './monitor.js';
import { Dashboard } from './dashboard.js';
import { Companion, companionAppearance } from './companion.js';
import { resolveResourcePath } from './resources.js';
import { createLaunchReporter } from './launcher-status.js';
import { resolveAudioPath } from '../core/audio-library-store.js';
import { accountTestPreview } from './test-preview.js';
import { StartupController } from './startup.js';
import { startupReason } from '../core/startup-policy.js';
import { SettingsStore } from '../core/settings.js';
import { AppUpdates } from '../core/app-updates.js';
import { fetchUpdateResource, markUpdateDownload, launchWindowsUpdate } from './update-platform.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const testMode = process.env.DRAGONGIRL_TEST === '1';
const reportLaunch = createLaunchReporter(ROOT, process.env.DRAGONGIRL_LAUNCH_STATUS);
app.setName('Codex DragonGirl');
// Windows 通知与托盘使用稳定的应用标识，避免被识别成通用 Electron。
if (process.platform === 'win32') app.setAppUserModelId('com.inhamirei.dragongirl');
if (testMode && path.isAbsolute(process.env.DRAGONGIRL_DATA_DIR || ''))
  app.setPath('userData', process.env.DRAGONGIRL_DATA_DIR);

// 使用本地自定义协议加载模块，页面不能读取主进程源码或任意磁盘文件。
protocol.registerSchemesAsPrivileged([
  { scheme: 'dragon', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'dragon-preview', privileges: { standard: true, secure: true } },
]);
let companion, monitor, dashboard, startup, installerOnQuit;
let quitAfterSave = false,
  closing = false;
const hasLock = app.requestSingleInstanceLock();

// 安装器输入来自校验通过的本地缓存，渲染窗口只能请求执行已准备好的更新。
async function openUpdateFile(file, format) {
  if (format === 'setup') {
    if (process.platform !== 'win32' || !app.isPackaged) throw new Error('请在 Windows 发行版中安装更新。');
    installerOnQuit = file;
    setImmediate(() => app.quit());
    return;
  }
  const error = await shell.openPath(file);
  if (error) throw new Error('无法打开下载文件：' + error);
}

if (!hasLock) {
  // 第二次启动成功通知现有实例后再反馈，启动器不会把正常去重当成异常退出。
  void reportLaunch('ready').finally(() => app.quit());
} else {
  // 重复启动只叫出已有角色，不创建两份叠在一起的桌宠。
  app.on('second-instance', (_event, argv) => {
    if (startupReason(argv) !== 'manual' || closing) return;
    startup?.retain();
    if (!companion?.stopping) companion?.show();
    void dashboard?.open();
  });
  app.on('activate', () => {
    if (!dashboard || closing) return;
    startup?.retain();
    if (!companion?.stopping) companion?.show();
  });
  app.on('window-all-closed', () => {});

  // 显式等待异步配置写入结束，拖动后立刻退出仍可正确恢复位置。
  app.on('before-quit', (event) => {
    if (quitAfterSave || !startup) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void (async () => {
      await startup.prepareQuit().catch((error) => console.error('暂停自动启动失败：', error.message));
      // 某一模块清理失败仍继续回收其他模块，避免后台进程和位置保存被跳过。
      for (const [name, controller] of [['管理窗口', dashboard], ['统计采集', monitor], ['桌面角色', companion]])
        await controller?.stop().catch((error) => console.error(`结束${name}失败：`, error.message));
    })().finally(() => {
      void startup.stop().catch((error) => console.error('结束启动联动失败：', error.message)).finally(async () => {
        if (installerOnQuit) {
          try { await launchWindowsUpdate(installerOnQuit); }
          catch (error) {
            dialog.showErrorBox('更新未能启动', '将重新打开当前版本。\n' + error.message);
            app.relaunch();
          }
        }
        quitAfterSave = true;
        app.quit();
      });
    });
  });

  // 应用只注册运行所需的文件白名单，不提供外部网络或通用文件读取入口。
  app
    .whenReady()
    .then(async () => {
      // 生成内容使用独立来源，主页面仍只允许项目脚本，且保留严格的资源白名单。
      protocol.handle('dragon-preview', (request) => accountTestPreview(request.url, dashboard?.tests));
      protocol.handle('dragon', async (request) => {
        let resolved = resolveResourcePath(ROOT, request.url);
        const userAsset = /^dragon:\/\/app\/user-assets\/([a-f0-9]{32}\.(png|webp|wav|mp3|ogg))$/.exec(
          request.url,
        );
        if (userAsset) {
          const directory = path.join(app.getPath('userData'), 'assets');
          // 原声地址兼容旧版已安装的文件，新电脑则直接读取安装包内经过校验的副本。
          resolved = /\.(wav|mp3|ogg)$/.test(userAsset[1])
            ? await resolveAudioPath(directory, userAsset[1], path.join(ROOT, 'assets/audio'))
            : path.join(directory, userAsset[1]);
        }
        if (!resolved) return new Response('Not found', { status: 404 });
        const source = await net.fetch(pathToFileURL(resolved).href);
        const headers = new Headers(source.headers);
        if (userAsset) headers.set('Cache-Control', 'no-store');
        headers.set(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; media-src 'self'; frame-src dragon-preview:; base-uri 'none'; form-action 'none'",
        );
        const types = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.png': 'image/png',
          '.webp': 'image/webp',
          '.wav': 'audio/wav',
          '.mp3': 'audio/mpeg',
          '.ogg': 'audio/ogg',
        };
        if (types[path.extname(resolved)]) headers.set('Content-Type', types[path.extname(resolved)]);
        return new Response(source.body, { status: source.status, headers });
      });
      app.dock?.hide();
      const initialSettings = await new SettingsStore(app.getPath('userData')).load();
      startup = new StartupController({ app, root: ROOT, directory: app.getPath('userData'), testMode });
      if (!(await startup.start(initialSettings))) {
        startup.hostExit = true;
        app.quit();
        return;
      }
      companion = new Companion(app.getPath('userData'), {
        // 跟随模式等首份宿主快照后再显示，手动启动时也不会短暂浮在其他应用上方。
        testMode, initiallySuppressed: initialSettings.mode === 'follow' && (!testMode || process.env.DRAGONGIRL_MONITOR_TEST === '1'),
        // 内置角色首帧使用已保存的角色和瞳色，导入图片继续走原有恢复流程。
        appearance: initialSettings.characterAsset ? undefined
          : companionAppearance(initialSettings, path.join(app.getPath('userData'), 'assets')),
      });
      if (testMode) globalThis.__dragonGirlTest = companion;
      await companion.start();
      if (!testMode || process.env.DRAGONGIRL_MONITOR_TEST === '1') {
        monitor = new Monitor(app.getPath('userData'), {
          testMode: testMode && process.env.DRAGONGIRL_LIVE_VERIFY !== '1',
        });
        const updates = new AppUpdates({ current: app.getVersion(), directory: path.join(app.getPath('userData'), 'updates'),
          installed: process.platform === 'win32' && existsSync(path.join(path.dirname(process.execPath), 'Uninstall DragonGirl.exe')),
          fetch: fetchUpdateResource, markDownload: markUpdateDownload, openFile: openUpdateFile, openPage: (url) => shell.openExternal(url) });
        dashboard = new Dashboard(monitor, companion, startup, updates);
        // 隔离桌面测试自行注入发布数据，正常启动及长期运行自动检测新版本。
        if (!testMode) updates.start();
        globalThis.__dragonGirlApp = { monitor, dashboard, companion, startup };
        await monitor.start();
        if (startup.reason === 'manual') await dashboard.open();
      }
      await reportLaunch('ready');
      // 原生实点验收只从源码运行，发行包不携带调试脚本。
      if (
        testMode &&
        !app.isPackaged &&
        process.argv.includes('--native-preview') &&
        path.isAbsolute(process.env.DRAGONGIRL_NATIVE_REPORT || '')
      ) {
        const { startNativeHarness } = await import('../../scripts/native-harness.mjs');
        await startNativeHarness(companion, process.env.DRAGONGIRL_NATIVE_REPORT);
      }
    })
    .catch(async (error) => {
      console.error(error);
      // 应用启动器负责显示握手错误；命令行直接启动时保留 Electron 原生错误框。
      const reported = await reportLaunch('error', error.message);
      if (!reported && startupReason(process.argv) === 'manual') dialog.showErrorBox('龙娘暂时没能启动', error.message);
      app.quit();
    });
}
