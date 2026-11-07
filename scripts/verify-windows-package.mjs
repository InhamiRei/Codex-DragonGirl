import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'output');
const manifest = JSON.parse(await fs.readFile(path.join(output, 'release-manifest-Windows-x64.json'), 'utf8'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘 安装验证-'));

// 递归核对发行文件，防止遗漏模块、混入个人数据或发布旧版本。
async function compare(relative, packaged) {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  assertSame(entries.map((entry) => entry.name).sort(), (await fs.readdir(path.join(packaged, relative))).sort(), relative);
  for (const entry of entries) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) await compare(name, packaged);
    else if (!(await fs.readFile(path.join(root, name))).equals(await fs.readFile(path.join(packaged, name))))
      throw new Error(`安装包文件不一致：${name}`);
  }
}

// 清单与二进制结构必须精确匹配，不以文件名代替实际校验。
function assertSame(actual, expected, name) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`文件清单不一致：${name}`);
}

try {
  const file = manifest.files[0];
  const bytes = await fs.readFile(path.join(output, file.name));
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('ZIP 摘要校验失败');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:DRAGONGIRL_PACKAGE_ZIP -DestinationPath $env:DRAGONGIRL_VERIFY_DIR'], {
    env: { ...process.env, DRAGONGIRL_PACKAGE_ZIP: path.join(output, file.name), DRAGONGIRL_VERIFY_DIR: temp },
    encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'ZIP 解压失败');
  const executable = path.join(temp, manifest.executable);
  const code = path.join(path.dirname(executable), 'resources/app');
  for (const directory of ['src', 'assets']) await compare(directory, code);
  // 新发行包只保留 README，检查旧文档未混入且产品说明对应本次源码。
  const packagedNames = await fs.readdir(code);
  if (packagedNames.includes('docs') || packagedNames.includes('CHANGELOG.md'))
    throw new Error('安装包混入已删除的文档');
  if (!(await fs.readFile(path.join(root, 'README.md'))).equals(await fs.readFile(path.join(code, 'README.md'))))
    throw new Error('安装包 README 不一致');
  const metadata = JSON.parse(await fs.readFile(path.join(code, 'package.json'), 'utf8'));
  if (metadata.version !== manifest.version || metadata.author !== 'Hey、小怪兽')
    throw new Error('安装包版本或作者不符');
  const native = await fs.readFile(path.join(code, 'native/bin/dragongirl-native.exe'));
  const startup = await fs.readFile(path.join(code, 'native/bin/dragongirl-startup.exe'));
  if (!startup.equals(await fs.readFile(path.join(root, 'native/bin/dragongirl-startup.exe')))) throw new Error('启动助手版本不一致');
  if (!native.equals(await fs.readFile(path.join(root, 'native/bin/dragongirl-native.exe')))) throw new Error('原生桥版本不一致');
  for (const binary of [await fs.readFile(executable), native, startup]) {
    if (binary.toString('ascii', 0, 2) !== 'MZ' || binary.readUInt16LE(binary.readUInt32LE(0x3c) + 4) !== 0x8664)
      throw new Error('Windows 二进制不是有效的 x64 PE 文件');
  }
  const launch = spawnSync(process.execPath, [path.join(root, 'scripts/windows-smoke.mjs')], {
    env: { ...process.env, DRAGONGIRL_TEST_EXECUTABLE: executable }, encoding: 'utf8', timeout: 120000,
  });
  if (launch.status !== 0) throw new Error(launch.stderr || launch.stdout || '安装包启动失败');
  console.log(launch.stdout.trim());
  const silent = spawnSync(process.execPath, [path.join(root, 'scripts/startup-smoke.mjs')], {
    env: { ...process.env, DRAGONGIRL_TEST_EXECUTABLE: executable }, encoding: 'utf8', timeout: 120000,
  });
  if (silent.status !== 0) throw new Error(silent.stderr || silent.stdout || '安装包联动启动失败');
  console.log(silent.stdout.trim());
  const position = spawnSync(process.execPath, [path.join(root, 'scripts/position-smoke.mjs')], {
    env: { ...process.env, DRAGONGIRL_TEST_EXECUTABLE: executable }, encoding: 'utf8', timeout: 120000,
  });
  if (position.status !== 0) throw new Error(position.stderr || position.stdout || '安装包位置恢复失败');
  console.log(position.stdout.trim());
  const bubble = spawnSync(process.execPath, [path.join(root, 'scripts/bubble-smoke.mjs')], {
    env: { ...process.env, DRAGONGIRL_TEST_EXECUTABLE: executable }, encoding: 'utf8', timeout: 120000,
  });
  if (bubble.status !== 0) throw new Error(bubble.stderr || bubble.stdout || '安装包气泡排版失败');
  console.log(bubble.stdout.trim());
  // 窗口遮挡、菜单、气泡和表情都在解压后的便携包运行，避免仅在源码目录中通过。
  for (const script of ['follow-smoke.mjs', 'bubble-refresh-smoke.mjs', 'facing-smoke.mjs', 'menu-smoke.mjs', 'eyes-smoke.mjs', 'blink-smoke.mjs', 'expression-smoke.mjs', 'sad-smoke.mjs', 'performance-smoke.mjs',
    'character-smoke.mjs', 'maro-frame-audit.mjs', 'maro-interaction-smoke.mjs', 'maro-gaze-audit.mjs']) {
    const expression = spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
      env: { ...process.env, DRAGONGIRL_TEST_EXECUTABLE: executable }, encoding: 'utf8', timeout: 120000,
    });
    if (expression.status !== 0) throw new Error(expression.stderr || expression.stdout || '安装包表情验证失败');
    console.log(expression.stdout.trim());
  }
  const report = { passed: true, version: manifest.version, checks: ['ZIP SHA-256', '源码一致', 'x64 二进制', '中文空格路径解压', '脱离源码启动', '桌面功能测试', '静默启动与宿主退出', '位置恢复与内置音效', '四档显示比例与无原生滚动条', '跟随窗口遮挡层级与最小化恢复', '气泡并发刷新保持显示与阅读位置', '拖拽松手自动朝向、镜像命中与动画偏好', '成功与失败表情及素材完整性', '原生菜单与表情预览', '后台刷新性能与常驻信息更新'] };
  // 发行验收记录明确列出新角色检查，避免只有源码检查通过而成品遗漏素材。
  report.checks.push('首次默认龙娘与角色切换', '三十帧 1254 像素动作、配色和几何一致', '两种角色眨眼与视线、麻吕眼眶和脸部逐像素保持固定');
  await fs.writeFile(path.join(output, 'verification-Windows-x64.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
