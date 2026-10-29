import path from 'node:path';

// 自定义协议只允许界面、共享模块与角色素材，编码后的路径穿越同样被拒绝。
export function resolveResourcePath(root, address) {
  try {
    const base = path.resolve(root);
    const url = new URL(address);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (
      url.protocol !== 'dragon:' ||
      url.hostname !== 'app' ||
      relative.includes('\\') ||
      relative.split('/').some((segment) => segment === '..' || segment === '.')
    )
      return null;
    if (!/^(src\/(renderer|shared)\/|assets\/characters\/)/.test(relative)) return null;
    const resolved = path.resolve(base, relative);
    return resolved.startsWith(base + path.sep) ? resolved : null;
  } catch {
    return null;
  }
}
