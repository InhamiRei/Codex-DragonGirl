import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'scripts/macos-launcher.applescript');
const output = path.join(root, '启动龙娘.app');
const staging = path.join(root, '.artifacts', 'launcher-build-' + process.pid, '启动龙娘.app');

// 使用系统自带工具构建应用，不依赖 Xcode 编译器或第三方打包服务。
function run(tool, args) {
  const result = spawnSync(tool, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim() || `${tool} 执行失败。`);
}

// 先在临时目录完整编译与签名，成功后再替换已生成的启动器。
async function build() {
  if (process.platform !== 'darwin') throw new Error('macOS 应用启动器需要在 Mac 上构建。');
  await fs.mkdir(path.dirname(staging), { recursive: true });
  try {
    run('/usr/bin/osacompile', ['-o', staging, source]);
    const plist = path.join(staging, 'Contents/Info.plist');
    run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.inhamirei.codex-dragongirl.launcher', plist]);
    run('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', '启动龙娘', plist]);
    run('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', '启动龙娘', plist]);
    run('/usr/bin/plutil', ['-replace', 'LSUIElement', '-bool', 'true', plist]);
    // 系统 applet 模板带有未使用的用途说明，本启动器不需要日历、相机等应用权限。
    const metadata = JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }).stdout);
    for (const field of Object.keys(metadata)) if (/^NS.*UsageDescription$/.test(field))
      run('/usr/bin/plutil', ['-remove', field, plist]);
    await fs.writeFile(path.join(staging, 'Contents/Resources/project-path.txt'), path.resolve(root));
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', staging]);
    run('/usr/bin/codesign', ['--verify', '--strict', staging]);
    await fs.rm(output, { recursive: true, force: true });
    await fs.rename(staging, output);
    console.log('双击启动入口已生成：' + output);
  } finally {
    await fs.rm(path.dirname(staging), { recursive: true, force: true });
  }
}

// 构建失败明确返回错误，避免把缺少可执行入口的目录当成成功的应用。
build().catch(error => { console.error('生成 macOS 启动器失败：', error.message); process.exitCode = 1; });
