import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { nativeBridgePath, accountEnvironment, cliCandidates } from '../src/core/platform.js';

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
