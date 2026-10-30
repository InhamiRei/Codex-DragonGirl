import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { locateCodex } from './rpc.js';
import { accountEnvironment } from './platform.js';
import { MAX_TEST_OUTPUT, TEST_INSTRUCTIONS, testRules } from '../shared/account-tests.js';

// 测试只覆盖子进程配置，原账号目录中的登录、模型和工具配置均不改写。
const TEST_CONFIG = {
  'features.shell_tool': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.apps': false,
  'features.plugins': false,
  'features.remote_plugin': false,
  'features.hooks': false,
  'features.code_mode.enabled': false,
  'features.js_repl': false,
  'features.skill_search': false,
  'features.skip_host_skill_discovery': true,
  'features.sleep_tool': false,
  'features.goals': false,
  'features.browser_use': false,
  'features.computer_use': false,
  'tools.view_image': false,
  web_search: 'disabled',
  project_doc_max_bytes: 0,
  developer_instructions: '',
  'skills.include_instructions': false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  notify: [],
};

// 公开错误只保留可操作的分类，服务响应和账号凭据不会进入界面或记录。
export class AccountTestError extends Error {
  // 可公开的错误带有明确类别，取消操作与请求失败分别展示。
  constructor(message, code = 'failed') {
    super(message);
    this.code = code;
  }
}

// 本地错误保留明确原因，上游未知错误统一脱敏。
export function accountTestError(error) {
  if (error instanceof AccountTestError) return error;
  const message = String(error?.message || error);
  if (/401|unauthorized|refresh.token|authentication|not.logged.in/i.test(message))
    return new AccountTestError('登录状态失效，请在对应实例重新登录');
  if (/429|quota|usage.limit|rate.limit|too many requests/i.test(message))
    return new AccountTestError('账号额度不足或请求被限流，请稍后重试');
  if (/model.*(not|unsupported|access)|unsupported.*model|invalid.model/i.test(message))
    return new AccountTestError('该账号当前无法使用所选模型，请重新读取模型列表');
  if (/timeout|timed out|network|connect|sending request|deadline/i.test(message))
    return new AccountTestError('连接失败或超时，请检查对应实例的代理和网络');
  if (/method not found|invalid params|-3260[12]/i.test(message))
    return new AccountTestError('当前 Codex CLI 不支持测试协议，请更新对应客户端');
  return new AccountTestError('模型请求失败，请刷新登录状态或更换可用模型后重试');
}

// 每次连接独占一个由龙娘启动的子进程，响应、通知与请求超时分别处理。
class TestRpc extends EventEmitter {
  // 连接只处理本进程的数据，不使用全局请求编号或共享回答缓冲区。
  constructor(child) {
    super();
    this.child = child;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk) => this.receive(this.decoder.write(chunk)));
    child.stdin.on('error', () => {});
    child.on('error', (error) => this.fail(error));
    child.on('exit', () => this.fail(new AccountTestError('测试进程已退出，请检查 Codex CLI')));
  }

  // UTF-8 解码器保留跨数据块的中文字符，异常大消息不能无限占用内存。
  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 2 * 1024 * 1024) {
      this.fail(new AccountTestError('测试服务返回的消息过大'));
      void this.close();
      return;
    }
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const request = message.method ? null : this.pending.get(message.id);
      if (request) {
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(accountTestError(message.error));
        else request.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        // 测试不接受额外的工具、权限或交互请求，也不自动放宽原有沙箱。
        this.send({ id: message.id, error: { code: -32601, message: 'Account tests do not allow tools or approvals' } });
        this.emit('failure', new AccountTestError('测试请求了工具或额外权限，已停止本次生成'));
      } else if (message.method) this.emit('notification', message);
    }
  }

  // 固定 JSON-RPC 连接只写入结构化消息，不运行 shell 或任意用户命令。
  send(message) {
    if (!this.closed && !this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  // 每个协议请求都有自己的截止时间，关闭连接后及时拒绝所有等待者。
  request(method, params = {}, timeout = 20000) {
    if (this.closed || this.failure) return Promise.reject(this.failure || new AccountTestError('测试连接已关闭'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AccountTestError('测试服务响应超时，请检查对应实例的网络'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  // 子进程异常只影响所属账号，不将失败传播成应用级未处理异常。
  fail(error) {
    if (this.closed || this.failure) return;
    this.failure = accountTestError(error);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(this.failure);
    }
    this.pending.clear();
    this.emit('failure', this.failure);
  }

  // 只回收本次创建的进程；等待退出后再移除临时工作目录。
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new AccountTestError('测试连接已关闭'));
    }
    this.pending.clear();
    this.closing = new Promise((resolve) => {
      if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 1500);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
      this.child.kill();
    });
    return this.closing;
  }
}

