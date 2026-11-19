import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extract } from '@electron-internal/extract-zip';
import { verifyReleasePayload } from './release-payload.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'output');
const manifest = JSON.parse(await fs.readFile(path.join(output, 'release-manifest-Windows-x64.json'), 'utf8'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘 安装验证-'));

try {
  const file = manifest.files[0];
  const archive = path.join(output, file.name);
  const bytes = await fs.readFile(archive);
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('ZIP 摘要校验失败');
  // 复用 Electron 下载时的 ZIP 解压库，保留中文路径，不经过系统命令的代码页转换。
  await extract(archive, { dir: temp });
  const executable = path.join(temp, manifest.executable);
  const code = path.join(path.dirname(executable), 'resources/app');
  await verifyReleasePayload(root, code, manifest.version, '.exe');
  const native = await fs.readFile(path.join(code, 'native/bin/dragongirl-native.exe'));
  const startup = await fs.readFile(path.join(code, 'native/bin/dragongirl-startup.exe'));
  // Windows 发行组件还需验证 PE 文件头，文件名和扩展名不能代替架构检查。
  for (const binary of [await fs.readFile(executable), native, startup]) {
    if (binary.toString('ascii', 0, 2) !== 'MZ' || binary.readUInt16LE(binary.readUInt32LE(0x3c) + 4) !== 0x8664)
      throw new Error('Windows 二进制不是有效的 x64 PE 文件');
  }
  // 桌面用例串行运行同一个解压包，避免测试窗口互抢焦点并保留每项诊断。
  const env = { ...process.env, DRAGONGIRL_TEST_EXECUTABLE: executable };
  const scripts = [
    'windows-smoke.mjs', 'startup-smoke.mjs', 'position-smoke.mjs', 'bubble-smoke.mjs',
    'follow-smoke.mjs', 'bubble-refresh-smoke.mjs', 'facing-smoke.mjs', 'menu-smoke.mjs',
    'eyes-smoke.mjs', 'blink-smoke.mjs', 'expression-smoke.mjs', 'sad-smoke.mjs',
    'account-tests-smoke.mjs', 'performance-smoke.mjs', 'character-smoke.mjs', 'dragon-config-smoke.mjs',
    'maro-frame-audit.mjs', 'maro-interaction-smoke.mjs', 'maro-gaze-audit.mjs',
  ];
  for (const script of scripts) {
    console.log(`验收 ${script}`);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
      env, encoding: 'utf8', timeout: 120000,
    });
    if (result.status !== 0) throw new Error(`${script} 验收失败：${result.error?.message || result.stderr || result.stdout || result.signal || result.status}`);
    console.log(result.stdout.trim());
  }
  const report = { passed: true, version: manifest.version, checks: ['ZIP SHA-256', '源码一致', 'x64 二进制', '中文空格路径解压', '脱离源码启动', '桌面功能测试', '静默启动与宿主退出', '位置恢复与内置音效', '四档显示比例与无原生滚动条', '跟随窗口遮挡层级与最小化恢复', '气泡并发刷新保持显示与阅读位置', '拖拽松手自动朝向、镜像命中与动画偏好', '成功与失败表情及素材完整性', '原生菜单与表情预览', '后台刷新性能与常驻信息更新'] };
  // 发行验收记录明确列出新角色检查，避免只有源码检查通过而成品遗漏素材。
  report.checks.push('首次默认龙娘与角色切换', '三十帧 1254 像素动作、配色和几何一致', '两种角色眨眼与视线、麻吕眼眶和脸部逐像素保持固定');
  report.checks.push('实际安装包侧栏版本、龙娘瞳色与重启恢复', '账号测智界面与本地协议');
  await fs.writeFile(path.join(output, 'verification-Windows-x64.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
