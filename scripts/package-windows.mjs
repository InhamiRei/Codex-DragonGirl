import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyAudioLibrary } from '../src/core/audio-library-store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Windows x64 安装包需在 Windows x64 电脑或 GitHub Actions 中构建。');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'output');
const name = `Codex-DragonGirl-${pkg.version}-Windows-x64`;
const bundle = path.join(output, name);
const application = path.join(bundle, 'resources/app');
const native = path.join(root, 'native/bin/dragongirl-native.exe');
await fs.access(native);
// 构建前强制检查随包音效，避免再次发布新电脑默认无声的安装包。
if (!(await verifyAudioLibrary(path.join(root, 'assets/audio'))).complete)
  throw new Error('内置原声音效缺失或损坏，Windows 安装包未生成。');

// 成品仅复制 Electron 运行时与明确列出的应用文件，不复制本机配置或制作缓存。
await fs.mkdir(output, { recursive: true });
await fs.rm(bundle, { recursive: true, force: true });
await fs.cp(path.join(root, 'node_modules/electron/dist'), bundle, { recursive: true });
await fs.rename(path.join(bundle, 'electron.exe'), path.join(bundle, 'DragonGirl.exe'));
await fs.mkdir(application, { recursive: true });
for (const folder of ['src', 'assets', 'docs'])
  await fs.cp(path.join(root, folder), path.join(application, folder), { recursive: true });
for (const file of ['README.md', 'CHANGELOG.md'])
  await fs.copyFile(path.join(root, file), path.join(application, file));
await fs.mkdir(path.join(application, 'native/bin'), { recursive: true });
await fs.copyFile(native, path.join(application, 'native/bin/dragongirl-native.exe'));
const runtimePackage = { ...pkg };
delete runtimePackage.scripts;
delete runtimePackage.devDependencies;
await fs.writeFile(path.join(application, 'package.json'), JSON.stringify(runtimePackage, null, 2));
await fs.writeFile(path.join(bundle, '使用说明.txt'), '\ufeff' + [
  'GPT龙娘 · 作者 Hey、小怪兽',
  '请先完整解压 ZIP，再双击 DragonGirl.exe。不要只拖出单个 EXE。',
  '支持 Windows 10 / 11 x64；无需安装 Node.js、npm 或开发工具。',
  '账户统计需要本机已安装并登录 Codex；九段原声音效已内置，首次打开即可离线播放。',
  '本版本未作商业代码签名。请从项目官方 Release 下载并核对 SHA-256。',
  '用户数据：%APPDATA%\\Codex DragonGirl\\',
  '升级前退出旧版，再解压新版到新目录；保留上述用户数据目录即可保留设置与账本。',
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
const bytes = await fs.readFile(zip);
const manifest = {
  version: pkg.version, platform: 'Windows', architecture: 'x64', minimumOS: 'Windows 10',
  signed: false, executable: `${name}/DragonGirl.exe`,
  files: [{ name: path.basename(zip), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
};
await fs.writeFile(path.join(output, 'release-manifest-Windows-x64.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
