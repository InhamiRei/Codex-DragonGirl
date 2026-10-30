import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { listAccountTestModels, runAccountTest, accountTestError, AccountTestError } from './account-test-rpc.js';
import { instanceLabel, planLabel } from '../shared/presentation.js';
import { MAX_TEST_OUTPUT, testRules, extractTestHtml } from '../shared/account-tests.js';

// 历史编号不能作为任意文件路径，测试记录与用量账本分开保存。
const RECORD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PENDING = new Set(['queued', 'running']);
const HISTORY_PAGE_SIZE = 10;

// 缩略图只接收完整回答，生成中的源码和失败前的部分输出留在详情记录里。
function previewSummary(result) {
  const completed = result.status === 'completed';
  const html = completed && !!extractTestHtml(result.text);
  return {
    instanceId: result.instanceId, name: result.name, plan: result.plan, status: result.status,
    startedAt: result.startedAt, durationMs: result.durationMs,
    totalTokens: Number.isFinite(result.usage?.totalTokens) ? result.usage.totalTokens : null,
    html, text: completed && !html ? result.text.slice(0, 2000) : '', error: result.error,
  };
}

// 列表只包含摘要，不把所有历史回答反复传递给界面。
function summary(run) {
  const { results, prompt, ...metadata } = run;
  return {
    ...metadata, promptPreview: prompt.slice(0, 90), accounts: results.length, completed: results.filter((r) => r.status === 'completed').length,
    previews: results.map(previewSummary),
  };
}

// 主进程调度真实账号、限制并发并保留每次测试实际使用的参数。
export class AccountTests extends EventEmitter {
  // 运行依赖可注入，真实调用和离线验证使用同一调度、存储及 IPC 路径。
  constructor(directory, { getInstances, getRuntime, getSettings = () => ({}), run = runAccountTest, models = listAccountTestModels } = {}) {
    super();
    this.directory = path.join(directory, 'account-tests');
    this.getInstances = getInstances;
    this.getRuntime = getRuntime;
    this.getSettings = getSettings;
    this.runner = run;
    this.modelReader = models;
    this.writes = Promise.resolve();
    this.catalogControllers = new Set();
    this.ready = fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    // 记录目录暂不可写时由用户操作显示错误，不让未处理拒绝影响桌宠和额度查询。
    void this.ready.catch(() => {});
  }

