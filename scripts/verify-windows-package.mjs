import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extract } from '@electron-internal/extract-zip';
import { verifyReleaseFile, verifyReleasePayload } from './release-payload.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'output');
const manifest = JSON.parse(await fs.readFile(path.join(output, 'release-manifest-Windows-x64.json'), 'utf8'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘 安装验证-'));

// 仅读取 DOS 文件头和 PE 签名、架构字段，校验 Electron 主程序无需整份载入。
async function peMachine(file) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(64), signature = Buffer.alloc(6);
    const dos = await handle.read(header, 0, header.length, 0);
    if (dos.bytesRead !== header.length || header.toString('ascii', 0, 2) !== 'MZ') throw new Error('DOS 文件头无效：' + file);
    const pe = await handle.read(signature, 0, signature.length, header.readUInt32LE(0x3c));
    if (pe.bytesRead !== signature.length || signature.readUInt32LE(0) !== 0x4550) throw new Error('PE 文件头无效：' + file);
    return signature.readUInt16LE(4);
  } finally { await handle.close(); }
}

try {
  const file = manifest.files.find((entry) => entry.name === `Codex-DragonGirl-${manifest.version}-Windows-x64.zip`);
  const setup = manifest.files.find((entry) => entry.name === `Codex-DragonGirl-${manifest.version}-Windows-x64-Setup.exe`);
  if (!file || !setup) throw new Error('发布清单缺少当前版本的 ZIP 或 Setup 安装包');
  // NSIS 引导程序与包内 x64 应用分别验证；引导程序本身可采用 32 位 PE 格式。
  await peMachine(await verifyReleaseFile(output, setup));
  const archive = await verifyReleaseFile(output, file);
  // 复用 Electron 下载时的 ZIP 解压库，保留中文路径，不经过系统命令的代码页转换。
  await extract(archive, { dir: temp });
  const executable = path.join(temp, manifest.executable);
  const code = path.join(path.dirname(executable), 'resources/app');
  await verifyReleasePayload(root, code, manifest.version, '.exe');
  // Windows 发行组件还需验证 PE 文件头，文件名和扩展名不能代替架构检查。
  for (const binary of [executable, path.join(code, 'native/bin/dragongirl-native.exe'), path.join(code, 'native/bin/dragongirl-startup.exe')]) {
    if (await peMachine(binary) !== 0x8664)
      throw new Error('Windows 二进制不是有效的 x64 PE 文件');
  }
  // 桌面用例串行运行同一个解压包，避免测试窗口互抢焦点并保留每项诊断。
  const env = { ...process.env, DRAGONGIRL_TEST_EXECUTABLE: executable };
  const scripts = [
    'windows-smoke.mjs', 'update-smoke.mjs', 'app-smoke.mjs', 'startup-smoke.mjs', 'position-smoke.mjs', 'bubble-smoke.mjs',
    'follow-smoke.mjs', 'bubble-refresh-smoke.mjs', 'facing-smoke.mjs', 'menu-smoke.mjs',
    'eyes-smoke.mjs', 'blink-smoke.mjs', 'expression-smoke.mjs', 'sad-smoke.mjs',
    'account-tests-smoke.mjs', 'performance-smoke.mjs', 'character-smoke.mjs', 'dragon-config-smoke.mjs',
    'maro-frame-audit.mjs', 'maro-interaction-smoke.mjs', 'maro-gaze-audit.mjs', 'kokkoro-interaction-smoke.mjs',
  ];
  for (const script of scripts) {
    console.log(`验收 ${script}`);
    // 六款发型各自启动验收窗口，沿用整套项目检查为单项提供的四分钟时限。
    const timeout = script === 'dragon-config-smoke.mjs' ? 240000 : 120000;
    // Windows 复用五实例重置卡用例，完整应用用例中的 macOS CLI 夹具仅在 Mac 上运行。
    const args = [path.join(root, 'scripts', script)];
    if (script === 'app-smoke.mjs') args.push('--reset-tooltip-only');
    const result = spawnSync(process.execPath, args, {
      env, encoding: 'utf8', timeout,
    });
    if (result.status !== 0) throw new Error(`${script} 验收失败：${result.error?.message || result.stderr || result.stdout || result.signal || result.status}`);
    console.log(result.stdout.trim());
  }
  const report = { passed: true, version: manifest.version, checks: ['ZIP SHA-256', '源码一致', 'x64 二进制', '中文空格路径解压', '脱离源码启动', '桌面功能测试', '静默启动与宿主退出', '位置恢复与内置音效', '四档显示比例与无原生滚动条', '跟随窗口遮挡层级与最小化恢复', '气泡并发刷新保持显示与阅读位置', '拖拽松手自动朝向、镜像命中与动画偏好', '成功与失败表情及素材完整性', '原生菜单与表情预览', '后台刷新性能与常驻信息更新'] };
  // 发行验收记录明确列出新角色检查，避免只有源码检查通过而成品遗漏素材。
  report.checks.push('首次默认龙娘与角色切换', '三十帧 1254 像素动作、配色和几何一致', '三个角色的眨眼与视线、麻吕眼眶和脸部逐像素保持固定');
  report.checks.push('实际安装包侧栏版本、陪伴配置切换与原版部件、龙娘瞳色与重启恢复', '可可萝的完成、失败与任务台词', '账号测智界面与本地协议');
  report.checks.push('NSIS 安装包 SHA-256', '更新提示、下载校验、关闭弹窗后继续下载与安装操作');
  report.checks.push('重置卡悬停、滚动跟随、键盘访问、滚出视口与后台刷新');
  await fs.writeFile(path.join(output, 'verification-Windows-x64.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
