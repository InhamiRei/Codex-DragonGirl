import {
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  screen,
  powerMonitor,
  globalShortcut,
  app,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  characterSize,
  stageBounds,
  constrainCharacter,
  snapCharacter,
  capturePlacement,
  restorePlacement,
  resizeCharacter,
  placeBubble,
  containsPoint,
  BUBBLE_SIZE,
  BUBBLE_MAX_SIZE,
} from '../shared/geometry.js';
import { DragGesture } from '../shared/gesture.js';
import { StateStore } from './state-store.js';
import { dialogueLine } from '../shared/dialogue.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORIGIN = 'dragon://app';
const SHORTCUT = 'CommandOrControl+Shift+Alt+D';

// 桌面层只负责窗口、手势与持久化，角色绘制和气泡内容各自独立。
export class Companion {
  static registry = new Set();
  static ipcRegistered = false;
  // 所有运行数据都留在本应用目录，测试时可以完全隔离。
  constructor(dataDirectory, { testMode = false, secondary = false, delegate = null, initiallySuppressed = false } = {}) {
    this.secondary = secondary;
    this.delegate = delegate;
    this.appearance = {};
    Companion.registry.add(this);
    this.store = new StateStore(path.join(dataDirectory, 'preferences.json'));
    this.testMode = testMode;
    this.gesture = new DragGesture();
    this.windows = new Map();
    this.interactive = new Map();
    this.ready = new Set();
    this.character = null;
    this.visible = true;
    this.suppressedByFollow = initiallySuppressed;
    this.bubbleVisible = false;
    this.lineIndex = 0;
    this.bubbleKind = null;
    this.bubbleSize = { ...BUBBLE_SIZE };
    this.bubbleModel = {
      text: dialogueLine('chat'),
      usage: null,
      kind: 'speech',
      revision: 0,
      measuredRevision: -1,
      ...this.bubbleLimits(),
      side: 'above',
      horizontal: 'left',
      tailX: 152,
    };
    this.stopping = false;
  }

