import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore, isQuiet } from '../core/settings.js';
import { discoverHomes, publicInstance } from '../core/instances.js';
import { readRecentQuota } from '../core/log-snapshot.js';
import { readAccount, rpcError } from '../core/rpc.js';
import { normalizeQuota, AlertTracker } from '../core/quota.js';
import { dayKey, midnight, nextDay } from '../shared/time.js';
import { digest } from '../core/usage-parser.js';
import { dialogueLine } from '../shared/dialogue.js';
import { nativeBridgePath } from '../core/platform.js';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// 多实例采集调度器：原生窗口、官方额度、历史索引彼此独立，任一路失败不阻塞其他数据。
export class Monitor extends EventEmitter {
  // 初始化独立数据仓库、请求队列和通知状态。
  constructor(directory, { testMode = false } = {}) {
    super();
    this.directory = directory;
    this.testMode = testMode;
    this.settingsStore = new SettingsStore(directory);
    this.instances = [];
    this.processes = [];
    this.readings = new Map();
    this.logs = new Map();
    this.pending = new Map();
    this.controllers = new Set();
    this.requestId = 0;
    this.progress = { done: 0, total: 0 };
    this.alerts = new AlertTracker();
    this.activeTasks = new Map();
    this.indexedAt = null;
    this.stopped = false;
    this.dialogueCounts = {};
  }
  // 加载本应用缓存后立即发现实例，历史索引在 Worker 中执行。
  async start() {
    this.settings = await this.settingsStore.load();
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.directory, 'snapshots.json'), 'utf8'));
      // 缓存仅恢复仍在使用的账户字段，旧版废弃统计不会继续发布或保存。
      for (const [id, value] of Object.entries(saved.readings || {}))
        this.readings.set(id, {
          ...Object.fromEntries(
            ['quota', 'identity', 'account', 'error', 'attemptedAt', 'failures', 'retryMs']
              .filter((key) => value?.[key] !== undefined)
              .map((key) => [key, value[key]]),
          ),
          loading: false,
        });
      this.alerts = new AlertTracker(saved.alerts || []);
    } catch {}
    this.worker = new Worker(new URL('../workers/usage-worker.js', import.meta.url), {
      workerData: { file: path.join(this.directory, 'usage.sqlite') },
    });
    this.worker.on('message', (message) => this.workerMessage(message));
    this.worker.on('error', () => {
      this.indexError = '统计进程异常，请重新打开应用';
      for (const pending of this.pending.values()) pending.reject(new Error(this.indexError));
      this.pending.clear();
      this.publish();
    });
    if (!this.testMode) this.startNative();
    await this.discover();
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
    this.native = spawn(nativeBridgePath(ROOT), [], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const bridge = this.native;
    let buffer = '';
    this.native.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
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
    this.native.on('error', () => {
      this.nativeError = '窗口桥不可用，统计仍可使用';
      this.publish();
    });
    this.native.on('exit', () => {
      if (!this.stopped) {
        this.nativeError = '窗口桥已退出，正在恢复';
        this.nativeRetry = setTimeout(() => this.startNative(), 5000);
      }
    });
  }
  // 统一符号链接、盘符与目录大小写，迟到的桥接结果不能覆盖更新的窗口状态。
  async receiveNative(state, bridge) {
    const sequence = this.nativeSequence = (this.nativeSequence || 0) + 1;
    const processes = await Promise.all((state.processes || []).map(async (process) => ({
      ...process, home: await fs.realpath(process.home).catch(() => process.home),
    })));
    if (this.stopped || bridge !== this.native || sequence !== this.nativeSequence) return;
    this.processes = processes;
    this.nativeError = null;
    this.screenPermission = state.screenPermission;
    this.emit('windows', { ...state, processes });
    this.publish();
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
    const changed = next.map((i) => i.home).join('|') !== this.instances.map((i) => i.home).join('|');
    this.instances = next;
    if (changed || !this.configured) {
      this.configured = true;
      this.worker.postMessage({
        type: 'configure',
        instances: next.map(({ id, home }) => ({ id, home })),
        settings: this.settings,
      });
    }
    this.publish();
  }
  // 新鲜日志观察在首次长时间索引期间也独立更新。
  async refreshLogs() {
    if (this.readingLogs || this.stopped) return;
    this.readingLogs = true;
    try {
      for (const i of this.instances) {
        const recent = await readRecentQuota(i.home).catch(() => null);
        if (recent) this.logs.set(i.id, recent);
      }
      this.publish();
    } finally {
      this.readingLogs = false;
    }
  }
  // 每个目录单独排队与退避，同时读取重置卡明细，悬停无需额外发起账户请求。
  refresh(force = false, details = true) {
    if (!force && this.manualRefresh) return this.manualRefresh;
    if (this.refreshPromise) return this.refreshPromise;
    if (this.stopped) return Promise.reject(new Error('应用正在退出'));
    this.refreshPromise = this.refreshBatch(force, details).finally(() => {
      this.refreshPromise = null;
      this.publish();
    });
    return this.refreshPromise;
  }
  // 批次返回真实成功、失败和退避数量，界面可以区分无变化与未刷新。
  async refreshBatch(force, details) {
    const targets = this.instances.filter(
      (i) =>
        (force && !this.readings.get(i.id)?.error?.includes('限流')) ||
        Date.now() - (this.readings.get(i.id)?.attemptedAt || 0) >
          (this.readings.get(i.id)?.retryMs || this.settings.refreshSeconds * 1000),
    );
    const result = { total: this.instances.length, success: 0, failed: 0, skipped: this.instances.length - targets.length };
    if (this.refreshState?.running) this.refreshState = { ...this.refreshState, ...result };
    try {
      let cursor = 0;
      // 两个消费者共享游标，每个目录只在当前批次读取一次。
      const consume = async () => {
        while (cursor < targets.length && !this.stopped) {
          const instance = targets[cursor++];
          const success = await this.refreshOne(instance, details);
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
      this.publish();
    }
    return result;
  }
  // 手动刷新等待账户和增量索引实际完成，重复点击或菜单操作共享同一次结果。
  refreshAll() {
    if (this.manualRefresh) return this.manualRefresh;
    this.manualRefresh = this.refreshAllData().finally(() => { this.manualRefresh = null; });
    return this.manualRefresh;
  }
  // 先等待正在运行的账户批次，再强制读取；索引失败也保留账户刷新结果。
  async refreshAllData() {
    if (this.stopped) throw new Error('应用正在退出');
    this.refreshState = { running: true, startedAt: Date.now(), success: 0, failed: 0, total: this.instances.length };
    this.publish();
    try {
      await this.refreshPromise;
      await this.discover();
      const [accounts, scan] = await Promise.allSettled([
        this.refresh(true, true),
        this.request('scan'),
      ]);
      // indexed 消息早于 scan 响应，等待同一轮汇总，避免按钮结束时仍显示旧数字。
      await this.summaryPromise;
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
      this.refreshState = { ...this.refreshState, running: false };
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
      const response = await readAccount(instance.home, {
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
        this.notify(instance, 'quota', alert.text);
      // 重置卡到期提示以每日为粒度去重，不兑换卡券。
      for (const card of quota?.resetCredits?.details || []) {
        if (card.expiresAt && card.expiresAt > Date.now() && card.expiresAt - Date.now() < 86400000) {
          const key = `credit:${identity}:${card.expiresAt}`;
          if (!this.alerts.seen.has(key)) {
            this.alerts.seen.add(key);
            this.notify(instance, 'quota', '有重置卡将在 24 小时内到期');
          }
        }
      }
      return !failed;
    } catch (error) {
      if (!this.stopped)
        this.readings.set(instance.id, {
          ...prior,
          loading: false,
          error: rpcError(error),
          attemptedAt: Date.now(),
          failures: (prior.failures || 0) + 1,
          retryMs: Math.min(300000, 30000 * 2 ** Math.min(prior.failures || 0, 3)),
        });
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
        await fs.writeFile(file + '.tmp', data, { mode: 0o600 });
        await fs.rename(file + '.tmp', file);
      });
    await this.cacheQueue;
  }

  // Worker 推送使用固定字段，初始扫描的历史事件不触发声音。
  workerMessage(m) {
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
    if (m.type === 'thread-state') {
      this.activeTasks.set(`${m.home}:${m.thread}`, m);
    }
    if (m.type === 'task') {
      const i = this.instances.find((i) => i.id === m.task.home);
      if (i && m.task.source === '主任务') {
        const kind = m.task.status === 'complete' ? 'complete' : m.task.status === 'cancelled' ? 'cancelled' : 'error';
        const index = this.dialogueCounts[kind] || 0;
        this.dialogueCounts[kind] = index + 1;
        this.notify(
          i,
          m.task.status === 'error' ? 'error' : 'complete',
          dialogueLine(kind, index),
        );
      }
    }
    if (m.type === 'indexed') {
      this.indexedAt = m.at;
      this.summaryPromise = this.updateSummary();
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
            this.notify(
              instance,
              'quota',
              name === 'token' ? '今日 Tokens 用量达到预算' : '今日参考费用达到预算',
            );
          }
        }
      }
      this.publish();
    } catch {
      this.indexError = '本机账本汇总失败，请重试刷新';
      this.publish();
    }
  }

  // 静音时仍更新数据；事件文本不包含对话正文。
  notify(instance, event, text) {
    if (!isQuiet(this.settings))
      this.emit('notice', {
        home: instance.id,
        name: instance.name,
        event,
        text,
        system: this.settings.notifications,
      });
  }
  // 统一查询请求 ID，关闭和错误时拒绝待处理承诺。
  request(type, params = {}) {
    if (this.stopped) return Promise.reject(new Error('应用正在退出'));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...params });
    });
  }
  // 按实际新鲜度选择数据，不将几小时前的日志当作实时额度。
  snapshot() {
    return {
      settings: this.settings,
      instances: this.instances.map((i) => {
        const r = this.readings.get(i.id) || {},
          log = this.logs.get(i.id);
        let quota = r.quota;
        if (
          (!quota || Date.now() - quota.capturedAt > 120000) &&
          log?.quota &&
          Date.now() - log.quota.capturedAt <= 120000 &&
          (!r.identity || r.identity === log.account)
        )
          quota = { ...log.quota, source: r.identity ? log.quota.source : '会话快照（账户待核实）' };
        const stale = !quota || Date.now() - quota.capturedAt > 120000;
        const tasks = [...this.activeTasks.values()].filter((t) => t.home === i.id);
        return {
          ...publicInstance({ ...i, processes: this.processes.filter((p) => p.home === i.home) }),
          ...r,
          quota,
          stale,
          taskState: tasks.some((t) => t.status === 'working' && Date.now() - (t.lastAt || 0) < 600000)
            ? 'working'
            : tasks.some((t) => t.status === 'error' && Date.now() - (t.lastAt || 0) < 600000)
              ? 'error'
              : tasks.some((t) => t.status === 'complete' && Date.now() - (t.lastAt || 0) < 600000)
                ? 'complete'
                : 'unknown',
        };
      }),
      progress: this.progress,
      indexedAt: this.indexedAt,
      refreshState: this.refreshState,
      indexError: this.indexError,
      nativeError: this.nativeError,
      screenPermission: this.screenPermission,
      projects: this.summary?.projects || [],
      summary: this.summary
        ? Object.fromEntries(
            Object.entries(this.summary).filter(([k]) => !['threads', 'tasks', 'projects'].includes(k)),
          )
        : null,
      today: this.today
        ? Object.fromEntries(
            Object.entries(this.today).filter(([k]) => !['threads', 'tasks', 'projects'].includes(k)),
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
  // 保存偏好后重置计时器，使刷新频率立即生效。
  async saveSettings(value) {
    this.settings = await this.settingsStore.save(value);
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
    this.publish();
    return this.settings;
  }
  // 聚焦通过 PID 进行，不依据易变化的窗口标题。
  focus(id) {
    const instance = this.instances.find((i) => i.id === id);
    const proc = this.processes.find((p) => p.home === instance?.home);
    if (proc)
      spawn(nativeBridgePath(ROOT), ['--focus', String(proc.pid)], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => {});
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
    ])
      clearTimeout(timer);
    for (const c of this.controllers) c.abort();
    this.native?.kill();
    await this.saveCache().catch(() => {});
    for (const p of this.pending.values()) p.reject(new Error('应用正在退出'));
    this.pending.clear();
    if (this.worker) {
      this.worker.postMessage({ type: 'close' });
      await Promise.race([
        new Promise((r) => this.worker.once('exit', r)),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
      await this.worker.terminate();
    }
  }
}
