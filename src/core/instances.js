import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

// 目录标识稳定跨重启，PID 只作为本次运行的窗口绑定。
export function homeId(home) {
  return createHash('sha256').update(home).digest('hex').slice(0, 20);
}
// 自动发现默认、Cockpit 注册表、Cockpit 目录和用户手动添加的任意数量实例。
export async function discoverHomes(settings, processes = [], userHome = os.homedir()) {
  const candidates = new Map([
    [path.join(userHome, '.codex'), { name: '默认 Codex', origin: '默认目录' }],
  ]);
  const cockpit = path.join(userHome, '.cockpit_tools');
  try {
    const registry = JSON.parse(await fs.readFile(path.join(cockpit, 'codex_instances.json'), 'utf8'));
    for (const item of registry.instances || [])
      if (typeof item.userDataDir === 'string' && path.isAbsolute(item.userDataDir))
        candidates.set(item.userDataDir, {
          name: String(item.name || 'Codex 实例').slice(0, 60),
          origin: 'Cockpit',
        });
  } catch {}
  try {
    for (const dir of await fs.readdir(path.join(cockpit, 'instances/codex'), { withFileTypes: true }))
      if (dir.isDirectory()) {
        const p = path.join(cockpit, 'instances/codex', dir.name);
        if (!candidates.has(p))
          candidates.set(p, { name: `Codex ${dir.name.slice(0, 6)}`, origin: 'Cockpit' });
      }
  } catch {}
  for (const home of settings.manualHomes)
    candidates.set(home, { name: path.basename(home), origin: '手动添加' });
  for (const p of processes)
    if (p.home && path.isAbsolute(p.home) && !candidates.has(p.home))
      candidates.set(p.home, { name: `Codex · ${p.pid}`, origin: '运行实例' });
  const result = new Map();
  for (const [candidate, meta] of candidates) {
    let home;
    try {
      home = await fs.realpath(candidate);
      if (!(await fs.stat(home)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (settings.hiddenHomes.includes(home)) continue;
    const running = processes.filter((p) => p.home === home || p.home === candidate);
    const existing = result.get(home);
    result.set(home, {
      id: homeId(home),
      home,
      name: settings.aliases[home] || meta.name,
      origin: meta.origin,
      processes: [...(existing?.processes || []), ...running],
    });
  }
  return [...result.values()];
}
// 只传递统计所需字段；进程环境和可执行路径不进入界面。
export function publicInstance(instance) {
  const { processes, ...safe } = instance;
  return {
    ...safe,
    pids: processes.map((p) => p.pid),
    running: processes.length > 0,
    frontmost: processes.some((p) => p.frontmost),
  };
}
