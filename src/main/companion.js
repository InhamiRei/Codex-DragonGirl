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
  clamp,
  stageBounds,
  constrainCharacter,
  snapCharacter,
  capturePlacement,
  restorePlacement,
  resizeCharacter,
  placeBubble,
  containsPoint,
  bubbleDimensions,
} from '../shared/geometry.js';
import { DragGesture } from '../shared/gesture.js';
import { StateStore } from './state-store.js';
import { dialogueLine, PRAYER_TEXT } from '../shared/dialogue.js';
import { EYE_ARTWORK, eyeTrackingEnabled } from '../shared/gaze.js';
import { shouldFaceLeft } from '../shared/facing.js';
import { followWindowStack, followWindowFloating, followDisplayFrame } from '../shared/follow-window.js';
import { CHARACTERS, characterByAsset, characterById, isDragonAsset } from '../shared/characters.js';
import { dragonHairstyle } from '../shared/dragon-gear.js';
import { DRAGON_FACE_EXPRESSIONS, isDragonFace } from '../shared/expression.js';
import { PRAYER_PALM } from '../shared/prayer-wave.js';
import { PrayerWave } from './prayer-wave.js';
import { recoverWindowRenderer } from './window-recovery.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORIGIN = 'dragon://app';
const SHORTCUT = 'CommandOrControl+Shift+Alt+D';
const RECT_KEYS = ['x', 'y', 'width', 'height'];

// 启动、切换角色和多实例共用素材规则，所选发型用于内置龙娘，自定义图片优先。
export function companionAppearance(settings, assetDirectory, status = 'idle') {
  const character = characterById(settings.characterId);
  const image = character.id === 'dragon' ? dragonHairstyle(settings.dragonHairstyleId).image : character.image;
  const custom = settings.characterAsset;
  return {
    settings,
    asset: custom ? ORIGIN + '/user-assets/' + custom : ORIGIN + '/' + image,
    assetPath: custom ? path.join(assetDirectory, custom) : path.join(ROOT, image),
    status,
  };
}

// 动作菜单根据角色已有的表情与动作素材提供预览。
const TASK_ACTIONS = [['完成', 'happy'], ['失败', 'sad']];
const CHARACTER_ACTIONS = {
  dragon: [['发光', 'happy'], ['哭泣', 'sad'], ['祈祷', 'prayer'], ...DRAGON_FACE_EXPRESSIONS],
  maro: [...TASK_ACTIONS, ['捋头发', 'hair']],
  kokkoro: TASK_ACTIONS,
  kanna: TASK_ACTIONS,
};

