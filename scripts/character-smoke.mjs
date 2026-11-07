import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHARACTERS } from '../src/shared/characters.js';

const root = process.cwd();
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-characters-'));
const artifacts = path.join(root, '.artifacts/maro-integration');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
let application, page;
const errors = [];

// 根据真实绘制与主进程状态等待，超时即失败，不把固定延迟当成功依据。
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

// 从正式主进程入口切换预览设置，不修改真实用户目录。
async function appearance(settings = {}, status = 'idle') {
  await application.evaluate((_, value) => {
    const c = globalThis.__dragonGirlTest;
    c.setAppearance({ ...c.appearance, status: value.status,
      settings: { ...c.appearance.settings, ...value.settings } });
  }, { settings, status });
}

// 状态来自实际角色画布，与收到 IPC 消息但尚未渲染区分开。
async function state() {
  return page.locator('#character').getAttribute('data-sprite-state');
}

// 手动预览走与真实任务提醒相同的受限表情入口。
async function expression(name, preview = true) {
  await application.evaluate((_, value) => globalThis.__dragonGirlTest.showExpression(value.name, { preview: value.preview }), { name, preview });
}

try {
  await fs.mkdir(artifacts, { recursive: true });
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DRAGONGIRL_MONITOR_TEST;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [root], env, timeout: 30000 });
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest?.ready.size === 2), '角色未就绪');
  page = application.windows().find((window) => window.url().endsWith('/character.html'));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // 空用户目录必须先显示龙娘，再进入切换验证，防止新角色覆盖首次安装的默认角色。
  assert.equal(await page.evaluate(async () => (await window.dragonGirl.bootstrap()).asset),
    'dragon://app/' + CHARACTERS[0].image);
  // 暂停首次解码，真实重现“刚切换角色就点捋头发”，避免加载期间的手动操作被吞掉。
  await page.evaluate(async () => {
    const { CharacterSprites } = await import('dragon://app/src/renderer/character-sprites.js');
    const original = CharacterSprites.prototype.loadImage;
    let first = true;
    CharacterSprites.prototype.loadImage = async function (url) {
      if (first) {
        first = false;
        window.__maroWaiting = true;
        await new Promise((resolve) => { window.__maroRelease = resolve; });
        CharacterSprites.prototype.loadImage = original;
      }
      return original.call(this, url);
    };
  });
  await application.evaluate(async ({ app }, definitions) => {
    const c = globalThis.__dragonGirlTest;
    // 测试委托使用同一角色注册表与布局入口，保留正式 IPC、菜单和画布路径。
    c.delegate = {
      openDashboard() {}, refresh() {},
      async selectCharacter(id) {
        const character = definitions.find((item) => item.id === id) || definitions[0];
        c.setAppearance({ asset: 'dragon://app/' + character.image,
          assetPath: app.getAppPath() + '/' + character.image, status: 'idle',
          settings: { characterId: id, autoFlip: false, soundEnabled: false, motion: true,
            expressionsEnabled: true, eyeTracking: true, blinkEnabled: true } });
      },
    };
    clearTimeout(c.cursorTimer);
    c.pollCursor = () => {};
    c.character = { ...c.character, x: c.display.workArea.x + 400, y: c.display.workArea.y + 220 };
    await c.delegate.selectCharacter('maro');
    c.setScale(0.75);
    c.show();
  }, CHARACTERS);
  await until(() => page.evaluate(() => window.__maroWaiting === true), '没有进入素材加载阶段');
  await expression('hair');
  await page.evaluate(() => {
    window.__maroRelease();
    delete window.__maroRelease;
    delete window.__maroWaiting;
  });
  await until(async () => await state() === 'hair', '加载期间的手动捋发请求被丢失');
  await until(async () => await state() === 'idle', '麻吕待机没有显示');
  const originalBounds = await application.evaluate(() => globalThis.__dragonGirlTest.windows.get('character').getBounds());
  // 角落透明且脸部可见，保证没有把预览的米白矩形带到桌面。
  const alpha = await page.evaluate(() => {
    const canvas = document.querySelector('.character-sprites');
    const size = canvas.width;
    const rgba = canvas.getContext('2d').getImageData(0, 0, size, size).data;
    return { size, corner: rgba[3], face: rgba[(Math.floor(size * 0.65) * size + Math.floor(size / 2)) * 4 + 3] };
  });
  assert.equal(alpha.size, 1254);
  assert.equal(alpha.corner, 0);
  assert.ok(alpha.face > 200);
  assert.equal(await page.locator('.eye-layer:not([hidden])').count(), 0, '套用了龙娘眼睛');
  await page.screenshot({ path: path.join(artifacts, 'idle.png'), omitBackground: true });
  await expression('happy');
  await until(async () => await state() === 'happy', '完成表情未显示');
  await page.screenshot({ path: path.join(artifacts, 'success.png'), omitBackground: true });
  await until(async () => await state() === 'idle', '完成表情未恢复');
  await expression('sad');
  await until(async () => await state() === 'sad', '失败表情未显示');
  await page.screenshot({ path: path.join(artifacts, 'failure.png'), omitBackground: true });
  // 复现实际工作中的右键操作：自动捋发不触发，用户点菜单仍完整播放且不被状态刷新取消。
  await appearance({}, 'working');
  await expression('hair', false);
  assert.equal(await state(), 'sad');
  const previewEnabled = await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    const item = c.buildMenu().items.find((entry) => entry.label === '表情').submenu.items.find((entry) => entry.label === '捋头发');
    item.click();
    return item.enabled;
  });
  assert.equal(previewEnabled, true);
  await until(async () => await state() === 'hair', '捋发没有开始');
  await appearance({}, 'working');
  const hairStarted = Date.now();
  const playback = await page.evaluate(() => new Promise((resolve) => {
    const seen = new Set(), rectangles = [];
    const timer = setInterval(() => {
      const element = document.getElementById('character');
      if (element.dataset.spriteState === 'hair') {
        const frame = Number(element.dataset.spriteFrame);
        if (!seen.has(frame)) {
          seen.add(frame);
          const rect = element.getBoundingClientRect();
          rectangles.push({ frame, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        }
      } else { clearInterval(timer); resolve({ frames: [...seen], rectangles }); }
    }, 10);
  }));
  const { frames, rectangles } = playback;
  assert.equal(frames.length, 30, `动画缺帧：${frames}`);
  // 原生窗口之外，还验证实际 DOM 绘制框没有被身体跟随或缩放动画偷偷改变。
  assert.ok(rectangles.every((rect) => ['x', 'y', 'width', 'height']
    .every((key) => Math.abs(rect[key] - rectangles[0][key]) < 0.01)), '捋发过程中显示位置或整体大小发生变化');
  assert.ok(Date.now() - hairStarted >= 4600, '慢速捋发过早结束');
  assert.equal(await state(), 'idle');
  assert.deepEqual(await application.evaluate(() => globalThis.__dragonGirlTest.windows.get('character').getBounds()), originalBounds);
  // 拖动、隐藏、关闭动画和减少动态效果都必须及时中断，并可恢复下一次播放。
  await expression('hair');
  await until(async () => await state() === 'hair', '再次捋发失败');
  await appearance({ motion: false });
  await until(async () => await state() === 'idle', '关闭动画没有停止捋发');
  assert.equal(await application.evaluate(() => globalThis.__dragonGirlTest.buildMenu().items
    .find((entry) => entry.label === '表情').submenu.items.find((entry) => entry.label === '捋头发').enabled), false);
  await appearance({ motion: true });
  await expression('hair');
  await application.evaluate(() => globalThis.__dragonGirlTest.hide());
  await until(async () => await state() === 'idle', '隐藏后仍在捋发');
  await application.evaluate(() => globalThis.__dragonGirlTest.show());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expression('hair');
  assert.equal(await state(), 'idle');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await appearance({ expressionsEnabled: false });
  await expression('sad');
  assert.equal(await state(), 'idle');
  await appearance({ expressionsEnabled: true, flip: true });
  await expression('hair');
  await until(async () => await state() === 'hair', '翻转状态无法捋发');
  await page.screenshot({ path: path.join(artifacts, 'hair-flipped.png'), omitBackground: true });
  // 真实点击龙娘发饰只展开角色菜单，不触发用量气泡或拖动窗口。
  await application.evaluate(() => globalThis.__dragonGirlTest.delegate.selectCharacter('dragon'));
  await until(async () => await state() === null, '切换龙娘后仍显示麻吕');
  await until(() => page.evaluate(() => {
    const image = document.getElementById('portrait');
    return image.complete && image.naturalWidth === 1330;
  }), '龙娘原画未解码');
  await page.bringToFront();
  const bounds = await application.evaluate(() => globalThis.__dragonGirlTest.windows.get('character').getContentBounds());
  await until(() => page.evaluate((bounds) => innerWidth === bounds.width && innerHeight === bounds.height
    && Math.abs(screenX - bounds.x) <= 1 && Math.abs(screenY - bounds.y) <= 1, bounds), '窗口切换后的坐标未同步');
  const point = await page.evaluate(async () => {
    const { rect } = await window.dragonGirl.bootstrap();
    return { x: rect.x + rect.width * 0.835, y: rect.y + rect.height * 0.505 };
  });
  await page.mouse.click(point.x, point.y);
  const menu = await until(() => application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    return c.contextMenu && { labels: c.contextMenu.items.map((item) => item.label), bubble: c.bubbleVisible };
  }), '点击发饰没有打开角色下拉框');
  assert.deepEqual(menu.labels, ['龙娘', '麻吕']);
  assert.equal(menu.bubble, false);
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    const menu = c.contextMenu;
    menu.closePopup(c.windows.get('character'));
    menu.items[1].click();
  });
  await until(async () => await state() === 'idle', '菜单切回麻吕失败');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ passed: true, frames, alpha, menu,
    workingMenuPreview: true, workingAutomaticBlocked: true, previewQueuedDuringLoading: true,
    fixedDisplayRectangle: true, rectangles, slowDuration: true }, null, 2));
  console.log('麻吕待机、完成、失败、30 帧、透明背景、翻转、取消与发饰切换全部通过。');
} finally {
  await application?.close().catch(() => {});
  await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