  // 所有账号只能从当前总览映射，界面不能传入自己的 home、代理或可执行文件。
  targets(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some((id) => typeof id !== 'string'))
      throw new Error('请选择 1 至 20 个账户总览中的账号');
    const all = this.getInstances();
    const targets = [...new Set(ids)].map((id) => all.find((i) => i.id === id));
    if (targets.some((i) => !i)) throw new Error('所选实例已不在账户总览中，请重新选择');
    return targets;
  }

  // 先逐账号读取模型，再取共同模型与思考强度；单个失败不会伪造成可用。
  async models(ids) {
    if (this.stopped) throw new Error('应用正在退出');
    const targets = this.targets(ids);
    const sequence = this.catalogSequence = (this.catalogSequence || 0) + 1;
    for (const controller of this.catalogControllers) controller.abort();
    const accounts = [];
    let cursor = 0;
    const consume = async () => {
      while (cursor < targets.length && !this.stopped && sequence === this.catalogSequence) {
        const instance = targets[cursor++];
        const controller = new AbortController();
        this.catalogControllers.add(controller);
        try {
          const models = await this.modelReader(instance.home, { ...this.getRuntime(instance.id), signal: controller.signal });
          accounts.push({ id: instance.id, models });
        } catch (error) {
          accounts.push({ id: instance.id, models: [], error: accountTestError(error).message });
        } finally { this.catalogControllers.delete(controller); }
      }
    };
    await Promise.all([consume(), consume()]);
    const common = (accounts[0]?.models || []).map((model) => ({
      ...model,
      efforts: model.efforts.filter((effort) => accounts.every((a) => a.models.find((m) => m.id === model.id)?.efforts.includes(effort))),
    })).filter((model) => accounts.length === targets.length && accounts.every((a) => a.models.some((m) => m.id === model.id)) &&
      (model.efforts.length || accounts.every((a) => {
        const matching = a.models.find((m) => m.id === model.id);
        return matching && !matching.efforts.length && matching.defaultEffort === model.defaultEffort;
      })));
    return { ids: targets.map((i) => i.id), models: common, accounts: accounts.map(({ id, error }) => ({ id, error: error || null })) };
  }

  // 原子串行落盘，较早的流式快照不能覆盖后来的完成或取消状态。
  save(run) {
    const contents = JSON.stringify(run);
    const file = path.join(this.directory, `${run.id}.json`);
    const write = this.writes.catch(() => {}).then(async () => {
      await this.ready;
      const temporary = file + '.tmp';
      await fs.writeFile(temporary, contents, { mode: 0o600 });
      await fs.rename(temporary, file);
    });
    this.writes = write;
    return write;
  }

  // 高频文本合并为轻量推送，完成和取消时立即发布并保存。
  publish(run, immediate = false) {
    run.revision = (run.revision || 0) + 1;
    if (immediate) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
      this.emit('update', structuredClone(run));
      return;
    }
    if (!this.publishTimer) this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.emit('update', structuredClone(run));
    }, 100);
  }

  // 创建记录前验证全部输入并锁定活动批次，重复点击不会重复消耗额度。
  async start(value) {
    if (this.stopped) throw new Error('应用正在退出');
    if (this.active || this.starting) throw new Error('已有测试正在运行，请等待完成或先停止');
    if (!value || !['pelican', 'custom'].includes(value.kind)) throw new Error('请选择有效的测试题目');
    const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
    if (!prompt || prompt.length > 20000) throw new Error('请输入 1 至 20000 字的提示词');
    if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 150)
      throw new Error('请先读取并选择可用模型');
    if (typeof value.effort !== 'string' || value.effort.length > 24) throw new Error('请选择有效的思考强度');
    if (![1, 2, 3].includes(value.concurrency)) throw new Error('并发数应为 1 至 3');
    if (!['text', 'html'].includes(value.format)) throw new Error('请选择文本或 HTML 输出');
    const targets = this.targets(value.instanceIds);
    const settings = this.getSettings();
    const run = {
      schemaVersion: 1, id: randomUUID(), createdAt: Date.now(), finishedAt: null, status: 'running',
      kind: value.kind, promptVersion: 1, prompt, model: value.model.trim(), effort: value.effort,
      testRules: testRules(value.kind === 'pelican' ? 'html' : value.format),
      format: value.kind === 'pelican' ? 'html' : value.format, concurrency: value.concurrency,
      results: targets.map((instance) => ({
        instanceId: instance.id, name: instanceLabel(instance, settings),
        plan: planLabel(instance.account?.type === 'apiKey' ? 'apiKey' : instance.account?.planType || instance.quota?.buckets?.[0]?.plan),
        shared: !!instance.identity && targets.some((i) => i.id !== instance.id && i.identity === instance.identity),
        status: 'queued', text: '', error: null, usage: null, startedAt: null, finishedAt: null, durationMs: null,
      })),
    };
    this.starting = true;
    try {
      await this.save(run);
      if (this.stopped) {
        run.status = 'cancelled';
        run.finishedAt = Date.now();
        for (const result of run.results) result.status = 'cancelled';
        await this.save(run);
        throw new Error('应用正在退出，测试未开始');
      }
      const active = { run, targets, controllers: new Map(), cancelled: false };
      this.active = active;
      this.publish(run, true);
      active.promise = this.execute(active).finally(() => { if (this.active === active) this.active = null; });
      // 后台任务的存储错误通过记录反馈，不能成为未处理的 Promise 拒绝。
      void active.promise.catch(() => {});
      return structuredClone(run);
    } finally { this.starting = false; }
  }

  // 一个消费者每次只处理一个实例；取消后的排队账号不会发送任何模型请求。
  async execute(active) {
    const { run, targets } = active;
    let cursor = 0;
    const consume = async () => {
      while (cursor < targets.length && !active.cancelled) {
        const index = cursor++;
        const instance = targets[index];
        const result = run.results[index];
        const controller = new AbortController();
        active.controllers.set(instance.id, controller);
        result.status = 'running';
        result.startedAt = Date.now();
        this.publish(run, true);
        try {
          // 队列等待期间账号可能被移除，执行前再次确认其所属目录。
          const current = this.targets([instance.id])[0];
          if (current.home !== instance.home) throw new AccountTestError('实例目录发生变化，请重新创建测试');
          const output = await this.runner(instance.home, {
            ...this.getRuntime(instance.id), prompt: run.prompt, model: run.model, effort: run.effort, format: run.format,
            signal: controller.signal,
            onProgress: (progress) => {
              if (result.status !== 'running' || active.cancelled) return;
              result.text = String(progress.text || '').slice(0, MAX_TEST_OUTPUT);
              result.usage = progress.usage || null;
              result.firstTokenMs = progress.firstTokenMs ?? null;
              if (progress.instructionCount !== undefined) result.instructionCount = progress.instructionCount;
              this.publish(run);
              if (Date.now() - (active.savedAt || 0) > 1500) {
                active.savedAt = Date.now();
                void this.save(run).catch(() => { run.storageError = '部分输出暂未保存，请检查磁盘空间'; });
              }
            },
          });
          if (active.cancelled) result.status = 'cancelled';
          else {
            result.text = String(output.text || '').slice(0, MAX_TEST_OUTPUT);
            result.usage = output.usage || null;
            result.durationMs = output.durationMs;
            result.firstTokenMs = output.firstTokenMs ?? null;
            result.actualModel = output.model || run.model;
            result.instructionCount = output.instructionCount || 0;
            result.status = 'completed';
          }
        } catch (error) {
          const safe = accountTestError(error);
          result.status = active.cancelled || safe.code === 'cancelled' ? 'cancelled' : 'failed';
          result.error = result.status === 'cancelled' ? null : safe.message;
        } finally {
          result.finishedAt = Date.now();
          result.durationMs ??= result.finishedAt - result.startedAt;
          active.controllers.delete(instance.id);
          await this.save(run).catch(() => { run.storageError = '测试记录保存失败，请检查磁盘空间并导出当前结果'; });
          this.publish(run, true);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(run.concurrency, targets.length) }, consume));
    } finally {
      for (const result of run.results) if (PENDING.has(result.status)) {
        result.status = active.cancelled ? 'cancelled' : 'interrupted';
        result.finishedAt = Date.now();
      }
      run.status = active.cancelled ? 'cancelled' : run.results.every((r) => r.status === 'completed') ? 'completed' : 'failed';
      run.finishedAt = Date.now();
      await this.save(run).catch(() => { run.storageError = '测试记录保存失败，请导出当前结果'; });
      this.publish(run, true);
    }
  }

  // 立即停止队列并中断当前子进程，保留已经完成的结果和已有部分输出。
  async cancel(id) {
    const active = this.active;
    if (!active || active.run.id !== id) return false;
    active.cancelled = true;
    active.run.cancelling = true;
    for (const result of active.run.results) if (result.status === 'queued') result.status = 'cancelled';
    for (const controller of active.controllers.values()) controller.abort();
    this.publish(active.run, true);
    await active.promise;
    return true;
  }

  // 读取单条历史前检查编号、大小和基础结构，退出遗留的任务显示为已中断。
  async read(id) {
    if (!RECORD_ID.test(id || '')) throw new Error('无效的测试记录编号');
    if (this.active?.run.id === id) return structuredClone(this.active.run);
    await this.ready;
    const file = path.join(this.directory, `${id}.json`);
    try {
      if ((await fs.stat(file)).size > 12 * 1024 * 1024) throw new Error('记录过大');
      const run = JSON.parse(await fs.readFile(file, 'utf8'));
      if (run.id !== id || !Array.isArray(run.results) || typeof run.prompt !== 'string') throw new Error('记录损坏');
      if (run.status === 'running') {
        run.status = 'interrupted';
        for (const result of run.results) if (PENDING.has(result.status)) result.status = 'interrupted';
      }
      return run;
    } catch { throw new Error('测试记录不存在或无法读取'); }
  }

  // 历史按时间分页，读取损坏的单条文件不会使其他记录消失。
  async list(page = 1) {
    await this.ready;
    const files = (await fs.readdir(this.directory)).filter((file) => file.endsWith('.json') && RECORD_ID.test(file.slice(0, -5)));
    const dated = await Promise.all(files.map(async (file) => ({ file, time: (await fs.stat(path.join(this.directory, file))).mtimeMs })));
    dated.sort((a, b) => b.time - a.time);
    const total = files.length;
    const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE)));
    const records = [];
    for (const { file } of dated.slice((current - 1) * HISTORY_PAGE_SIZE, current * HISTORY_PAGE_SIZE)) {
      try { records.push(summary(await this.read(file.slice(0, -5)))); } catch {}
    }
    return { records, page: current, total, pages: Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE)), activeId: this.active?.run.status === 'running' ? this.active.run.id : null };
  }

  // 删除只作用于已结束的指定记录，运行中的测试需要先停止。
  async remove(id) {
    if (!RECORD_ID.test(id || '')) throw new Error('无效的测试记录编号');
    if (this.active?.run.id === id) throw new Error('请先停止测试再删除记录');
    await this.writes.catch(() => {});
    await fs.rm(path.join(this.directory, `${id}.json`));
    return true;
  }

  // 单项重测创建新记录，原回答和原参数保持可追溯。
  async retry({ id, instanceId }) {
    const previous = await this.read(id);
    if (!previous.results.some((r) => r.instanceId === instanceId)) throw new Error('该账号不属于这条测试记录');
    return this.start({ ...previous, instanceIds: [instanceId], concurrency: 1 });
  }

  // 退出前停止模型读取和生成，等待最后一次原子保存完成。
  async stop() {
    this.stopped = true;
    for (const controller of this.catalogControllers) controller.abort();
    if (this.active) await this.cancel(this.active.run.id);
    clearTimeout(this.publishTimer);
    await this.writes.catch(() => {});
  }
}
