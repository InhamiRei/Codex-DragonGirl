import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeSettings } from '../src/core/settings.js';
import { startupReason, freshStartupStatus, shouldStopWithHost } from '../src/core/startup-policy.js';
import { StartupRegistration, readStartupJson, writeStartupJson } from '../src/core/startup-registration.js';
import { StartupController } from '../src/main/startup.js';

// 迁移保留旧用户的选择，新联动必须经过明确保存才启用。
test('启动设置迁移与显式选项保持一致', () => {
  assert.equal(normalizeSettings().startupMode, 'manual');
  assert.equal(normalizeSettings({ launchAtLogin: true }).startupMode, 'login');
  assert.equal(normalizeSettings({ startupMode: 'manual', launchAtLogin: true }).launchAtLogin, false);
  assert.equal(normalizeSettings({ startupMode: 'codex' }).startupMode, 'codex');
  assert.equal(normalizeSettings({ startupMode: 'codex' }).launchAtLogin, false);
  assert.equal(startupReason(['app', '--dg-startup=codex']), 'codex');
  assert.equal(startupReason(['app']), 'manual');
});

// 过期、错误修订、坏快照都不允许触发退出，最小化不等于进程退出。
test('自动退出只接受当前助手的连续空宿主快照', () => {
  const status = { revision: 'r', updatedAt: 10000, hosts: [] };
  const input = { managed: true, mode: 'codex', displayMode: 'follow', status, revision: 'r', absentSince: 7000, now: 10000 };
  assert.equal(shouldStopWithHost(input), true);
  for (const change of [
    { managed: false }, { mode: 'login' }, { displayMode: 'desktop' }, { revision: 'old' },
    { absentSince: 9000 }, { absentSince: null }, { now: 17000 },
    { status: { ...status, hosts: ['123:1'] } }, { status: { ...status, hosts: null } },
  ]) assert.equal(shouldStopWithHost({ ...input, ...change }), false);
  assert.equal(freshStartupStatus(null, 'r'), false);
});

// 系统服务在内存中模拟，测试会检查真实磁盘配置但不会注册机器登录项。
async function registrationFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-startup-中文 & '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'source');
  await fs.mkdir(path.join(root, 'native/bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'native/bin/dragongirl-startup'), 'native-fixture');
  const state = { loaded: false, calls: [], failBootstrap: false };
  const registration = new StartupRegistration({
    root, directory, executable: '/Applications/Codex 龙娘.app/Contents/MacOS/CodexDragonGirl',
    platform: 'darwin', home: directory, uid: 501,
    // 模拟加载失败和回滚，确保失败不会留下一份显示成功的配置。
    run: async (_command, args) => {
      state.calls.push(args);
      if (args[0] === 'print' && !state.loaded) throw Object.assign(new Error('missing'), { code: 113 });
      if (args[0] === 'bootout') state.loaded = false;
      if (args[0] === 'bootstrap') {
        if (state.failBootstrap) { state.failBootstrap = false; throw new Error('permission denied'); }
        state.loaded = true;
      }
      return { stdout: '' };
    },
  });
  return { registration, state, directory };
}

// 重复保存普通偏好不能重建登录项，系统中的禁用意图应保持不动。
test('启动注册幂等，移动应用后更新路径，关闭后移除服务', async (t) => {
  const { registration, state } = await registrationFixture(t);
  assert.equal(await registration.configure('manual'), null);
  const first = await registration.configure('codex');
  const count = state.calls.length;
  assert.deepEqual(await registration.configure('codex'), first);
  assert.equal(state.calls.length, count);
  const plist = await fs.readFile(registration.plist, 'utf8');
  assert.ok(plist.includes('&amp;'));
  registration.executable = '/Applications/New 龙娘.app/Contents/MacOS/CodexDragonGirl';
  const updated = await registration.configure('codex');
  assert.notEqual(updated.revision, first.revision);
  assert.equal(updated.executable, registration.executable);
  await registration.configure('manual');
  assert.equal(state.loaded, false);
  await assert.rejects(fs.access(registration.plist), { code: 'ENOENT' });
});

// 启用失败必须恢复之前的服务和路径，临时失败不能破坏旧配置。
test('系统注册失败会恢复旧启动方式', async (t) => {
  const { registration, state } = await registrationFixture(t);
  const initial = await registration.configure('login');
  state.failBootstrap = true;
  await assert.rejects(registration.configure('codex'), /未生效/);
  assert.deepEqual(await registration.current(), initial);
  assert.equal(state.loaded, true);
  assert.ok((await fs.readFile(registration.plist, 'utf8')).includes('<key>KeepAlive</key><false/>'));
});

// 关闭入口必须在控制文件损坏时仍可使用，恢复副本用于后续排查。
test('坏配置不阻止关闭自动启动', async (t) => {
  const { registration, state } = await registrationFixture(t);
  await registration.configure('codex');
  await fs.writeFile(registration.configFile, '{broken');
  await assert.rejects(registration.configure('codex'), /手动启动/);
  await registration.configure('manual');
  assert.equal(state.loaded, false);
  assert.equal((await registration.current()).mode, 'manual');
  assert.ok((await fs.readdir(registration.directory)).some((file) => file.startsWith('config.json.recovered-')));
});

// 安装映像和隔离路径不适合作为持久化启动入口。
test('临时 macOS 安装位置不会创建登录项', async (t) => {
  const { registration, state } = await registrationFixture(t);
  registration.executable = '/Volumes/安装/Codex 龙娘.app/Contents/MacOS/CodexDragonGirl';
  await assert.rejects(registration.configure('codex'), /Applications/);
  assert.equal(state.calls.length, 0);
});

// 已关闭的自动启动请求即使晚到也不创建心跳和窗口。
test('关闭联动后拒绝迟到的自动启动请求', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-startup-late-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const controller = new StartupController({ app: { isPackaged: false }, root: directory, directory, testMode: true, argv: ['--dg-startup=codex'] });
  assert.equal(await controller.start(normalizeSettings()), false);
  assert.equal(await readStartupJson(path.join(directory, 'startup/runtime.json')), null);
});

// 主程序退出时的暂停标识必须早于心跳移除，并与进程实例绑定。
test('用户退出写入暂停，手动重开解除暂停，自动退出不暂停', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-startup-runtime-'));
  const app = { isPackaged: false, quit() {} };
  const controller = new StartupController({ app, root: directory, directory, testMode: true, argv: ['--dg-startup=codex'] });
  t.after(async () => { await controller.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  await writeStartupJson(path.join(directory, 'startup/config.json'), { revision: 'r', mode: 'codex' });
  await writeStartupJson(path.join(directory, 'startup/status.json'), { revision: 'r', updatedAt: Date.now(), hosts: ['10:100', '20:200'] });
  await controller.start(normalizeSettings({ startupMode: 'codex' }));
  await controller.prepareQuit();
  assert.deepEqual((await readStartupJson(path.join(directory, 'startup/pause.json'))).hosts, ['10:100', '20:200']);
  assert.ok(await readStartupJson(path.join(directory, 'startup/runtime.json')));
  await controller.resume();
  assert.equal(await readStartupJson(path.join(directory, 'startup/pause.json')), null);
  controller.hostExit = true;
  await controller.prepareQuit();
  assert.equal(await readStartupJson(path.join(directory, 'startup/pause.json')), null);
});
