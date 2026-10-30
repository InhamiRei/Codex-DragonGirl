// 自动启动参数采用固定值，重复自动唤起不会打开管理窗口或解除暂停。
export function startupReason(argv) {
  return argv.includes('--dg-startup=codex') ? 'codex'
    : argv.includes('--dg-startup=login') ? 'login' : 'manual';
}

// 监督状态必须来自当前配置且仍新鲜；助手故障不能被误判为 Codex 已退出。
export function freshStartupStatus(status, revision, now = Date.now()) {
  return typeof revision === 'string' && revision.length > 0 && status?.revision === revision && Number.isFinite(status.updatedAt)
    && now >= status.updatedAt - 2000 && now - status.updatedAt < 6000
    && Array.isArray(status.hosts) && status.hosts.every((host) => typeof host === 'string');
}

// 只有自动跟随启动的实例才随宿主退出，手动打开和独立桌面继续由用户控制。
export function shouldStopWithHost({ managed, mode, displayMode, status, revision, absentSince, now }) {
  return managed && mode === 'codex' && displayMode === 'follow'
    && freshStartupStatus(status, revision, now) && status.hosts.length === 0
    && absentSince !== null && now - absentSince >= 3000;
}
