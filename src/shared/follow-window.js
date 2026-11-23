import { containsPoint } from './geometry.js';

// 无辅助功能权限时，根据系统 sheet 的居中覆盖关系识别临时面板，不依赖标题语言。
function coversParentAsSheet(panel, parent) {
  const centered = Math.abs(panel.x + panel.width / 2 - parent.x - parent.width / 2) <= 12;
  const middle = Math.abs(panel.y + panel.height / 2 - parent.y - parent.height / 2) <= 12;
  const attachedToTop = panel.y >= parent.y && panel.y <= parent.y + 80;
  const shorter = panel.height < parent.height * 0.9;
  return centered && shorter && (middle || attachedToTop);
}

// 原生模态状态优先；macOS 无权限时只对同进程、前后叠放的 sheet 几何进行保守兜底。
export function followWindowFrame(process) {
  const windows = process?.windows || [];
  if (!windows.length || process.modalOpen === true) return null;
  if (
    process.platform === 'darwin' &&
    process.modalOpen !== false &&
    windows.slice(1).some((parent) => coversParentAsSheet(windows[0], parent))
  ) return null;
  return windows[0];
}

// 同一账户有多个进程时，切走前台应用后仍保留上次使用的进程；进程退出才改选可见宿主。
export function followProcess(processes, home, previousPid) {
  const hosts = processes.filter(p => p.home === home);
  return hosts.find(p => p.frontmost) || hosts.find(p => p.pid === previousPid)
    || hosts.find(p => followWindowFrame(p)) || hosts[0];
}

// 求宿主真正占用的显示区域，边缘相接不算落在该屏。
function intersectionArea(a, b) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

// 按角色锚点选显示器。Windows 跨不同 DPI 时，以目标屏原点投影原生矩形，避免拿主屏比例计算副屏位置。
export function followDisplayFrame(frame, offset, screen) {
  const physical = frame.physicalBounds;
  const source = physical || frame;
  const point = {
    x: Math.round(source.x + (source.width - 1) * offset.x),
    y: Math.round(source.y + (source.height - 1) * offset.y),
  };
  // 只有 Windows 物理帧需要转换显示器边界。
  const screenBounds = display => physical ? screen.dipToScreenRect(null, display.bounds) : display.bounds;
  let display = screen.getDisplayNearestPoint(physical ? screen.screenToDipPoint(point) : point);
  let bounds = screenBounds(display);
  // 锚点可能已移出桌面或落在错排列屏之间，余下仍可见的屏幕按实际交集选取。
  if (!containsPoint(bounds, point)) {
    let largest = 0;
    for (const candidate of screen.getAllDisplays()) {
      const next = screenBounds(candidate);
      const area = intersectionArea(source, next);
      if (area && containsPoint(next, point)) { largest = area; display = candidate; bounds = next; break; }
      if (area > largest) { largest = area; display = candidate; bounds = next; }
    }
    if (!largest) return null;
  }
  if (!physical) return { display, frame };
  const scale = display.scaleFactor;
  return { display, frame: { ...frame,
    x: display.bounds.x + (source.x - bounds.x) / scale, y: display.bounds.y + (source.y - bounds.y) / scale,
    width: source.width / scale, height: source.height / scale,
  } };
}

// macOS 按角色与气泡的实际区域判断遮挡；盖住宿主其他位置的窗口不能让仍露出的角色反复切换层级。
export function followWindowFloating(normalWindows, host, overlays, regions = []) {
  const owned = new Set(overlays.map(String));
  const areas = regions.length ? regions : [host];
  for (const window of normalWindows || []) {
    if (String(window.id) === String(host.id)) return true;
    if (owned.has(String(window.id))) continue;
    if (areas.some((area) => intersectionArea(window, area) > 0)) return false;
  }
  return false;
}

// 为使用 Electron 相对排序的平台规划移动；Windows 置顶组由原生桥读取和处理。
export function followWindowStack(windowOrder, hostId, overlays, force = false) {
  const order = windowOrder?.map(String) || [];
  let above = String(hostId);
  if (windowOrder && !order.includes(above)) return null;
  const moves = [];
  for (const id of overlays.map(String)) {
    const parent = order.indexOf(above);
    if (force || parent <= 0 || order[parent - 1] !== id) {
      moves.push({ id, above });
      const current = order.indexOf(id);
      if (current >= 0) order.splice(current, 1);
      const target = order.indexOf(above);
      order.splice(target < 0 ? order.length : target, 0, id);
    }
    above = id;
  }
  return moves;
}
