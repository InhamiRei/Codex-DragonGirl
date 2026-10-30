import { app, protocol, net, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Monitor } from './monitor.js';
import { Dashboard } from './dashboard.js';
import { Companion } from './companion.js';
import { resolveResourcePath } from './resources.js';
import { createLaunchReporter } from './launcher-status.js';
import { resolveAudioPath } from '../core/audio-library-store.js';
import { accountTestPreview } from './test-preview.js';

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
let companion, monitor, dashboard;
let quitAfterSave = false,
  closing = false;
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  // 第二次启动成功通知现有实例后再反馈，启动器不会把正常去重当成异常退出。
  void reportLaunch('ready').finally(() => app.quit());
} else {
  // 重复启动只叫出已有角色，不创建两份叠在一起的桌宠。
  app.on('second-instance', () => {
    if (!companion?.stopping) companion?.show();
  });
  app.on('activate', () => {
    if (!companion?.stopping) companion?.show();
  });
  app.on('window-all-closed', () => {});

  // 显式等待异步配置写入结束，拖动后立刻退出仍可正确恢复位置。
  app.on('before-quit', (event) => {
    if (quitAfterSave || !companion) return;
    event.preventDefault();
    if (closing || companion.stopping) return;
    closing = true;
    void (async () => {
      await dashboard?.stop();
      await monitor?.stop();
      await companion.stop();
    })().finally(() => {
      quitAfterSave = true;
      app.quit();
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
      companion = new Companion(app.getPath('userData'), { testMode });
      if (testMode) globalThis.__dragonGirlTest = companion;
      await companion.start();
      if (!testMode || process.env.DRAGONGIRL_MONITOR_TEST === '1') {
        monitor = new Monitor(app.getPath('userData'), {
          testMode: testMode && process.env.DRAGONGIRL_LIVE_VERIFY !== '1',
        });
        dashboard = new Dashboard(monitor, companion);
        globalThis.__dragonGirlApp = { monitor, dashboard, companion };
        await monitor.start();
        await dashboard.open();
      }
      await reportLaunch('ready');
      // 原生实点验收必须同时具备测试标记、显式参数和独立报告路径。
      if (
        testMode &&
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
      if (!reported) dialog.showErrorBox('龙娘暂时没能启动', error.message);
      app.quit();
    });
}
