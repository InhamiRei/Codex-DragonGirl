import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

// 使用 Node 自带的语法检查器，无需构建步骤也能检查全部主进程与界面模块。
async function checkDirectory(relative) {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) await checkDirectory(file);
    else if (/\.(js|mjs|cjs)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`${file}\n${result.stderr}`);
    }
  }
}

// 三个目录覆盖应用、验证脚本和单元测试，任意语法错误都使检查失败。
for (const directory of ['src', 'scripts', 'tests']) await checkDirectory(directory);
console.log('全部 JavaScript 模块语法检查通过。');
