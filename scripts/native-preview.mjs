import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'dragongirl-native-'));
const report = path.join(root, '.artifacts/native-session.json');
await fs.mkdir(path.dirname(report), { recursive: true });
const environment = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: data,
  DRAGONGIRL_NATIVE_REPORT: report };
delete environment.ELECTRON_RUN_AS_NODE;

// 原生验收使用普通桌面启动，不附加调试器，不使用 CDP 发送鼠标事件。
const child = spawn(electron, [root, '--native-preview'], { cwd: root, env: environment, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });

// 子进程退出后删除隔离配置，保留可复核的点击计数报告。
child.on('exit', async code => {
  await fs.rm(data, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
