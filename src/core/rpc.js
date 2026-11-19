import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { accountEnvironment, cliCandidates } from './platform.js';

// 只缓存已通过版本探测的文件，大小和时间等标识变化后重新验证。
const verifiedWindowsClis = new Map();
const runFile = promisify(execFile);
export const CLI_UNAVAILABLE = 'CODEX_CLI_UNAVAILABLE';
export const CLI_UNAVAILABLE_MESSAGE = '找不到可运行的 Codex CLI，请检查安装后刷新账户';
export const GENERIC_RPC_ERROR = 'Codex 查询失败，请刷新或查看连接诊断';
// 初始化错误可能已经脱敏；诊断层再次分类时保留这组固定提示。
const RPC_MESSAGES = {
  login: '登录状态失效，请在对应 Codex 实例重新登录',
  rateLimit: '查询被限流，稍后自动重试',
  connection: '连接暂不可用，请检查该实例的代理或网络',
  unsupported: '当前 Codex 版本不支持这个查询',
};
const SAFE_RPC_MESSAGES = new Set([...Object.values(RPC_MESSAGES), CLI_UNAVAILABLE_MESSAGE, GENERIC_RPC_ERROR]);
const RPC_MESSAGES_BY_CODE = new Map([['401', RPC_MESSAGES.login], ['429', RPC_MESSAGES.rateLimit], ['-32601', RPC_MESSAGES.unsupported]]);

// 先尝试现有路径，再按版本文件的修改时间检查桌面版缓存；目录名不代表版本顺序。
async function* windowsCliFiles(appPath, environment) {
  yield* cliCandidates(appPath, 'win32', environment);
  if (!environment.LOCALAPPDATA || !path.isAbsolute(environment.LOCALAPPDATA)) return;
  const cache = path.join(environment.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  const entries = await fs.readdir(cache, { withFileTypes: true }).catch(() => []);
  const versions = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async ({ name }) => {
    const file = path.join(cache, name, 'codex.exe');
    const info = await fs.stat(file).catch(() => null);
    return info?.isFile() ? { file, updatedAt: info.mtimeMs } : null;
  }));
  for (const { file } of versions.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt)) yield file;
}

