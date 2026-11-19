import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nativeBridgePath, accountEnvironment, cliCandidates } from '../src/core/platform.js';
import { CLI_UNAVAILABLE, CLI_UNAVAILABLE_MESSAGE, locateCodex, rpcError } from '../src/core/rpc.js';

// Windows 查询保留系统运行环境，同时拒绝 API 密钥及未授权的覆盖字段。
test('账户环境仅传递运行时与网络白名单', () => {
  const env = accountEnvironment('C:\\用户\\.codex', { HTTPS_PROXY: 'http://localhost:8080', SECRET: 'hidden', PATH: 'wrong' }, {
    SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\用户', PATH: 'runtime-path', OPENAI_API_KEY: 'hidden', ELECTRON_RUN_AS_NODE: '1',
  });
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.CODEX_HOME, 'C:\\用户\\.codex');
  assert.equal(env.PATH, 'runtime-path');
  assert.equal(env.HTTPS_PROXY, 'http://localhost:8080');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.SECRET, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
});

// 同名不同大小写在 Windows 只能传一个值，且实例代理可以显式覆盖或清空父进程代理。
test('Windows 实例代理按大小写无关覆盖，macOS 保持各变量独立', () => {
  const environment = { pAtH: 'native-path', SYSTEMROOT: 'C:\\Windows', HTTPS_PROXY: 'http://parent.invalid', NO_PROXY: 'old' };
  const network = { https_proxy: 'http://instance.invalid', No_Proxy: '', Ssl_Cert_File: 'C:\\instance.pem', Path: 'ignored' };
  assert.deepEqual(accountEnvironment('C:\\fixture', network, environment, 'win32'), {
    PATH: 'native-path', SystemRoot: 'C:\\Windows', HTTPS_PROXY: 'http://instance.invalid', NO_PROXY: '',
    SSL_CERT_FILE: 'C:\\instance.pem', CODEX_HOME: 'C:\\fixture',
  });
  const mac = accountEnvironment('/fixture', { https_proxy: network.https_proxy }, environment, 'darwin');
  assert.equal(mac.HTTPS_PROXY, environment.HTTPS_PROXY);
  assert.equal(mac.https_proxy, network.https_proxy);
});

// 平台差异集中在路径边界，不改变原有账户统计协议。
test('Windows 桥与 CLI 使用原生可执行文件', () => {
  assert.equal(nativeBridgePath('/project', 'win32'), path.join('/project', 'native/bin/dragongirl-native.exe'));
  const files = cliCandidates('C:\\Program Files\\Codex\\Codex.exe', 'win32', { APPDATA: 'C:\\用户\\AppData\\Roaming', PATH: 'C:\\工具;C:\\Node' });
  assert.ok(files.includes('C:\\Program Files\\Codex\\resources\\codex.exe'));
  assert.ok(files.some((file) => file.includes('codex-win32-x64') && file.endsWith('codex.exe')));
  assert.ok(files.includes('C:\\用户\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'));
  assert.ok(files.every((file) => file.endsWith('.exe')));
  assert.ok(!files.includes('C:\\Program Files\\Codex\\codex.exe'));
  assert.throws(() => nativeBridgePath('/project', 'linux'), /支持/);
});

// 无宿主、PATH 或 npm 安装时仍可发现桌面缓存，并沿最近更新顺序跳过不能启动的候选。
test('Windows 桌面版 CLI 回退验证版本并及时发现安装变化', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-codex-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const fixture = path.join(directory, 'fixture.exe');
  if (process.platform === 'win32') {
    const source = path.join(directory, 'CliFixture.cs');
    // 真实 Windows 用原生入口返回标准版本格式，其余平台用可执行脚本走同一查找逻辑。
    await fs.writeFile(source, '// 返回离线测试所需的 CLI 版本。\nclass CliFixture { static void Main() { System.Console.WriteLine("codex-cli 0.162.1"); } }');
    const csc = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const build = spawnSync(csc, ['/nologo', '/target:exe', `/out:${fixture}`, source], { encoding: 'utf8', windowsHide: true });
    assert.equal(build.status, 0, build.stdout + build.stderr);
  } else {
    await fs.writeFile(fixture, '#!/bin/sh\nprintf "%s\\n" "codex-cli 0.162.1"\n', { mode: 0o700 });
  }
  const root = path.join(directory, 'OpenAI', 'Codex', 'bin');
  const entries = [['zz-damaged', 3, false], ['aa-current', 2, true], ['zz-older', 1, true]];
  const files = [];
  for (const [name, days, valid] of entries) {
    const file = path.join(root, name, 'codex.exe');
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (valid) await fs.copyFile(fixture, file);
    else await fs.writeFile(file, 'invalid executable');
    const timestamp = new Date(2026, 10, days);
    await fs.utimes(file, timestamp, timestamp);
    files.push(file);
  }
  const options = { platform: 'win32', environment: { ...process.env, PATH: '', Path: '', APPDATA: '', LOCALAPPDATA: directory } };
  assert.equal(await locateCodex(undefined, options), files[1]);
  await fs.rm(files[1]);
  assert.equal(await locateCodex(undefined, options), files[2]);
  await fs.rm(files[2]);
  await assert.rejects(locateCodex(undefined, options), (error) => error.code === CLI_UNAVAILABLE && rpcError(error) === CLI_UNAVAILABLE_MESSAGE);
  await fs.copyFile(fixture, files[1]);
  assert.equal(await locateCodex(undefined, options), files[1]);
});
