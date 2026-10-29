import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLaunchReporter, launcherStatusPath } from '../src/main/launcher-status.js';

// 环境变量只能指向挂件自己的握手文件，不能要求主进程覆盖任意文件。
test('启动握手路径限制在本项目日志目录与固定文件名', () => {
  assert.equal(launcherStatusPath('/project/', '/project/.artifacts/logs/launch-123.status'), path.resolve('/project/.artifacts/logs/launch-123.status'));
  for (const candidate of ['/tmp/launch-123.status', '/project/.artifacts/logs/preferences.json',
    '/project/.artifacts/logs/../../launch-123.status', 'launch-123.status', undefined])
    assert.equal(launcherStatusPath('/project', candidate), null);
});

// 就绪与错误都以完整文件反馈，不能留下半段状态或临时文件。
test('就绪握手与失败原因完整写入并清理临时文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dragongirl-ready-'));
  try {
    const directory = path.join(root, '.artifacts/logs');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'launch-123.status');
    const report = createLaunchReporter(root, file);
    assert.equal(await report('ready'), true);
    assert.equal(await fs.readFile(file, 'utf8'), 'ready\n');
    assert.equal(await report('error', '素材无法读取'), true);
    assert.equal(await fs.readFile(file, 'utf8'), 'error\n素材无法读取');
    assert.deepEqual(await fs.readdir(directory), ['launch-123.status']);
    assert.equal(await createLaunchReporter(root, '/tmp/not-allowed.status')('ready'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