// 桌面层只负责窗口、手势与持久化，角色绘制和气泡内容各自独立。
export class Companion {
  static registry = new Set();
  static ipcRegistered = false;
  // 所有运行数据都留在本应用目录，测试时可以完全隔离。
  constructor(dataDirectory, { testMode = false, secondary = false, delegate = null, initiallySuppressed = false, appearance = {} } = {}) {
    this.secondary = secondary;
    this.delegate = delegate;
    this.appearance = appearance;
    this.facingLeft = false;
    Companion.registry.add(this);
    this.store = new StateStore(path.join(dataDirectory, 'preferences.json'));
    this.testMode = testMode;
    this.gesture = new DragGesture();
    this.windows = new Map();
    this.interactive = new Map();
    this.cursorPositions = new Map();
    this.ready = new Set();
    this.lastCharacterVisibility = null;
    this.character = null;
    this.visible = true;
    this.suppressedByFollow = initiallySuppressed;
    this.bubbleVisible = false;
    this.dialogueCounts = new Map();
    this.bubbleKind = null;
    this.completionClick = null;
    this.bubbleModel = {
      text: '',
      usage: null,
      kind: 'speech',
      typingId: null,
      showId: 0,
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
    const defaultImage = path.join(ROOT, CHARACTERS[0].image);
    // 内置龙娘的尺寸按原画标定，窗口布局可以直接使用。
    const image = nativeImage.createFromPath(isDragonAsset(this.appearance.asset) ? defaultImage : this.appearance.assetPath || defaultImage);
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
    // 工作区变化与唤醒必须沿用当前模式，不能用桌面锚点临时覆盖宿主坐标。
    this.onDisplayChanged = () => {
      this.cancelGesture();
      this.refreshPlacement();
    };
    screen.on('display-added', this.onDisplayChanged);
    screen.on('display-removed', this.onDisplayChanged);
    screen.on('display-metrics-changed', this.onDisplayChanged);
    this.onSuspend = () => this.cancelGesture();
    this.onResume = () => {
      this.refreshPlacement();
      this.pollCursor(true);
    };
    powerMonitor.on('suspend', this.onSuspend);
    powerMonitor.on('resume', this.onResume);
    // 素材加载期间工作区可能变化；监听建立后再同步一次，避免沿用启动前的边界。
    this.refreshPlacement();
    this.shortcutRegistered =
      !this.secondary && globalShortcut.register(SHORTCUT, () => this.toggleVisibility());
    this.updateMenu();
    this.pollCursor();
    this.started = true;
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
    window.setAlwaysOnTop(!(this.followMode || this.suppressedByFollow), 'floating');
    if (process.platform === 'darwin')
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    window.setIgnoreMouseEvents(true, { forward: true });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    recoverWindowRenderer(window, `${ORIGIN}/src/renderer/${view}.html`, () => this.stopping, () => {
      this.ready.delete(view);
      this.cursorPositions.delete(view);
      if (view === 'character') {
        this.contextMenu?.closePopup(window);
        this.cancelGesture();
        this.setInteractive(view, false);
        this.hideWindow(view);
      }
      // 重新启动的气泡从关闭状态开始；角色的主动隐藏偏好由原来的用户操作决定。
      this.hideBubble();
    });
    // 原生透明窗口的隐藏不总会触发页面可见性事件，显式同步显示状态以暂停视线动画。
    if (view === 'character') for (const event of ['show', 'hide']) window.on(event, () => this.sendCharacterLayout());
    window.on('hide', () => this.cursorPositions.delete(view));
    // 鼠标静止时新出现的气泡也要重新命中；显示后立即纠正系统可能提升的窗口层级。
    window.on('show', () => { this.syncWindowStacking(true); this.pollCursor(true); });
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
          c.sendCharacterLayout();
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
      if (c?.validPoint(point) && !c.contextMenu && c.canInteract('character')) {
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
    ipcMain.on('dg:menu', (event, point) => {
      const c = locate(event, 'character');
      if (c) c.showMenu(point);
    });
    // 发饰菜单复用原生定位和来源校验，不扩大透明角色窗口。
    ipcMain.on('dg:character-menu', (event, point) => {
      const c = locate(event, 'character');
      if (c?.delegate?.selectCharacter) c.showMenu(point, true);
    });
    ipcMain.on('dg:close-bubble', (event) => locate(event, 'bubble')?.hideBubble());
    // 推进消息只路由到发送它的气泡实例，角色页或其他窗口不能跨实例触发对话。
    ipcMain.on('dg:advance-bubble', (event) => void locate(event, 'bubble')?.clickBubble());
    // 只有所属气泡正常播完才释放震荡波，上一轮的完成消息无效。
    ipcMain.on('dg:prayer-typed', (event, typingId) => locate(event, 'bubble')?.finishPrayerTyping(typingId, true));
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

  // 恢复独立桌面的首选位置；显示器暂时断开时不覆盖原来的显示器与锚点。
  restore() {
    this.display =
      screen
        .getAllDisplays()
        .find((display) => String(display.id) === this.state.placement?.displayId) ||
      screen.getPrimaryDisplay();
    const size = characterSize(this.state.scale, this.display.workArea, this.imageRatio);
    this.character = restorePlacement(this.state.placement, this.display, size);
    this.updateFacing();
  }

  // 重排时优先沿用已知宿主和相对锚点；等待宿主期间保持隐藏。
  refreshPlacement() {
    if (this.followTarget) this.applyFollowPlacement(true);
    else if (!this.followMode && !this.suppressedByFollow) {
      this.restore();
      this.applyCharacter();
    }
  }

  // 拖动中锁定原朝向，松手后按所属屏幕或宿主窗口更新，取消拖动会沿原位置恢复。
  updateFacing() {
    if (this.gesture.active || (this.contextMenu && this.followMode)) return false;
    const next = shouldFaceLeft(this.character, this.followTarget || this.display?.workArea, this.facingLeft);
    const changed = next !== this.facingLeft;
    this.facingLeft = next;
    return changed;
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
      visible: !!window && !window.isDestroyed() && window.isVisible(),
      praying: this.bubbleModel.typingId !== null || Boolean(this.prayerWave && !this.prayerWave.started),
      snapEnabled: this.state.snapEnabled,
      // 手动镜像作为基础方向，关闭自动朝向后仍完整保留原来的手动翻转行为。
      flipped: !!this.appearance.settings?.flip !== (this.appearance.settings?.autoFlip !== false && this.facingLeft),
      appearance: this.appearance,
    };
  }

  // 记录实际发给渲染层的可见性，原生显隐绕过窗口事件时，光标轮询也能纠正旧状态。
  sendCharacterLayout() {
    const window = this.windows.get('character');
    if (!window || window.isDestroyed() || !this.ready.has('character')) return;
    const model = this.characterModel();
    this.lastCharacterVisibility = model.visible;
    window.webContents.send('dg:layout', model);
  }

  // 所有窗口几何集中更新，气泡始终跟随角色，且只发送变化后的布局。
  applyCharacter() {
    this.updateFacing();
    const window = this.windows.get('character');
    if (!window || window.isDestroyed()) return;
    // 菜单期间的后台状态更新不重复改动人物窗口；用户主动改大小或恢复位置时仍正常应用。
    const menuKeepsGeometry = this.contextMenu && this.menuCharacter
      && RECT_KEYS.every((key) => this.character[key] === this.menuCharacter[key]);
    if (!menuKeepsGeometry) window.setBounds(stageBounds(this.character), false);
    this.sendCharacterLayout();
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

  // 松手后由手势状态机区分点击与拖动，只有轻点会触发开心和独立气泡。
  endGesture(point) {
    const result = this.gesture.end(point);
    this.dragging = false;
    if (!result) return;
    if (result.kind === 'drag') {
      this.display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
      this.character = snapCharacter(result.rect, this.display.workArea, this.state.snapEnabled);
      if (this.followMode && this.followTarget) {
        // 将拖动终点和宿主换到同一坐标系，跨 DPI 拖动时也能反算相同的相对位置。
        const host = this.followTarget.physicalBounds || this.followTarget;
        const rect = this.followTarget.physicalBounds ? screen.dipToScreenRect(null, this.character) : this.character;
        this.setFollowOffset({
          x: host.width > rect.width ? clamp((rect.x - host.x) / (host.width - rect.width), 0, 1) : this.followOffset.x,
          y: host.height > rect.height ? clamp((rect.y - host.y) / (host.height - rect.height), 0, 1) : this.followOffset.y,
        });
      } else if (!this.followMode) {
        this.state.placement = capturePlacement(this.character, this.display, this.state.snapEnabled);
        this.applyCharacter();
        this.persist();
      }
    } else {
      this.toggleBubble();
      // 只有手势状态机判定为轻戳才通知双耳，独立于点击后的气泡和表情。
      if (characterByAsset(this.appearance.asset)?.id === 'dragon')
        this.windows.get('character').webContents.send('dg:poke');
      this.showExpression('happy');
    }
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
    if (this.ready.has('character')) this.windows.get('character')?.webContents.send('dg:cancelled');
  }

  // 更改大小时固定底部及吸附边，正在显示的气泡随角色的新宽度同步排版。
  setScale(scale) {
    this.cancelGesture();
    this.state.scale = scale;
    if (this.followMode) this.applyFollowPlacement(true);
    else {
      const size = characterSize(scale, this.display.workArea, this.imageRatio);
      this.character = resizeCharacter(this.character, size, this.state.placement, this.display.workArea);
      this.state.placement = capturePlacement(this.character, this.display, this.state.snapEnabled);
      this.applyCharacter();
    }
    this.persist();
    this.updateMenu();
  }

  // 连续轻点头像依次打开用量、显示一句语录、收起；中间也可以改点气泡。
  toggleBubble() {
    if (this.bubbleVisible) {
      this.advanceBubble();
      return;
    }
    if (!this.state.speechEnabled) return;
    this.showBubble(this.delegate?.bubbleFor?.(this) || this.nextDialogue('chat'), 'usage');
  }

  // 文本与默认用量卡片共用内容版本，异步测量不能覆盖后来显示的新消息。
  setBubbleContent(content, kind = this.bubbleKind) {
    this.bubbleKind = kind;
    const wasTyping = this.bubbleModel.typingId !== null;
    const revision = this.bubbleModel.revision + 1;
    this.bubbleModel = {
      ...this.bubbleModel,
      text: typeof content === 'string' ? content : content.text,
      usage: typeof content === 'string' ? null : content.usage,
      kind,
      // 逐字播放编号只在换内容时变化，移动气泡或重新测量不会重新打字。
      typingId: kind === 'prayer' ? revision : null,
      revision,
      measuredRevision: -1,
    };
    if (wasTyping !== (this.bubbleModel.typingId !== null)) this.sendCharacterLayout();
  }

  // 所有气泡共用显示和计时逻辑，内容来源用于避免通知被后台数据覆盖。
  showBubble(content, kind, { focusOnClick = false } = {}) {
    if (!this.visible || this.suppressedByFollow || !this.ready.has('bubble')) return;
    this.cancelPrayerWave();
    const opening = !this.bubbleVisible;
    this.setBubbleContent(content, kind);
    // 显示轮次独立于内容版本，后台额度更新与气泡内换句不能被当作重新打开。
    if (opening) this.bubbleModel.showId += 1;
    this.bubbleVisible = true;
    // 每条完成通知有独立的点击状态，迟到的聚焦结果不能收起后来出现的气泡。
    this.completionClick = focusOnClick ? { instanceId: this.instanceId, pending: false } : null;
    this.syncCompletionFocusable();
    this.positionBubble(true);
    clearTimeout(this.bubbleTimer);
    // 祷文由释放震荡波的流程收起，普通气泡仍使用各自的自动关闭设置。
    if (kind !== 'prayer' && !this.appearance.settings?.pinnedBubble)
      this.bubbleTimer = setTimeout(
        () => this.hideBubble(),
        (this.appearance.settings?.bubbleSeconds || 7) * 1000,
      );
  }

  // 台词按当前画面上的角色选择，自定义图片使用默认文案。
  get dialogueCharacterId() {
    return characterByAsset(this.appearance.asset)?.id ?? 'dragon';
  }

  // 各角色的日常、完成、取消和失败分别轮换，切回来从原来的顺序接着说。
  nextDialogue(kind) {
    const characterId = this.dialogueCharacterId;
    const key = `${characterId}:${kind}`;
    const index = this.dialogueCounts.get(key) ?? 0;
    this.dialogueCounts.set(key, index + 1);
    return dialogueLine(kind, index, characterId);
  }

  // 主动互动共用当前角色的语录顺序，菜单入口不受“点击时显示气泡”开关限制。
  speak() {
    this.show();
    this.showBubble(this.nextDialogue('chat'), 'speech');
  }

  // 主动祈祷只在本地播放，气泡打字期间让龙娘保持合掌。
  prayForCode() {
    if (this.stopping || characterByAsset(this.appearance.asset)?.id !== 'dragon') return;
    this.show();
    this.showBubble(PRAYER_TEXT, 'prayer');
  }

  // 正常结束后先释放震荡波，手动收起只取消本轮打字。
  finishPrayerTyping(typingId, completed = false) {
    if (typingId == null || typingId !== this.bubbleModel.typingId) return;
    this.bubbleModel.typingId = null;
    const window = this.windows.get('bubble');
    if (this.ready.has('bubble') && window && !window.isDestroyed()) window.webContents.send('dg:bubble', this.bubbleModel);
    if (completed && this.bubbleVisible) {
      this.releasePrayer();
    } else {
      this.sendCharacterLayout();
    }
  }

  // 震荡波沿用宿主的几何和层级，开场时同步收起气泡并让龙娘放下双手。
  releasePrayer() {
    const target = this.delegate?.prayerWaveTarget?.(this);
    const settings = this.appearance.settings;
    if (this.stopping || !target || settings?.motion === false || settings?.expressionsEnabled === false) {
      this.sendCharacterLayout();
      this.hideBubble();
      return;
    }
    const wave = this.prayerWave = new PrayerWave(target.frame.id, {
      getTarget: () => this.delegate?.prayerWaveTarget?.(this),
      getOrigin: () => ({
        x: this.character.x + this.character.width * PRAYER_PALM.x,
        y: this.character.y + this.character.height * PRAYER_PALM.y,
      }),
      ownedWindowIds: () => Companion.ownedWindowIds(),
      stackWithCompanion: (host, id, force) => {
        if (this.followMode && this.followTarget?.id === host && !this.contextMenu) {
          // 跟随快照已按波纹、角色、气泡整组排序；特效首次显示时补排新窗口。
          if (force) this.syncWindowStacking(true);
          return true;
        }
        if (process.platform !== 'win32') return false;
        // 独立桌面的置顶角色也是特效的遮挡者，单排波纹时只排除波纹自身。
        this.delegate?.stackWindows?.(host, [id], [id]);
        return true;
      },
      onStart: () => {
        this.hideBubble({ keepWave: true });
        this.sendCharacterLayout();
      },
      onFinish: () => {
        if (this.prayerWave !== wave) return;
        this.prayerWave = null;
        // 特效在开场前结束时，补做气泡和合掌的收尾。
        if (this.bubbleVisible) {
          this.hideBubble();
          this.sendCharacterLayout();
        }
      },
    });
    void wave.play();
  }

  // 跟随快照更新时只维护正在播放的特效，宿主不再有效就收起。
  syncPrayerWave() {
    this.prayerWave?.update(this.delegate?.prayerWaveTarget?.(this));
  }

  // 先清空引用再销毁窗口，防止旧一轮的完成回调关闭新气泡。
  cancelPrayerWave() {
    const wave = this.prayerWave;
    if (!wave) return;
    this.prayerWave = null;
    wave.close();
    if (!wave.started) this.sendCharacterLayout();
  }

  // 用量气泡切换为一条语录，其余气泡点击收起；迟到点击不能重新叫出已隐藏的角色或气泡。
  advanceBubble() {
    if (this.stopping || !this.visible || this.suppressedByFollow || !this.bubbleVisible) return;
    if (this.bubbleKind === 'usage') this.showBubble(this.nextDialogue('chat'), 'speech');
    else this.hideBubble();
  }

  // 仅当 Windows 完成气泡仍属于当前跟随实例，且有可定位的宿主时，允许点击激活。
  canFocusCompletion() {
    const hostId = this.followTarget?.id;
    return process.platform === 'win32' && this.followMode === true && !this.suppressedByFollow
      && !!this.completionClick && this.completionClick.instanceId === this.instanceId
      && !!this.delegate?.focusCompletedHost && Number.isSafeInteger(this.followPID) && this.followPID > 0
      && Number.isSafeInteger(hostId) && hostId > 0;
  }

  // 完成气泡仍通过 showInactive 静默弹出，只有用户点击时才可激活窗口。
  syncCompletionFocusable() {
    if (process.platform !== 'win32') return;
    const window = this.windows.get('bubble');
    const focusable = this.canFocusCompletion();
    if (!window || window.isDestroyed() || window.isFocusable() === focusable) return;
    window.setFocusable(focusable);
    if (focusable) window.setSkipTaskbar(true);
  }

  // 点击完成气泡时把焦点交回宿主，同一条通知的重复点击合并为一次。
  async clickBubble() {
    const completion = this.completionClick;
    if (completion?.pending) return;
    if (!this.canFocusCompletion()) {
      this.advanceBubble();
      return;
    }
    if (!this.canInteract('bubble')) return;
    completion.pending = true;
    clearTimeout(this.bubbleTimer);
    try {
      const bubbleId = this.windows.get('bubble').getMediaSourceId().split(':')[1];
      await this.delegate.focusCompletedHost(this.followPID, this.followTarget.id, bubbleId);
    } catch (error) {
      console.error('返回跟随窗口失败：', error.message);
    } finally {
      // 宿主关闭或系统拒绝切换时也允许收起被点击的气泡。
      if (this.completionClick === completion) this.advanceBubble();
    }
  }

  // 布局基于实际角色宽度和当前工作区，显示器切换或小屏自动缩小时也会更新比例。
  bubbleLimits() {
    const { width, height, scale } = bubbleDimensions(this.character?.width, this.display?.workArea);
    return { maxWidth: width, maxHeight: height, scale };
  }

  // 界面消息只确认当前内容已经排版，原生窗口始终使用固定尺寸，不能被正文长度改写。
  resizeBubble(measurement) {
    if (
      !measurement ||
      measurement.revision !== this.bubbleModel.revision ||
      measurement.revision === this.bubbleModel.measuredRevision ||
      !Number.isFinite(measurement.width) ||
      !Number.isFinite(measurement.height) ||
      measurement.width <= 0 ||
      measurement.height <= 0 ||
      measurement.width > this.bubbleModel.maxWidth ||
      measurement.height > this.bubbleModel.maxHeight
    ) return;
    this.bubbleModel.measuredRevision = measurement.revision;
    this.positionBubble(true);
    const window = this.windows.get('bubble');
    if (this.bubbleVisible && !window.isVisible()) {
      window.showInactive();
      this.cursorPositions.delete('bubble');
      this.pollCursor(true);
    }
  }

  // 实际窗口随角色移动；只有内容、测量状态或窗口内的图形变化时才通知渲染端。
  positionBubble(notify = false) {
    const limits = this.bubbleLimits();
    if (limits.scale !== this.bubbleModel.scale || limits.maxWidth !== this.bubbleModel.maxWidth || limits.maxHeight !== this.bubbleModel.maxHeight) {
      this.bubbleModel = {
        ...this.bubbleModel,
        ...limits,
        revision: this.bubbleModel.revision + 1,
        measuredRevision: -1,
      };
      notify = true;
    }
    const layout = placeBubble(this.character, this.display.workArea, {
      width: limits.maxWidth, height: limits.maxHeight, scale: limits.scale,
    });
    const { side, horizontal, tailX } = layout;
    if (this.bubbleModel.side !== side || this.bubbleModel.horizontal !== horizontal || this.bubbleModel.tailX !== tailX) {
      Object.assign(this.bubbleModel, { side, horizontal, tailX });
      notify = true;
    }
    const window = this.windows.get('bubble');
    const current = window.getBounds();
    // 原生窗口位置不变时不重复定位，避免在透明窗口上制造无意义的重绘与位置回跳。
    if (RECT_KEYS.some(key => current[key] !== layout.bounds[key]))
      window.setBounds(layout.bounds, false);
    if (notify) window.webContents.send('dg:bubble', this.bubbleModel);
  }

  // 已收起的窗口不重复向系统发隐藏命令，避免 AppKit 释放另一扇角色窗口正在使用的鼠标捕获。
  hideWindow(view) {
    const window = this.windows.get(view);
    if (window && !window.isDestroyed() && window.isVisible()) window.hide();
  }

  // 隐藏气泡时释放输入区域，震荡波开场可单独收起气泡。
  hideBubble({ keepWave = false } = {}) {
    clearTimeout(this.bubbleTimer);
    this.bubbleVisible = false;
    this.completionClick = null;
    this.setInteractive('bubble', false);
    this.hideWindow('bubble');
    this.syncCompletionFocusable();
    if (!keepWave) this.cancelPrayerWave();
    this.finishPrayerTyping(this.bubbleModel.typingId);
  }

  // 显隐来自主进程，已隐藏的页面即使有迟到命中消息也不能重新占用鼠标。
  canInteract(view) {
    const window = this.windows.get(view);
    return this.ready.has(view) && this.visible && !this.suppressedByFollow && !this.stopping && (view !== 'bubble' || this.bubbleVisible)
      && window && !window.isDestroyed() && window.isVisible();
  }

  // 手势和原生菜单展开期间保留输入，移出角色后仍能悬停子菜单。
  setInteractive(view, enabled) {
    const window = this.windows.get(view);
    if (!window || window.isDestroyed()) return;
    const next = !!((enabled || view === 'character' && (this.gesture.active || this.contextMenu)) && this.canInteract(view));
    if (this.interactive.get(view) === next) {
      // 被隐藏状态否决的迟到消息也要回执，否则渲染端可能一直认为鼠标已经启用。
      if (enabled !== next && this.ready.has(view)) window.webContents.send('dg:input-state', next);
      return;
    }
    this.interactive.set(view, next);
    if (!next) this.cursorPositions.delete(view);
    window.setIgnoreMouseEvents(!next, { forward: true });
    // 原生轮询或隐藏操作可能主动释放输入，回传实际状态避免渲染层缓存过期后无法重新进入。
    if (this.ready.has(view)) window.webContents.send('dg:input-state', next);
  }

  // 复用全局光标轮询驱动视线；仅在位置变化时发消息，隐藏角色与静止鼠标不增加绘制。
  pollCursor(force = false) {
    if (this.stopping) return;
    clearTimeout(this.cursorTimer);
    // 菜单自行追踪鼠标；全局轮询此时不能把所属窗口重新设为穿透。
    if (this.contextMenu) return;
    let point;
    let nearby = false;
    let followingEyes = false;
    for (const [view, window] of this.windows) {
      if (window.isDestroyed() || !this.ready.has(view)) continue;
      const visible = window.isVisible();
      // macOS 原生显示可能先于 Electron 的 show 通知完成，不能让可见角色一直保留隐藏标记。
      if (view === 'character' && visible !== this.lastCharacterVisibility) this.sendCharacterLayout();
      if (!visible) continue;
      // 两扇窗口都已隐藏时无需查询全局光标；显示后的第一次采样仍会立即命中。
      point ??= screen.getCursorScreenPoint();
      const bounds = window.getBounds();
      const inside = containsPoint(bounds, point);
      const followEyes = view === 'character' && eyeTrackingEnabled(this.appearance.asset, this.appearance.settings);
      followingEyes ||= followEyes;
      nearby ||= inside;
      if (!inside && !(view === 'character' && this.gesture.active)) this.setInteractive(view, false);
      const local = { x: point.x - bounds.x, y: point.y - bounds.y };
      const previous = this.cursorPositions.get(view);
      if ((inside || force || followEyes) && !(view === 'character' && this.gesture.active)
        && (force || previous?.x !== local.x || previous?.y !== local.y)) {
        this.cursorPositions.set(view, local);
        // 强制采样也要重查渲染端命中缓存，处理原生显示与网页完成排版先后不固定的情况。
        window.webContents.send('dg:cursor', view === 'bubble' && (force || !previous) ? { ...local, refresh: true } : local);
      }
    }
    this.cursorTimer = setTimeout(() => this.pollCursor(), nearby ? 24 : followingEyes ? 33 : 100);
    this.cursorTimer.unref();
  }

  // 明确的用户操作才落盘；写入失败会保留当前界面并允许稍后重试。
  persist() {
    this.store.save(this.state).catch((error) => {
      console.error('位置与设置保存失败：', error.message);
      this.tray?.setToolTip('龙娘 · 设置暂未保存，请检查用户目录写入权限');
    });
  }

  // 在实际右击位置打开菜单，整个生命周期保留菜单对象与鼠标输入。
  showMenu(point = screen.getCursorScreenPoint(), characterOnly = false) {
    const window = this.windows.get('character');
    if (this.stopping || this.contextMenu || !this.validPoint(point)
      || !window || window.isDestroyed() || !window.isVisible()) return;
    const menu = characterOnly ? Menu.buildFromTemplate(this.characterMenuItems()) : this.buildMenu();
    // 菜单期间保留最新宿主坐标，关闭时补上移动，不需要等待下一份快照。
    const closed = () => {
      if (this.contextMenu !== menu) return;
      this.contextMenu = null;
      this.menuCharacter = null;
      if (this.followMode && this.followTarget && !this.suppressedByFollow) this.applyFollowPlacement();
      this.pollCursor(true);
    };
    this.menuCharacter = { ...this.character };
    this.contextMenu = menu;
    clearTimeout(this.cursorTimer);
    try {
      const bounds = window.getContentBounds();
      this.setInteractive('character', true);
      // macOS 交给 AppKit 放置原生菜单，不把菜单空间换算成人物网页的尺寸与坐标。
      menu.popup({ window, frame: window.webContents.mainFrame, ...(process.platform === 'darwin' ? { positioningItem: 0 } : {}),
        x: Math.round(point.x - bounds.x), y: Math.round(point.y - bounds.y), callback: closed });
    } catch (error) {
      closed();
      throw error;
    }
  }

  // 角色入口同时用于发饰下拉框、右键和托盘，选中状态依据实际展示的内置素材。
  characterMenuItems() {
    return CHARACTERS.map((character) => ({
      label: character.name,
      type: 'radio',
      checked: characterByAsset(this.appearance.asset)?.id === character.id,
      enabled: !!this.delegate?.selectCharacter,
      click: () => void this.delegate?.selectCharacter?.(character.id)
        ?.catch((error) => console.error('切换角色失败：', error.message)),
    }));
  }

  // 原生菜单让透明挂件不必常驻额外按钮，角色本体和设置入口保持分离。
  buildMenu() {
    const characterId = characterByAsset(this.appearance.asset)?.id;
    const actions = CHARACTER_ACTIONS[characterId] ?? [];
    return Menu.buildFromTemplate([
      { label: this.instanceName || '龙娘', enabled: false },
      ...(this.delegate
        ? [
            { label: '用量总览与设置…', click: () => this.delegate.openDashboard() },
            { label: '刷新全部账户', click: () => this.delegate.refresh() },
          ]
        : []),
      { type: 'separator' },
      ...(this.delegate?.selectCharacter ? [{ label: '切换角色', submenu: this.characterMenuItems() }] : []),
      // 只有默认龙娘有合掌素材；托盘与右键共用此入口。
      {
        label: '祈祷式编程',
        enabled: characterId === 'dragon',
        click: () => this.prayForCode(),
      },
      { label: this.visible ? '暂时收起' : '叫出龙娘', click: () => this.toggleVisibility() },
      {
        label: '说句话',
        click: () => this.speak(),
      },
      // 角色有可用动作且动态表情开启时，才启用手动预览。
      {
        label: '动作',
        enabled: actions.length > 0 && this.appearance.settings?.expressionsEnabled !== false,
        submenu: actions.map(([label, name]) => ({
          label,
          enabled: name !== 'hair' || this.appearance.settings?.motion !== false,
          click: () => {
            this.show();
            this.showExpression(name, { preview: true });
          },
        })),
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

  // 仅菜单内容变化时重建托盘菜单，频繁窗口快照不会打断正在展开的菜单。
  updateMenu() {
    if (this.stopping || !this.tray || this.tray.isDestroyed()) return;
    const key = JSON.stringify([this.instanceName, !!this.delegate, this.visible, this.state.scale,
      this.state.snapEnabled, this.state.speechEnabled, this.shortcutRegistered,
      this.appearance.asset, this.appearance.settings?.expressionsEnabled]);
    if (key === this.menuKey) return;
    this.tray.setContextMenu(this.buildMenu());
    this.menuKey = key;
  }

  // 重置只影响位置，大小、气泡与吸附偏好继续保留。
  resetPosition() {
    this.cancelGesture();
    if (this.followMode) {
      this.setFollowOffset({ x: 1, y: 1 });
      this.show();
      return;
    }
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
    const window = this.windows.get('character');
    if (this.ready.has('character') && !this.suppressedByFollow && !window.isVisible()) window.showInactive();
    this.pollCursor(true);
    this.updateMenu();
  }

  // 主动收起同时取消未完成手势，避免恢复时仍然跟随鼠标。
  hide() {
    if (this.stopping) return;
    this.contextMenu?.closePopup(this.windows.get('character'));
    this.cancelGesture();
    this.visible = false;
    this.hideBubble();
    this.setInteractive('character', false);
    this.hideWindow('character');
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
    const previousDialogueCharacter = this.dialogueCharacterId;
    this.appearance = appearance;
    // 换角色时收起上一位的气泡；换成自定义图片时也要结束龙娘的祷文。
    if ((this.bubbleVisible && previousDialogueCharacter !== this.dialogueCharacterId)
      || (assetChanged && this.bubbleKind === 'prayer' && characterByAsset(appearance.asset)?.id !== 'dragon'))
      this.hideBubble();
    if (this.prayerWave && (appearance.settings?.motion === false || appearance.settings?.expressionsEnabled === false))
      this.hideBubble();
    const dragon = assetChanged && isDragonAsset(appearance.asset);
    const image = assetChanged && !dragon && appearance.assetPath ? nativeImage.createFromPath(appearance.assetPath) : null;
    const dimensions = dragon ? EYE_ARTWORK : image && !image.isEmpty() ? image.getSize() : null;
    const ratio = dimensions ? dimensions.height / dimensions.width : this.imageRatio;
    if (ratio !== this.imageRatio) {
      this.imageRatio = ratio;
      this.refreshPlacement();
    } else this.applyCharacter();
    this.refreshUsageBubble();
  }

  // 常驻用量气泡跟随最新读数更新，内容不变时不重排，也不重置自动收起时间。
  refreshUsageBubble() {
    if (this.stopping || !this.bubbleVisible || this.bubbleKind !== 'usage') return;
    const content = this.delegate?.bubbleFor?.(this) || this.bubbleModel.text;
    const text = typeof content === 'string' ? content : content.text;
    const usage = typeof content === 'string' ? null : content.usage;
    if (text === this.bubbleModel.text && JSON.stringify(usage) === JSON.stringify(this.bubbleModel.usage)) return;
    this.setBubbleContent(content);
    this.positionBubble(true);
  }

  // 跟随模式交由宿主决定层级，独立桌面模式继续置顶；只在模式切换时重设默认窗口属性。
  setFollowMode(enabled) {
    if (this.followMode === enabled) return;
    if (this.gesture?.active) this.cancelGesture();
    this.followMode = enabled;
    this.syncCompletionFocusable();
    this.contextMenu?.closePopup(this.windows.get('character'));
    for (const window of this.windows.values()) window.setAlwaysOnTop(!enabled, 'floating');
    // 同一管道中的桌面恢复命令会覆盖尚未执行的旧跟随请求，避免切换后被迟到请求降级。
    if (!enabled && process.platform === 'win32') this.delegate?.stackWindows?.(0,
      [...this.windows.values()].filter((window) => !window.isDestroyed()).map((window) => window.getMediaSourceId().split(':')[1]), []);
  }

  // 桌宠自己的透明窗口和临时震荡波都参与层级判断，不能把彼此当成其他应用的遮挡。
  static ownedWindowIds() {
    return [...Companion.registry].flatMap((pet) => [...pet.windows.values(), pet.prayerWave?.window])
      .filter((window) => window && !window.isDestroyed()).map((window) => window.getMediaSourceId().split(':')[1]);
  }

  // 使用原生窗口编号直接调整相对层级，不截屏、不聚焦宿主，也不把后台角色提升到其他应用上方。
  syncWindowStacking(force = false) {
    const hostId = this.followTarget?.id;
    if (!this.followMode || this.suppressedByFollow || this.stopping || this.contextMenu || !Number.isSafeInteger(hostId) || hostId <= 0) return;
    if (this.followOrder && !this.followOrder.some((id) => String(id) === String(hostId))) { this.followFrame(null); return; }
    const owned = Companion.ownedWindowIds();
    const wave = this.prayerWave?.hostId === hostId ? this.prayerWave.window : null;
    const hasWave = wave && !wave.isDestroyed() && wave.isVisible();
    const group = [...(hasWave ? [wave] : []), ...this.windows.values()].filter(window => !window.isDestroyed());
    // Windows 由原生桥按实时句柄排序，避免 Electron 对普通宿主的相对排序隐式改变置顶组。
    if (process.platform === 'win32') {
      const overlays = group.map(window => window.getMediaSourceId().split(':')[1]);
      this.delegate?.stackWindows?.(hostId, overlays, owned);
      return;
    }
    const regions = [this.character, ...(hasWave ? [this.followTarget] : []), ...(this.bubbleVisible ? [this.windows.get('bubble').getBounds()] : [])];
    const floating = process.platform === 'darwin' && followWindowFloating(this.followNormalWindows, this.followTarget, owned, regions);
    let levelChanged = false;
    // 前台只比普通窗口高一级，重新显示角色与气泡时也会留在浮动菜单后面。
    if (process.platform === 'darwin') for (const window of group) {
      if (window.isAlwaysOnTop() !== floating) {
        window.setAlwaysOnTop(floating, 'normal', 1);
        levelChanged = true;
      }
    }
    const overlays = group.filter(window => window.isVisible());
    const sources = new Map(overlays.map((window) => [window.getMediaSourceId().split(':')[1], window]));
    if (!sources.size) return;
    const [baseId, ...upperIds] = sources.keys();
    // 浮动层已天然高于宿主，只维护组内波纹、角色和气泡的前后顺序。
    const localOrder = this.followOrder?.some((id) => String(id) === baseId) ? this.followOrder : null;
    const moves = floating
      ? followWindowStack(localOrder, baseId, upperIds, force || levelChanged)
      : followWindowStack(this.followOrder, hostId, [...sources.keys()], force || levelChanged);
    if (!moves) { this.followFrame(null); return; }
    try {
      for (const { id, above } of moves) {
        const window = sources.get(id);
        window.moveAbove(`window:${above}:0`);
      }
    } catch {
      // 宿主可能在本次快照后关闭；先收起窗口，等下一份有效快照重新绑定。
      this.followFrame(null);
    }
  }

  // 保留当前宿主和相对锚点，显示器事件到达时无需等待下一份原生快照。
  followFrame(frame, offset = { x: 1, y: 1 }, { order = null, normalWindows = null } = {}) {
    // 独立桌面的菜单忽略宿主坐标，避免菜单关闭后的屏幕重排使用跟随位置。
    if (this.contextMenu && frame && !this.followMode) return;
    this.followOrder = order;
    this.followNormalWindows = normalWindows;
    if (this.gesture.active && this.followTarget?.id !== frame?.id) this.cancelGesture();
    this.followTarget = frame;
    this.followOffset = offset;
    this.applyFollowPlacement();
    this.syncCompletionFocusable();
  }

  // 手动拖动和菜单重置共用宿主锚点，立即应用，再由管理层按账户保存。
  setFollowOffset(offset) {
    this.followOffset = offset;
    this.delegate?.saveFollowOffset?.(this, offset);
    this.applyFollowPlacement(true);
  }

  // 宿主或所在屏幕不可见时先收起角色和气泡，保留用户主动隐藏的状态。
  hideForFollow() {
    this.suppressedByFollow = true;
    this.contextMenu?.closePopup(this.windows.get('character'));
    this.cancelGesture();
    this.hideBubble();
    this.setInteractive('character', false);
    this.hideWindow('character');
  }

  // 原生窗口快照和屏幕重排共用宿主坐标，不能回退到独立桌面的位置。
  applyFollowPlacement(refresh = false) {
    const offset = this.followOffset;
    const target = this.followTarget && followDisplayFrame(this.followTarget, offset, screen);
    if (!target) {
      this.hideForFollow();
      return;
    }
    if (!this.character) return;
    const { frame, display } = target;
    this.followTarget = frame;
    if (this.gesture.active) {
      this.syncWindowStacking();
      return;
    }
    // 菜单展开时保留角色位置；宿主消失或显示器断开已在上方处理。
    if (this.contextMenu) return;
    const size = characterSize(this.state.scale, display.workArea, this.imageRatio);
    const next = constrainCharacter(
      {
        ...size,
        x: frame.x + Math.max(0, frame.width - size.width) * offset.x,
        y: frame.y + Math.max(0, frame.height - size.height) * offset.y,
      },
      display.workArea,
    );
    // 即使角色本身没有移动，工作区变化也可能需要重新摆放气泡。
    const layoutChanged = refresh || this.suppressedByFollow || RECT_KEYS.some((key) =>
      next[key] !== this.character[key] || display.workArea[key] !== this.display.workArea[key]);
    this.display = display;
    this.suppressedByFollow = false;
    if (layoutChanged) {
      this.character = next;
      this.applyCharacter();
    } else if (this.updateFacing()) this.sendCharacterLayout();
    this.syncWindowStacking();
    if (this.visible && !this.suppressedByFollow && this.ready.has('character') && !this.windows.get('character').isVisible())
      this.windows.get('character').showInactive();
  }

  // 表情与声音独立；只接受已知表情，隐藏或拖动期间不积压表情消息。
  showExpression(name, { preview = false } = {}) {
    const window = this.windows.get('character');
    const characterId = characterByAsset(this.appearance.asset)?.id;
    // 新的五官贴图只适用于龙娘原画，仍由右键和托盘使用同一预览通道。
    const supported = ['happy', 'sad'].includes(name)
      || (name === 'hair' && characterId === 'maro')
      || (characterId === 'dragon' && (name === 'prayer' || isDragonFace(name)));
    if (!supported || this.stopping || this.gesture.active || this.appearance.settings?.expressionsEnabled === false
      || !this.ready.has('character') || !window || window.isDestroyed() || !window.isVisible()) return;
    // 先同步当前可见性，再发出表情；正常桌面点击不能因渲染层残留的隐藏状态而被丢弃。
    this.sendCharacterLayout();
    // 动作菜单的请求统一带预览来源，供渲染器选择手动播放姿态。
    window.webContents.send('dg:expression', preview || name === 'hair'
      ? { name, source: preview ? 'preview' : 'idle' } : name);
  }

  // 事件声和状态提示复用角色窗口，不额外创建音频后台进程。
  notify(event, text, { focusOnClick = false } = {}) {
    this.windows.get('character')?.webContents.send('dg:sound', event);
    // 祷文与震荡波期间暂停显示任务通知，提示音仍然照常播放。
    if (text && this.state.speechEnabled && !this.prayerWave && !(this.bubbleVisible && this.bubbleKind === 'prayer'))
      this.showBubble(text, 'notice', { focusOnClick });
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
    this.started = false;
    this.cancelPrayerWave();
    this.contextMenu?.closePopup(this.windows.get('character'));
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