  // 首次显示要等素材解码和命中图准备完成，避免短暂出现白块或不可操作的角色。
  async start() {
    this.state = await this.store.load();
    const image = nativeImage.createFromPath(path.join(ROOT, 'assets/characters/codex-dragon-girl.png'));
    if (image.isEmpty())
      throw new Error('龙娘素材无法读取，请检查 assets/characters/codex-dragon-girl.png。');
    const dimensions = image.getSize();
    this.imageRatio = dimensions.height / dimensions.width;
    this.restore();
    this.registerIpc();
    // 资源或预加载失败时明确结束启动，避免后台留下永远不可见的进程。
    const ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.startupTimer = setTimeout(
        () => reject(new Error('角色或气泡界面未能完成加载，请检查启动日志。')),
        15000,
      );
    });
    this.createWindow('character', stageBounds(this.character));
    this.createWindow('bubble', placeBubble(this.character, this.display.workArea).bounds);
    await Promise.all(
      [...this.windows.entries()].map(([view, window]) =>
        window.loadURL(`${ORIGIN}/src/renderer/${view}.html`),
      ),
    );
    await ready;
    if (!this.secondary) {
      this.tray = new Tray(image.resize({ width: 22, height: 20 }));
      this.tray.setToolTip('龙娘 · 右键角色打开设置');
      this.updateMenu();
      this.tray.on('click', () => {
        if (this.delegate) this.delegate.openDashboard();
        else {
          this.show();
          this.toggleBubble();
        }
      });
    }
    this.onDisplayChanged = () => {
      this.cancelGesture();
      this.restore();
      this.applyCharacter();
    };
    screen.on('display-added', this.onDisplayChanged);
    screen.on('display-removed', this.onDisplayChanged);
    screen.on('display-metrics-changed', this.onDisplayChanged);
    this.onSuspend = () => this.cancelGesture();
    this.onResume = () => {
      this.restore();
      this.applyCharacter();
      this.pollCursor(true);
    };
    powerMonitor.on('suspend', this.onSuspend);
    powerMonitor.on('resume', this.onResume);
    this.shortcutRegistered =
      !this.secondary && globalShortcut.register(SHORTCUT, () => this.toggleVisibility());
    this.pollCursor();
  }

  // 只创建角色附近的小窗口，气泡不占用角色窗口的几何范围。
  createWindow(view, bounds) {
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      acceptFirstMouse: true,
      backgroundColor: '#00000000',
      title: view === 'character' ? '龙娘' : '龙娘的气泡',
      webPreferences: {
        preload: path.join(ROOT, 'src/main/preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.setAlwaysOnTop(true, 'floating');
    if (process.platform === 'darwin')
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setIgnoreMouseEvents(true, { forward: true });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[${view}] 窗口渲染已退出：${details.reason}`);
      this.cancelGesture();
      this.hide();
    });
    this.windows.set(view, window);
    this.interactive.set(view, false);
    return window;
  }

  // 只接受对应本地页面主框架发来的 IPC，预加载脚本不暴露任意通道。
  accepts(event, view) {
    const window = this.windows.get(view);
    return (
      !!window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame.url === `${ORIGIN}/src/renderer/${view}.html`
    );
  }

  // 所有输入都有固定通道和校验；原生窗口位置由桌面层统一计算。
  registerIpc() {
    if (Companion.ipcRegistered) return;
    Companion.ipcRegistered = true;
    // 按消息发送窗口定位所属角色，任意多个实例共用受限 IPC 而不串号。
    const locate = (event, view) => [...Companion.registry].find((c) => c.accepts(event, view));
    ipcMain.handle('dg:bootstrap', (event) => {
      const c = locate(event, 'character');
      if (c) return c.characterModel();
      const b = locate(event, 'bubble');
      if (b) return b.bubbleModel;
      throw new Error('无效的窗口来源');
    });
    ipcMain.on('dg:ready', (event) => {
      for (const view of ['character', 'bubble']) {
        const c = locate(event, view);
        if (!c) continue;
        c.ready.add(view);
        if (view === 'character' && c.visible && !c.suppressedByFollow) {
          c.windows.get(view).showInactive();
          // macOS 首次显示可能收回屏幕边缘的透明边距，重新发送实际坐标以保持气泡与可见角色对齐。
          c.windows.get(view).webContents.send('dg:layout', c.characterModel());
        }
        if (c.ready.size === 2) {
          clearTimeout(c.startupTimer);
          c.resolveReady?.();
        }
      }
    });
    ipcMain.on('dg:interactive', (event, value) => {
      if (typeof value !== 'boolean') return;
      for (const view of ['character', 'bubble']) locate(event, view)?.setInteractive(view, value);
    });
    ipcMain.on('dg:gesture-start', (event, point) => {
      const c = locate(event, 'character');
      if (c?.validPoint(point)) {
        c.gesture.begin(point, c.character);
        c.setInteractive('character', true);
      }
    });
    ipcMain.on('dg:gesture-move', (event, point) => {
      const c = locate(event, 'character');
      if (c?.validPoint(point)) c.moveGesture(point);
    });
    ipcMain.on('dg:gesture-end', (event, point) => {
      const c = locate(event, 'character');
      if (c?.validPoint(point)) c.endGesture(point);
    });
    ipcMain.on('dg:gesture-cancel', (event) => locate(event, 'character')?.cancelGesture());
    ipcMain.on('dg:menu', (event) => {
      const c = locate(event, 'character');
      if (c) c.buildMenu().popup({ window: c.windows.get('character') });
    });
    ipcMain.on('dg:close-bubble', (event) => locate(event, 'bubble')?.hideBubble());
    ipcMain.on('dg:bubble-measured', (event, measurement) =>
      locate(event, 'bubble')?.resizeBubble(measurement),
    );
    ipcMain.on('dg:asset-error', (event) => locate(event, 'character')?.hide());
  }

  // 限制 IPC 坐标必须是有限屏幕坐标，拒绝异常值污染窗口状态。
  validPoint(point) {
    return (
      point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Math.abs(point.x) < 100000 &&
      Math.abs(point.y) < 100000
    );
  }

  // 根据首选显示器恢复位置；显示器暂时断开时不覆盖原来的显示器与锚点。
  restore() {
    this.display =
      screen
        .getAllDisplays()
        .find((display) => String(display.id) === this.state.placement?.displayId) ||
      screen.getPrimaryDisplay();
    const size = characterSize(this.state.scale, this.display.workArea, this.imageRatio);
    this.character = restorePlacement(this.state.placement, this.display, size);
  }

  // 用系统实际窗口位置换算角色局部坐标，避免 macOS 收回透明边距后把角色一起顶离边缘。
  characterModel() {
    const window = this.windows.get('character');
    const bounds = window && !window.isDestroyed() ? window.getBounds() : stageBounds(this.character);
    return {
      rect: {
        x: this.character.x - bounds.x,
        y: this.character.y - bounds.y,
        width: this.character.width,
        height: this.character.height,
      },
      asset: this.appearance.asset || `${ORIGIN}/assets/characters/codex-dragon-girl.png`,
      snapEnabled: this.state.snapEnabled,
      appearance: this.appearance,
    };
  }

  // 所有窗口几何集中更新，气泡始终跟随角色，且只发送变化后的布局。
  applyCharacter() {
    const window = this.windows.get('character');
    if (!window || window.isDestroyed()) return;
    window.setBounds(stageBounds(this.character), false);
    window.webContents.send('dg:layout', this.characterModel());
    if (this.bubbleVisible) this.positionBubble();
    this.pollCursor(true);
  }

  // 拖动跨显示器时根据光标选择目标工作区，保持角色可见。
  moveGesture(point) {
    const update = this.gesture.move(point);
    if (!update || update.kind !== 'drag') return;
    const firstMove = !this.dragging;
    this.dragging = true;
    this.display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
    this.character = constrainCharacter(update.rect, this.display.workArea);
    if (firstMove) {
      this.hideBubble();
      this.windows.get('character').webContents.send('dg:dragging', true);
    }
    this.applyCharacter();
  }

  // 只有成功松手的拖拽才提交位置；点击只切换独立气泡。
  endGesture(point) {
    const result = this.gesture.end(point);
    this.dragging = false;
    if (!result) return;
    if (result.kind === 'drag') {
      this.display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
      this.character = snapCharacter(result.rect, this.display.workArea, this.state.snapEnabled);
      this.state.placement = capturePlacement(this.character, this.display, this.state.snapEnabled);
      this.applyCharacter();
      this.persist();
      this.delegate?.onDrag?.(this);
    } else this.toggleBubble();
    this.windows.get('character').webContents.send('dg:dragging', false);
    this.pollCursor(true);
  }

  // 中断时恢复按下前的位置，绝不保存系统取消产生的坐标。
  cancelGesture() {
    const result = this.gesture.cancel();
    this.dragging = false;
    if (!result) return;
    this.character = result.rect;
    this.display = screen.getDisplayMatching(this.character);
    this.applyCharacter();
    this.windows.get('character')?.webContents.send('dg:cancelled');
  }

  // 更改大小时固定底部及吸附边；气泡尺寸保持独立，文字不会跟着缩放。
  setScale(scale) {
    this.cancelGesture();
    this.state.scale = scale;
    this.character = resizeCharacter(
      this.character,
      characterSize(scale, this.display.workArea, this.imageRatio),
      this.state.placement,
      this.display.workArea,
    );
    this.state.placement = capturePlacement(this.character, this.display, this.state.snapEnabled);
    this.applyCharacter();
    this.persist();
    this.updateMenu();
  }

  // 轻点角色切换用量气泡，主动对话由独立入口处理。
  toggleBubble() {
    if (this.bubbleVisible) {
      this.hideBubble();
      return;
    }
    if (!this.state.speechEnabled) return;
    this.showBubble(this.delegate?.bubbleFor?.(this) || dialogueLine('chat', this.lineIndex++), 'usage');
  }

  // 文本与默认用量卡片共用内容版本，异步测量不能覆盖后来显示的新消息。
  setBubbleContent(content, kind = this.bubbleKind) {
    this.bubbleKind = kind;
    this.bubbleModel = {
      ...this.bubbleModel,
      text: typeof content === 'string' ? content : content.text,
      usage: typeof content === 'string' ? null : content.usage,
      kind,
      revision: this.bubbleModel.revision + 1,
      measuredRevision: -1,
    };
  }

  // 所有气泡共用显示和计时逻辑，内容来源用于避免通知被后台数据覆盖。
  showBubble(content, kind) {
    if (!this.visible || this.suppressedByFollow || !this.ready.has('bubble')) return;
    this.setBubbleContent(content, kind);
    this.bubbleVisible = true;
    this.positionBubble();
    clearTimeout(this.bubbleTimer);
    if (!this.appearance.settings?.pinnedBubble)
      this.bubbleTimer = setTimeout(
        () => this.hideBubble(),
        (this.appearance.settings?.bubbleSeconds || 7) * 1000,
      );
  }

  // 菜单中的主动互动始终回应，不受“点击时显示气泡”开关限制。
  speak() {
    this.show();
    this.showBubble(dialogueLine('chat', this.lineIndex++), 'speech');
  }

  // 使用固定设计尺寸，仅在屏幕工作区小于气泡时收紧边界，内容长度不参与计算。
  bubbleLimits() {
    const area = this.display?.workArea;
    if (!area) return { maxWidth: BUBBLE_MAX_SIZE.width, maxHeight: BUBBLE_MAX_SIZE.height };
    return {
      maxWidth: Math.min(BUBBLE_MAX_SIZE.width, Math.max(1, area.width - 8)),
      maxHeight: Math.min(BUBBLE_MAX_SIZE.height, Math.max(1, area.height - 8)),
    };
  }

  // 界面消息只确认当前内容已经排版，原生窗口始终使用固定尺寸，不能被正文长度改写。
  resizeBubble(measurement) {
    if (
      !measurement ||
      measurement.revision !== this.bubbleModel.revision ||
      !Number.isFinite(measurement.width) ||
      !Number.isFinite(measurement.height) ||
      measurement.width <= 0 ||
      measurement.height <= 0 ||
      measurement.width > this.bubbleModel.maxWidth ||
      measurement.height > this.bubbleModel.maxHeight
    ) return;
    const limits = this.bubbleLimits();
    this.bubbleSize = { width: limits.maxWidth, height: limits.maxHeight };
    this.bubbleModel.measuredRevision = measurement.revision;
    this.positionBubble();
    if (this.bubbleVisible) this.windows.get('bubble').showInactive();
  }

  // 默认使用角色左上方的位置，方向和思绪泡锚点随屏幕边缘避让一起更新。
  positionBubble() {
    const limits = this.bubbleLimits();
    if (limits.maxWidth !== this.bubbleModel.maxWidth || limits.maxHeight !== this.bubbleModel.maxHeight)
      this.bubbleModel = {
        ...this.bubbleModel,
        ...limits,
        revision: this.bubbleModel.revision + 1,
        measuredRevision: -1,
      };
    const layout = placeBubble(this.character, this.display.workArea, this.bubbleSize);
    this.bubbleModel = { ...this.bubbleModel, side: layout.side, horizontal: layout.horizontal, tailX: layout.tailX };
    this.windows.get('bubble').setBounds(layout.bounds, false);
    this.windows.get('bubble').webContents.send('dg:bubble', this.bubbleModel);
  }

  // 隐藏气泡时同时释放其输入区域，透明窗口不会继续遮挡桌面。
  hideBubble() {
    clearTimeout(this.bubbleTimer);
    this.bubbleVisible = false;
    this.setInteractive('bubble', false);
    this.windows.get('bubble')?.hide();
  }

  // 点击穿透在原生窗口层切换；手势进行中必须保留输入直到松手。
  setInteractive(view, enabled) {
    const window = this.windows.get(view);
    if (!window || window.isDestroyed()) return;
    const next = view === 'character' && this.gesture.active ? true : enabled;
    if (this.interactive.get(view) === next) return;
    this.interactive.set(view, next);
    window.setIgnoreMouseEvents(!next, { forward: true });
    // 原生轮询或隐藏操作可能主动释放输入，回传实际状态避免渲染层缓存过期后无法重新进入。
    window.webContents.send('dg:input-state', next);
  }

  // 鼠标移动转发之外再加低频原生兜底，窗口移动到静止光标下方也能恢复命中。
  pollCursor(force = false) {
    if (this.stopping) return;
    clearTimeout(this.cursorTimer);
    const point = screen.getCursorScreenPoint();
    let nearby = false;
    for (const [view, window] of this.windows) {
      if (window.isDestroyed() || !window.isVisible() || !this.ready.has(view)) continue;
      const bounds = window.getBounds();
      const inside = containsPoint(bounds, point);
      nearby ||= inside;
      if (!inside && !(view === 'character' && this.gesture.active)) this.setInteractive(view, false);
      if ((inside || force) && !(view === 'character' && this.gesture.active))
        window.webContents.send('dg:cursor', { x: point.x - bounds.x, y: point.y - bounds.y });
    }
    this.cursorTimer = setTimeout(() => this.pollCursor(), nearby ? 24 : 100);
    this.cursorTimer.unref();
  }

  // 明确的用户操作才落盘；写入失败会保留当前界面并允许稍后重试。
  persist() {
    this.store.save(this.state).catch((error) => {
      console.error('位置与设置保存失败：', error.message);
      this.tray?.setToolTip('龙娘 · 设置暂未保存，请检查用户目录写入权限');
    });
  }

  // 原生菜单让透明挂件不必常驻额外按钮，角色本体和设置入口保持分离。
  buildMenu() {
    return Menu.buildFromTemplate([
      { label: this.instanceName || '龙娘', enabled: false },
      ...(this.delegate
        ? [
            { label: '用量总览与设置…', click: () => this.delegate.openDashboard() },
            { label: '刷新全部账户', click: () => this.delegate.refresh() },
          ]
        : []),
      { type: 'separator' },
      { label: this.visible ? '暂时收起' : '叫出龙娘', click: () => this.toggleVisibility() },
      {
        label: '说句话',
        click: () => this.speak(),
      },
      {
        label: '大小',
        submenu: [
          ['迷你 · 50%', 0.5],
          ['轻巧 · 60%', 0.6],
          ['小巧 · 75%', 0.75],
          ['标准 · 100%', 1],
          ['稍大 · 125%', 1.25],
          ['大号 · 150%', 1.5],
        ].map(([label, scale]) => ({
          label,
          type: 'radio',
          checked: this.state.scale === scale,
          click: () => this.setScale(scale),
        })),
      },
      {
        label: '靠近屏幕边缘时吸附',
        type: 'checkbox',
        checked: this.state.snapEnabled,
        click: (item) => {
          this.state.snapEnabled = item.checked;
          this.persist();
          this.updateMenu();
        },
      },
      {
        label: '点击时显示气泡',
        type: 'checkbox',
        checked: this.state.speechEnabled,
        click: (item) => {
          this.state.speechEnabled = item.checked;
          this.hideBubble();
          this.persist();
          this.updateMenu();
        },
      },
      { label: '回到右下角', click: () => this.resetPosition() },
      { type: 'separator' },
      {
        label: this.shortcutRegistered
          ? process.platform === 'darwin'
            ? '显示 / 隐藏：⌘⌥⇧D'
            : '显示 / 隐藏：Ctrl+Alt+Shift+D'
          : '可从菜单栏 / 托盘重新叫出龙娘',
        enabled: false,
      },
      { label: '退出龙娘', click: () => app.quit() },
    ]);
  }

  // 每次设置变化后重建菜单，托盘和右键看到的都是当前值。
  updateMenu() {
    if (!this.stopping && this.tray && !this.tray.isDestroyed())
      this.tray.setContextMenu(this.buildMenu());
  }

  // 重置只影响位置，大小、气泡与吸附偏好继续保留。
  resetPosition() {
    this.cancelGesture();
    this.state.placement = null;
    this.restore();
    this.state.placement = capturePlacement(this.character, this.display, this.state.snapEnabled);
    this.applyCharacter();
    this.show();
    this.persist();
  }

  // 显示时不抢走编辑器焦点，用户可以继续输入。
  show() {
    if (this.stopping) return;
    this.visible = true;
    if (this.ready.has('character') && !this.suppressedByFollow)
      this.windows.get('character').showInactive();
    this.pollCursor(true);
    this.updateMenu();
  }

  // 主动收起同时取消未完成手势，避免恢复时仍然跟随鼠标。
  hide() {
    if (this.stopping) return;
    this.cancelGesture();
    this.visible = false;
    this.hideBubble();
    this.setInteractive('character', false);
    this.windows.get('character')?.hide();
    this.updateMenu();
  }

  // 托盘和快捷键共用同一个显示状态入口。
  toggleVisibility() {
    if (this.stopping) return;
    if (this.visible) this.hide();
    else this.show();
  }

  // 状态变化只更新局部布局，换图时同步更新几何比例。
  setAppearance(appearance) {
    const assetChanged = appearance.asset !== this.appearance.asset;
    this.appearance = appearance;
    if (assetChanged && appearance.assetPath) {
      const img = nativeImage.createFromPath(appearance.assetPath);
      if (!img.isEmpty()) {
        const d = img.getSize();
        this.imageRatio = d.height / d.width;
        this.restore();
      }
    }
    this.applyCharacter();
    if (this.bubbleVisible && this.bubbleKind === 'usage') {
      this.setBubbleContent(this.delegate?.bubbleFor?.(this) || this.bubbleModel.text);
      this.positionBubble();
    }
  }

  // 跟随只改变显示位置，不覆盖独立桌面模式保存的位置意图。
  followFrame(frame, offset = { x: 1, y: 1 }) {
    this.followTarget = frame;
    this.suppressedByFollow = !frame;
    if (!frame) {
      // 弹窗或最小化期间同时释放拖拽和鼠标命中，恢复时不改变用户主动隐藏的状态。
      this.cancelGesture();
      this.hideBubble();
      this.setInteractive('character', false);
      this.windows.get('character')?.hide();
      return;
    }
    if (this.gesture.active) return;
    this.display = screen.getDisplayMatching(frame);
    const next = constrainCharacter(
      {
        ...this.character,
        x: frame.x + Math.max(0, frame.width - this.character.width) * offset.x,
        y: frame.y + Math.max(0, frame.height - this.character.height) * offset.y,
      },
      this.display.workArea,
    );
    if (next.x !== this.character.x || next.y !== this.character.y) {
      this.character = next;
      this.applyCharacter();
    }
    if (this.visible && this.ready.has('character') && !this.windows.get('character').isVisible())
      this.windows.get('character').showInactive();
  }

  // 事件声和状态提示复用角色窗口，不额外创建音频后台进程。
  notify(event, text) {
    this.windows.get('character')?.webContents.send('dg:sound', event);
    if (text && this.state.speechEnabled) this.showBubble(text, 'notice');
  }

  // 测试只读快照包含窗口布局和当前开关，不暴露任意系统操作。
  snapshot() {
    return {
      state: structuredClone(this.state),
      character: { ...this.character },
      windows: Object.fromEntries([...this.windows].map(([view, window]) => [view, window.getBounds()])),
      interactive: Object.fromEntries(this.interactive),
      ready: [...this.ready],
      visible: this.visible,
      bubbleVisible: this.bubbleVisible,
      dragging: !!this.dragging,
    };
  }

  // 退出前停止轮询、注销快捷键并等待保存，避免留下后台观察进程。
  async stop() {
    this.stopping = true;
    Companion.registry.delete(this);
    clearTimeout(this.cursorTimer);
    clearTimeout(this.bubbleTimer);
    clearTimeout(this.startupTimer);
    if (this.shortcutRegistered) globalShortcut.unregister(SHORTCUT);
    if (this.onDisplayChanged)
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed'])
        screen.removeListener(event, this.onDisplayChanged);
    if (this.onSuspend) powerMonitor.removeListener('suspend', this.onSuspend);
    if (this.onResume) powerMonitor.removeListener('resume', this.onResume);
    await this.store.flush().catch((error) => console.error('退出前保存失败：', error.message));
    this.tray?.destroy();
    this.tray = null;
    if (this.secondary)
      for (const window of this.windows.values()) if (!window.isDestroyed()) window.destroy();
  }
}
