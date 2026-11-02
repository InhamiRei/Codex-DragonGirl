import { _electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const data = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-debug-'));
const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let application;

// 调试也使用隔离配置，脚本或启动失败后仍关闭应用并清理临时数据。
try {
  application = await _electron.launch({ args: [process.cwd()], env });
  application.process().stderr.on('data', (data) => console.log(String(data)));
  application.on('window', (page) => {
    page.on('console', (message) => console.log('console', message.type(), message.text()));
    page.on('pageerror', (error) => console.log('pageerror', error.message));
  });
  await new Promise((resolve) => setTimeout(resolve, 3500));
  console.log(await application.evaluate(() => globalThis.__dragonGirlTest?.snapshot()));
  for (const page of application.windows())
    console.log(page.url(), await page.evaluate(() => ({
      ready: document.readyState, bridge: !!window.dragonGirl, error: document.body.innerText,
    })));
} finally {
  await application?.close().catch(() => {});
  await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
