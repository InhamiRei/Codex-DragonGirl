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
    // 每一跳先交回下载器核对目标域名，通过后再单独请求。
    request.once('redirect', (status, _method, location) => {
      resolve(new Response(null, { status, headers: { location } }));
      request.abort();
    });
    request.once('response', (response) => {
      const status = response.statusCode;
      // Web 流的队列按字节计量，写盘变慢时让网络读取也暂停，不积压大量安装包分块。
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(response, {
        strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
      });
      resolve(new Response(body, { status }));
    });
    // 释放网络请求，同时唤醒等待响应头的调用方。
    const abort = () => { reject(signal.reason); request.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    request.on('error', reject);
    // 在响应头之前意外断开也要结束等待；已经得到响应的 Promise 会忽略这次拒绝。
    request.once('close', () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('下载连接中断，请重试。'));
    });
    request.end();
  });
}