// 文件存在仍可能无法运行，只接受返回官方 CLI 版本格式的原生程序。
async function verifyWindowsCli(file, environment, signal) {
  const info = await fs.stat(file).catch(() => null);
  if (!info?.isFile()) return false;
  const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  if (verifiedWindowsClis.get(file) === signature) return true;
  // PATH 也可能指向 Electron 桌面程序目录，探测版本前排除常见的 GUI 发行布局。
  const resources = path.join(path.dirname(file), 'resources');
  for (const marker of ['app.asar', path.join('app', 'package.json')]) {
    if ((await fs.stat(path.join(resources, marker)).catch(() => null))?.isFile()) return false;
  }
  try {
    const { stdout } = await runFile(file, ['--version'], {
      env: accountEnvironment(undefined, {}, environment, 'win32'), signal, windowsHide: true, timeout: 3000, maxBuffer: 16384,
    });
    if (!/^codex-cli\s+\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/i.test(stdout.trim())) return false;
    verifiedWindowsClis.set(file, signature);
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

// 额度查询和账号测智共用查找；优先使用运行宿主的附带 CLI。
export async function locateCodex(appPath, { platform = process.platform, environment = process.env, signal } = {}) {
  if (platform === 'win32') {
    for await (const file of windowsCliFiles(appPath, environment)) {
      signal?.throwIfAborted();
      if (await verifyWindowsCli(file, environment, signal)) return file;
    }
  } else {
    for (const file of cliCandidates(appPath, platform, environment)) {
      signal?.throwIfAborted();
      try { await fs.access(file, 1); return file; } catch {}
    }
  }
  signal?.throwIfAborted();
  throw Object.assign(new Error(CLI_UNAVAILABLE_MESSAGE), { code: CLI_UNAVAILABLE });
}
// 错误只公开分类；不把服务响应、凭据、代理 URL 或账户标识带入诊断。
export function rpcError(error) {
  if (error?.code === CLI_UNAVAILABLE) return CLI_UNAVAILABLE_MESSAGE;
  const message = String(error?.message || error);
  if (SAFE_RPC_MESSAGES.has(message)) return message;
  const category = RPC_MESSAGES_BY_CODE.get(String(error?.code ?? ''));
  if (category) return category;
  if (/\b401\b|unauthorized|refresh.token|authentication/i.test(message)) return RPC_MESSAGES.login;
  if (/\b429\b|too many requests|rate.limit.(?:exceeded|reached)|rate_limited/i.test(message)) return RPC_MESSAGES.rateLimit;
  if (/sending request|connect|network|timeout|timed out|deadline/i.test(message)) return RPC_MESSAGES.connection;
  if (/method not found|-32601/i.test(message)) return RPC_MESSAGES.unsupported;
  return GENERIC_RPC_ERROR;
}
// 每次查询只读取账户，凭据刷新交给 Codex；退出时仅结束本应用启动的查询子进程。
export async function readAccount(
  home,
  { appPath, networkEnv = {}, timeout = 15000, signal, executable, prefixArgs = [], details = false } = {},
) {
  if (signal?.aborted) throw new Error('查询已取消');
  const cli = executable || (await locateCodex(appPath, { signal }));
  if (signal?.aborted) throw new Error('查询已取消');
  return new Promise((resolve, reject) => {
    const env = accountEnvironment(home, networkEnv);
    // 运行时前缀兼容脚本形式的 CLI，始终使用参数数组且不启用 shell。
    const child = spawn(cli, [...prefixArgs, 'app-server', '--stdio'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '',
      initialized = false,
      finished = false;
    let quotaRequestId = 3;
    const replies = {};
    // 序列化请求并处理退出过程中的 EPIPE。
    const send = (message) => {
      if (!finished && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n');
    };
    // 请求完成与取消统一清理定时器和进程，避免后台泄漏。
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      child.stdin.end();
      child.kill();
      const killer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 1500);
      killer.unref();
      error
        ? reject(error)
        : resolve({
            account: replies[2]?.result?.account || null,
            quota: replies[3]?.result || null,
            errors: {
              quota: replies[3]?.error ? rpcError(replies[3].error) : null,
            },
            cli,
          });
    };
    const cancel = () => finish(new Error('查询已取消'));
    const timer = setTimeout(() => finish(new Error('Codex query timeout')), timeout);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    child.stdin.on('error', () => {});
    child.on('error', finish);
    child.on('exit', () => {
      if (!finished) finish(new Error('Codex 查询服务提前退出'));
    });
    // 流式解码保留跨数据块的中文套餐与额度桶名称。
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) {
        finish(new Error('异常响应过大'));
        return;
      }
      let n;
      while ((n = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1 && !initialized) {
          if (m.error) {
            finish(new Error(rpcError(m.error)));
            return;
          }
          initialized = true;
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
          send({
            id: 3,
            method: 'account/rateLimits/read',
            params: { excludeResetCreditDetails: !details },
          });
        }
        if (m.id === 2) replies[2] = m;
        if (m.id === quotaRequestId) {
          // 旧版 app-server 只接受空参数；收到参数错误时换新请求编号重试一次。
          if (quotaRequestId === 3 && [-32600, -32602].includes(m.error?.code)) {
            quotaRequestId = 4;
            send({ id: quotaRequestId, method: 'account/rateLimits/read', params: null });
          } else replies[3] = m;
        }
        if (replies[2] && replies[3]) {
          finish();
          return;
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'dragongirl', title: 'GPT龙娘', version: '1.2.0' },
        capabilities: { experimentalApi: false },
      },
    });
  });
}
