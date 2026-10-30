import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StartupRegistration, readStartupJson, writeStartupJson } from '../core/startup-registration.js';
import { freshStartupStatus, shouldStopWithHost, startupReason } from '../core/startup-policy.js';
import { normalizeSettings } from '../core/settings.js';

// 主程序通过本地心跳与原生助手协作，退出始终走正常保存流程。
export class StartupController {
  // 系统注册与运行时控制分离，桌面测试不会写入真实登录项。
  constructor({ app, root, directory, testMode, argv = process.argv }) {
    Object.assign(this, { app, directory, testMode });
    this.reason = startupReason(argv);
    this.requestedRevision = argv.find((arg) => arg.startsWith('--dg-startup-revision='))?.slice('--dg-startup-revision='.length);
    this.managed = this.reason === 'codex';
    this.files = path.join(directory, 'startup');
    this.registration = new StartupRegistration({ root, directory, executable: process.execPath });
    this.launchId = randomUUID();
    this.absentSince = null;
    this.queue = Promise.resolve();
    this.error = '';
    this.stopping = false;
  }

  // 先发布运行状态再启动助手，首次启用联动时不会另开一个管理窗口。
  async start(settings) {
    this.settings = settings;
    // 关闭联动或更新注册后迟到的启动请求直接结束，不能绕过用户刚保存的选择。
    if (this.reason !== 'manual') {
      this.config = await this.registration.current();
      if (settings.startupMode !== this.reason || (this.requestedRevision && this.config?.revision !== this.requestedRevision)) return false;
    }
    await this.heartbeat();
    this.timer = setInterval(() => void this.tick().catch((error) => { this.error = error.message; }), 1000);
    this.timer.unref();
    if (this.reason === 'manual') await this.resume();
    try {
      if (this.app.isPackaged && !this.testMode) {
        const previous = await this.registration.current();
        this.config = await this.registration.configure(settings.startupMode);
        this.configuredAt = Date.now();
        // 旧版登录项在新注册成功后移除，迁移失败不会丢掉原来的启动方式。
        if (!previous && settings.launchAtLogin) this.app.setLoginItemSettings({ openAtLogin: false });
        // Windows 登录项只在登录时运行；手动打开应用也能修复意外停止的助手。
        const status = await readStartupJson(path.join(this.files, 'status.json')).catch(() => null);
        if (this.reason === 'manual' && this.config?.mode === 'codex' && !freshStartupStatus(status, this.config.revision))
          await this.registration.launch(this.config.helper, ['--config', this.registration.configFile]);
      } else this.config = await this.registration.current();
    } catch (error) { this.error = error.message; }
    return true;
  }

  // 心跳只包含应用自身信息，不带任何账号标识或进程环境。
  async heartbeat() {
    await writeStartupJson(path.join(this.files, 'runtime.json'), {
      version: 1, pid: process.pid, executable: process.execPath, launchId: this.launchId, updatedAt: Date.now(),
    });
  }

  // 手动打开解除当前暂停，并把应用生命周期交还用户。
  async resume() {
    this.managed = false;
    this.absentSince = null;
    await fs.rm(path.join(this.files, 'pause.json'), { force: true });
  }

  // 用户从托盘打开管理页后可以继续使用账本，不因随后关闭 Codex 而被打断。
  retain() { void this.resume().catch((error) => { this.error = error.message; }); }

  // 轮询串行执行，磁盘迟缓时不会叠加写入或重复发起退出。
  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      await this.heartbeat();
      this.config = await this.registration.current();
      this.status = await readStartupJson(path.join(this.files, 'status.json'));
      const now = Date.now();
      if (freshStartupStatus(this.status, this.config?.revision, now) && !this.status.hosts.length)
        this.absentSince ??= now;
      else this.absentSince = null;
      if (shouldStopWithHost({ managed: this.managed, mode: this.settings.startupMode,
        displayMode: this.settings.mode, status: this.status, revision: this.config?.revision,
        absentSince: this.absentSince, now })) {
        this.hostExit = true;
        this.app.quit();
      }
    } finally { this.ticking = false; }
  }

  // 系统注册成功后才保存偏好，失败时恢复原方式并把错误交给界面。
  save(value, persist) {
    const next = normalizeSettings(value);
    this.queue = this.queue.catch(() => {}).then(async () => {
      const previous = this.settings;
      const changed = next.startupMode !== previous.startupMode;
      if (changed && !this.app.isPackaged && !this.testMode)
        throw new Error('自动启动需要使用安装包中的龙娘，开发模式不注册登录项。');
      let configured = false, saved;
      try {
        if (changed && !this.testMode) {
          this.config = await this.registration.configure(next.startupMode, { force: true });
          configured = true;
          this.configuredAt = Date.now();
        }
        saved = await persist(next);
      } catch (error) {
        if (configured) {
          try {
            this.config = await this.registration.configure(previous.startupMode, { force: true });
            await persist(previous);
          }
          catch (rollback) { throw new Error(`${error.message}；启动方式恢复失败：${rollback.message}`); }
        }
        throw error;
      }
      this.settings = saved;
      if (changed) {
        this.managed = false;
        this.error = '';
        await this.resume().catch((error) => { this.error = error.message; });
      }
      return saved;
    });
    return this.queue;
  }

  // 退出前先写暂停，再结束心跳，防止助手在保存数据库期间重新拉起应用。
  async prepareQuit() {
    this.stopping = true;
    await this.queue.catch(() => {});
    if (!this.hostExit && this.settings?.startupMode === 'codex') {
      const status = await readStartupJson(path.join(this.files, 'status.json')).catch(() => null);
      const fresh = freshStartupStatus(status, this.config?.revision);
      await writeStartupJson(path.join(this.files, 'pause.json'), {
        hosts: fresh ? status.hosts : [], untilEmpty: !fresh, createdAt: Date.now(),
      });
    }
  }

  // 只移除属于本次运行的心跳，重复启动的退出不会干扰已有实例。
  async stop() {
    clearInterval(this.timer);
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 20));
    const file = path.join(this.files, 'runtime.json');
    const state = await readStartupJson(file).catch(() => null);
    if (state?.launchId === this.launchId) await fs.rm(file, { force: true });
  }

  // 设置页显示可执行的恢复办法，过期心跳不显示为已连接。
  snapshot() {
    if (this.error) return { message: this.error, error: true };
    if (!this.app.isPackaged && !this.testMode) return { message: '自动启动在安装包中生效，开发模式不注册登录项。' };
    if (this.settings?.startupMode === 'manual') return { message: '需要时手动打开龙娘。' };
    if (this.settings?.startupMode === 'login') return { message: '登录电脑后静默启动，可从托盘打开管理界面。' };
    if (!freshStartupStatus(this.status, this.config?.revision) && Date.now() - this.configuredAt < 6000)
      return { message: '正在连接启动助手…', pending: true };
    if (!freshStartupStatus(this.status, this.config?.revision))
      return { message: '启动助手未连接；可切换为手动启动并保存，再重新启用联动。', error: true };
    return { message: this.status.message || (this.status.phase === 'paused'
      ? '本次已暂停，重新打开龙娘或重启 Codex 后恢复。'
      : '联动已开启；退出龙娘后，本批 Codex 实例结束前不会自动重开。'), error: this.status.phase === 'error' };
  }
}
