import { net } from 'electron';
import { Readable } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// 自行写入的下载也标记为互联网文件，交给系统打开时保留 Gatekeeper 或 Windows 的来源检查。
export async function markUpdateDownload(file, url) {
  if (process.platform === 'darwin') {
    const timestamp = Math.floor(Date.now() / 1000).toString(16);
    await execute('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0081;${timestamp};Codex DragonGirl;${randomUUID()}`, file]);
  } else if (process.platform === 'win32') {
    await writeFile(file + ':Zone.Identifier', `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${url}\r\n`);
  }
}

// 账本、窗口桥与助手收尾后启动当前用户安装器，NSIS 在成功安装后重新打开龙娘。
export function launchWindowsUpdate(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ['--updated', '/S', '--dg-restart'], { detached: true, stdio: 'ignore', cwd: path.dirname(file) });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// 保留系统代理设置。Electron 的 net.fetch 会取消手动重定向，附件改用能读取跳转地址的 ClientRequest。
export function fetchUpdateResource(url, options) {
  if (options.redirect !== 'manual') return net.fetch(url, options);
  return new Promise((resolve, reject) => {
    const { signal } = options;
    signal.throwIfAborted();
    const request = net.request({ url, redirect: 'manual', credentials: 'omit' });
    // 取消时同时唤醒等待响应头的调用方，并停止已经开始的响应正文传输。
    const abort = () => { reject(signal.reason); request.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    // 移除已完成请求的监听，避免长时间运行后仍持有旧响应。
    const removeAbort = () => signal.removeEventListener('abort', abort);
    // 重定向和无正文响应在收到响应头时就能交回下载器并释放当前连接。
    const finishWithoutBody = (status, headers) => {
      removeAbort();
      resolve(new Response(null, { status, headers }));
      request.abort();
    };
    request.once('redirect', (status, _method, location) => finishWithoutBody(status, { location }));
    request.once('response', (response) => {
      const status = response.statusCode;
      if ([204, 205, 304].includes(status)) return finishWithoutBody(status);
      // GET 请求的写入流会在响应头到达前关闭，网络取消监听应保留到响应正文结束。
      response.once('close', () => {
        removeAbort();
        if (!response.readableEnded) request.abort();
      });
      // Web 流的队列按字节计量，写盘变慢时让网络读取也暂停，不积压大量安装包分块。
      const body = Readable.toWeb(response, {
        strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
      });
      resolve(new Response(body, { status }));
    });
    request.on('error', (error) => { removeAbort(); reject(error); });
    request.end();
  });
}
