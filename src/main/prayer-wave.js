import { BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { clamp } from '../shared/geometry.js';
import { followWindowFloating } from '../shared/follow-window.js';
import { PRAYER_WAVE_MS } from '../shared/prayer-wave.js';

const WAVE_URL = 'dragon://app/src/renderer/prayer-wave.html';
const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const RECT_KEYS = ['x', 'y', 'width', 'height'];

// 一次祈祷只持有一个透明特效窗口，绘制期间绑定最初的 Codex 窗口编号。
export class PrayerWave {
  // 所有坐标和窗口编号都来自主进程已有的宿主快照。
  constructor(hostId, { getTarget, getOrigin, ownedWindowIds, stackOnWindows, onStart, onFinish }) {
    Object.assign(this, { hostId, getTarget, getOrigin, ownedWindowIds, stackOnWindows, onStart, onFinish });
    this.started = false;
    this.closed = false;
  }

  // 宿主消失、切到其他窗口或被系统隐藏时，结束这次播放。
  matches(target) {
    const frame = target?.frame;
    return Number.isSafeInteger(this.hostId) && this.hostId > 0 && frame?.id === this.hostId
      && RECT_KEYS.every((key) => Number.isFinite(frame[key])) && frame.width >= 1 && frame.height >= 1
      && (!target.order || target.order.some((id) => String(id) === String(this.hostId)));
  }

  // 波心换算到透明窗口实际坐标，桌面模式中超出 Codex 的手心贴到最近边缘。
  sendOrigin() {
    const bounds = this.window.getContentBounds();
    const origin = this.getOrigin();
    this.window.webContents.send('dg:prayer-wave', {
      x: clamp(origin.x - bounds.x, 0, bounds.width),
      y: clamp(origin.y - bounds.y, 0, bounds.height),
    });
  }

  // 窗口只展示本地画布，永远穿透鼠标，加载完才显示并释放合掌动作。
  async play() {
    const target = this.getTarget();
    if (!this.matches(target)) { this.close(); return; }
    try {
      const window = this.window = new BrowserWindow({
        show: false, transparent: true, frame: false, hasShadow: false,
        resizable: false, movable: false, focusable: false, skipTaskbar: true,
        fullscreenable: false, minimizable: false, maximizable: false,
        backgroundColor: '#00000000', title: '祈祷震荡波',
        ...Object.fromEntries(RECT_KEYS.map((key) => [key, Math.round(target.frame[key])])),
        webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      // 龙娘启动时已经隐藏 Dock；临时波纹窗口沿用该模式，避免系统为全屏可见性切换进程类型。
      if (process.platform === 'darwin')
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      window.setIgnoreMouseEvents(true);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.once('render-process-gone', () => this.close());
      window.once('closed', () => this.close());
      window.webContents.ipc.on('dg:prayer-wave-finished', (event) => {
        // 完成消息只接受这次特效页面的主框架。
        if (event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === WAVE_URL) this.close();
      });
      this.timer = setTimeout(() => this.close(), 2500);
      await window.loadURL(WAVE_URL);
      if (this.closed) return;
      const latest = this.getTarget();
      if (!this.matches(latest)) { this.close(); return; }
      window.showInactive();
      this.update(latest, true);
      if (this.closed) return;
      this.started = true;
      this.sendOrigin();
      this.onStart();
      clearTimeout(this.timer);
      // 正常以画布最后一帧为准，渲染停摆时仍会收起特效窗口。
      this.timer = setTimeout(() => this.close(), PRAYER_WAVE_MS + 700);
    } catch (error) {
      if (!this.closed) console.warn('祈祷震荡波未能显示：', error.message);
      this.close();
    }
  }

  // 继续跟随宿主位置；有其他应用挡住 Codex 时，把光效留在挡住它的窗口后面。
  update(target, force = false) {
    if (this.closed) return;
    if (!this.matches(target)) { this.close(); return; }
    const window = this.window;
    if (!window || window.isDestroyed() || (!force && !window.isVisible())) return;
    const { frame, order, normalWindows } = target;
    const bounds = Object.fromEntries(RECT_KEYS.map((key) => [key, Math.round(frame[key])]));
    const boundsChanged = !this.lastBounds || RECT_KEYS.some((key) => this.lastBounds[key] !== bounds[key]);
    try {
      if (boundsChanged) {
        this.lastBounds = bounds;
        window.setBounds(bounds, false);
        if (this.started) this.sendOrigin();
      }
      const id = window.getMediaSourceId().split(':')[1];
      const owned = this.ownedWindowIds();
      if (process.platform === 'win32') {
        this.stackOnWindows(this.hostId, id, owned);
        return;
      }
      const floating = process.platform === 'darwin' && followWindowFloating(normalWindows, frame, owned, [frame]);
      const levelChanged = window.isAlwaysOnTop() !== floating;
      if (levelChanged) window.setAlwaysOnTop(floating, 'floating');
      const index = order?.findIndex((entry) => String(entry) === id) ?? -1;
      const hostIndex = order?.findIndex((entry) => String(entry) === String(this.hostId)) ?? -1;
      const overlapsStack = index < 0 || index >= hostIndex
        || order.slice(index + 1, hostIndex).some((entry) => !owned.includes(String(entry)));
      if (!floating && (force || levelChanged || overlapsStack)) window.moveAbove(`window:${this.hostId}:0`);
    } catch {
      this.close();
    }
  }

  // 释放原生窗口、画布和超时；手动取消与自然结束都允许重复调用。
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
    this.onFinish();
  }
}
