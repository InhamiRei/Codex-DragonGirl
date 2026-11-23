import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { AUDIO_FILES } from '../src/shared/audio-library.js';

// 源码路径作为 Electron 的命令行参数传递；Windows 不能让末尾反斜杠转义闭引号。
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), '龙娘音效验收-'));
const data = path.join(temp, 'data'), user = path.join(temp, 'user');
const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1',
  DRAGONGIRL_DATA_DIR: data, DRAGONGIRL_FIXTURE_HOME: user };
delete env.ELECTRON_RUN_AS_NODE;
let application, page;
const errors = [];

// 在三分钟立体声录音中加入同峰值、不同平均强度的段落，以及已知时间的单声道脉冲。
async function writeLongSource(target) {
  const file = AUDIO_FILES.find((entry) => entry.id === 'end_a');
  const sample = await fs.readFile(path.join(root, 'assets/audio', file.localFile));
  assert.equal(sample.toString('ascii', 36, 40), 'data');
  const size = 180 * sample.readUInt32LE(28);
  const wav = Buffer.alloc(44 + size);
  sample.copy(wav, 0, 0, 44);
  wav.writeUInt32LE(size + 36, 4);
  wav.writeUInt32LE(size, 40);
  wav.fill(sample.subarray(44), 44);
  const rate = wav.readUInt32LE(24), frameBytes = wav.readUInt16LE(32);
  assert.equal(frameBytes, 4);
  const offset = (seconds) => 44 + Math.round(seconds * rate) * frameBytes;
  for (const [start, level] of [[24, 0.025], [48, 0.70]]) {
    const cycle = Buffer.alloc(512 * frameBytes);
    for (let frame = 0; frame < 512; frame++) {
      const value = frame === 0 ? 0.9 : frame === 1 ? -0.9 : level * Math.sin(frame * Math.PI / 32);
      const pcm = Math.round(value * 32767);
      cycle.writeInt16LE(pcm, frame * frameBytes);
      cycle.writeInt16LE(-pcm, frame * frameBytes + 2);
    }
    wav.fill(cycle, offset(start), offset(start + 16));
  }
  // 静音段的左右声道分别放入一个向下、一个向上的单采样尖峰。
  wav.fill(0, offset(72), offset(84));
  wav.writeInt16LE(-29490, offset(78.125) + 2);
  wav.writeInt16LE(29490, offset(81.375));
  await fs.writeFile(target, wav);
}

// 在实际画布上核对柱间留白、上下对称、段落强弱，以及两个声道各自的瞬态位置。
async function verifyWaveform() {
  const result = await page.locator('#audio-wave canvas').evaluate((canvas) => {
    const { width, height } = canvas;
    const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    // 透明像素不计入波形，用平均墨色量比较两段在同一标尺下的可见强度。
    const ink = (left, right, top, bottom) => {
      let total = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const index = (y * width + x) * 4;
          total += pixels[index + 3] / 255 * (255 - (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3);
        }
      }
      return total / ((right - left) * (bottom - top));
    };
    const x = (seconds) => Math.floor(width * seconds / 180);
    // 按一根柱的时间分辨率查找瞬态，并排除中线附近的静音标记。
    const radius = Math.ceil(3 * width / canvas.clientWidth);
    const pulse = (seconds) => ({
      above: ink(x(seconds) - radius, x(seconds) + radius + 1, 0, Math.floor(height * 0.45)),
      below: ink(x(seconds) - radius, x(seconds) + radius + 1, Math.ceil(height * 0.55), height),
    });
    // 响段中线上约三分之二的宽度是柱体，其余是留白；按透明度计算以兼容小数显示比例。
    const left = x(49), right = x(63);
    let painted = 0;
    for (let column = left; column < right; column++) {
      painted += pixels[(Math.floor(height / 2) * width + column) * 4 + 3] / 255;
    }
    return {
      sparse: ink(x(25), x(39), 0, height), dense: ink(x(49), x(63), 0, height),
      silent: pulse(75), negative: pulse(78.125), positive: pulse(81.375),
      centerCoverage: painted / (right - left),
      grid: getComputedStyle(canvas.parentElement).backgroundImage,
    };
  });
  assert.ok(result.dense > result.sparse * 1.3,
    `相同峰值掩盖了声音强弱：弱段 ${result.sparse.toFixed(2)}，强段 ${result.dense.toFixed(2)}`);
  assert.deepEqual(result.silent, { above: 0, below: 0 });
  for (const pulse of [result.negative, result.positive]) {
    assert.ok(pulse.above > 0 && pulse.below > 0, '瞬态应在对应时刻画成一根对称柱');
    assert.ok(Math.abs(pulse.above - pulse.below) < pulse.above * 0.05, '柱体上下高度不对称');
  }
  assert.ok(result.centerCoverage > 0.60 && result.centerCoverage < 0.74, '波形柱之间应有均匀留白');
  assert.equal(result.grid.match(/linear-gradient/g)?.length, 2, '波形背景应有横纵网格');
}

