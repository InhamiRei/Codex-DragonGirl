import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);

// 只读取本产品自己的登录项，固定脚本不接收外部路径或账户信息。
async function registration() {
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run')
try { $value = if ($null -ne $key) { $key.GetValue('Codex DragonGirl Startup', $null) } else { $null }; [Console]::WriteLine((ConvertTo-Json -InputObject @{ value = $value } -Compress)) }
finally { if ($null -ne $key) { $key.Dispose() } }`;
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return JSON.parse(result.stdout.trim().replace(/^\uFEFF/, '')).value;
}

// Windows 可能展开 8.3 短路径；按真实文件比较，同时要求完整引号防止空格拆参。
async function matchesHelper(command, helper) {
  if (typeof command !== 'string' || !/^"[^"]+"$/.test(command)) return false;
  const actual = await fs.realpath(command.slice(1, -1)).catch(() => null);
  return actual?.toLowerCase() === (await fs.realpath(helper)).toLowerCase();
}

// 真实注册验证仅在一次性的 Windows CI 用户下执行，本机单测不修改登录项。
test('Windows 原生助手注册和移除当前用户登录项，中文空格路径保持完整', {
  skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true', timeout: 120000,
}, async (t) => {
  assert.equal(await registration(), null, '测试环境已有同名登录项，不覆盖已有设置');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘 启动注册-'));
  const helper = path.join(directory, '启动 助手.exe');
  await fs.copyFile(path.join(root, 'native/bin/dragongirl-startup.exe'), helper);
  // 即使中途断言失败，也移除本测试创建的登录项和二进制副本。
  t.after(async () => {
    const saved = await registration();
    if (await matchesHelper(saved, helper)) await run(helper, ['--disable'], { windowsHide: true });
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await run(helper, ['--enable'], { windowsHide: true });
  assert.ok(await matchesHelper(await registration(), helper), '登录项没有完整指向该测试助手');
  await run(helper, ['--disable'], { windowsHide: true });
  assert.equal(await registration(), null);
});
