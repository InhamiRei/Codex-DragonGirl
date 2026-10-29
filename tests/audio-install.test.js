import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { downloadAudioLibrary, verifyAudioLibrary, resolveAudioPath } from '../src/core/audio-library-store.js';
import { AUDIO_FILES } from '../src/shared/audio-library.js';

const bundledDirectory = path.resolve('assets/audio');

// 每个用例使用独立中文空格路径，保证验证不依赖开发电脑已安装的音效。
async function fixtureDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘 音效-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// 网络失败和摘要不符均不覆盖已有原声，也不创建半安装的文件。
test('原声安装先验证来源和摘要，失败保留原有文件', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-audio-download-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const existing = path.join(directory, AUDIO_FILES[0].localFile);
  await fs.writeFile(existing, 'keep-existing');
  await assert.rejects(downloadAudioLibrary(directory, async (url, options) => {
    assert.equal(url, AUDIO_FILES[0].sourceUrl);
    assert.equal(options.redirect, 'error');
    return { ok: false };
  }), /下载失败/);
  await assert.rejects(downloadAudioLibrary(directory, async () => ({ ok: true, arrayBuffer: async () => Buffer.from('invalid') })), /校验失败/);
  // 后续音频校验失败时，前面已下载成功的音频也不能覆盖旧文件。
  await assert.rejects(downloadAudioLibrary(directory, async (url) => ({
    ok: true,
    arrayBuffer: async () => url === AUDIO_FILES[0].sourceUrl
      ? fs.readFile(path.join(bundledDirectory, AUDIO_FILES[0].localFile))
      : Buffer.from('invalid'),
  })), /校验失败/);
  assert.equal(await fs.readFile(existing, 'utf8'), 'keep-existing');
  assert.equal((await fs.readdir(directory)).length, 1);
});

// 全新用户目录即使没有任何音频，也能直接解析并校验九段内置原声。
test('新安装无需下载即可读取全部内置原声，状态为九段就绪', async (t) => {
  const directory = await fixtureDirectory(t);
  const status = await verifyAudioLibrary(directory, bundledDirectory);
  assert.equal(status.complete, true);
  assert.equal(status.installed, 9);
  assert.equal(status.bundled, 9);
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.invalid, []);
  for (const file of AUDIO_FILES)
    assert.equal(await resolveAudioPath(directory, file.localFile, bundledDirectory), path.join(bundledDirectory, file.localFile));
  assert.deepEqual(await fs.readdir(directory), []);
  for (const filename of ['../settings.json', 'unknown.mp3', '0'.repeat(32) + '.mp3'])
    assert.equal(await resolveAudioPath(directory, filename, bundledDirectory), null);
});

// 旧版本机音频损坏时，播放与状态检查一致地回退到内置副本。
test('损坏的旧版音频不会遮蔽有效的内置音效', async (t) => {
  const directory = await fixtureDirectory(t);
  const file = AUDIO_FILES[0];
  await fs.writeFile(path.join(directory, file.localFile), 'broken');
  assert.equal(await resolveAudioPath(directory, file.localFile, bundledDirectory), path.join(bundledDirectory, file.localFile));
  const status = await verifyAudioLibrary(directory, bundledDirectory);
  assert.equal(status.complete, true);
  assert.equal(status.bundled, 9);
  assert.equal(await fs.readFile(path.join(directory, file.localFile), 'utf8'), 'broken');
});

// 内置文件损坏时保留旧版有效音频的兼容路径，两份都无效才报告不足。
test('旧版有效音频可补齐损坏的内置副本，两份均损坏时拒绝播放', async (t) => {
  const directory = await fixtureDirectory(t);
  const bundle = path.join(directory, 'bundle');
  const local = path.join(directory, 'local');
  await fs.cp(bundledDirectory, bundle, { recursive: true });
  await fs.mkdir(local);
  const file = AUDIO_FILES[0];
  await fs.copyFile(path.join(bundledDirectory, file.localFile), path.join(local, file.localFile));
  await fs.writeFile(path.join(bundle, file.localFile), 'broken');
  const status = await verifyAudioLibrary(local, bundle);
  assert.equal(status.complete, true);
  assert.equal(status.bundled, 8);
  assert.equal(await resolveAudioPath(local, file.localFile, bundle), path.join(local, file.localFile));
  await fs.writeFile(path.join(local, file.localFile), 'also-broken');
  const broken = await verifyAudioLibrary(local, bundle);
  assert.equal(broken.complete, false);
  assert.equal(broken.installed, 8);
  assert.deepEqual(broken.invalid, [file.label]);
  assert.equal(await resolveAudioPath(local, file.localFile, bundle), null);
});

// 断网时从安装包修复原声；重复修复复用本机文件，不触发下载或覆盖其他素材。
test('内置原声支持离线修复，重复修复不联网', async (t) => {
  const directory = await fixtureDirectory(t);
  const unrelated = path.join(directory, 'custom-character.png');
  await fs.writeFile(unrelated, 'keep-character');
  let requests = 0;
  // 任何联网尝试都让测试失败，确保修复真正可以离线完成。
  const offline = async () => { requests++; throw new Error('设备离线'); };
  const installed = await downloadAudioLibrary(directory, offline, bundledDirectory);
  assert.equal(installed.complete, true);
  assert.equal((await verifyAudioLibrary(directory)).installed, 9);
  assert.equal((await downloadAudioLibrary(directory, offline)).complete, true);
  assert.equal(requests, 0);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep-character');
});

// 两份副本均无效时才从固定来源下载，其他八段继续复用内置音频。
test('修复只下载内置与本机均不可用的原声', async (t) => {
  const directory = await fixtureDirectory(t);
  const bundle = path.join(directory, 'bundle');
  const local = path.join(directory, 'local');
  await fs.cp(bundledDirectory, bundle, { recursive: true });
  const file = AUDIO_FILES[0];
  await fs.writeFile(path.join(bundle, file.localFile), 'broken');
  const requests = [];
  const status = await downloadAudioLibrary(local, async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'error');
    return { ok: true, arrayBuffer: () => fs.readFile(path.join(bundledDirectory, file.localFile)) };
  }, bundle);
  assert.equal(status.complete, true);
  assert.deepEqual(requests, [file.sourceUrl]);
});
