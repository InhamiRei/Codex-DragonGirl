import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = process.cwd(),
  output = path.join(root, 'output'),
  manifest = JSON.parse(await fs.readFile(path.join(output, 'release-manifest.json'), 'utf8')),
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dragongirl-install-check-'));
let mounted = false;
// 每个外部工具都使用独立参数数组，保存输出便于检查失败原因。
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0)
    throw new Error(`${path.basename(command)}: ${result.stderr || result.stdout}`);
  return result.stdout;
}
// 递归验证打包源码与当前源码完全一致，防止旧产物被当作本次版本。
async function compareFolder(relative, packaged) {
  const sourceNames = (await fs.readdir(path.join(root, relative))).sort();
  const packagedNames = (await fs.readdir(path.join(packaged, relative))).sort();
  if (JSON.stringify(sourceNames) !== JSON.stringify(packagedNames))
    throw new Error(`安装包文件清单不一致：${relative}`);
  for (const e of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, e.name);
    if (e.isDirectory()) await compareFolder(name, packaged);
    else {
      const a = await fs.readFile(path.join(root, name)),
        b = await fs.readFile(path.join(packaged, name));
      if (!a.equals(b)) throw new Error(`安装包内容过期：${name}`);
    }
  }
}
try {
  for (const f of manifest.files) {
    const data = await fs.readFile(path.join(output, f.name));
    if (createHash('sha256').update(data).digest('hex') !== f.sha256) throw new Error('安装包哈希不符');
  }
  const zip = manifest.files.find((f) => f.name.endsWith('.zip')),
    dmg = manifest.files.find((f) => f.name.endsWith('.dmg'));
  run('/usr/bin/ditto', ['-x', '-k', path.join(output, zip.name), temp]);
  const application = path.join(temp, 'Codex 龙娘.app'),
    code = path.join(application, 'Contents/Resources/app');
  await compareFolder('src', code);
  await compareFolder('assets', code);
  await compareFolder('docs', code);
  for (const binary of ['dragongirl-native', 'dragongirl-startup'])
    if (!(await fs.readFile(path.join(root, 'native/bin', binary))).equals(await fs.readFile(path.join(code, 'native/bin', binary))))
      throw new Error(`原生组件过期：${binary}`);
  // 说明和版本信息也必须来自当前源码，避免文档修改后误用旧包。
  for (const file of ['README.md', 'CHANGELOG.md'])
    if (!(await fs.readFile(path.join(root, file))).equals(await fs.readFile(path.join(code, file))))
      throw new Error(`安装包文档过期：${file}`);
  const metadata = JSON.parse(await fs.readFile(path.join(code, 'package.json'), 'utf8'));
  if (metadata.version !== manifest.version || metadata.author !== 'Hey、小怪兽')
    throw new Error('安装包版本或作者不符');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
  run('/usr/bin/hdiutil', ['verify', path.join(output, dmg.name)]);
  const mount = path.join(temp, 'mounted');
  await fs.mkdir(mount);
  run('/usr/bin/hdiutil', [
    'attach',
    path.join(output, dmg.name),
    '-readonly',
    '-nobrowse',
    '-mountpoint',
    mount,
  ]);
  mounted = true;
  await fs.access(path.join(mount, 'Codex 龙娘.app/Contents/MacOS/CodexDragonGirl'));
  if ((await fs.readlink(path.join(mount, 'Applications'))) !== '/Applications')
    throw new Error('安装快捷入口错误');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(mount, 'Codex 龙娘.app')]);
  run('/usr/bin/hdiutil', ['detach', mount]);
  mounted = false;
  const exe = path.join(application, 'Contents/MacOS/CodexDragonGirl');
  const text = run(process.execPath, [path.join(root, 'scripts/app-smoke.mjs')], {
    ...process.env,
    DRAGONGIRL_TEST_EXECUTABLE: exe,
  });
  console.log(text.trim());
  console.log(run(process.execPath, [path.join(root, 'scripts/startup-smoke.mjs')], {
    ...process.env, DRAGONGIRL_TEST_EXECUTABLE: exe,
  }).trim());
  console.log(run(process.execPath, [path.join(root, 'scripts/startup-open-smoke.mjs')], {
    ...process.env, DRAGONGIRL_TEST_EXECUTABLE: exe,
  }).trim());
  console.log(run(process.execPath, [path.join(root, 'scripts/position-smoke.mjs')], {
    ...process.env, DRAGONGIRL_TEST_EXECUTABLE: exe,
  }).trim());
  console.log(run(process.execPath, [path.join(root, 'scripts/bubble-smoke.mjs')], {
    ...process.env, DRAGONGIRL_TEST_EXECUTABLE: exe,
  }).trim());
  const result = {
    passed: true,
    version: manifest.version,
    signature: 'ad-hoc verified',
    notarized: false,
    checks: [
      'ZIP 与 DMG SHA-256',
      '安装包源码一致',
      '深度签名校验',
      'DMG 完整性与只读挂载',
      'Applications 安装入口',
      '脱离工程目录启动',
      '五实例完整界面测试',
      '原生启动助手完整性与静默联动入口',
      '位置保存与重启恢复、内置音效离线可用',
      '四档显示比例下双额度完整且无原生滚动条',
    ],
  };
  await fs.writeFile(
    path.join(output, 'installation-verification.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  if (mounted)
    try {
      run('/usr/bin/hdiutil', ['detach', path.join(temp, 'mounted')]);
    } catch {}
  await fs.rm(temp, { recursive: true, force: true });
}
