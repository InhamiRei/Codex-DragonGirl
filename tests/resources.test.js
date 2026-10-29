import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveResourcePath } from '../src/main/resources.js';

// 加载本地页面的协议不能被用来读取主进程、项目配置或目录外文件。
test('资源白名单允许角色与界面，拒绝普通及编码路径穿越', () => {
  const root = path.resolve('/project');
  assert.equal(resolveResourcePath(root, 'dragon://app/src/renderer/character.html'), path.join(root, 'src/renderer/character.html'));
  assert.equal(resolveResourcePath(root + '/', 'dragon://app/src/renderer/character.html'), path.join(root, 'src/renderer/character.html'));
  assert.equal(resolveResourcePath(root, 'dragon://app/assets/characters/codex-dragon-girl.png'), path.join(root, 'assets/characters/codex-dragon-girl.png'));
  for (const address of ['dragon://app/src/main/main.js', 'dragon://app/.git/config',
    'dragon://app/src/shared/../main/main.js', 'dragon://app/src/shared/..%2fmain/main.js',
    'dragon://app/src/shared/..%5cmain/main.js', 'dragon://other/src/shared/state.js',
    'https://app/src/shared/state.js', 'dragon://app/src/shared/%ZZ'])
    assert.equal(resolveResourcePath(root, address), null, address);
});
