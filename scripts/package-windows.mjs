import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import builder from 'electron-builder';
import { verifyAudioLibrary } from '../src/core/audio-library-store.js';
import { copyReleasePayload, readReleaseVersion, releaseFileInfo, verifyReleasePayload } from './release-payload.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Windows x64 安装包需在 Windows x64 电脑或 GitHub Actions 中构建。');
const version = await readReleaseVersion(root);
const output = path.join(root, 'output');
const name = `Codex-DragonGirl-${version}-Windows-x64`;
const bundle = path.join(output, name);
const application = path.join(bundle, 'resources/app');
const native = path.join(root, 'native/bin/dragongirl-native.exe');
await fs.access(native);
// 构建前强制检查随包音效，避免再次发布新电脑默认无声的安装包。
if (!(await verifyAudioLibrary(path.join(root, 'assets/audio'))).complete)
  throw new Error('内置原声音效缺失或损坏，Windows 安装包未生成。');

// 通过锁定的 Electron 包准备运行时，干净环境首次打包也会下载对应平台的二进制。
const { default: electron } = await import('electron');
// 成品仅复制 Electron 运行时与明确列出的应用文件，不复制本机配置或制作缓存。
await fs.mkdir(output, { recursive: true });
await fs.rm(bundle, { recursive: true, force: true });
await fs.cp(path.dirname(electron), bundle, { recursive: true });
await fs.rename(path.join(bundle, path.basename(electron)), path.join(bundle, 'DragonGirl.exe'));
await copyReleasePayload(root, application, '.exe');
await verifyReleasePayload(root, application, version, '.exe');
await fs.writeFile(path.join(bundle, '使用说明.txt'), '\ufeff' + [
  'GPT龙娘 · 作者 Hey、小怪兽',
  '安装版请双击 Setup 安装器；使用便携 ZIP 时请完整解压，再双击 DragonGirl.exe。',
  '支持 Windows 10 / 11 x64；无需安装 Node.js、npm 或开发工具。',
  '账户统计需要本机已安装并登录 Codex；九段原声音效已内置，首次打开即可离线播放。',
  '本版本未作商业代码签名。请从项目官方 Release 下载并核对 SHA-256。',
  '用户数据：%APPDATA%\\Codex DragonGirl\\',
  '点击管理窗口版本旁的更新按钮可切换到安装版，之后可在龙娘内重启更新。也可从发布页下载便携 ZIP。',
  '项目：https://github.com/InhamiRei/Codex-DragonGirl',
  '',
].join('\r\n'));
const zip = path.join(output, name + '.zip');
await fs.rm(zip, { force: true });
// 路径通过环境变量传递，中文、空格和引号不参与 PowerShell 源码拼接。
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '$ErrorActionPreference = "Stop"; Compress-Archive -LiteralPath $env:DRAGONGIRL_PACKAGE_DIR -DestinationPath $env:DRAGONGIRL_PACKAGE_ZIP -CompressionLevel Optimal'], {
  env: { ...process.env, DRAGONGIRL_PACKAGE_DIR: bundle, DRAGONGIRL_PACKAGE_ZIP: zip },
  encoding: 'utf8', windowsHide: true,
});
if (result.status !== 0) throw new Error(`Windows 压缩失败：${result.stderr || result.error?.message}`);
// 用同一份已验证的目录制作当前用户 NSIS 安装器；自动更新复用 GitHub 正式附件和稳定应用标识。
const installer = name + '-Setup.exe';
await builder.build({
  projectDir: root, prepackaged: bundle, publish: 'never',
  targets: builder.Platform.WINDOWS.createTarget(['nsis'], builder.Arch.x64),
  config: {
    appId: 'com.inhamirei.dragongirl', productName: 'Codex DragonGirl', directories: { output }, publish: null,
    win: { executableName: 'DragonGirl', signAndEditExecutable: false },
    nsis: { artifactName: installer, oneClick: true, perMachine: false, runAfterFinish: true,
      shortcutName: 'GPT龙娘', deleteAppDataOnUninstall: false, differentialPackage: false },
  },
});
const manifest = {
  version, platform: 'Windows', architecture: 'x64', minimumOS: 'Windows 10',
  signed: false, executable: `${name}/DragonGirl.exe`,
  files: [await releaseFileInfo(zip), await releaseFileInfo(path.join(output, installer))],
};
await fs.writeFile(path.join(output, 'release-manifest-Windows-x64.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
