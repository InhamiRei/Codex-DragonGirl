import path from 'node:path';

// 原生窗口桥按平台选择二进制，所有调用共用同一路径。
export function nativeBridgePath(root, platform = process.platform) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('目前支持 macOS 和 Windows。');
  return path.join(root, 'native/bin', platform === 'win32' ? 'dragongirl-native.exe' : 'dragongirl-native');
}

// 账户子进程仅继承运行时与网络白名单，Windows 系统目录也必须保留。
export function accountEnvironment(home, networkEnv = {}, environment = process.env) {
  const runtimeKeys = [
    'HOME', 'PATH', 'Path', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  ];
  const networkKeys = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  ];
  return {
    ...Object.fromEntries([...runtimeKeys, ...networkKeys].filter((key) => environment[key]).map((key) => [key, environment[key]])),
    ...Object.fromEntries(networkKeys.filter((key) => typeof networkEnv[key] === 'string').map((key) => [key, networkEnv[key]])),
    CODEX_HOME: home,
  };
}

// 为桌面安装和 npm 安装列出原生 CLI；不通过 shell 运行 cmd 包装脚本。
export function cliCandidates(appPath, platform = process.platform, environment = process.env) {
  const p = platform === 'win32' ? path.win32 : path;
  if (platform === 'win32') {
    const directories = [
      appPath && p.dirname(appPath),
      ...(environment.PATH || environment.Path || '').split(';'),
      environment.LOCALAPPDATA && p.join(environment.LOCALAPPDATA, 'Programs', 'Codex'),
    ].filter(Boolean);
    const native = directories.flatMap((directory) => [
      p.join(directory, 'resources', 'codex.exe'),
      p.join(directory, 'resources', 'codex-cli', 'bin', 'codex.exe'),
      p.join(directory, 'codex.exe'),
    ]);
    const npmRoots = [
      environment.APPDATA && p.join(environment.APPDATA, 'npm', 'node_modules', '@openai', 'codex'),
      ...directories.map((directory) => p.join(directory, 'node_modules', '@openai', 'codex')),
    ].filter(Boolean);
    // npm 包的原生程序可能由可选平台包提供，兼容两种官方目录布局。
    for (const root of npmRoots)
      for (const base of [root, p.join(p.dirname(root), 'codex-win32-x64'), p.join(root, 'node_modules', '@openai', 'codex-win32-x64')])
        for (const folder of ['bin', 'codex'])
          native.push(p.join(base, 'vendor', 'x86_64-pc-windows-msvc', folder, 'codex.exe'));
    // Windows 文件名不区分大小写，GUI 的 Codex.exe 不能被误当成 CLI。
    return [...new Set(native)].filter((file) => !appPath || p.normalize(file).toLowerCase() !== p.normalize(appPath).toLowerCase());
  }
  const apps = [appPath, '/Applications/ChatGPT.app', '/Applications/Codex.app',
    environment.HOME && p.join(environment.HOME, 'Applications/ChatGPT.app'),
    environment.HOME && p.join(environment.HOME, 'Applications/Codex.app')].filter(Boolean);
  return [...new Set([
    ...apps.flatMap((app) => ['codex-cli/bin/codex', 'codex-cli/CodexCLI.app/Contents/MacOS/codex', 'codex']
      .map((file) => p.join(app, 'Contents/Resources', file))),
    ...(environment.PATH || '').split(':').filter(Boolean).map((directory) => p.join(directory, 'codex')),
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
  ])];
}
