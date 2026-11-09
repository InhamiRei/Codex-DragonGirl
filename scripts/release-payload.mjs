import fs from 'node:fs/promises';
import path from 'node:path';
import { AUDIO_FILES } from '../src/shared/audio-library.js';

// 发布包只收录运行模块、内置角色、原声和出处。README 海报与开发验收文件留在仓库。
const runtimeFolders = [
  ['src', /\.(?:js|cjs|html|css)$/],
  ['assets/characters', /\.(?:png|webp)$/],
];
const audioFiles = [...AUDIO_FILES.map((file) => file.localFile), 'original-audio-sources.json'];

// 同一遍历既能筛选源码，也能在验收时发现多打进包的隐藏文件或开发素材。
async function listFiles(root, directory, pattern) {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    if (pattern && entry.name.startsWith('.')) continue;
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, name, pattern));
    else if (!pattern || (entry.isFile() && pattern.test(entry.name))) files.push(name);
  }
  return files;
}

// 构建和验收共享一份收录规则，macOS 和 Windows 仅在原生组件后缀上有差别。
async function releaseFiles(root, nativeExtension) {
  const folders = await Promise.all(runtimeFolders.map(([folder, pattern]) => listFiles(root, folder, pattern)));
  return [
    ...folders.flat(),
    ...audioFiles.map((name) => path.join('assets/audio', name)),
    ...['dragongirl-native', 'dragongirl-startup'].map((name) => path.join('native/bin', name + nativeExtension)),
  ];
}

// 保留离线说明和音效出处链接，移除只用于仓库首页的海报引用。
async function releaseReadme(root) {
  const text = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  return text.replace(/^!\[[^\r\n]*\]\(assets\/readme\/[^)\r\n]+\)\r?\n/m, '');
}

// 用文件清单构建应用目录，避免整个目录复制把本机临时文件带进安装包。
export async function copyReleasePayload(root, application, nativeExtension = '') {
  for (const file of await releaseFiles(root, nativeExtension)) {
    const target = path.join(application, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, file), target);
  }
  const { scripts, devDependencies, ...metadata } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(application, 'package.json'), JSON.stringify(metadata, null, 2));
  await fs.writeFile(path.join(application, 'README.md'), await releaseReadme(root));
}

// 核对实际应用目录中的所有文件、源码内容和发布信息，旧产物不能通过验收。
export async function verifyReleasePayload(root, application, version, nativeExtension = '') {
  const files = await releaseFiles(root, nativeExtension);
  const expected = new Set([...files, 'package.json', 'README.md']);
  const actual = new Set(await listFiles(application, ''));
  const missing = [...expected].filter((file) => !actual.has(file));
  const extra = [...actual].filter((file) => !expected.has(file));
  if (missing.length || extra.length)
    throw new Error(`安装包文件清单不一致。缺失 ${missing.join(', ') || '无'}，额外 ${extra.join(', ') || '无'}`);
  for (const file of files) {
    const [source, packaged] = await Promise.all([
      fs.readFile(path.join(root, file)), fs.readFile(path.join(application, file)),
    ]);
    if (!source.equals(packaged)) throw new Error(`安装包文件内容过期：${file}`);
  }
  if (await fs.readFile(path.join(application, 'README.md'), 'utf8') !== await releaseReadme(root))
    throw new Error('安装包 README 过期');
  const metadata = JSON.parse(await fs.readFile(path.join(application, 'package.json'), 'utf8'));
  if (metadata.version !== version || metadata.author !== 'Hey、小怪兽' || metadata.scripts || metadata.devDependencies)
    throw new Error('安装包版本、作者或运行时配置不符');
}
