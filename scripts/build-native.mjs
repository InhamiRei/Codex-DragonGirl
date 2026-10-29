import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
// 编译当前平台的独立窗口桥，安装包无需开发环境。
await fs.mkdir(path.join(root, 'native/bin'), { recursive: true });
let command, args;
// Windows 使用系统内置 .NET Framework 编译器，成品不依赖开发工具或 PowerShell 脚本。
if (process.platform === 'win32') {
  command = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  args = ['/nologo', '/optimize+', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll',
    `/out:${path.join(root, 'native/bin/dragongirl-native.exe')}`, path.join(root, 'native/DragonBridge.cs')];
} else if (process.platform === 'darwin') {
  command = '/usr/bin/xcrun';
  args = [
    'swiftc', '-O', '-target', 'arm64-apple-macosx15.0',
    '-module-cache-path', path.join(os.tmpdir(), 'dragongirl-swift-cache'),
    path.join(root, 'native/DragonBridge.swift'), '-o', path.join(root, 'native/bin/dragongirl-native'),
  ];
} else throw new Error('原生桥目前支持 macOS 和 Windows。');
const result = spawnSync(command, args,
  { stdio: 'inherit', windowsHide: true, env: { ...process.env, ...(process.platform === 'darwin' ? { DEVELOPER_DIR: '/Library/Developer/CommandLineTools' } : {}) } },
);
if (result.status !== 0) process.exit(result.status || 1);
console.log('原生实例与窗口桥编译完成。');
