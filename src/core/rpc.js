import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { accountEnvironment, cliCandidates } from './platform.js';

// 优先使用所属 App 内附 CLI，避免多版本安装时跨实例误用二进制。
export async function locateCodex(appPath) {
  const candidates = cliCandidates(appPath);
  for (const p of candidates)
    try {
      await fs.access(p, process.platform === 'win32' ? 0 : 1);
      return p;
    } catch {}
  throw new Error('找不到 Codex CLI，请安装 Codex 或 ChatGPT 桌面应用。');
}
// 错误只公开分类；不把服务响应、凭据、代理 URL 或账户标识带入诊断。
export function rpcError(error) {
  const message = String(error?.message || error);
  if (/401|unauthorized|refresh.token|authentication/i.test(message))
    return '登录状态失效，请在对应 Codex 实例重新登录';
  if (/429|too many requests|rate.limit.exceeded|rate_limited/i.test(message))
    return '查询被限流，稍后自动重试';
  if (/sending request|connect|network|timeout|timed out|deadline/i.test(message))
    return '连接暂不可用，请检查该实例的代理或网络';
  if (/method not found|-32601/i.test(message)) return '当前 Codex 版本不支持这个查询';
  return 'Codex 查询失败，请刷新或查看连接诊断';
}
// 每次查询只读取账户，凭据刷新交给 Codex；退出时仅结束本应用启动的查询子进程。
export async function readAccount(
  home,
  { appPath, networkEnv = {}, timeout = 15000, signal, executable, prefixArgs = [], details = false } = {},
) {
  const cli = executable || (await locateCodex(appPath));
  return new Promise((resolve, reject) => {
    const env = accountEnvironment(home, networkEnv);
    // 运行时前缀兼容脚本形式的 CLI，始终使用参数数组且不启用 shell。
    const child = spawn(cli, [...prefixArgs, 'app-server', '--stdio'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '',
      initialized = false,
      finished = false;
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
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
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
        if ([2, 3].includes(m.id)) replies[m.id] = m;
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
