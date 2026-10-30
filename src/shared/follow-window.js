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
