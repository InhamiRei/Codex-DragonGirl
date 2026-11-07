import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, '.artifacts/project-audit');
await fs.mkdir(artifacts, { recursive: true });
const tests = (await fs.readdir(path.join(root, 'tests'))).filter((file) => file.endsWith('.test.js')).sort();
const suite = [
  ['syntax', ['scripts/check.mjs']],
  ['unit', ['--test', ...tests.map((file) => `tests/${file}`)]],
  ...(process.platform === 'win32' ? [['windows', ['scripts/windows-smoke.mjs']]] : [
    ['desktop', ['scripts/desktop-smoke.mjs']], ['app', ['scripts/app-smoke.mjs']],
  ]),
  ...['startup', 'position', 'follow', 'bubble', 'bubble-refresh', 'facing', 'eyes', 'blink', 'expression', 'menu', 'sad', 'account-tests', 'performance']
    .map((name) => [name, [`scripts/${name}-smoke.mjs`]]),
  // 新角色从默认选择、逐帧几何与配色到眼部像素都进入正式发布验收。
  ...['character-smoke', 'maro-frame-audit', 'maro-interaction-smoke', 'maro-gaze-audit']
    .map((name) => [name, [`scripts/${name}.mjs`]]),
];

// 桌面检查串行运行，避免测试窗口互抢焦点；独立检查失败后仍继续收集其他结果。
async function verify(name, args) {
  const started = Date.now();
  let output = '';
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const timer = setTimeout(() => child.kill(), 240000);
  let result;
  try {
    result = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: -1, error: error.message }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally { clearTimeout(timer); }
  await fs.writeFile(path.join(artifacts, `${name}.log`), output);
  const passed = result.code === 0;
  console.log(`${passed ? '✓' : '✗'} ${name} · ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
  if (!passed) console.error(output.slice(-4000) || result.error);
  return { name, passed, ...result, milliseconds: Date.now() - started };
}

const results = [];
for (const [name, args] of suite) results.push(await verify(name, args));
const passed = results.every((result) => result.passed);
await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify({ passed, platform: process.platform, results }, null, 2));
console.log(`项目检查${passed ? '全部通过' : '存在失败'}：${results.filter((result) => result.passed).length} / ${results.length}，日志位于 .artifacts/project-audit/。`);
if (!passed) process.exitCode = 1;
