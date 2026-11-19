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

// 使用预编译探针直接读取注册表，避免每次查询都等待 PowerShell 启动。
async function registration(probe) {
  const { stdout } = await run(probe, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return JSON.parse(stdout);
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘 启动注册-'));
  const helper = path.join(directory, '启动 助手.exe');
  const probe = path.join(directory, 'registry-probe.exe');
  let registrationStarted = false;
  // 即使中途断言失败，也移除本测试创建的登录项和二进制副本。
  t.after(async () => {
    try {
      if (registrationStarted && await matchesHelper(await registration(probe), helper))
        await run(helper, ['--disable'], { windowsHide: true, timeout: 10000 });
    } finally {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  // 使用编译原生组件的同一套 x64 编译器，读写两端采用相同的注册表视图。
  const csc = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await run(csc, ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', `/out:${probe}`,
    path.join(root, 'tests/fixtures/StartupRegistryFixture.cs')], { windowsHide: true, timeout: 20000 });
  assert.equal(await registration(probe), null, '测试环境已有同名登录项，不覆盖已有设置');
  await fs.copyFile(path.join(root, 'native/bin/dragongirl-startup.exe'), helper);
  registrationStarted = true;
  await run(helper, ['--enable'], { windowsHide: true, timeout: 10000 });
  assert.ok(await matchesHelper(await registration(probe), helper), '登录项没有完整指向该测试助手');
  await run(helper, ['--disable'], { windowsHide: true, timeout: 10000 });
  assert.equal(await registration(probe), null);
  registrationStarted = false;
});