// 先通过开发版导入，第二次从指定的实际成品打开同一份测试用户目录。
async function openSettings(executablePath) {
  console.log(executablePath ? '音效验收：从成品重新打开原用户目录' : '音效验收：启动隔离的源码应用');
  application = await electron.launch({
    ...(executablePath ? { executablePath, args: [], cwd: temp } : { args: [root], cwd: root }),
    env, timeout: 30000,
  });
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
  await page.waitForFunction(() => document.querySelector('#event-audio-press option'));
  assert.equal(await page.locator('#sound-library-list li').count(), 0, '折叠的音效库不需要建行');
}

// 折叠与展开共用同一条中线和文字间距，内置原声只提供试听，修改操作属于导入的片段。
async function verifyCatalog(importedCount) {
  const summary = page.locator('#sound-catalog summary');
  await page.waitForFunction((count) => document.querySelector('#sound-library-count').textContent ===
    `9 段内置 · ${count} 段导入`, importedCount);
  for (const expanded of [false, true]) {
    if (expanded) await summary.press('Enter');
    const geometry = await summary.evaluate((element) => {
      const arrow = element.querySelector('.sound-catalog-marker')?.getBoundingClientRect();
      const label = element.querySelector('.sound-catalog-label')?.getBoundingClientRect();
      const count = element.querySelector('#sound-library-count').getBoundingClientRect();
      if (!arrow || !label) return null;
      const center = (rect) => rect.top + rect.height / 2;
      return { expanded: element.parentElement.open, gap: label.left - arrow.right,
        arrowOffset: center(arrow) - center(label), countOffset: center(count) - center(label) };
    });
    assert.ok(geometry, '展开箭头和文字缺少独立的对齐区域');
    assert.equal(geometry.expanded, expanded);
    assert.ok(geometry.gap >= 6 && geometry.gap <= 10, '展开箭头与标题之间应有适度间距');
    assert.ok(Math.abs(geometry.arrowOffset) <= .5 && Math.abs(geometry.countOffset) <= .5, '箭头、标题和数量没有垂直居中');
  }
  await page.waitForFunction((n) => document.querySelectorAll('#sound-library-list li').length === n, AUDIO_FILES.length + importedCount);
  const actions = await page.locator('#sound-library-list li').evaluateAll((rows) =>
    Object.fromEntries(rows.map(row => [row.dataset.clipId, [...row.querySelectorAll('button')].map(button => button.textContent)])));
  for (const { id } of AUDIO_FILES) {
    assert.deepEqual(actions[id], ['试听'], id + ' 内置原声应只显示试听');
    await assert.rejects(page.evaluate((id) => window.dragonGirl.command('remove-audio-clip', id), id), /找不到要移除的音效/);
  }
  for (const [id, labels] of Object.entries(actions)) {
    if (id.startsWith('clip-')) assert.deepEqual(labels, ['试听', '裁剪', '重命名', '移除']);
  }
  // 从原声列表播放并当场停止，确保只读条目仍是可操作的试听入口。
  const listen = page.locator('li[data-clip-id="end_a"] button');
  await listen.click();
  assert.equal(await listen.getAttribute('aria-pressed'), 'true');
  await listen.click();
  assert.equal(await listen.getAttribute('aria-pressed'), 'false');
  await summary.press('Space');
  await page.waitForFunction(() => !document.querySelector('#sound-catalog').open && !document.querySelector('#sound-library-list li'));
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
  const original = path.join(temp, '三分钟录音.wav');
  await writeLongSource(original);
  await openSettings();
  await verifyCatalog(0);
  console.log('音效验收：开始导入三分钟录音');
  assert.equal(await page.locator('#event-audio-press').inputValue(), 'd1');
  assert.equal(await page.locator('#event-audio-release').inputValue(), 'd2');
  assert.equal(await page.locator('select[name="soundTheme"]').count(), 0);

  // 默认显示全曲并选中整首，右上角正常显示三分钟时长。
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入音效', exact: true }).click();
  await (await chooser).setFiles(original);
  await page.locator('#audio-wave[data-ready=true]').waitFor();
  const editor = page.locator('#audio-editor'), length = page.locator('#audio-selection-length');
  const ruler = editor.locator('.wave-ruler span');
  assert.deepEqual(await ruler.allTextContents(), ['0.000 s', '90.000 s', '180.000 s']);
  assert.equal(await length.textContent(), '已选 180.000 秒');
  assert.equal(await length.getAttribute('data-error'), 'false');
  await verifyWaveform();
  assert.equal(await editor.locator('input[type=range], #audio-source-name, #audio-editor-message').count(), 0);
  assert.doesNotMatch(await editor.innerText(), /拖动波形选取片段|片段最长|三分钟录音\.wav/);
  await page.locator('#audio-save').click();
  await page.waitForFunction(() => !document.querySelector('#audio-editor').open ||
    document.querySelector('#audio-selection-length').dataset.error === 'true');
  assert.equal(await editor.isVisible(), false, await length.textContent());
  const longRow = page.locator('#sound-library-list li').filter({ hasText: '三分钟录音' });
  const longId = await longRow.getAttribute('data-clip-id');
  const libraryDirectory = path.join(data, 'sound-library');
  const longFile = path.join(libraryDirectory, longId, 'clip.wav');
  assert.equal((await fs.stat(longFile)).size, 44 + 180 * 48000 * 4);
  // 使用真实导入通道中断第二块，确认磁盘回滚且前一次完成的导入仍在。
  const headerFile = await fs.open(longFile);
  const header = Buffer.alloc(44);
  try { await headerFile.read(header, 0, header.length, 0); }
  finally { await headerFile.close(); }
  await assert.rejects(page.evaluate((bytes) => {
    let sent = false;
    return window.dragonGirl.importAudioClip('中断验证', () => {
      if (sent) throw new Error('读取中断');
      sent = true;
      return Uint8Array.from(bytes);
    });
  }, [...header]), /读取中断/);
  const deadline = Date.now() + 5000;
  while ((await fs.readdir(libraryDirectory)).some((name) => name.startsWith('.import-'))) {
    assert.ok(Date.now() < deadline, '导入中断后仍有临时音效文件');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // 长片段的试听可以当场停止，离开声音页时也会停止。
  const listen = longRow.getByRole('button', { name: /试听/ });
  await listen.click();
  assert.equal(await listen.getAttribute('aria-pressed'), 'true');
  await listen.click();
  assert.equal(await listen.getAttribute('aria-pressed'), 'false');
  await listen.click();
  await page.locator('[data-settings-tab="data"]').click();
  assert.equal(await longRow.locator('button[aria-pressed]').getAttribute('aria-pressed'), 'false');
  await page.locator('[data-settings-tab="sound"]').click();

  // 再次裁剪可拖选、移动手柄、输入起止时间；长选区保持有效，越界才提示。
  await longRow.getByRole('button', { name: /裁剪/ }).click();
  await page.locator('#audio-wave[data-ready=true]').waitFor();
  const wave = await page.locator('#audio-wave').boundingBox();
  // 在全曲中部试听，核对高亮选区和播放线使用的起止时间与实际波形一致。
  await page.locator('#audio-start').fill('47');
  await page.locator('#audio-end').fill('60.146');
  assert.equal(await length.textContent(), '已选 13.146 秒');
  const selected = await editor.locator('.wave-selection').boundingBox();
  assert.ok(Math.abs(selected.x - wave.x - wave.width * 47 / 180) < 1);
  assert.ok(Math.abs(selected.width - wave.width * 13.146 / 180) < 1);
  // 在相同强度的两段读取柱体颜色，确认紫色只随选区着色。
  const [inside, outside] = await page.locator('#audio-wave canvas').evaluate((canvas) => {
    const context = canvas.getContext('2d');
    return [54, 62].map((seconds) => {
      const x = Math.floor(canvas.width * seconds / 180), width = Math.ceil(3 * canvas.width / canvas.clientWidth);
      const { data } = context.getImageData(x, Math.floor(canvas.height / 2), width, 1);
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] >= 240) return [...data.slice(i, i + 3)];
      throw new Error('未在选区对照位置找到柱体');
    });
  });
  assert.ok(inside[2] - inside[1] > 35 && outside[2] - outside[1] < 25 && inside[1] < outside[1],
    '选区内应为紫色柱，选区外应为灰色柱');
  await page.locator('#audio-preview').click();
  await editor.locator('.wave-playhead').waitFor({ state: 'visible' });
  const playing = await editor.locator('.wave-playhead').boundingBox();
  assert.ok(playing.x >= selected.x - 1 && playing.x < selected.x + selected.width);
  await page.locator('#audio-preview').click();
  await page.mouse.move(wave.x + wave.width * 0.1, wave.y + 16);
  await page.mouse.down();
  await page.mouse.move(wave.x + wave.width * 0.8, wave.y + 25, { steps: 7 });
  await page.mouse.up();
  const start = Number(await page.locator('#audio-start').inputValue());
  assert.ok(Math.abs(start - 18) < 0.5);
  assert.equal(await page.locator('#audio-save').isEnabled(), true);
  assert.equal(await length.getAttribute('data-error'), 'false');
  await page.locator('[data-edge=start]').focus();
  await page.keyboard.press('ArrowRight');
  assert.ok(Number(await page.locator('#audio-start').inputValue()) > start);
  await page.locator('#audio-start').fill('0.125');
  await page.locator('#audio-end').fill('181');
  assert.equal(await length.getAttribute('data-error'), 'true');
  assert.equal(await page.locator('#audio-save').isDisabled(), true);
  assert.equal(await page.locator('#audio-preview').isDisabled(), true);
  await page.locator('#audio-end').fill('0.825');
  assert.deepEqual(await ruler.allTextContents(), ['0.000 s', '90.000 s', '180.000 s']);
  assert.equal(await length.textContent(), '已选 0.700 秒');
  // 全曲视图里极短的选区也需要两个独立的拖动目标。
  for (const handle of await editor.locator('.wave-handle').all()) {
    assert.ok(await handle.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element;
    }), '短选区的把手互相遮挡');
  }
  await page.locator('#audio-clip-name').fill('轻声提醒');
  await page.locator('#audio-preview').click();
  await page.locator('.wave-playhead').waitFor({ state: 'visible' });
  await page.locator('#audio-preview').click();
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
  await choose('complete', longId);
  await saveSettings();
  // 清空已经预热的真实角色缓存，修复通知应让角色立即重新核对并解码。
  const firstCharacter = application.windows().find((window) => window.url().endsWith('/character.html'));
  await firstCharacter.waitForFunction((id) => window.__soundEngine.buffers.has(id), id);
  await firstCharacter.evaluate(() => window.__soundEngine.buffers.clear());
  await page.locator('#install-audio').click();
  await page.waitForFunction(() => document.querySelector('#audio-library-status').textContent.includes('本机原声音效已就绪'));
  await firstCharacter.waitForFunction((ids) => ids.every((id) => window.__soundEngine.buffers.has(id)), [id, ...AUDIO_FILES.map((clip) => clip.id)]);
  assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), digest);
  await fs.unlink(original);
  await application.close();
  application = null;
  console.log('音效验收：已校验分块导入、试听、修复和裁剪结果');

  // 重启并切到成品程序，源文件已移走，原声已修复，事件分配仍指向同一 WAV。
  await openSettings(process.env.DRAGONGIRL_TEST_EXECUTABLE);
  await verifyCatalog(2);
  assert.equal(await page.locator('#event-audio-press').inputValue(), id);
  assert.equal(await page.locator('#event-audio-release').inputValue(), 'exp_orb');
  assert.equal(await page.locator('#event-audio-question option:checked').textContent(), '轻声');
  assert.equal(await page.locator('#event-audio-complete').inputValue(), longId);
  await page.locator('#sound-catalog summary').click();
  await page.locator(`li[data-clip-id="${longId}"]`).getByRole('button', { name: /裁剪/ }).click();
  await page.locator('#audio-wave[data-ready=true]').waitFor();
  assert.equal(await page.locator('#audio-selection-length').textContent(), '已选 180.000 秒');
  await verifyWaveform();
  await page.locator('#audio-cancel').click();
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
  // 用实际事件播放器离线渲染完整三分钟，核对原先 15 秒界限之后直到结尾仍有声音。
  const full = await character.evaluate(async (id) => {
    const { SoundEngine } = await import('./audio.js');
    const settings = window.__soundEngine.settings;
    const context = new OfflineAudioContext(1, 180 * 8000 + 128, 8000);
    const player = new SoundEngine({ createContext: () => context });
    player.settings = settings;
    const live = await window.__soundEngine.play('complete');
    player.buffers.set(id, live.node.buffer);
    window.__soundEngine.stop();
    const voice = await player.play('complete');
    const samples = (await context.startRendering()).getChannelData(0);
    return { id: voice.id, duration: voice.endsAt - voice.startsAt,
      tail: samples.subarray(178 * 8000, 180 * 8000).some((value) => Math.abs(value) > 0.001) };
  }, longId);
  assert.equal(full.id, longId);
  assert.ok(Math.abs(full.duration - 180) < 0.001);
  assert.ok(full.tail, '三分钟事件音效没有播放到末尾');
  await assert.rejects(page.evaluate((id) => window.dragonGirl.command('remove-audio-clip', id), id), /正在使用/);

  // 库内有滚动条时，内置与导入行的首个按钮仍与卡片操作及总音量从同一列开始。
  for (const width of [880, 1160]) {
    await application.evaluate((_, width) => globalThis.__dragonGirlApp.dashboard.window.setContentSize(width, 750), width);
    await page.waitForFunction((width) => Math.abs(window.innerWidth - width) < 4, width);
    const aligned = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
      const master = rect('#sound-volume'), text = rect('#audio-library-status');
      const controls = ['#import-audio', '#install-audio', 'li[data-clip-id="ya1"] button', 'li[data-clip-id^="clip-"] button'];
      return controls.every((selector) => Math.abs(rect(selector).left - master.left) < 1)
        && rect('#install-audio').left - text.right >= 20;
    });
    assert.ok(aligned, '音效库的操作按钮未对齐或与说明挤在一起');
  }
  await page.locator('#import-audio').scrollIntoViewIfNeeded();
  await page.locator('#import-audio').locator('xpath=ancestor::article').screenshot({ path: path.join(root, '.artifacts/sound-library.png') });
  // 用已导入的短片段截取预览，检查竖条、网格和选区的整体效果。
  await page.locator(`li[data-clip-id="${id}"]`).getByRole('button', { name: /裁剪/ }).click();
  await page.locator('#audio-wave[data-ready=true]').waitFor();
  await page.locator('#audio-start').fill('0.160');
  await page.locator('#audio-end').fill('0.540');
  await page.locator('.wave-heading > span').click();
  await page.locator('#audio-editor').screenshot({ path: path.join(root, '.artifacts/audio-editor.png') });
  await page.locator('#audio-wave').screenshot({ path: path.join(root, '.artifacts/audio-waveform-preview.png') });
  await page.locator('#audio-cancel').click();
  assert.deepEqual(errors, []);
  console.log('音效库验收通过：三分钟整曲导入和播至末尾、全曲视图、精确裁剪、试听、重启恢复与宽窄布局。');
} finally {
  await application?.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
