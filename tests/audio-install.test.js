import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { downloadAudioLibrary } from '../src/core/audio-library-store.js';
import { AUDIO_FILES } from '../src/shared/audio-library.js';

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
  assert.equal(await fs.readFile(existing, 'utf8'), 'keep-existing');
  assert.equal((await fs.readdir(directory)).length, 1);
});
