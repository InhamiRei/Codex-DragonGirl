import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startupPlist, readStartupJson, writeStartupJson } from '../src/core/startup-registration.js';

if (process.platform !== 'darwin') throw new Error('此验证需要 macOS 桌面会话。');
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-service-'));
const data = path.join(temporary, 'data');
const configFile = path.join(data, 'startup/config.json');
const hostsFile = path.join(temporary, 'hosts.json');
const plist = path.join(temporary, 'service.plist');
const label = 'com.inhamirei.dragongirl.startup.verification-' + randomUUID();
const domain = `gui/${process.getuid()}`;
const run = promisify(execFile);
let loaded = false;

// 只等待隔离服务的状态，不查询或修改正式龙娘的登录项。
async function until(check, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

try {
  await writeStartupJson(configFile, { version: 1, revision: label, mode: 'codex', executable: process.execPath,
    arguments: [path.join(root, 'tests/fixtures/startup-client.mjs'), data] });
  await writeStartupJson(hostsFile, { hosts: [] });
  // 使用唯一临时服务名和显式测试宿主，验证系统实际装载助手的行为。
  const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const text = startupPlist(path.join(root, 'native/bin/dragongirl-startup'), configFile, 'codex')
    .replace('com.inhamirei.dragongirl.startup', label)
    .replace('</array>', `<string>--test-hosts</string><string>${escape(hostsFile)}</string></array>`)
    .replace('</dict></plist>', '<key>EnvironmentVariables</key><dict><key>DRAGONGIRL_TEST</key><string>1</string></dict></dict></plist>');
  await fs.writeFile(plist, text);
  await run('/usr/bin/plutil', ['-lint', plist]);
  await run('/bin/launchctl', ['bootstrap', domain, plist]); loaded = true;
  await run('/bin/launchctl', ['print', `${domain}/${label}`]);
  const status = () => readStartupJson(path.join(data, 'startup/status.json')).catch(() => null);
  await until(async () => (await status())?.phase === 'waiting', '系统未启动测试助手');
  await writeStartupJson(hostsFile, { hosts: ['fixture:1'] });
  await until(async () => (await status())?.phase === 'running', '系统助手未唤起测试客户端');
  assert.equal((await status()).revision, label);
  await writeStartupJson(hostsFile, { hosts: [] });
  await until(async () => !(await readStartupJson(path.join(data, 'startup/runtime.json'))), '宿主退出后测试客户端未保存退出');
  console.log('macOS 实际 LaunchAgent 装载、等待、唤起与退出验证通过。');
} finally {
  if (loaded) await run('/bin/launchctl', ['bootout', `${domain}/${label}`]);
  await fs.rm(temporary, { recursive: true, force: true });
}
