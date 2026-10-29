import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'output');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const appName = 'Codex 龙娘.app',
  bundle = path.join(output, appName),
  contents = path.join(bundle, 'Contents');
// 构建命令全部通过参数数组传递，中文和空格路径不会进入 shell 展开。
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0)
    throw new Error(
      `${path.basename(command)} 构建失败 (${result.status}): ${(result.stderr || result.stdout || '').slice(-2000)}`,
    );
}
// 只清理本项目输出目录中的同名生成物，不碰用户安装或配置。
await fs.mkdir(output, { recursive: true });
await fs.rm(bundle, { recursive: true, force: true });
run('/usr/bin/ditto', [path.join(root, 'node_modules/electron/dist/Electron.app'), bundle]);
const application = path.join(contents, 'Resources/app');
await fs.mkdir(application, { recursive: true });
for (const notice of ['LICENSE', 'LICENSES.chromium.html'])
  await fs.copyFile(
    path.join(root, 'node_modules/electron/dist', notice),
    path.join(contents, 'Resources', notice),
  );
for (const folder of ['src', 'assets', 'docs'])
  await fs.cp(path.join(root, folder), path.join(application, folder), { recursive: true });
await fs.mkdir(path.join(application, 'native/bin'), { recursive: true });
await fs.copyFile(
  path.join(root, 'native/bin/dragongirl-native'),
  path.join(application, 'native/bin/dragongirl-native'),
);
await fs.mkdir(path.join(application, 'scripts'), { recursive: true });
await fs.copyFile(
  path.join(root, 'scripts/native-harness.mjs'),
  path.join(application, 'scripts/native-harness.mjs'),
);
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
delete pkg.devDependencies;
delete pkg.scripts;
await fs.writeFile(path.join(application, 'package.json'), JSON.stringify(pkg, null, 2));
await fs.copyFile(path.join(root, 'README.md'), path.join(application, 'README.md'));
await fs.copyFile(path.join(root, 'CHANGELOG.md'), path.join(application, 'CHANGELOG.md'));
await fs.rename(path.join(contents, 'MacOS/Electron'), path.join(contents, 'MacOS/CodexDragonGirl'));
const plist = path.join(contents, 'Info.plist');
for (const [key, value] of Object.entries({
  CFBundleName: 'Codex 龙娘',
  CFBundleDisplayName: 'Codex 龙娘',
  CFBundleIdentifier: 'com.inhamirei.dragongirl',
  CFBundleExecutable: 'CodexDragonGirl',
  CFBundleShortVersionString: version,
  CFBundleVersion: version,
  LSMinimumSystemVersion: '15.0',
}))
  run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
run('/usr/libexec/PlistBuddy', ['-c', 'Add :LSUIElement bool true', plist]);
// 图标沿用透明角色素材，sips 仅执行打包所需尺寸转换。
const iconset = path.join(output, 'DragonGirl.iconset');
await fs.mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2])
    run('/usr/bin/sips', [
      '-z',
      String(size * scale),
      String(size * scale),
      path.join(root, 'assets/characters/codex-dragon-girl.png'),
      '--out',
      path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
    ]);
// 直接组合标准 ICNS PNG 块，兼容本机 iconutil 拒绝合法 iconset 的情况。
const entries = [
  ['icp4', '16x16'],
  ['ic11', '16x16@2x'],
  ['icp5', '32x32'],
  ['ic12', '32x32@2x'],
  ['ic07', '128x128'],
  ['ic13', '128x128@2x'],
  ['ic08', '256x256'],
  ['ic14', '256x256@2x'],
  ['ic09', '512x512'],
  ['ic10', '512x512@2x'],
];
const chunks = [];
for (const [type, name] of entries) {
  const png = await fs.readFile(path.join(iconset, `icon_${name}.png`));
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(8 + png.length, 4);
  chunks.push(header, png);
}
const header = Buffer.alloc(8);
header.write('icns');
header.writeUInt32BE(8 + chunks.reduce((s, b) => s + b.length, 0), 4);
await fs.writeFile(path.join(contents, 'Resources/electron.icns'), Buffer.concat([header, ...chunks]));
await fs.rm(iconset, { recursive: true, force: true });
// 本机分发采用 ad-hoc 签名，验证完整性；不宣称 Apple Developer ID 公证。
run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
const zip = path.join(output, `Codex-DragonGirl-${version}-macOS-arm64.zip`);
await fs.rm(zip, { force: true });
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip]);
// 安装映像内同时放入应用、Applications 快捷入口和简明说明。
const staging = path.join(output, 'dmg-staging');
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
run('/usr/bin/ditto', [bundle, path.join(staging, appName)]);
await fs.symlink('/Applications', path.join(staging, 'Applications'));
await fs.writeFile(
  path.join(staging, '安装说明.txt'),
  '将 Codex 龙娘.app 拖到 Applications，然后双击打开。\n首次运行会发现本机 Codex 与 Cockpit 实例，并建立本地用量索引。\n本包包含 Electron 与原生窗口桥，不需要 Node、npm 或源码。\n本机 ad-hoc 签名，未经过 Apple Developer ID 公证。系统如阻止首次打开，请在系统设置 → 隐私与安全性中允许此应用。\n数据目录：~/Library/Application Support/Codex DragonGirl/\n',
);
const dmg = path.join(output, `Codex-DragonGirl-${version}-macOS-arm64.dmg`);
await fs.rm(dmg, { force: true });
run('/usr/bin/hdiutil', [
  'create',
  '-volname',
  'Codex 龙娘',
  '-srcfolder',
  staging,
  '-ov',
  '-format',
  'UDZO',
  dmg,
]);
await fs.rm(staging, { recursive: true, force: true });
const manifest = {
  version,
  platform: 'macOS',
  architecture: 'arm64',
  minimumOS: '15.0',
  signature: 'ad-hoc',
  notarized: false,
  files: [],
};
for (const file of [zip, dmg]) {
  const bytes = await fs.readFile(file);
  manifest.files.push({
    name: path.basename(file),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await fs.writeFile(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
