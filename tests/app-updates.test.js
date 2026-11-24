import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppUpdates, selectUpdate } from '../src/core/app-updates.js';

const root = 'https://github.com/InhamiRei/Codex-DragonGirl/releases';
const bytes = Buffer.from('用于核验更新状态的测试附件');

// 构造与 GitHub 正式 Release 相同结构的元数据，摘要对应实际要写入磁盘的内容。
function fixture(tag = 'v1.10.0') {
  return { tag_name: tag, draft: false, prerelease: false, assets:
    ['Windows-x64.zip', 'Windows-x64-Setup.exe', 'macOS-arm64.dmg'].map((suffix) => {
      const name = `Codex-DragonGirl-${tag.slice(1)}-${suffix}`;
      return { name, browser_download_url: `${root}/download/${tag}/${name}`, size: bytes.length,
        state: 'uploaded', digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
    }) };
}

// 每项用例均使用隔离缓存与替代的系统打开函数，不访问用户安装目录。
async function setup(t, platform = 'darwin') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-update-'));
  const release = fixture(), requests = [], opened = [], pages = [];
  const service = new AppUpdates({ directory, current: '1.7.0', platform, arch: platform === 'darwin' ? 'arm64' : 'x64',
    fetch: async (url) => {
      requests.push(url);
      if (url.startsWith('https://api.github.com/')) return Response.json(release);
      if (url.startsWith(root + '/download/')) return Response.redirect('https://release-assets.githubusercontent.com/test', 302);
      return new Response(bytes);
    }, openFile: async (...args) => { opened.push(args); }, openPage: async (url) => { pages.push(url); } });
  t.after(async () => { await service.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, directory, release, requests, opened, pages };
}

// 覆盖版本排序、草稿与预览版过滤、按架构挑包和缺少可校验附件时仅显示发布说明。
test('只提示更高正式版并选择本仓库的正确安装包', () => {
  const release = fixture();
  const choose = (data, platform = 'win32', arch = 'x64') => selectUpdate(data, '1.7.0', platform, arch);
  assert.equal(choose(release).asset.format, 'setup');
  assert.equal(choose(release, 'darwin', 'arm64').asset.format, 'dmg');
  assert.equal(choose(release, 'darwin', 'x64').asset, null);
  for (const tag of ['v1.6.9', 'v1.7.0', 'v1.11.0-beta.2', 'v1.7.1/extra']) assert.equal(choose(fixture(tag)), null);
  assert.equal(choose({ ...release, draft: true }), null);
  assert.equal(choose({ ...release, prerelease: true }), null);
  release.assets[1].digest = null;
  assert.equal(choose(release).asset.format, 'zip');
  release.assets[0].browser_download_url = 'https://example.org/other.zip';
  assert.equal(choose(release).asset, null);
});

// 并发检查只发一次网络请求，下载在用户点击时开始，同一文件命中缓存后仍在安装前复验。
test('用户触发下载与安装，缓存修改会阻止打开', async (t) => {
  const { service, requests, directory, opened, pages } = await setup(t);
  await Promise.all([service.check(), service.check()]);
  assert.equal(requests.length, 1);
  assert.equal(service.state.status, 'available');
  await Promise.all([service.download(), service.download(), service.check()]);
  assert.equal(service.state.status, 'ready');
  assert.equal(opened.length, 0);
  const file = path.join(directory, service.state.release.asset.name);
  await fs.writeFile(file, Buffer.alloc(bytes.length));
  await service.apply();
  assert.equal(opened.length, 0);
  assert.equal(service.state.status, 'available');
  await service.download();
  await service.apply();
  assert.deepEqual(opened, [[file, 'dmg']]);
  const again = await setup(t);
  again.service.directory = directory;
  await again.service.check();
  await again.service.download();
  assert.equal(again.requests.length, 1);
  await service.visitRelease();
  assert.deepEqual(pages, [root + '/tag/v1.10.0']);
});

// Windows 只交付经过校验的本项目安装器，便携 ZIP 回退不能走可执行安装分支。
test('Windows 安装包、缺包回退和发布页按实际附件分流', async (t) => {
  const { service, opened, release } = await setup(t, 'win32');
  await service.check();
  await service.download();
  await service.apply();
  assert.equal(opened[0][1], 'setup');
  const portable = await setup(t, 'win32');
  portable.release.assets = [release.assets[0]];
  await portable.service.check();
  await portable.service.download();
  await portable.service.apply();
  assert.equal(portable.opened[0][1], 'zip');
});

// 校验失败、附件截断和非分发域跳转都保留重试入口并清理部分文件。
test('损坏下载或不受信任的重定向不能成为可安装文件', async (t) => {
  const { service, directory, opened } = await setup(t);
  await service.check();
  for (const body of [Buffer.alloc(bytes.length), Buffer.alloc(bytes.length - 1), Buffer.alloc(bytes.length + 1)]) {
    service.fetch = async () => new Response(body);
    await service.download();
    assert.equal(service.state.status, 'available');
    assert.match(service.state.error, /校验失败|长度/);
    assert.deepEqual(await fs.readdir(directory), []);
  }
  service.fetch = async () => Response.redirect('https://example.com/file', 302);
  await service.download();
  assert.match(service.state.error, /跳转地址/);
  assert.equal(opened.length, 0);
});

// 限流时保留失败状态并延迟自动检查，回退的版本不能触发下载。
test('限流后延迟自动检查，回退的最新标签不提示降级', async (t) => {
  const { service } = await setup(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  service.fetch = async () => new Response('', { status: 429 });
  service.start();
  await service.pending;
  assert.equal(service.state.status, 'error');
  service.fetch = async () => Response.json(fixture('v1.6.7'));
  t.mock.timers.tick(5 * 60 * 1000);
  service.checkOnOpen();
  await service.pending;
  assert.equal(service.state.status, 'error');
  t.mock.timers.tick(55 * 60 * 1000);
  await service.pending;
  assert.equal(service.state.status, 'current');
  assert.equal(service.state.error, '');
});

// 首次断网后应自动发现新版，管理窗口也能刷新过期结果且不会重复发起检查。
test('自动检查在断网后重试，打开管理窗口时刷新过期结果', async (t) => {
  const { service, release } = await setup(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const fetch = service.fetch;
  let attempts = 0;
  // 只让启动时的请求断开，之后返回正常的 GitHub 发布信息。
  service.fetch = async (...args) => {
    attempts++;
    if (attempts === 1) throw new TypeError('fetch failed');
    return fetch(...args);
  };
  service.start();
  await service.pending;
  assert.equal(service.state.status, 'error');

  t.mock.timers.tick(5 * 60 * 1000);
  await service.pending;
  assert.equal(service.state.status, 'available');
  assert.equal(service.state.release.version, '1.10.0');

  service.checkOnOpen();
  assert.equal(attempts, 2);
  t.mock.timers.tick(15 * 60 * 1000);
  release.tag_name = 'v1.7.0';
  service.checkOnOpen();
  service.checkOnOpen();
  await service.pending;
  assert.equal(attempts, 3);
  assert.equal(service.state.status, 'current');
  assert.equal(service.state.release, null);

  // 成功后恢复六小时检查，退出时取消下一次检查。
  t.mock.timers.tick(6 * 60 * 60 * 1000 - 1);
  assert.equal(attempts, 3);
  t.mock.timers.tick(1);
  await service.pending;
  assert.equal(attempts, 4);
  await service.stop();
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(attempts, 4);
});

// 长期运行时保留通过核验的附件，新标签、撤回或同名替换都不能继续安装旧缓存。
test('重新检查已下载版本能识别撤回和替换，离线仍可使用此前核验的文件', async (t) => {
  const { service, release, directory } = await setup(t);
  const fetch = service.fetch;
  await service.check();
  await service.download();
  await service.check();
  assert.equal(service.state.status, 'ready');
  service.fetch = async () => new Response('', { status: 503 });
  await service.check();
  assert.equal(service.state.status, 'ready');
  service.fetch = fetch;
  release.assets[2].digest = 'sha256:' + 'a'.repeat(64);
  await service.check();
  assert.equal(service.state.status, 'available');
  const unrelated = path.join(directory, '其他文件.txt');
  await fs.writeFile(unrelated, '保留');
  service.fetch = async () => Response.json(fixture('v1.6.7'));
  await service.check();
  assert.equal(service.state.status, 'current');
  assert.deepEqual(await fs.readdir(directory), ['其他文件.txt']);
});

// 暂停的真实流只发送轻量百分比；退出立即解除等待并删除不完整的下载。
test('进度不重复发送发布说明，退出会回收部分文件', async (t) => {
  const { service, directory, release } = await setup(t);
  release.body = '长发布说明'.repeat(4000);
  await service.check();
  const progress = [];
  let started;
  const first = new Promise((resolve) => { started = resolve; });
  service.on('change', (packet) => {
    if (typeof packet === 'number') { progress.push(packet); started(); }
    else if (packet.status === 'downloading') assert.equal(packet.percent, 0);
  });
  service.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, Math.ceil(bytes.length / 2)));
  } }));
  const transfer = service.download();
  await first;
  assert.deepEqual(progress, [Math.floor(Math.ceil(bytes.length / 2) / bytes.length * 100)]);
  await service.stop();
  await transfer;
  assert.deepEqual(await fs.readdir(directory), []);
});
