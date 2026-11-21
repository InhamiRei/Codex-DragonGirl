import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { _electron as electron } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-update-ui-'));
const output = path.join(root, '.artifacts/update-preview');
const current = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const next = current.split('.').map((value, index) => String(Number(value) + (index === 2 ? 1 : 0))).join('.');
const executable = process.env.DRAGONGIRL_TEST_EXECUTABLE;
let application;

// 用真实管理窗口、真实下载器与隔离数据生成截图；虚构发布只存在于这次验收的主进程内。
async function showRelease(platform, installed) {
  const suffix = platform === 'win32' ? 'Windows-x64-Setup.exe' : 'macOS-arm64.dmg';
  const name = `Codex-DragonGirl-${next}-${suffix}`;
  const size = 128 * 1024;
  const asset = { name, size, state: 'uploaded', digest: 'sha256:' + createHash('sha256').update(Buffer.alloc(size, 17)).digest('hex'),
    browser_download_url: `https://github.com/InhamiRei/Codex-DragonGirl/releases/download/v${next}/${name}` };
  await application.evaluate(async (_electron, fixture) => {
    const service = globalThis.__dragonGirlApp.dashboard.updates;
    service.platform = fixture.platform;
    service.arch = fixture.platform === 'win32' ? 'x64' : 'arm64';
    service.update({ status: 'idle', release: null, percent: 0, installed: fixture.installed });
    // 把第二个数据块留到关闭弹窗之后发出，按真实字节数核对恰好 50% 的画面。
    const tail = fixture.platform === 'darwin'
      ? new Promise((resolve) => { globalThis.__resumeUpdateTransfer = resolve; }) : Promise.resolve();
    // 拦截的仅是网络和最终系统打开操作，点击、IPC、流式写入和 SHA-256 校验均走生产代码。
    service.fetch = async (url) => {
      if (url.startsWith('https://api.github.com/')) return Response.json(fixture.release);
      let received = 0;
      return new Response(new ReadableStream({ async pull(controller) {
        if (received) await tail;
        controller.enqueue(new Uint8Array(65536).fill(17));
        received += 65536;
        if (received === fixture.release.assets[0].size) controller.close();
      } }));
    };
    service.openFile = async (_file, format) => { globalThis.__updateOpenedFormat = format; };
    service.openPage = async (url) => { globalThis.__updateVisitedPage = url; };
    await service.check();
  }, { platform, installed, release: { tag_name: 'v' + next, draft: false, prerelease: false,
    published_at: new Date().toISOString(), assets: [asset],
    body: '- 可在版本号旁查看更新，直接下载适合当前系统的安装包。\n- 关闭更新窗口后，下载会在后台继续。\n- 安装前会校验文件的完整性。' } });
}

// 从同一检测入口返回本机版本，覆盖首次打开和已提示版本被撤回两种情况。
async function checkCurrentRelease() {
  await application.evaluate(async (_electron, version) => {
    const service = globalThis.__dragonGirlApp.dashboard.updates;
    service.fetch = async () => Response.json({ tag_name: 'v' + version, assets: [] });
    await service.check();
  }, current);
}

