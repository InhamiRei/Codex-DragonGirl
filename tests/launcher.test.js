import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../scripts/launch-macos.sh', import.meta.url));
const options = { skip: process.platform === 'win32' };

// 用真实 shell 入口与假运行时检验外部启动行为，覆盖引号、中文、空格和 Finder 最小环境。
async function fixture() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dragongirl-launcher-')));
  const root = path.join(directory, "龙娘's project with spaces");
  const script = path.join(root, 'scripts/launch-macos.sh');
  const binary = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  const report = path.join(directory, 'runtime-report.txt');
  await fs.mkdir(path.dirname(script), { recursive: true });
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.copyFile(source, script);
  await fs.writeFile(binary, `#!/bin/sh
# 记录真正收到的目录、参数与环境，模拟桌面运行时的外部边界。
printf '%s\\n' "$PWD" "$1" "\${ELECTRON_RUN_AS_NODE-unset}" "\${2-}" > "$DRAGONGIRL_TEST_OUTPUT"
if [ -n "\${DRAGONGIRL_LAUNCH_STATUS-}" ] && [ "\${DRAGONGIRL_TEST_EXIT-0}" = '0' ]; then
  printf 'ready\\n' > "$DRAGONGIRL_LAUNCH_STATUS"
fi
exit "\${DRAGONGIRL_TEST_EXIT-0}"
`, { mode: 0o755 });
  return { directory, root, script, binary, report,
    env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1', DRAGONGIRL_TEST_OUTPUT: report } };
}

// 后台启动器先返回是正常行为，等待子进程实际执行后再断言其输入。
async function runtimeReport(file) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { return (await fs.readFile(file, 'utf8')).trimEnd().split('\n'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('后台运行时没有执行或没有写入验证结果。');
}

// 终端入口同样应摆脱 npm、nvm 和交互式 shell 的依赖。
test('最小环境也能启动，中文空格与引号路径完整传给运行时', options, async () => {
  const input = await fixture();
  try {
    const result = spawnSync('/bin/sh', [input.script, '--foreground', 'marker with spaces'],
      { cwd: '/', env: input.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await runtimeReport(input.report),
      [input.root, input.root, 'unset', 'marker with spaces']);
  } finally { await fs.rm(input.directory, { recursive: true, force: true }); }
});

// 应用启动器必须及时返回，并且后台进程仍能收到完整参数并留下日志。
test('后台入口脱离启动器，不依赖交互输入并写入启动日志', options, async () => {
  const input = await fixture();
  try {
    const result = spawnSync('/bin/sh', [input.script, '--background', 'background marker'],
      { cwd: '/', env: input.env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^\d+$/);
    assert.deepEqual(await runtimeReport(input.report),
      [input.root, input.root, 'unset', 'background marker']);
    assert.match(await fs.readFile(path.join(input.root, '.artifacts/logs/launcher.log'), 'utf8'), /启动龙娘/);
  } finally { await fs.rm(input.directory, { recursive: true, force: true }); }
});

// 缺少二进制时要立即失败，不能只检查 npm 包目录后静默退出。
test('缺少桌面运行时时返回可操作的错误', options, async () => {
  const input = await fixture();
  try {
    await fs.rm(input.binary);
    const result = spawnSync('/bin/sh', [input.script, '--background'], { env: input.env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /没有找到 Electron 桌面运行时/);
    assert.match(result.stderr, /npm install 和 npm start/);
  } finally { await fs.rm(input.directory, { recursive: true, force: true }); }
});

// 运行时即时崩溃时返回真实失败码，让应用入口能够显示错误而不是假报成功。
test('后台即时启动失败会透传退出码与日志位置', options, async () => {
  const input = await fixture();
  try {
    const result = spawnSync('/bin/sh', [input.script, '--background'],
      { env: { ...input.env, DRAGONGIRL_TEST_EXIT: '23' }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 23);
    assert.match(result.stderr, /退出码 23/);
    assert.match(result.stderr, /launcher\.log/);
  } finally { await fs.rm(input.directory, { recursive: true, force: true }); }
});
