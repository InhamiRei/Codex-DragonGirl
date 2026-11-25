import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AUDIO_FILES } from '../src/shared/audio-library.js';
import { CHARACTERS } from '../src/shared/characters.js';
import { DRAGON_CROWN_MASK, DRAGON_FOREGROUND, DRAGON_GEAR, DRAGON_HAIRSTYLES, DRAGON_OUTFITS, DRAGON_PRAYER_EYES } from '../src/shared/dragon-gear.js';
import { KANNA_OUTFITS, KANNA_OUTFIT_REGION } from '../src/shared/kanna-outfits.js';
import { MARO_OUTFITS, MARO_OUTFIT_OFFSETS, maroOutfitLayer } from '../src/shared/maro-outfits.js';
import { fileDigest } from '../src/core/file-digest.js';

// 发布包只收录运行模块、内置角色、原声和出处。README 海报与开发验收文件留在仓库。
const runtimeFolders = [
  ['src', /\.(?:js|cjs|html|css)$/],
  ['assets/characters', /\.(?:png|webp)$/],
];
const audioFiles = [...AUDIO_FILES.map((file) => file.localFile), 'original-audio-sources.json'];

// 两个平台采用相同的发布清单字段，摘要和大小从同一次流式读取获得。
export async function releaseFileInfo(file) {
  return { name: path.basename(file), ...await fileDigest(file) };
}

// 解包前先核对成品完整性，不把整个磁盘映像或安装器留在内存中。
export async function verifyReleaseFile(directory, expected) {
  const file = path.join(directory, expected.name);
  const actual = await fileDigest(file);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
    throw new Error('安装包长度或 SHA-256 不符：' + expected.name);
  return file;
}

// 版本以 package.json 为准；锁文件不同步时禁止构建新包。
export async function readReleaseVersion(root) {
  const [metadata, lock] = await Promise.all(['package.json', 'package-lock.json'].map(async (name) =>
    JSON.parse(await fs.readFile(path.join(root, name), 'utf8'))));
  const { version } = metadata;
  if (!version || lock.version !== version || lock.packages?.['']?.version !== version)
    throw new Error('应用版本与锁文件不一致，请用 npm version <版本号> --no-git-tag-version 同步。');
  return version;
}

// macOS 的系统显示版本和应用构建共用同一版本，成品不符时直接报错。
export function verifyMacBundleVersion(bundle, version) {
  const plist = path.join(bundle, 'Contents/Info.plist');
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist], { encoding: 'utf8' });
    if (result.status !== 0 || result.stdout.trim() !== version)
      throw new Error('macOS 安装包版本不一致：' + key + ' 应为 ' + version);
  }
}

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
  // 安装包必须包含完整立绘、角色头像、分层发型素材以及配置页使用的部件缩略图。
  const gearArtwork = new Set([
    ...CHARACTERS.flatMap(({ image, avatar }) => [image, avatar]),
    DRAGON_FOREGROUND,
    DRAGON_PRAYER_EYES,
    DRAGON_CROWN_MASK,
    ...DRAGON_HAIRSTYLES.flatMap(({ image, artwork, temple, bodice }) => [image, artwork, temple, bodice]),
    ...DRAGON_OUTFITS.flatMap(({ overlay, shortHem }) => overlay ? [overlay, shortHem] : []),
    ...DRAGON_GEAR.flatMap(({ choices }) => choices.map(({ icon }) => icon)),
    KANNA_OUTFIT_REGION.mask,
    ...KANNA_OUTFITS.map(({ icon }) => icon),
    ...KANNA_OUTFITS.flatMap(({ image }) => image ? [image] : []),
    // 麻吕的服饰逐帧覆盖捋发与任务表情，随应用打包全部必要素材。
    ...MARO_OUTFITS.map(({ icon }) => icon),
    ...MARO_OUTFITS.filter(({ layerDirectory }) => layerDirectory).flatMap((outfit) =>
      Object.keys(MARO_OUTFIT_OFFSETS).map((pose) => maroOutfitLayer(outfit, pose))),
  ]);
  await Promise.all([...gearArtwork].map((file) => fs.access(path.join(root, file))));
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
  // 发行壳自带的 Electron 示例网页只供开发启动器使用，正式产品有自己的 app/package.json。
  await fs.rm(path.join(path.dirname(application), 'default_app.asar'), { force: true });
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
  if (version !== await readReleaseVersion(root)) throw new Error('安装包版本与当前源码版本不符');
  if ((await fs.readdir(path.dirname(application))).includes('default_app.asar'))
    throw new Error('发行包仍包含 Electron 的示例应用');
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
