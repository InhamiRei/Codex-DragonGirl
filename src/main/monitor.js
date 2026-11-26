import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore, isQuiet } from '../core/settings.js';
import { discoverHomes, publicInstance } from '../core/instances.js';
import { readRecentQuota } from '../core/log-snapshot.js';
import { CLI_UNAVAILABLE, CLI_UNAVAILABLE_MESSAGE, GENERIC_RPC_ERROR, readAccount, rpcError } from '../core/rpc.js';
import { normalizeQuota, AlertTracker } from '../core/quota.js';
import { dayKey, midnight, nextDay } from '../shared/time.js';
import { digest } from '../core/usage-parser.js';
import { nativeBridgePath } from '../core/platform.js';
import { followProcess } from '../shared/follow-window.js';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const QUOTA_FRESH_MS = 120000;
// 缺少本地程序时只重查安装状态，避免套用远端请求的分钟级退避。
const CLI_RETRY_MS = 5000;
// 现有原声最长约 1.66 秒，队列留出完整播放和阅读气泡的时间。
const TASK_NOTICE_GAP_MS = 1750;

// 多实例采集调度器：原生窗口、官方额度、历史索引彼此独立，任一路失败不阻塞其他数据。
export class Monitor extends EventEmitter {
  // 初始化独立数据仓库、请求队列和通知状态。
  constructor(directory, { testMode = false, accountReader = readAccount } = {}) {
    super();
    this.directory = directory;
    this.testMode = testMode;
    this.accountReader = accountReader;
    this.settingsStore = new SettingsStore(directory);
    this.instances = [];
    this.processes = [];
    this.readings = new Map();
    this.logs = new Map();
    this.pending = new Map();
    this.controllers = new Set();
    this.requestId = 0;
    this.nativeSequence = 0;
    this.appliedNativeSequence = 0;
    this.nativeHomeLookups = new Map();
    this.progress = { done: 0, total: 0 };
    this.alerts = new AlertTracker();
    this.activeTasks = new Map();
    this.seenTaskTurns = new Set();
    this.mainTaskNotices = [];
    this.subagentTaskNotices = [];
    this.taskNoticeAvailableAt = 0;
    this.indexedAt = null;
    this.stopped = false;
  }
  // 加载本应用缓存后立即发现实例，历史索引在 Worker 中执行。
  async start() {
    this.taskStartedAt = Date.now();
    this.settings = await this.settingsStore.load();
    if (this.stopped) return;
    try {
      const data = await fs.readFile(path.join(this.directory, 'snapshots.json'), 'utf8');
      const saved = JSON.parse(data);
      // 缓存仅恢复仍在使用的账户字段，旧版废弃统计不会继续发布或保存。
      for (const [id, value] of Object.entries(saved.readings || {})) {
        const reading = {
          ...Object.fromEntries(
            ['quota', 'identity', 'account', 'error', 'attemptedAt', 'failures', 'retryMs']
              .filter((key) => value?.[key] !== undefined)
              .map((key) => [key, value[key]]),
          ),
          loading: false,
        };
        // 旧 Windows 缓存会把找不到 CLI 写成通用错误。升级后立即重查这类尚无官方读数的账号。
        if (reading.error === CLI_UNAVAILABLE_MESSAGE
          || (process.platform === 'win32' && reading.error === GENERIC_RPC_ERROR && !reading.quota)) {
          reading.attemptedAt = 0;
          reading.failures = 0;
        }
        this.readings.set(id, reading);
      }
      this.alerts = new AlertTracker(saved.alerts || []);
      this.savedCacheData = data;
    } catch {}
    if (this.stopped) return;
    this.worker = new Worker(new URL('../workers/usage-worker.js', import.meta.url), {
      workerData: { file: path.join(this.directory, 'usage.sqlite') },
    });
    this.worker.on('message', (message) => this.workerMessage(message));
    this.worker.on('error', () => this.workerFailed());
    this.worker.on('exit', () => { if (!this.stopped) this.workerFailed(); });
    if (!this.testMode) this.startNative();
    await this.discover();
    if (this.stopped) return;
    this.discoveryTimer = setInterval(() => this.discover().catch(() => {}), 5000);
    this.scanTimer = setInterval(() => {
      if (!this.scanning) this.worker.postMessage({ type: 'scan' });
    }, this.settings.scanSeconds * 1000);
    if (!this.testMode) {
      void this.refreshLogs();
      this.logTimer = setInterval(() => this.refreshLogs(), 15000);
      void this.refresh();
      this.refreshTimer = setInterval(() => this.refresh(), 1000);
    }
  }
  // Native 桥只发送几何与必要连接信息，stderr 不保存潜在进程环境。
  startNative() {
    if (this.stopped || this.native) return;
    clearTimeout(this.nativeRetry);
    this.native = spawn(nativeBridgePath(ROOT), process.platform === 'win32' ? ['--owner', String(process.pid)] : [], {
      windowsHide: true,
      stdio: [process.platform === 'win32' ? 'pipe' : 'ignore', 'pipe', 'ignore'],
    });
    const bridge = this.native;
    // 管道随桥重启而重建；旧管道关闭时不能让主进程因为 EPIPE 退出。
    bridge.stdin?.on('error', () => {});
    let buffer = '';
    // 中文目录和代理值可能跨管道数据块，使用流式 UTF-8 解码。
    this.native.stdout.setEncoding('utf8');
    this.native.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 2e6) {
        buffer = '';
        return;
      }
      let n;
      while ((n = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        try {
          const state = JSON.parse(line);
          void this.receiveNative(state, bridge).catch(() => {});
        } catch {}
      }
    });
    // 启动失败可能只发 error 和 close，已经运行的桥则会退出；对同一条连接只收起和重连一次。
    const disconnected = () => {
      if (this.stopped || this.native !== bridge) return;
      this.native = null;
      this.nativeError = '窗口桥暂不可用，正在恢复';
      this.processes = this.processes.map(row => ({ ...row, windows: [], frontmost: false }));
      this.windowOrder = [];
      this.normalWindows = [];
      this.emit('windows', { processes: this.processes, windowOrder: [], topmostWindows: [], normalWindows: [] });
      this.publish();
      this.nativeRetry = setTimeout(() => this.startNative(), 5000);
    };
    bridge.once('error', disconnected);
    bridge.once('close', disconnected);
  }
  // 层级请求复用原生桥管道，编号由原生端再次核对所属进程；断线或背压时等下一份心跳重试。
  stackWindows(host, overlays, owned) {
    const input = this.native?.stdin;
    const ids = [...overlays, ...owned].map(Number);
    if (this.stopped || !input?.writable || input.destroyed || input.writableLength > 16384
      || !Number.isSafeInteger(Number(host)) || Number(host) < 0 || !overlays.length
      || overlays.length > 256 || owned.length > 256
      || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) return false;
    input.write(JSON.stringify({ host: Number(host), overlays: overlays.map(Number), owned: owned.map(Number) }) + '\n', () => {});
    return true;
  }
  // 窗口心跳共用正在进行的目录查询；查询结束后仍允许识别链接变化或目录恢复。
  resolveNativeHome(home) {
    let lookup = this.nativeHomeLookups.get(home);
    if (!lookup) {
      lookup = fs.realpath(home).catch(() => home).finally(() => this.nativeHomeLookups.delete(home));
      this.nativeHomeLookups.set(home, lookup);
    }
    return lookup;
  }
  // 统一符号链接、盘符与目录大小写，迟到的桥接结果不能覆盖更新的窗口状态。
  async receiveNative(state, bridge) {
    if (this.stopped || bridge !== this.native) return;
    const sequence = ++this.nativeSequence;
    const processes = await Promise.all((state.processes || []).map(async (process) => ({
      ...process, home: await this.resolveNativeHome(process.home),
    })));
    // 已完成的快照不等待后续目录查询；仅丢弃会覆盖更新位置的旧结果。
    if (this.stopped || bridge !== this.native || sequence <= this.appliedNativeSequence) return;
    this.appliedNativeSequence = sequence;
    // 几何与层级直接同步给桌宠，账户状态按实例和运行时路径变化更新。
    const changed = this.nativeError || this.screenPermission !== state.screenPermission
      || this.processes.length !== processes.length || processes.some(({ pid, home, frontmost, appPath }, index) => {
        const previous = this.processes[index];
        return pid !== previous.pid || home !== previous.home || frontmost !== previous.frontmost || appPath !== previous.appPath;
      });
    // 宿主重新可用时跳过下一次 CLI 等待，服务端限流和其他账户错误仍按原计划重试。
    if (changed) for (const { home, appPath } of processes) {
      if (!appPath || this.processes.some((previous) => previous.home === home && previous.appPath === appPath)) continue;
      const instance = this.instances.find((candidate) => candidate.home === home);
      const reading = this.readings.get(instance?.id);
      if (reading?.error === CLI_UNAVAILABLE_MESSAGE) this.readings.set(instance.id, { ...reading, attemptedAt: 0 });
    }
    this.processes = processes;
    this.windowOrder = state.windowOrder;
    this.normalWindows = state.normalWindows;
    this.nativeError = null;
    this.screenPermission = state.screenPermission;
    this.emit('windows', { ...state, processes });
    if (changed) this.publish();
  }
  // 目录映射变化才重新配置索引，稳定时无需重扫历史。
  discover() {
    if (this.discoveryPromise) return this.discoveryPromise;
    if (this.stopped) return Promise.resolve();
    this.discoveryPromise = this.discoverInstances().finally(() => {
      this.discoveryPromise = null;
    });
    return this.discoveryPromise;
  }
  // 手动刷新和定时发现共用一次目录读取，完成前不使用半更新的实例集合。
  async discoverInstances() {
    const next = await discoverHomes(
      this.settings,
      this.processes,
      this.testMode
        ? process.env.DRAGONGIRL_FIXTURE_HOME || path.join(this.directory, 'empty-home')
        : undefined,
    );
    if (this.stopped) return;
    const changed = next.map((i) => i.home).join('|') !== this.instances.map((i) => i.home).join('|');
    this.instances = next;
    if (changed || !this.configured) {
      this.configured = true;
      if (this.taskWorker) this.configureTaskWorker();
      else if (!this.taskWorkerRetry) this.startTaskWorker();
      if (!this.workerUnavailable) this.worker.postMessage({
        type: 'configure',
        instances: next.map(({ id, home }) => ({ id, home })),
        settings: this.settings,
      });
    }
    this.publish();
  }
  // 独立的只读 Worker 与所有实例共用，崩溃重启仍沿用本次应用启动时间和主进程去重记录。
  startTaskWorker() {
    if (this.stopped || !this.instances.length) return;
    let worker;
    try {
      worker = new Worker(new URL('../workers/task-worker.js', import.meta.url), {
        workerData: { startedAt: this.taskStartedAt },
      });
    } catch {
      this.retryTaskWorker();
      return;
    }
    this.taskWorker = worker;
    worker.on('message', (message) => {
      if (this.taskWorker === worker && message.type === 'tasks') this.receiveTaskEvents(message.tasks);
    });
    // 错误随后会触发退出，由退出处理统一恢复，避免重复启动。
    worker.on('error', () => {});
    worker.on('exit', () => {
      if (this.taskWorker !== worker || this.stopped) return;
      this.taskWorker = null;
      this.retryTaskWorker();
    });
    this.configureTaskWorker();
  }
  // 创建失败或意外退出都只恢复提醒，不中断实例发现和用量索引。
  retryTaskWorker() {
    this.taskWorkerRetry = setTimeout(() => {
      this.taskWorkerRetry = null;
      this.startTaskWorker();
    }, 5000);
  }
  // 提醒只接收目录标识和间隔，切换子代理开关在派送端生效。
  configureTaskWorker() {
    this.taskWorker?.postMessage({ type: 'configure', interval: this.settings.taskCheckSeconds * 1000,
      instances: this.instances.map(({ id, home }) => ({ id, home })) });
  }
  // 系统恢复后核对遗漏的目录变化，随后沿用各会话的读取位置。
  reconcileTaskLogs() {
    if (!this.stopped) this.taskWorker?.postMessage({ type: 'reconcile' });
  }
  // 新鲜日志观察在首次长时间索引期间也独立更新。
  async refreshLogs() {
    if (this.readingLogs || this.stopped) return;
    this.readingLogs = true;
    try {
      for (const i of this.instances) {
        if (this.stopped) return;
        // 账户接口有新鲜读数时，界面会采用该读数，无需另行遍历会话目录。
        const quota = this.readings.get(i.id)?.quota;
        if (quota && Date.now() - quota.capturedAt <= QUOTA_FRESH_MS) continue;
        const recent = await readRecentQuota(i.home).catch(() => null);
        if (recent) {
          this.logs.set(i.id, recent);
          this.publish();
        }
      }
    } finally {
      this.readingLogs = false;
    }
  }
  // 每个目录单独排队与退避，记录当前批次结果供手动刷新复用。
  refresh(force = false, details = true, reused = null) {
    if (!force && this.manualRefresh) return this.manualRefresh;
    if (this.activeAccountBatch) return this.activeAccountBatch.promise;
    if (this.stopped) return Promise.reject(new Error('应用正在退出'));
    const batch = this.activeAccountBatch = { details, results: new Map() };
    batch.promise = this.refreshBatch(force, details, batch.results, reused).finally(() => {
      this.activeAccountBatch = null;
    });
    return batch.promise;
  }
  // 批次返回真实成功、失败和退避数量，界面可以区分无变化与未刷新。
  async refreshBatch(force, details, results, reused) {
    const targets = [];
    const result = { total: this.instances.length, success: 0, failed: 0, skipped: 0 };
    const now = Date.now();
    for (const instance of this.instances) {
      const reading = this.readings.get(instance.id);
      // 如果刚恢复宿主，前一轮的 CLI 定位失败不能覆盖立即重试的标记。
      if (reused?.has(instance.id) && !(reading?.error === CLI_UNAVAILABLE_MESSAGE && !reading.attemptedAt)) {
        result[reused.get(instance.id) ? 'success' : 'failed']++;
      } else if ((force && !reading?.error?.includes('限流'))
        || now - (reading?.attemptedAt || 0) > (reading?.retryMs || this.settings.refreshSeconds * 1000)) {
        targets.push(instance);
      } else {
        result.skipped++;
      }
    }
    if (this.refreshState?.running) this.refreshState = { ...this.refreshState, ...result };
    try {
      let cursor = 0;
      // 两个消费者共享游标，每个目录只在当前批次读取一次。
      const consume = async () => {
        while (cursor < targets.length && !this.stopped) {
          const instance = targets[cursor++];
          const success = await this.refreshOne(instance, details);
          results.set(instance.id, success);
          result[success ? 'success' : 'failed']++;
          if (this.refreshState?.running) {
            this.refreshState = { ...this.refreshState, ...result };
            this.publish();
          }
        }
      };
      await Promise.all([consume(), consume()]);
      await this.saveCache().catch(() => {});
    } finally {
      // 退避期间没有账户更新，额度过期状态由现有目录和索引心跳发布。
      if (targets.length) this.publish();
    }
    return result;
  }
  // 手动刷新等待账户和增量索引实际完成，重复点击或菜单操作共享同一次结果。
  refreshAll() {
    if (this.manualRefresh) return this.manualRefresh;
    this.manualRefresh = this.refreshAllData().finally(() => { this.manualRefresh = null; });
    return this.manualRefresh;
  }
  // 账户和账本独立推进，复用进行中的详细查询，只补读本轮未覆盖的账户。
  async refreshAllData() {
    if (this.stopped) throw new Error('应用正在退出');
    const pendingBatch = this.activeAccountBatch;
    this.refreshState = { running: true, accountsPending: true, indexPending: true, startedAt: Date.now(), success: 0, failed: 0, total: this.instances.length };
    this.publish();
    try {
      await this.discover();
      const accountsTask = Promise.resolve(pendingBatch?.promise).catch(() => {}).then(() =>
        this.refresh(true, true, pendingBatch?.details ? pendingBatch.results : null),
      ).finally(() => {
        this.refreshState = { ...this.refreshState, accountsPending: false };
        this.publish();
      });
      // indexed 消息早于 scan 响应；进度等待同一轮汇总，避免已完成却仍显示旧数字。
      const scanTask = this.request('scan').then(async (output) => {
        await this.summaryPromise;
        return output;
      }).finally(() => {
        this.refreshState = { ...this.refreshState, indexPending: false };
        this.publish();
      });
      const [accounts, scan] = await Promise.allSettled([accountsTask, scanTask]);
      const result = {
        ...this.refreshState,
        ...(accounts.status === 'fulfilled' ? accounts.value : { failed: this.instances.length }),
        running: false,
        finishedAt: Date.now(),
        indexedAt: this.indexedAt,
        indexError: scan.status === 'rejected' ? '本机账本刷新失败' : this.indexError || null,
        scanErrors: scan.status === 'fulfilled' ? scan.value.errors : 0,
      };
      this.refreshState = result;
      return result;
    } finally {
      this.refreshState = { ...this.refreshState, running: false, accountsPending: false, indexPending: false };
      this.publish();
    }
  }
  // 返回数据始终绑定发起请求的 home，迟到结果不能写入已移除实例。
  async refreshOne(instance, details) {
    const prior = this.readings.get(instance.id) || {},
      controller = new AbortController();
    this.controllers.add(controller);
    const runtime = this.processes.find((p) => p.home === instance.home) || instance.processes[0];
    this.readings.set(instance.id, { ...prior, loading: true, attemptedAt: Date.now() });
    this.publish();
    try {
      const response = await this.accountReader(instance.home, {
        appPath: runtime?.appPath,
        networkEnv: runtime?.networkEnv || {},
        signal: controller.signal,
        details,
      });
      if (!this.instances.some((i) => i.id === instance.id) || this.stopped) return;
      const quota = normalizeQuota(response.quota);
      if (quota?.accountId) quota.accountId = digest(quota.accountId);
      const identity = quota?.accountId || prior.identity || null;
      const switched = prior.identity && identity !== prior.identity;
      const error = response.errors.quota || (!quota ? '服务未返回有效额度' : null);
      const failed = !!error;
      const value = {
        quota: quota || (!switched ? prior.quota : null),
        identity,
        account: response.account
          ? { type: response.account.type, planType: response.account.planType }
          : null,
        error,
        loading: false,
        attemptedAt: Date.now(),
        failures: failed ? (prior.failures || 0) + 1 : 0,
        retryMs: failed
          ? Math.min(300000, 30000 * 2 ** Math.min(prior.failures || 0, 3))
          : this.settings.refreshSeconds * 1000,
      };
      this.readings.set(instance.id, value);
      for (const alert of this.alerts.evaluate(identity || instance.id, quota, this.settings.lowQuota))
        this.notify(instance, { event: 'quota', text: alert.text });
      // 重置卡到期提示以每日为粒度去重，不兑换卡券。
      for (const card of quota?.resetCredits?.details || []) {
        if (card.expiresAt && card.expiresAt > Date.now() && card.expiresAt - Date.now() < 86400000) {
          const key = `credit:${identity}:${card.expiresAt}`;
          if (!this.alerts.seen.has(key)) {
            this.alerts.seen.add(key);
            this.notify(instance, { event: 'quota', text: '有重置卡将在 24 小时内到期' });
          }
        }
      }
      return !failed;
    } catch (error) {
      if (!this.stopped && this.instances.some((candidate) => candidate.id === instance.id)) {
        const cliUnavailable = error?.code === CLI_UNAVAILABLE;
        const currentAppPath = cliUnavailable && this.processes.find((process) => process.home === instance.home)?.appPath;
        const hostRecovered = currentAppPath && currentAppPath !== runtime?.appPath;
        this.readings.set(instance.id, {
          ...prior,
          loading: false,
          error: rpcError(error),
          attemptedAt: hostRecovered ? 0 : Date.now(),
          failures: cliUnavailable ? 0 : (prior.failures || 0) + 1,
          retryMs: cliUnavailable ? CLI_RETRY_MS : Math.min(300000, 30000 * 2 ** Math.min(prior.failures || 0, 3)),
        });
      }
      return false;
    } finally {
      this.controllers.delete(controller);
      this.publish();
    }
  }
  // 去重标记与最近读数原子保存，只包含统计字段。
  async saveCache() {
    const file = path.join(this.directory, 'snapshots.json'),
      data = JSON.stringify({
        readings: Object.fromEntries(this.readings),
        alerts: [...this.alerts.seen].slice(-3000),
      });
    this.cacheQueue = (this.cacheQueue || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        // 在串行队列内对比最后一次成功写入，空闲检查和相同缓存的退出保存不触盘。
        if (data === this.savedCacheData) return;
        await fs.writeFile(file + '.tmp', data, { mode: 0o600 });
        await fs.rename(file + '.tmp', file);
        this.savedCacheData = data;
      });
    await this.cacheQueue;
  }

  // 账本 Worker 更新进度、额度和状态，由独立的任务 Worker 派送提醒。
  workerMessage(m) {
    if (this.stopped) return;
    // 手动扫描和自动扫描失败都应解除忙碌状态，下次成功后重新发布汇总。
    if (m.type === 'index-error' && (!m.id || m.operation === 'scan' || m.operation === 'rebuild')) {
      this.scanning = false;
      this.summaryRevision = null;
      this.indexError = '本机账本扫描失败，请重试刷新';
      this.publish();
    }
    if (m.id) {
      const promise = this.pending.get(m.id);
      if (promise) {
        this.pending.delete(m.id);
        m.error ? promise.reject(new Error(m.error)) : promise.resolve(m.result);
      }
      return;
    }
    if (m.type === 'progress') {
      this.progress = m;
      this.scanning = !m.complete;
    }
    if (m.type === 'log-quota') this.logs.set(m.home, { quota: m.quota, account: m.account });
    if (m.type === 'thread-state') this.activeTasks.set(`${m.home}:${m.thread}`, m);
    if (m.type === 'thread-states')
      this.activeTasks = new Map(m.states.map((state) => [`${state.home}:${state.thread}`, state]));
    if (m.type === 'indexed') {
      this.indexedAt = m.at;
      this.dataRevision = m.revision;
      const today = dayKey(Date.now(), this.settings.timezone);
      // 空闲扫描不重复汇总全部历史；跨日、价格或时区变化仍会更新。
      if (m.revision === undefined || m.revision !== this.summaryRevision || today !== this.summaryDay) {
        this.summaryRevision = m.revision;
        this.summaryDay = today;
        this.summaryPromise = (this.summaryPromise || Promise.resolve()).then(() => this.updateSummary());
      }
    }
    this.publish();
  }
  // 汇总按应用设定的时区取本地今天，预算提醒与页面一致。
  async updateSummary() {
    try {
      this.summary = await this.request('report', {});
      const today = dayKey(Date.now(), this.settings.timezone);
      this.today = await this.request('report', {
        filter: {
          from: midnight(today, this.settings.timezone),
          to: midnight(nextDay(today), this.settings.timezone),
        },
      });
      this.indexError = null;
      for (const instance of this.instances) {
        const usage = this.today.threads.filter((t) => t.home === instance.id),
          count = usage.reduce((a, b) => a + b.tokens, 0),
          cost = usage.reduce((a, b) => a + b.cost, 0);
        for (const [name, reached] of [
          ['token', this.settings.tokenBudget && count >= this.settings.tokenBudget],
          ['cost', this.settings.costBudget && cost >= this.settings.costBudget],
        ]) {
          const key = `budget:${name}:${instance.id}:${today}`;
          if (reached && !this.alerts.seen.has(key)) {
            this.alerts.seen.add(key);
            this.notify(instance, {
              event: 'quota',
              text: name === 'token' ? '今日 Tokens 用量达到预算' : '今日参考费用达到预算',
            });
          }
        }
      }
      this.publish();
    } catch {
      this.summaryRevision = null;
      this.indexError = '本机账本汇总失败，请重试刷新';
      this.publish();
    }
  }

  // 一批结果先全部去重并入队，同一批的子代理即使先读到也排在主任务之后。
  receiveTaskEvents(tasks) {
    if (this.stopped) return;
    const results = new Map();
    for (const task of tasks) {
      if (!this.instances.some(({ id }) => id === task.home)) continue;
      if (task.source !== '主任务' && task.source !== '子代理') continue;
      if (task.source === '子代理' && task.status !== 'complete') continue;
      const key = JSON.stringify([task.home, task.thread, task.turn || task.time]);
      if (this.seenTaskTurns.has(key)) continue;
      const prior = results.get(key);
      // 同批日志优先使用最终成功结果，重复的成功记录优先取有本轮用量的版本。
      if (!prior || (task.status === 'complete' && (prior.status === 'error'
        || (prior.status === 'complete' && task.turnUsage && !prior.turnUsage))))
        results.set(key, task);
    }
    if (!results.size) return;
    const quiet = isQuiet(this.settings);
    for (const [key, task] of results) {
      // 免打扰或关闭子代理时同样消费事件，之后开启时不补播。
      this.seenTaskTurns.add(key);
      if (quiet) continue;
      if (task.source === '主任务') this.mainTaskNotices.push(task);
      else if (this.settings.subagentNotifications) this.subagentTaskNotices.push(task);
    }
    this.flushTaskNotices();
  }
  // 每次显示一条并留出声音间隔，主任务到达时可以抢在子代理之前显示。
  flushTaskNotices() {
    clearTimeout(this.taskNoticeTimer);
    this.taskNoticeTimer = null;
    if (this.stopped) return;
    while (this.mainTaskNotices.length || this.subagentTaskNotices.length) {
      if (isQuiet(this.settings)) {
        this.mainTaskNotices.length = 0;
        this.subagentTaskNotices.length = 0;
        return;
      }
      const main = this.mainTaskNotices.length > 0;
      const wait = this.taskNoticeAvailableAt - Date.now();
      if (wait > 0 && !(main && this.lastTaskNoticeWasSubagent)) {
        this.taskNoticeTimer = setTimeout(() => this.flushTaskNotices(), wait);
        return;
      }
      const task = (main ? this.mainTaskNotices : this.subagentTaskNotices).shift();
      const instance = this.instances.find(({ id }) => id === task.home);
      if (!instance || (!main && !this.settings.subagentNotifications)) continue;
      this.lastTaskNoticeWasSubagent = !main;
      this.taskNoticeAvailableAt = Date.now() + TASK_NOTICE_GAP_MS;
      this.notify(instance, main ? {
        dialogueKind: task.status === 'complete' ? 'complete' : task.status === 'cancelled' ? 'cancelled' : 'error',
        event: task.status === 'error' ? 'error' : 'complete',
        expression: task.status === 'complete' ? 'happy' : task.status === 'error' ? 'sad' : null,
        turnUsage: task.status === 'complete' ? task.turnUsage : null,
      } : { event: 'complete', text: '子代理完成' });
    }
  }
  // 静音时仍更新数据；额度、预算和子代理提醒保留原文，主任务传结果和表情。
  notify(instance, notice) {
    if (!isQuiet(this.settings))
      this.emit('notice', {
        ...notice,
        home: instance.id,
        name: instance.name,
        system: this.settings.notifications,
      });
  }
  // 统一查询请求 ID，关闭和错误时拒绝待处理承诺。
  request(type, params = {}) {
    if (this.stopped) return Promise.reject(new Error('应用正在退出'));
    if (this.workerUnavailable) return Promise.reject(new Error('统计进程异常，请重新打开应用'));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, type, ...params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  // 统计进程意外退出后同时结束当前和后续请求，避免刷新按钮永久等待。
  workerFailed() {
    this.workerUnavailable = true;
    this.scanning = false;
    this.indexError = '统计进程异常，请重新打开应用';
    for (const pending of this.pending.values()) pending.reject(new Error(this.indexError));
    this.pending.clear();
    this.publish();
  }
  // 按实际新鲜度选择数据，不将几小时前的日志当作实时额度。
  snapshot() {
    const now = Date.now();
    return {
      settings: this.settings,
      instances: this.instances.map((i) => {
        const r = this.readings.get(i.id) || {},
          log = this.logs.get(i.id);
        let quota = r.quota;
        if (
          (!quota || now - quota.capturedAt > QUOTA_FRESH_MS) &&
          log?.quota &&
          now - log.quota.capturedAt <= QUOTA_FRESH_MS &&
          (!r.identity || r.identity === log.account)
        )
          quota = { ...log.quota, source: r.identity ? log.quota.source : '会话快照（账户待核实）' };
        const stale = !quota || now - quota.capturedAt > QUOTA_FRESH_MS;
        const tasks = [...this.activeTasks.values()].filter((t) => t.home === i.id);
        return {
          ...publicInstance({ ...i, processes: this.processes.filter((p) => p.home === i.home) }),
          ...r,
          quota,
          stale,
          taskState: tasks.some((t) => t.status === 'working' && now - (t.lastAt || 0) < 600000)
            ? 'working'
            : tasks.some((t) => t.status === 'error' && now - (t.lastAt || 0) < 600000)
              ? 'error'
              : tasks.some((t) => t.status === 'complete' && now - (t.lastAt || 0) < 600000)
                ? 'complete'
                : 'unknown',
        };
      }),
      progress: this.progress,
      indexedAt: this.indexedAt,
      dataRevision: this.dataRevision,
      refreshState: this.refreshState,
      indexError: this.indexError,
      nativeError: this.nativeError,
      screenPermission: this.screenPermission,
      projects: this.summary?.projects || [],
      summary: this.summary
        ? Object.fromEntries(
            Object.entries(this.summary).filter(([k]) => !['threads', 'projects'].includes(k)),
          )
        : null,
      today: this.today
        ? Object.fromEntries(
            Object.entries(this.today).filter(([k]) => !['threads', 'projects'].includes(k)),
          )
        : null,
    };
  }
  // 高频几何变化不高频重绘设置页面，采集状态最多每秒发布四次。
  publish() {
    if (this.stopped || this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.emit('update', this.snapshot());
    }, 250);
  }
  // 采集设置变化后重新配置索引；独立保存瞳色时沿用当前采集状态。
  async saveSettings(value, { refreshUsage = true } = {}) {
    const saved = await this.settingsStore.save(value);
    const { taskCheckSeconds: oldInterval, subagentNotifications: oldSubagents, ...previous } = this.settings || {};
    this.settings = saved;
    if (this.stopped) return this.settings;
    const { taskCheckSeconds, subagentNotifications, ...current } = saved;
    if (taskCheckSeconds !== oldInterval) this.configureTaskWorker();
    if (!subagentNotifications) this.subagentTaskNotices.length = 0;
    // 单独调节提醒不会重启账本计时器，也不会触发额外的历史目录扫描。
    const reminderChanged = taskCheckSeconds !== oldInterval || subagentNotifications !== oldSubagents;
    if (refreshUsage && (!reminderChanged || !isDeepStrictEqual(previous, current))) {
      // 修改预算等偏好后重新评估提醒，即使日志本身没有新增也要生效。
      this.summaryRevision = null;
      clearInterval(this.scanTimer);
      this.scanTimer = setInterval(() => {
        if (!this.scanning) this.worker.postMessage({ type: 'scan' });
      }, this.settings.scanSeconds * 1000);
      this.worker.postMessage({
        type: 'configure',
        instances: this.instances.map(({ id, home }) => ({ id, home })),
        settings: this.settings,
      });
      await this.discover();
    }
    this.publish();
    return this.settings;
  }
  // 聚焦通过 PID 进行，不依据易变化的窗口标题。
  focus(id, previousPid) {
    const instance = this.instances.find((i) => i.id === id);
    const proc = instance && followProcess(this.processes, instance.home, previousPid);
    if (proc)
      spawn(nativeBridgePath(ROOT), ['--focus', String(proc.pid)], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => {});
  }
  // 用刚获焦的气泡启动短命令，请求聚焦准确窗口句柄并限制等待时间。
  focusCompletedHost(pid, host, bubble) {
    return new Promise((resolve) => {
      const bridge = spawn(nativeBridgePath(ROOT), ['--focus-from-bubble', String(pid), String(host), String(process.pid), bubble], {
        windowsHide: true, stdio: 'ignore', timeout: 1500,
      });
      bridge.once('error', () => resolve(false));
      bridge.once('exit', (code) => resolve(code === 0));
    });
  }
  // 权限只在用户点击入口时请求，后台统计无需此权限。
  requestPermission() {
    spawn(nativeBridgePath(ROOT), ['--permission'], { stdio: 'ignore', windowsHide: true }).on(
      'error',
      () => {},
    );
  }
  // 退出停止调度、结束自身查询和原生桥，并刷新数据库检查点。
  async stop() {
    this.stopped = true;
    for (const timer of [
      this.discoveryTimer,
      this.scanTimer,
      this.refreshTimer,
      this.publishTimer,
      this.nativeRetry,
      this.logTimer,
      this.taskWorkerRetry,
      this.taskNoticeTimer,
    ])
      clearTimeout(timer);
    for (const c of this.controllers) c.abort();
    this.native?.kill();
    const taskStop = this.taskWorker?.terminate().catch(() => {});
    this.taskWorker = null;
    await this.settingsStore.flush().catch((error) => console.error('退出前保存偏好失败：', error.message));
    await this.saveCache().catch(() => {});
    for (const p of this.pending.values()) p.reject(new Error('应用正在退出'));
    this.pending.clear();
    if (this.worker) {
      let deadline;
      if (!this.workerUnavailable) {
        // 正常退出立即移除兜底计时器，不额外拖延进程结束。
        const exited = new Promise((resolve) => this.worker.once('exit', resolve));
        this.worker.postMessage({ type: 'close' });
        try {
          await Promise.race([exited, new Promise((resolve) => { deadline = setTimeout(resolve, 4000); })]);
        } finally { clearTimeout(deadline); }
      }
      await this.worker.terminate();
    }
    await taskStop;
  }
}
