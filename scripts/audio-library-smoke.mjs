import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { AUDIO_FILES } from '../src/shared/audio-library.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘音效验收-'));
const data = path.join(temp, 'data'), user = path.join(temp, 'user');
const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1',
  DRAGONGIRL_DATA_DIR: data, DRAGONGIRL_FIXTURE_HOME: user };
delete env.ELECTRON_RUN_AS_NODE;
let application, page;
const errors = [];

// 先通过开发版导入，第二次从指定的实际成品打开同一份测试用户目录。
async function openSettings(executablePath) {
  application = await electron.launch(executablePath
    ? { executablePath, args: [], env } : { args: [root], env });
  await application.evaluate(async () => {
    const deadline = Date.now() + 15000;
    while (!globalThis.__dragonGirlApp?.dashboard.window) {
      if (Date.now() > deadline) throw new Error('管理窗口未就绪');
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  });
  page = application.windows().find((window) => window.url().endsWith('/dashboard.html'))
    || await application.waitForEvent('window', (window) => window.url().endsWith('/dashboard.html'));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('[data-tab="settings"]').click();
  await page.locator('[data-settings-tab="sound"]').click();
  await page.waitForFunction(() => document.querySelector('#sound-library-list li'));
}

// 操作和用户相同的自定义下拉菜单。
async function choose(event, id) {
  const key = 'event-audio-' + event;
  await page.locator(`[data-select="${key}"]`).click();
  await page.locator(`#${key}-list [data-value="${id}"]`).click();
}

// 设置写入完成后再核对真实角色使用的播放缓冲。
async function saveSettings() {
  await page.locator('#save-settings').click();
  await page.waitForFunction(() => document.querySelector('#dirty-hint').dataset.dirty === 'false'
    && !document.querySelector('#save-settings').disabled);
}

// 临时目录承载文件和截图，不在实际用户的偏好与音效库写入验收数据。
try {
  await fs.mkdir(data, { recursive: true });
  await fs.mkdir(path.join(user, '.codex/sessions'), { recursive: true });
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ soundTheme: 'fx1', mode: 'desktop' }));
  const original = path.join(temp, '清脆提示.wav');
  await fs.copyFile(path.join(root, 'assets/audio', AUDIO_FILES.find((file) => file.id === 'end_a').localFile), original);
  await openSettings();
  assert.equal(await page.locator('#event-audio-press').inputValue(), 'd1');
  assert.equal(await page.locator('#event-audio-release').inputValue(), 'd2');
  assert.equal(await page.locator('select[name="soundTheme"]').count(), 0);

  // 通过文件选择入口打开波形，核对拖选、手柄、缩放、精确时间与试听。
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入音效', exact: true }).click();
  await (await chooser).setFiles(original);
  await page.locator('#audio-wave[data-ready=true]').waitFor();
  const wave = await page.locator('#audio-wave').boundingBox();
  await page.mouse.move(wave.x + wave.width * 0.1, wave.y + 16);
  await page.mouse.down();
  await page.mouse.move(wave.x + wave.width * 0.8, wave.y + 25, { steps: 7 });
  await page.mouse.up();
  const start = Number(await page.locator('#audio-start').inputValue());
  assert.ok(start > 0.15 && start < 0.18);
  await page.locator('[data-edge=start]').focus();
  await page.keyboard.press('ArrowRight');
  assert.ok(Number(await page.locator('#audio-start').inputValue()) > start);
  await page.locator('#audio-zoom').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#audio-pan-row').isVisible(), true);
  await page.locator('#audio-start').fill('0.125');
  await page.locator('#audio-end').fill('0.825');
  await page.locator('#audio-clip-name').fill('轻声提醒');
  await page.locator('#audio-preview').click();
  await page.locator('.wave-playhead').waitFor({ state: 'visible' });
  await page.locator('#audio-preview').click();
  await page.locator('#audio-editor').screenshot({ path: path.join(root, '.artifacts/audio-editor.png') });
  await page.locator('#audio-save').click();
  await page.locator('#audio-editor').waitFor({ state: 'hidden' });
  const row = page.locator('#sound-library-list li').filter({ hasText: '轻声提醒' });
  const id = await row.getAttribute('data-clip-id');
  assert.match(id, /^clip-[a-f0-9]{32}$/);
  const file = path.join(data, 'sound-library', id, 'clip.wav'), bytes = await fs.readFile(file);
  assert.equal(bytes.length, 44 + 33600 * 4);
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(await page.locator('#dirty-hint').getAttribute('data-dirty'), 'false');
  await row.getByRole('button', { name: /重命名/ }).click();
  await page.locator('#audio-new-name').fill('轻声');
  await page.getByRole('button', { name: '保存名称' }).click();
  await page.locator('#audio-rename').waitFor({ state: 'hidden' });
  await choose('press', id);
  await choose('release', 'exp_orb');
  await choose('question', id);
  await saveSettings();
  await page.locator('#install-audio').click();
  await page.waitForFunction(() => document.querySelector('#audio-library-status').textContent.includes('本机原声音效已就绪'));
  assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), digest);
  await fs.unlink(original);
  await application.close();
  application = null;

  // 重启并切到成品程序，源文件已移走，原声已修复，事件分配仍指向同一 WAV。
  await openSettings(process.env.DRAGONGIRL_TEST_EXECUTABLE);
  assert.equal(await page.locator('#event-audio-press').inputValue(), id);
  assert.equal(await page.locator('#event-audio-release').inputValue(), 'exp_orb');
  assert.equal(await page.locator('#event-audio-question option:checked').textContent(), '轻声');
  const character = application.windows().find((window) => window.url().endsWith('/character.html'));
  await character.waitForFunction((id) => window.__soundEngine?.buffers.has(id), id);
  const playback = await character.evaluate(async (id) => {
    const sound = window.__soundEngine;
    const press = await sound.play('press');
    const release = await sound.play('release');
    const question = await sound.play('question');
    return { press, release: release.id, question: question.id, duration: sound.buffers.get(id).duration };
  }, id);
  assert.equal(playback.press, true);
  assert.equal(playback.release, 'exp_orb');
  assert.equal(playback.question, id);
  assert.ok(Math.abs(playback.duration - 0.7) < 0.0001);
  await assert.rejects(page.evaluate((id) => window.dragonGirl.command('remove-audio-clip', id), id), /正在使用/);

  // 在界面最窄和常规尺寸检查修复行的间距，以及与总音量控件列的水平对齐。
  for (const width of [880, 1160]) {
    await application.evaluate((_, width) => globalThis.__dragonGirlApp.dashboard.window.setSize(width, 750), width);
    await page.waitForFunction((width) => Math.abs(window.innerWidth - width) < 4, width);
    const aligned = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
      const repair = rect('#install-audio'), text = rect('#audio-library-status'), master = rect('#sound-volume');
      return Math.abs(repair.left - master.left) < 1 && repair.left - text.right >= 20;
    });
    assert.ok(aligned, '修复按钮未对齐或与说明挤在一起');
  }
  await page.locator('#import-audio').scrollIntoViewIfNeeded();
  await page.locator('#import-audio').locator('xpath=ancestor::article').screenshot({ path: path.join(root, '.artifacts/sound-library.png') });
  assert.deepEqual(errors, []);
  console.log('音效库验收通过：旧设置迁移、波形裁剪、试听、保存、重命名、跨安装恢复、角色播放与宽窄布局。');
} finally {
  await application?.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
