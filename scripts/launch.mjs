import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import path from 'node:path';

// 清理父进程的运行时标记，确保桌面程序以正常窗口模式启动。
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const child = spawn(electron, [root, ...process.argv.slice(2)], { cwd: root, env: environment, stdio: 'inherit' });

// 启动错误给出可操作信息，避免挂件静默消失。
child.on('error', error => { console.error('无法启动龙娘：', error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });

// 终端中断时将信号转交给桌面程序，让它执行正常的保存与退出流程。
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
