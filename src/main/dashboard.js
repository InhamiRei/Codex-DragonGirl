import { verifyAudioLibrary, downloadAudioLibrary } from '../core/audio-library-store.js';
import { BrowserWindow, ipcMain, dialog, app, Notification, nativeImage, screen } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DEFAULT_SETTINGS, normalizeSettings } from '../core/settings.js';
import { planLabel, instanceLabel } from '../shared/presentation.js';
import { Companion } from './companion.js';
import { followWindowFrame } from '../shared/follow-window.js';
import { AccountTests } from '../core/account-tests.js';
import { extractTestHtml } from '../shared/account-tests.js';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DASHBOARD_URL = 'dragon://app/src/renderer/dashboard.html';

// 总览窗口统一管理 N 个采集源，桌宠窗口只负责各自展示和交互。
export class Dashboard {
  // 绑定主角色、采集器和经过来源校验的界面命令。
  constructor(monitor, primary, startup = null) {
    this.monitor = monitor;
    this.primary = primary;
    this.startup = startup;
    this.pets = new Map();
    this.assetDirectory = path.join(monitor.directory, 'assets');
    this.bundledAudioDirectory = path.join(ROOT, 'assets/audio');
    this.tests = new AccountTests(monitor.directory, {
      getInstances: () => monitor.snapshot().instances,
      getSettings: () => monitor.settings,
      getRuntime: (id) => {
        const instance = monitor.instances.find((item) => item.id === id);
        const runtime = monitor.processes.find((item) => item.home === instance?.home) || instance?.processes?.[0];
        return { appPath: runtime?.appPath, networkEnv: runtime?.networkEnv || {} };
      },
    });
    this.tests.on('update', (run) => {
      if (this.window && !this.window.isDestroyed()) this.window.webContents.send('dg:account-tests', run);
    });
    this.delegate = {
      openDashboard: () => this.open(),
      refresh: () => void monitor.refreshAll().catch(() => {}),
      bubbleFor: (c) => this.bubbleFor(c),
      onDrag: (c) => this.onDrag(c),
    };
    primary.delegate = this.delegate;
    ipcMain.handle('dg:command', (event, command, value) => {
      if (
        !this.window ||
        event.sender !== this.window.webContents ||
        event.senderFrame !== this.window.webContents.mainFrame ||
        event.senderFrame.url !== DASHBOARD_URL
      )
        throw new Error('无效的界面来源');
      return this.command(command, value);
    });
    monitor.on('update', (snapshot) => {
      this.latest = snapshot;
      if (this.window && !this.window.isDestroyed())
        this.window.webContents.send('dg:monitor', snapshot);
      this.updatePets();
    });
    monitor.on('windows', () => this.follow());
    monitor.on('notice', (notice) => {
      const pet =
        [this.primary, ...this.pets.values()].find((c) => c.instanceId === notice.home) || this.primary;
      pet.notify(notice.event, notice.text);
      if (notice.system && Notification.isSupported()) {
        const n = new Notification({ title: `GPT龙娘 · ${notice.name}`, body: notice.text, silent: true });
        n.on('click', () => {
          monitor.focus(notice.home);
          this.open();
        });
        n.show();
      }
    });
  }
  // 设置与详情需要可聚焦的正常窗口，不改变桌宠的鼠标穿透策略。
  async open() {
    this.startup?.retain();
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }
    this.window = new BrowserWindow({
      width: 1160,
      height: 820,
      minWidth: 880,
      minHeight: 660,
      title: 'GPT龙娘 · 用量管理',
      backgroundColor: '#f5f4fa',
      show: false,
      webPreferences: {
        preload: path.join(ROOT, 'src/main/preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window.setMenuBarVisibility(false);
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event) => event.preventDefault());
    // 生成页面只能在受限预览协议内导航，脚本和链接不能跳到网络或本地文件。
    this.window.webContents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame || !event.url.startsWith('dragon-preview://test/')) event.preventDefault();
    });
    await this.window.loadURL(DASHBOARD_URL);
    this.window.show();
  }
  // 选定目录优先；未固定时跟随当前前台 Codex，切到其他应用时保留最近实例。
  selected() {
    const instances = this.latest?.instances || [];
    const selected =
      instances.find((i) => i.home === this.monitor.settings.selectedHome) ||
      instances.find((i) => i.frontmost) ||
      instances.find((i) => i.id === this.primary.instanceId) ||
      instances[0];
    return selected;
  }
  // 气泡模板只有固定占位符，用户输入不会被当作 HTML 或脚本执行。
  bubbleFor(companion) {
    const i = this.latest?.instances.find((i) => i.id === companion.instanceId) || this.selected();
    if (!i) return '还没有发现应用实例\n右键打开设置，添加数据目录';
    const quota = i.stale
      ? '额度待刷新'
      : i.quota?.buckets
          .flatMap((b) =>
            b.windows.map(
              (w) =>
                `${w.label} ${w.remaining > 0 && w.remaining < 1 ? '<1' : Math.round(w.remaining)}%`,
            ),
          )
          .join(' · ') || '暂无额度数据';
    const vars = {
      name: instanceLabel(i, this.monitor.settings),
      plan: planLabel(
        i.account?.type === 'apiKey' ? 'apiKey' : i.account?.planType || i.quota?.buckets[0]?.plan,
      ),
      quota,
      tokens: new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(
        this.latest?.today?.homes[i.id] || 0,
      ),
      status:
        i.taskState === 'working'
          ? '工作中'
          : i.taskState === 'complete'
            ? '任务完成'
            : i.taskState === 'error'
              ? '任务异常'
              : '状态待更新',
    };
    Object.assign(vars, {
      实例: vars.name,
      套餐: vars.plan,
      额度: vars.quota,
      今日用量: vars.tokens,
      任务状态: vars.status,
    });
    const text = this.monitor.settings.bubbleTemplate
      .replace(/\{([^{}\s]+)\}/g, (text, key) => vars[key] ?? text)
      .slice(0, 220);
    // 仅默认模板展示结构化用量，自定义模板始终保留用户自己的纯文本排版。
    const quotas = i.stale ? [] : (i.quota?.buckets || []).flatMap((bucket) =>
      bucket.windows.map((window) => ({
        label: i.quota.buckets.length > 1 ? `${bucket.name} · ${window.label}` : window.label,
        remaining: window.remaining,
        low: window.remaining <= this.monitor.settings.lowQuota,
      })),
    );
    return {
      text,
      usage: this.monitor.settings.bubbleTemplate === DEFAULT_SETTINGS.bubbleTemplate
        ? {
            plan: vars.plan,
            quotas,
            quotaNote: quotas.length ? '' : quota,
            tokens: vars.tokens,
          }
        : null,
    };
  }
  // 一个运行进程一个跟随角色，统计仍按规范目录和账户去重。
  async updatePets() {
    if (this.updating || this.monitor.stopped) return;
    this.updating = true;
    try {
      const settings = this.monitor.settings,
        selected = this.selected();
      this.primary.instanceId = selected?.id;
      this.primary.instanceName = selected ? instanceLabel(selected, settings) : undefined;
      this.primary.home = selected?.home;
      const primaryProcess =
        this.monitor.processes.find((p) => p.home === selected?.home && p.frontmost) ||
        this.monitor.processes.find((p) => p.home === selected?.home);
      this.primary.followPID = primaryProcess?.pid;
      const extra =
        settings.multiplePets && settings.mode === 'follow'
          ? this.monitor.processes.filter(
              (p) =>
                p.pid !== primaryProcess?.pid && this.latest?.instances.some((i) => i.home === p.home),
            )
          : [];
      for (const [pid, pet] of this.pets)
        if (!extra.some((p) => p.pid === pid)) {
          await pet.stop();
          this.pets.delete(pid);
        }
      for (const process of extra)
        if (!this.pets.has(process.pid)) {
          const i = this.latest.instances.find((i) => i.home === process.home);
          const pet = new Companion(path.join(this.monitor.directory, 'pets', i.id), {
            secondary: true,
            initiallySuppressed: true,
            delegate: this.delegate,
          });
          pet.instanceId = i.id;
          pet.instanceName = instanceLabel(i, settings);
          pet.home = i.home;
          pet.followPID = process.pid;
          this.pets.set(process.pid, pet);
          await pet.start();
        }
      for (const pet of [this.primary, ...this.pets.values()]) {
        const i = this.latest?.instances.find((i) => i.id === pet.instanceId);
        const asset = settings.characterAsset
          ? `dragon://app/user-assets/${settings.characterAsset}`
          : 'dragon://app/assets/characters/codex-dragon-girl.png';
        const appearance = {
          settings,
          asset,
          assetPath: settings.characterAsset
            ? path.join(this.assetDirectory, settings.characterAsset)
            : path.join(ROOT, 'assets/characters/codex-dragon-girl.png'),
          status: i?.taskState || 'idle',
        };
        const key = JSON.stringify(appearance);
        if (key !== pet.appearanceKey) {
          pet.appearanceKey = key;
          pet.setAppearance(appearance);
        }
        pet.updateMenu();
      }
      this.follow();
    } finally {
      this.updating = false;
    }
  }
  // 选择文件等模态弹窗、最小化或不可见时隐藏关联角色；恢复后沿用相对位置。
  follow() {
    const settings = this.monitor.settings;
    if (!settings) return;
    for (const pet of [this.primary, ...this.pets.values()]) {
      if (settings.mode === 'desktop') {
        if (pet.suppressedByFollow || pet.followTarget) {
          pet.suppressedByFollow = false;
          pet.followTarget = null;
          pet.restore();
          pet.applyCharacter();
          if (pet.visible) pet.show();
        }
        continue;
      }
      const process = this.monitor.processes.find((p) => p.pid === pet.followPID);
      let frame = followWindowFrame(process);
      // Windows 原生窗口使用物理像素，转换为 Electron 的逻辑坐标后再跟随。
      if (frame && process.coordinateSpace === 'physical' && globalThis.process.platform === 'win32')
        frame = screen.screenToDipRect(null, frame);
      pet.followFrame(frame, settings.followOffsets[pet.home] || { x: 1, y: 1 });
    }
  }
  // 跟随模式中的拖拽保存窗口内相对锚点，屏幕缩放不会破坏用户意图。
  onDrag(pet) {
    const frame = pet.followTarget;
    if (this.monitor.stopped || this.monitor.settings.mode !== 'follow' || !frame || !pet.home) return;
    const home = pet.home;
    const x = Math.max(
        0,
        Math.min(1, (pet.character.x - frame.x) / Math.max(1, frame.width - pet.character.width)),
      ),
      y = Math.max(
        0,
        Math.min(1, (pet.character.y - frame.y) / Math.max(1, frame.height - pet.character.height)),
      );
    void this.monitor
      .saveSettings((current) => ({
        ...current,
        followOffsets: { ...current.followOffsets, [home]: { x, y } },
      }))
      .catch(() => {
        this.monitor.nativeError = '跟随位置暂未保存，请检查应用数据目录';
        this.monitor.publish();
      });
  }
  // 文件对话框由用户明确操作触发，所有导入内容复制到应用独立资源目录。
  async importCharacter() {
    const result = await dialog.showOpenDialog(this.window, {
      properties: ['openFile'],
      filters: [
        {
          name: '透明角色',
          extensions: ['png', 'webp'],
        },
      ],
    });
    if (result.canceled) return null;
    const source = result.filePaths[0],
      stat = await fs.stat(source);
    if (stat.size > 15 * 1024 * 1024) throw new Error('素材不能超过 15 MiB');
    {
      const image = nativeImage.createFromPath(source);
      if (image.isEmpty()) throw new Error('无法读取图片');
      const size = image.getSize();
      if (size.width > 4096 || size.height > 4096) throw new Error('角色图片最长边不能超过 4096 像素');
      const pixels = image.toBitmap();
      let clear = false,
        opaque = false;
      for (let i = 3; i < pixels.length; i += 4) {
        clear ||= pixels[i] === 0;
        opaque ||= pixels[i] > 24;
      }
      if (!clear || !opaque) throw new Error('请选择同时包含透明背景和可见角色的图片');
    }
    await fs.mkdir(this.assetDirectory, { recursive: true });
    const name = randomBytes(16).toString('hex') + path.extname(source).toLowerCase();
    await fs.copyFile(source, path.join(this.assetDirectory, name));
    return name;
  }
  // 导出通过系统保存框选择目标，CSV 对电子表格公式前缀做转义。
  async exportData(type, filter) {
    const result = await dialog.showSaveDialog(this.window, {
      defaultPath: `龙娘用量-${new Date().toISOString().slice(0, 10)}.${type}`,
      filters: [{ name: type === 'csv' ? '表格文件' : '数据文件', extensions: [type] }],
    });
    if (result.canceled) return false;
    const rows = await this.monitor.request('rows', { filter });
    let body = JSON.stringify(
      {
        scope: '本机用量',
        timezone: this.monitor.settings.timezone,
        exportedAt: new Date().toISOString(),
        rows,
      },
      null,
      2,
    );
    if (type === 'csv') {
      const keys = [
        'home',
        'thread',
        'time',
        'model',
        'tier',
        'project',
        'source',
        'input_tokens',
        'cached_input_tokens',
        'cache_write_input_tokens',
        'output_tokens',
        'reasoning_output_tokens',
        'total_tokens',
      ];
      const cell = (value) => {
        let s = String(value ?? '');
        if (/^[\t\r\n ]*[=+@-]/.test(s)) s = "'" + s;
        return '"' + s.replaceAll('"', '""') + '"';
      };
      body =
        '\ufeff' +
        keys.join(',') +
        '\n' +
        rows
          .map((r) =>
            keys.map((k) => cell(k === 'time' ? new Date(r[k]).toISOString() : r[k])).join(','),
          )
          .join('\n');
    }
    await fs.writeFile(result.filePath, body);
    return true;
  }
  // 固定命令表只暴露统计和本应用设置，禁止渲染层调用任意命令或修改 Codex 资料。
  async command(command, value) {
    if (command === 'test-models') return this.tests.models(value);
    if (command === 'test-start') return this.tests.start(value);
    if (command === 'test-cancel') return this.tests.cancel(value);
    if (command === 'test-list') return this.tests.list(value);
    if (command === 'test-read') return this.tests.read(value);
    if (command === 'test-delete') return this.tests.remove(value);
    if (command === 'test-retry') return this.tests.retry(value || {});
    if (command === 'test-export') return this.exportTest(value || {});
    if (command === 'default-settings') return normalizeSettings();
    if (command === 'startup-status') return this.startup?.snapshot() || { message: '' };
    if (command === 'normalize-settings') return normalizeSettings(value);
    if (command === 'snapshot') return { ...this.monitor.snapshot(), appearance: this.primary.state };
    if (command === 'refresh') return this.monitor.refreshAll();
    if (command === 'report') return this.monitor.request('report', { filter: value || {} });
    if (command === 'focus') {
      this.monitor.focus(value);
      return true;
    }
    if (command === 'permission') {
      this.monitor.requestPermission();
      return true;
    }
    if (command === 'settings' || command === 'replace-settings') {
      // 普通表单只能修改偏好；位置以排队写入时的最新值为准，导入或恢复默认才替换位置。
      const persist = (settings) => this.monitor.saveSettings(command === 'replace-settings'
        ? settings : (current) => ({ ...settings, followOffsets: current.followOffsets }));
      return this.startup
        ? this.startup.save(value, persist)
        : persist(value);
    }
    if (command === 'appearance') {
      if (Number.isFinite(value?.scale))
        for (const pet of [this.primary, ...this.pets.values()]) pet.setScale(value.scale);
      if (typeof value?.snapEnabled === 'boolean') {
        this.primary.state.snapEnabled = value.snapEnabled;
        this.primary.persist();
      }
      return this.primary.state;
    }
    if (command === 'add-home') {
      const result = await dialog.showOpenDialog(this.window, {
        properties: ['openDirectory'],
        message: '选择包含 sessions 或 config.toml 的 Codex 数据目录',
      });
      if (result.canceled) return false;
      await this.monitor.saveSettings({
        ...this.monitor.settings,
        manualHomes: [...this.monitor.settings.manualHomes, result.filePaths[0]],
        hiddenHomes: this.monitor.settings.hiddenHomes.filter((h) => h !== result.filePaths[0]),
      });
      return true;
    }
    if (command === 'import-character') return this.importCharacter();
    if (command === 'audio-status')
      return verifyAudioLibrary(this.assetDirectory, this.bundledAudioDirectory);
    // 离线优先修复，完成后通知所有播放器重新预热，用户无需重启或重新保存设置。
    if (command === 'install-audio') {
      if (!this.audioInstall)
        this.audioInstall = downloadAudioLibrary(this.assetDirectory, fetch, this.bundledAudioDirectory)
          .then((status) => {
            const windows = [
              this.window,
              ...[this.primary, ...this.pets.values()].map((pet) => pet.windows.get('character')),
            ];
            for (const window of windows)
              if (window && !window.isDestroyed()) window.webContents.send('dg:audio-ready');
            return status;
          })
          .finally(() => { this.audioInstall = null; });
      return this.audioInstall;
    }
    if (command === 'export-json' || command === 'export-csv')
      return this.exportData(command.endsWith('csv') ? 'csv' : 'json', value || {});
    if (command === 'export-settings') {
      const r = await dialog.showSaveDialog(this.window, { defaultPath: '龙娘设置.json' });
      if (r.canceled) return false;
      await fs.writeFile(r.filePath, JSON.stringify(this.monitor.settings, null, 2));
      return true;
    }
    if (command === 'import-settings') {
      const r = await dialog.showOpenDialog(this.window, {
        properties: ['openFile'],
        filters: [{ name: '设置', extensions: ['json'] }],
      });
      if (r.canceled) return null;
      const stat = await fs.stat(r.filePaths[0]);
      if (stat.size > 1024 * 1024) throw new Error('设置文件过大');
      return JSON.parse(await fs.readFile(r.filePaths[0], 'utf8'));
    }
    if (command === 'rebuild') {
      const answer = await dialog.showMessageBox(this.window, {
        type: 'question',
        buttons: ['取消', '备份并重建'],
        defaultId: 0,
        cancelId: 0,
        message: '重建本地用量索引？',
        detail: '先备份当前数据库，再从原始日志重建。Codex 日志不会被修改。',
      });
      if (answer.response !== 1) return false;
      return this.monitor.request('rebuild');
    }
    if (command === 'backup') {
      const r = await dialog.showSaveDialog(this.window, { defaultPath: '龙娘用量备份.sqlite' });
      if (r.canceled) return false;
      return this.monitor.request('backup', { path: r.filePath });
    }
    if (command === 'diagnostics') {
      const data = {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        screenPermission: this.monitor.screenPermission,
        nativeError: this.monitor.nativeError,
        indexError: this.monitor.indexError,
        progress: this.monitor.progress,
        instances: this.monitor.snapshot().instances.map((i, index) => ({
          instance: index + 1,
          running: i.running,
          source: i.origin,
          plan: i.account?.planType,
          quotaSource: i.quota?.source,
          capturedAt: i.quota?.capturedAt,
          error: i.error,
        })),
      };
      const r = await dialog.showSaveDialog(this.window, { defaultPath: '龙娘诊断.json' });
      if (!r.canceled) await fs.writeFile(r.filePath, JSON.stringify(data, null, 2));
      return !r.canceled;
    }
    throw new Error('不支持的操作');
  }
  // 退出前关闭所有附属角色，取消后台窗口资源。
  async stop() {
    await this.tests.stop();
    for (const pet of this.pets.values()) await pet.stop();
    this.pets.clear();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    ipcMain.removeHandler('dg:command');
  }

  // 导出只读取用户选择的测试记录，不包含账号目录、代理和认证信息。
  async exportTest({ id, instanceId, format = 'json' }) {
    const run = await this.tests.read(id);
    const result = run.results.find((item) => item.instanceId === instanceId);
    if (!['json', 'html', 'text'].includes(format)) throw new Error('不支持的导出格式');
    let body;
    if (format === 'json') body = JSON.stringify(run, null, 2);
    else {
      if (!result) throw new Error('未找到该账号的测试结果');
      body = format === 'html' && result.status === 'completed' ? extractTestHtml(result.text) : result.text;
      if (!body || (format === 'html' && result.status !== 'completed')) throw new Error('没有可导出的完整结果');
    }
    const extension = format === 'text' ? 'txt' : format;
    const choice = await dialog.showSaveDialog(this.window, {
      defaultPath: `账号测智-${id.slice(0, 8)}.${extension}`,
      filters: [{ name: format === 'html' ? 'HTML 页面' : format === 'text' ? '文本' : '测试数据', extensions: [extension] }],
    });
    if (choice.canceled) return false;
    await fs.writeFile(choice.filePath, body, { mode: 0o600 });
    return true;
  }
}
