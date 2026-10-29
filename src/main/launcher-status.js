import fs from 'node:fs/promises';
import path from 'node:path';

// 只接受本项目日志目录内、由启动脚本创建的状态文件名，避免环境参数扩大文件写入范围。
export function launcherStatusPath(root, candidate) {
  if (!path.isAbsolute(candidate || '')) return null;
  const resolved = path.resolve(candidate);
  return path.dirname(resolved) === path.resolve(root, '.artifacts/logs') &&
    /^launch-\d+\.status$/.test(path.basename(resolved))
    ? resolved
    : null;
}

// 窗口真正就绪或确定失败后才反馈；原子替换避免启动脚本读到半段状态。
export function createLaunchReporter(root, candidate) {
  const destination = launcherStatusPath(root, candidate);
  return async (status, message = '') => {
    if (!destination || !['ready', 'error'].includes(status)) return false;
    const temporary = destination + '.' + process.pid + '.tmp';
    try {
      await fs.writeFile(temporary, status + '\n' + String(message).slice(0, 8192), { mode: 0o600 });
      await fs.rename(temporary, destination);
      return true;
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => {});
      return false;
    }
  };
}
