import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { verifyReleasePayload } from './release-payload.mjs';

// 这项用例真实安装和卸载产品，只在工作流的一次性 Windows 虚拟机内运行。
if (process.platform !== 'win32' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('真实安装升级验收需要一次性 GitHub 托管 Windows 运行器。');
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'output/release-manifest-Windows-x64.json'), 'utf8'));
const asset = manifest.files.find((file) => file.name.endsWith('-Setup.exe'));
const setup = path.join(root, 'output', asset.name);
const temp = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'dg-nsis-'));
const installed = path.join(temp, 'installed'), executable = path.join(installed, 'DragonGirl.exe');
const metadata = path.join(installed, 'resources/app/package.json');
// 在临时运行器的真实产品数据目录放入探针，可检测安装器误删用户配置的问题。
const user = path.join(process.env.APPDATA, 'Codex DragonGirl'), profile = path.join(temp, 'test-home');
const sentinel = path.join(user, 'update-sentinel-' + path.basename(temp));
const runtimeFile = path.join(user, 'startup/runtime.json');
let application;

// 复用主程序的原子心跳文件；启动编号区分新旧进程，路径按文件系统实际长路径核对。
async function readRuntime() {
  return fs.readFile(runtimeFile, 'utf8').then((text) => JSON.parse(text)).catch(() => null);
}

try {
  // 先建立正式安装布局，将临时应用的版本降低，以同一份真实安装器验证跨版本替换。
  execFileSync(setup, ['/S', '/D=' + installed], { windowsVerbatimArguments: true, timeout: 120000 });
  console.log('已在临时目录完成首次安装');
  const initial = JSON.parse(await fs.readFile(metadata, 'utf8'));
  assert.equal(initial.version, manifest.version);
  await fs.writeFile(metadata, JSON.stringify({ ...initial, version: '0.0.1' }));
  await fs.mkdir(path.join(profile, '.codex/sessions'), { recursive: true });
  await fs.mkdir(user, { recursive: true });
  await fs.writeFile(sentinel, '本地数据', { flag: 'wx' });
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1',
    DRAGONGIRL_DATA_DIR: user, DRAGONGIRL_FIXTURE_HOME: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: executable, args: [], env, cwd: temp });
  // 等待管理页完成初始化，之后仅将网络替换成 CI 本次实际构建的安装器。
  let page;
  const deadline = Date.now() + 30000;
  while (!(page = application.windows().find((item) => item.url().endsWith('/dashboard.html')))) {
    if (Date.now() > deadline) throw new Error('安装版管理窗口未出现');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await page.waitForFunction(() => document.querySelector('#app-version')?.textContent === 'v0.0.1');
  const previousRuntime = await readRuntime();
  assert.equal(previousRuntime?.pid, await application.evaluate(() => process.pid));
  await application.evaluate(async (_electron, { name, size, digest, version, source }) => {
    const service = globalThis.__dragonGirlApp.dashboard.updates;
    if (!service.state.installed) throw new Error('安装版未被识别');
    service.fetch = async (url) => {
      if (url.startsWith('https://api.github.com/')) return Response.json({ tag_name: 'v' + version, assets: [{
        name, size, digest: 'sha256:' + digest, state: 'uploaded',
        browser_download_url: `https://github.com/InhamiRei/Codex-DragonGirl/releases/download/v${version}/${name}`,
      }] });
      return new Response(process.getBuiltinModule('node:stream').Readable.toWeb(process.getBuiltinModule('node:fs').createReadStream(source)));
    };
    await service.check();
  }, { name: asset.name, size: asset.bytes, digest: asset.sha256, version: manifest.version, source: setup });
  await page.locator('#app-update-button').click();
  await page.getByRole('button', { name: '下载更新', exact: true }).click();
  const restart = page.getByRole('button', { name: '重启并更新', exact: true });
  await restart.waitFor({ timeout: 60000 });
  console.log('已从旧版窗口下载并校验本次实际生成的 NSIS 安装包');
  await Promise.all([application.waitForEvent('close', { timeout: 60000 }), restart.click()]);
  application = null;
  console.log('旧版已完成保存并退出，等待新进程心跳');
  // 新心跳与新版文件必须同时存在，每次轮询仅读取小文件，无需持续启动 PowerShell。
  const until = Date.now() + 90000;
  let restarted;
  while (Date.now() < until) {
    const runtime = await readRuntime();
    if (runtime && runtime.launchId !== previousRuntime.launchId && runtime.pid !== previousRuntime.pid
      && Date.now() - runtime.updatedAt < 6000) { restarted = runtime; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(JSON.parse(await fs.readFile(metadata, 'utf8')).version, manifest.version);
  assert.ok(restarted, '安装结束后未收到新版主程序心跳');
  assert.equal((await fs.realpath(restarted.executable)).toLowerCase(), (await fs.realpath(executable)).toLowerCase());
  process.kill(restarted.pid, 0);
  await verifyReleasePayload(root, path.join(installed, 'resources/app'), manifest.version, '.exe');
  assert.equal(await fs.readFile(sentinel, 'utf8'), '本地数据');
  console.log('已验证 NSIS 正式安装、应用内完整下载、重启替换和用户数据保留');
} finally {
  await application?.close().catch(() => {});
  // 只回收这次安装目录内的进程，不按名称清理其他位置的龙娘。
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process -Filter "Name=\'DragonGirl.exe\'" | Where-Object { $_.ExecutablePath -eq $env:DRAGONGIRL_VERIFY_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'],
  { env: { ...process.env, DRAGONGIRL_VERIFY_EXE: await fs.realpath(executable).catch(() => executable) }, windowsHide: true });
  const uninstall = path.join(installed, 'Uninstall DragonGirl.exe');
  if (await fs.stat(uninstall).catch(() => null)) execFileSync(uninstall, ['/S'], { timeout: 90000 });
  await fs.rm(sentinel, { force: true });
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
}
