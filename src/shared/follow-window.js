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

// macOS 按角色与气泡的实际区域判断遮挡；盖住宿主其他位置的窗口不能让仍露出的角色反复切换层级。
export function followWindowFloating(normalWindows, host, overlays, regions = []) {
  const owned = new Set(overlays.map(String));
  const areas = regions.length ? regions : [host];
  for (const window of normalWindows || []) {
    if (String(window.id) === String(host.id)) return true;
    if (owned.has(String(window.id))) continue;
    if (areas.some((area) => window.x < area.x + area.width && window.x + window.width > area.x
      && window.y < area.y + area.height && window.y + window.height > area.y)) return false;
  }
  return false;
}

// 按宿主、角色、气泡的顺序规划相邻层级；只移动偏离位置的窗口，保留其他应用的遮挡关系。
export function followWindowStack(windowOrder, hostId, overlays, { force = false, topmost = [] } = {}) {
  const order = windowOrder?.map(String) || [];
  const raised = new Set(topmost.map(String));
  const owned = new Set(overlays.map(String));
  let above = String(hostId);
  if (windowOrder && !order.includes(above)) return null;
  const moves = [];
  for (const id of overlays.map(String)) {
    const parent = order.indexOf(above);
    if (force || parent <= 0 || order[parent - 1] !== id || raised.has(id) !== raised.has(above)) {
      // Windows 紧邻置顶组的普通窗口改用移到普通组顶端，避免 SetWindowPos 继承置顶属性。
      const top = !!windowOrder && parent >= 0 && !raised.has(above)
        && order.slice(0, parent).every((id) => raised.has(id) || owned.has(id));
      moves.push({ id, above, top });
      const current = order.indexOf(id);
      if (current >= 0) order.splice(current, 1);
      const target = order.indexOf(above);
      order.splice(target < 0 ? order.length : target, 0, id);
      if (raised.has(above)) raised.add(id);
      else raised.delete(id);
    }
    above = id;
  }
  return moves;
}