// 空目录隔离项目指令；保留账号自己的认证与代理，由 CLI 正常管理登录续期。
async function connect(home, options, callback) {
  if (options.signal?.aborted) throw new AccountTestError('测试已取消', 'cancelled');
  const cli = options.executable || await locateCodex(options.appPath).catch(() => {
    throw new AccountTestError('找不到 Codex CLI，请安装对应客户端或官方 CLI 后重试');
  });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dragongirl-test-'));
  let rpc;
  // 取消时关闭本连接，包含初始化和模型发现阶段，避免卡在尚未开始的回答上。
  const abort = () => { if (rpc?.cancel) void rpc.cancel(); else void rpc?.close(); };
  try {
    const overrides = Object.entries(TEST_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
    const child = spawn(cli, [...(options.prefixArgs || []), 'app-server', '--stdio', ...overrides], {
      cwd, env: accountEnvironment(home, options.networkEnv), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    rpc = new TestRpc(child);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) throw new AccountTestError('测试已取消', 'cancelled');
    await rpc.request('initialize', { clientInfo: { name: 'dragongirl_account_tests', title: 'GPT龙娘 · 账号测智', version: '1.2.2' }, capabilities: { experimentalApi: false } });
    rpc.send({ method: 'initialized', params: {} });
    const account = await rpc.request('account/read', { refreshToken: false });
    if (!account.account && account.requiresOpenaiAuth !== false)
      throw new AccountTestError('此实例尚未登录，请先在对应客户端登录');
    return await callback(rpc, cwd);
  } catch (error) {
    if (options.signal?.aborted) throw new AccountTestError('测试已取消', 'cancelled');
    throw accountTestError(error);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await rpc?.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

// 完整读取分页模型目录，仅向界面提供模型名和真实支持的思考强度。
async function modelsFrom(rpc) {
  const models = new Map();
  let cursor;
  for (let page = 0; page < 20; page++) {
    const result = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    for (const item of result.data || []) {
      if (!item.model || item.hidden) continue;
      models.set(item.model, {
        id: item.model, name: item.displayName || item.model, default: !!item.isDefault,
        defaultEffort: item.defaultReasoningEffort,
        efforts: (item.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).filter((e) => typeof e === 'string'),
      });
    }
    if (!result.nextCursor) return [...models.values()];
    if (result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  throw new AccountTestError('模型列表未读取完整，请重试');
}

// 模型预检只读取登录和目录，不发送生成请求。
export async function listAccountTestModels(home, options = {}) {
  return connect(home, options, (rpc) => modelsFrom(rpc));
}

// 全新临时会话使用同一指令、标准速度和参数，阻止工具调用污染回答对比。
export async function runAccountTest(home, { prompt, model, effort, format = 'text', signal, onProgress = () => {}, timeout = 600000, ...options }) {
  return connect(home, { ...options, signal }, async (rpc, cwd) => {
    const models = await modelsFrom(rpc);
    const chosen = models.find((m) => m.id === model);
    if (!chosen || (effort && !chosen.efforts.includes(effort)))
      throw new AccountTestError('该账号不支持所选模型或思考强度，请重新读取模型列表');
    // 已有 MCP 按名称逐项关闭，空对象不能覆盖配置层级合并后的服务器列表。
    const { config = {} } = await rpc.request('config/read', { includeLayers: false });
    const threadConfig = { ...TEST_CONFIG };
    for (const name of Object.keys(config.mcp_servers || {})) threadConfig[`mcp_servers.${name}.enabled`] = false;
    const started = await rpc.request('thread/start', {
      model, cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', serviceTier: 'default',
      baseInstructions: TEST_INSTRUCTIONS, developerInstructions: testRules(format), config: threadConfig,
    });
    if (started.model && started.model !== model)
      throw new AccountTestError('服务切换了所选模型，本次测试已停止，请重新读取模型列表');
    const instructionCount = started.instructionSources?.length || 0;
    onProgress({ text: '', usage: null, instructionCount });
    const threadId = started.thread.id;
    const messages = new Map();
    let turnId, usage = null, firstTokenMs = null, output = '', settled = false, succeeded = false;
    const began = Date.now();
    let resolveTurn, rejectTurn;
    const completion = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    // 提前挂接异常处理，通知可能早于 turn/start 的响应到达。
    void completion.catch(() => {});
    const fail = (error) => { if (!settled) { settled = true; rejectTurn(error); } };
    const timer = setTimeout(() => fail(new AccountTestError('测试超过十分钟，已停止本次生成')), timeout);
    // 部分输出可保留查看，但失败和取消不会被标记成完整结果。
    const update = () => {
      if ([...messages.values()].reduce((total, item) => total + item.text.length, 0) > MAX_TEST_OUTPUT * 2) {
        fail(new AccountTestError('回答超过长度限制，已停止本次生成'));
        return;
      }
      output = [...messages.values()].filter((m) => m.phase !== 'commentary').map((m) => m.text).join('\n\n');
      if (output.length > MAX_TEST_OUTPUT) { fail(new AccountTestError('回答超过长度限制，已停止本次生成')); return; }
      if (output && firstTokenMs === null) firstTokenMs = Date.now() - began;
      onProgress({ text: output, usage, firstTokenMs });
    };
    // 只接受当前会话的文本和用量，其他会话事件不能混入此结果。
    const notification = ({ method, params = {} }) => {
      if (settled || (params.threadId && params.threadId !== threadId)) return;
      if (method === 'turn/started') turnId = params.turn?.id;
      if (method === 'item/agentMessage/delta') {
        const item = messages.get(params.itemId) || { text: '', phase: params.phase };
        item.text += params.delta || '';
        messages.set(params.itemId, item);
        update();
      }
      if (method === 'item/started' || method === 'item/completed') {
        const item = params.item || {};
        if (!['userMessage', 'agentMessage', 'reasoning'].includes(item.type)) {
          fail(new AccountTestError('测试调用了工具，已停止生成；请使用直接回答的提示词'));
          return;
        }
        if (item.type === 'agentMessage') {
          const prior = messages.get(item.id);
          messages.set(item.id, { text: method === 'item/completed' ? item.text || prior?.text || '' : prior?.text || '', phase: item.phase || prior?.phase });
          update();
        }
      }
      if (method === 'thread/tokenUsage/updated') {
        usage = params.tokenUsage?.total || params.tokenUsage?.last || null;
        update();
      }
      if (method === 'error' && !params.willRetry) fail(accountTestError(params.error));
      if (method === 'turn/completed') {
        const turn = params.turn;
        if (turn?.status !== 'completed') {
          fail(turn?.status === 'interrupted' ? new AccountTestError('测试已中断', 'cancelled') : accountTestError(turn?.error));
          return;
        }
        for (const item of turn.items || [])
          if (item.type === 'agentMessage') messages.set(item.id, { text: item.text || '', phase: item.phase });
        update();
        if (!output.trim()) { fail(new AccountTestError('模型没有返回可展示的回答')); return; }
        if (!settled) { settled = true; succeeded = true; resolveTurn({ text: output, usage, firstTokenMs, durationMs: Date.now() - began, model, effort, instructionCount }); }
      }
    };
    rpc.on('notification', notification);
    rpc.on('failure', fail);
    const cancelled = () => fail(new AccountTestError('测试已取消', 'cancelled'));
    let interruption;
    // 取消信号与清理可能同时到达，同一轮只发送一次协议中断。
    const interrupt = () => interruption ||= turnId && !rpc.closed
      ? rpc.request('turn/interrupt', { threadId, turnId }, 1000).catch(() => {})
      : Promise.resolve();
    rpc.cancel = async () => {
      cancelled();
      await interrupt();
      await rpc.close();
    };
    signal?.addEventListener('abort', cancelled, { once: true });
    try {
      if (signal?.aborted) throw new AccountTestError('测试已取消', 'cancelled');
      const response = await rpc.request('turn/start', {
        threadId, model, ...(effort ? { effort } : {}), serviceTier: 'default',
        input: [{ type: 'text', text: prompt }],
      });
      turnId ||= response.turn?.id;
      return await completion;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      rpc.off('notification', notification);
      rpc.off('failure', fail);
      if (!succeeded) {
        await interrupt();
      }
    }
  });
}
