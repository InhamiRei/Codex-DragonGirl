import fs from 'node:fs/promises';
import path from 'node:path';
import { StartupController } from '../../src/main/startup.js';
import { normalizeSettings } from '../../src/core/settings.js';
import { readStartupJson } from '../../src/core/startup-registration.js';

const directory = process.argv[2];
let closing = false, timer;
// 隔离测试客户端复用真实的主程序生命周期控制器，不启动桌面或连接账户。
const app = { isPackaged: false, quit: () => void quit() };
const controller = new StartupController({ app, root: directory, directory, testMode: true });

// 测试退出采用真实保存顺序，让原生助手观察心跳移除和暂停标记。
async function quit() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await controller.prepareQuit();
  await controller.stop();
  process.exit(0);
}

if (!(await controller.start(normalizeSettings({ startupMode: 'codex' })))) process.exit(0);
await fs.appendFile(path.join(directory, 'launches.jsonl'), JSON.stringify({ pid: process.pid, reason: controller.reason }) + '\n');
let lastCommand = (await readStartupJson(path.join(directory, 'command.json')))?.id;
// 指令文件只存在于临时测试目录，用于模拟用户退出和手动打开管理界面。
timer = setInterval(async () => {
  const command = await readStartupJson(path.join(directory, 'command.json')).catch(() => null);
  if (!command || command.id === lastCommand) return;
  lastCommand = command.id;
  if (command.action === 'quit') await quit();
  if (command.action === 'retain') await controller.resume();
  if (command.action === 'crash') process.exit(23);
}, 100);