try {
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(path.join(temp, 'user/.codex/sessions'), { recursive: true });
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1',
    DRAGONGIRL_DATA_DIR: path.join(temp, 'data'), DRAGONGIRL_FIXTURE_HOME: path.join(temp, 'user') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ ...(executable ? { executablePath: executable, args: [], cwd: temp } : { args: [root], cwd: root }), env });
  // 管理窗口晚于角色与气泡创建；等 preload 和整个页面都已初始化再操作。
  let page;
  const deadline = Date.now() + 30000;
  while (!(page = application.windows().find((item) => item.url().endsWith('/dashboard.html')))) {
    if (Date.now() > deadline) throw new Error('更新验收未找到管理窗口');
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  await page.waitForFunction((version) => document.querySelector('#app-version')?.textContent === 'v' + version, current);
  // 此用例使用定向发送给页面的输入，避免桌面上其他窗口的实际键鼠操作关闭截图中的弹窗。
  await application.evaluate(() => {
    const window = globalThis.__dragonGirlApp.dashboard.window;
    window.setIgnoreMouseEvents(true);
    window.setFocusable(false);
    window.blur();
  });
  const badge = page.locator('#app-update-button'), modal = page.locator('#app-update-dialog'), primary = page.locator('#update-primary');
  assert.equal(await badge.isVisible(), false);
  await checkCurrentRelease();
  await page.locator('#title').click();
  assert.equal(await badge.isVisible(), false);
  assert.equal(await modal.isVisible(), false);
  // 两张侧栏截图使用同一裁剪区域，方便直接比较最新版和发现新版的效果。
  const side = await page.locator('.sidebar').boundingBox(), nav = await page.locator('.main-nav').boundingBox();
  const clip = { x: 0, y: 0, width: side.width, height: Math.round(nav.y - 1) };
  await page.screenshot({ path: path.join(output, 'current.png'), clip });
  await showRelease('darwin', false);
  await page.getByRole('button', { name: '查看 v' + next + ' 更新' }).waitFor();
  await badge.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  // 字号、行高、标签上下边缘都和版本号对齐，隐形点击区域仍有 24 像素高。
  assert.equal(await badge.evaluate((el) => getComputedStyle(el).fontWeight), '300');
  const versionLabel = page.locator('#app-version'), badgeLabel = badge.locator('#app-update-badge');
  assert.equal(await versionLabel.evaluate((el) => getComputedStyle(el).fontWeight), '400');
  // 同时核对字形字号和行盒高度，单看按钮外框无法发现文字偏小。
  const textMetrics = (el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight];
  assert.deepEqual(await badgeLabel.evaluate(textMetrics), await versionLabel.evaluate(textMetrics));
  const badgeBox = await badge.boundingBox(), versionBox = await versionLabel.boundingBox(), labelBox = await badgeLabel.boundingBox();
  assert.equal(badgeBox.height, versionBox.height);
  assert.equal(badgeBox.y, versionBox.y);
  assert.equal(labelBox.height, versionBox.height);
  assert.equal(labelBox.y, versionBox.y);
  assert.equal(await badge.evaluate((el) => getComputedStyle(el, '::after').height), '24px');
  await page.screenshot({ path: path.join(output, 'button.png'), clip });
  await badge.click();
  await page.getByText('发现新版本', { exact: true }).waitFor();
  await page.locator('.update-art img').evaluate((element) => element.decode());
  assert.equal(await page.locator('#update-message').isVisible(), false);
  assert.equal(await page.getByRole('progressbar').isVisible(), false);
  await modal.screenshot({ path: path.join(output, 'mac-window.png') });
  await primary.click();
  await page.waitForFunction(() => document.querySelector('#update-progress').value === 50);
  assert.equal(await primary.innerText(), '下载中 50%');
  assert.equal(await page.locator('#app-update-badge').innerText(), '50%');
  // 只在按钮原有颜色过渡自然结束后截图，像素对照不受采样时刻影响。
  await primary.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await modal.screenshot({ path: path.join(output, 'downloading.png') });
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  await application.evaluate(() => globalThis.__resumeUpdateTransfer());
  await page.waitForFunction(() => document.querySelector('#app-update-badge').textContent === '已就绪');
  await badge.click();
  await page.getByRole('button', { name: '打开安装包', exact: true }).waitFor();
  await primary.click();
  await page.getByText('已打开安装包', { exact: true }).waitFor();
  assert.equal(await application.evaluate(() => globalThis.__updateOpenedFormat), 'dmg');
  await page.locator('#update-release').click();
  assert.match(await application.evaluate(() => globalThis.__updateVisitedPage), /\/releases\/tag\/v/);
  await page.keyboard.press('Escape');
  await showRelease('win32', true);
  await badge.click();
  await primary.click();
  await page.getByRole('button', { name: '重启并更新', exact: true }).waitFor();
  assert.equal(await page.locator('#update-message').isVisible(), false);
  await primary.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await modal.screenshot({ path: path.join(output, 'windows-ready.png') });
  await primary.click();
  await page.getByText('正在重启更新', { exact: true }).waitFor();
  assert.equal(await application.evaluate(() => globalThis.__updateOpenedFormat), 'setup');
  await page.keyboard.press('Escape');
  await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.window.setSize(880, 660));
  await page.waitForFunction(() => window.innerWidth <= 880);
  assert.ok(await badge.evaluate((el) => el.getBoundingClientRect().right < document.querySelector('.sidebar').getBoundingClientRect().right));
  await badge.click();
  await modal.waitFor({ state: 'visible' });
  await checkCurrentRelease();
  await modal.waitFor({ state: 'hidden' });
  await badge.waitFor({ state: 'hidden' });
  console.log(`已验证 v${current} 到模拟 v${next} 的侧栏、更新弹窗、后台下载和两个平台的安装操作。`);
} finally {
  if (application) await application.evaluate(() => globalThis.__resumeUpdateTransfer?.()).catch(() => {});
  await application?.close();
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
