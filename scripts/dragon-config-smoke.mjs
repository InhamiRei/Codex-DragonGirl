import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { DEFAULT_CHARACTER_ASSET, MARO_ASSET } from '../src/shared/characters.js';
import { readReleaseVersion } from './release-payload.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-dragon-config-'));
const data = path.join(temporary, 'data');
const home = path.join(temporary, 'home');
const errors = [];
let application;

// 窗口可能在 Electron 握手前就创建，按实际页面地址等待加载。
async function waitForWindow(name) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const page = application.windows().find((window) => window.url().endsWith('/' + name));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('窗口未加载：' + name);
}

// 源码和签名包都使用真实桌面入口，设置和账号数据写到隔离目录。
async function boot() {
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1',
    DRAGONGIRL_DATA_DIR: data, DRAGONGIRL_FIXTURE_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [root], env, timeout: 30000 });
  const [dashboard, pet] = await Promise.all(['dashboard.html', 'character.html'].map(waitForWindow));
  for (const page of [dashboard, pet]) {
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
  }
  await pet.emulateMedia({ reducedMotion: 'no-preference' });
  return { dashboard, pet };
}

// 确认桌宠加载的是实际原图，而不是旧配置中的派生立绘。
async function waitForPortrait(page, asset, width = 1330) {
  await page.waitForFunction(({ asset, width }) => {
    const image = document.getElementById('portrait');
    return image.src === asset && image.complete && image.naturalWidth === width;
  }, { asset, width });
}

// 用完整像素签名核对原画，包括半透明发梢和衣服轮廓。
async function portraitDigest(locator) {
  return locator.evaluate(async (source) => {
    const { width, height } = source instanceof HTMLCanvasElement
      ? source : { width: source.naturalWidth, height: source.naturalHeight };
    const surface = new OffscreenCanvas(width, height);
    const context = surface.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))];
  });
}

// 用虹膜内部的取样点确认桌宠和配置页应用同一个颜色。
async function irisColor(locator) {
  return locator.evaluate((source) => {
    const context = new OffscreenCanvas(1, 1).getContext('2d');
    context.drawImage(source, 838, 771, 1, 1, 0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  });
}

// 分别检查固定装备和瞳孔的选项数量及排列顺序。
async function openGearOptions(page, id, ...names) {
  const slot = page.locator('.dragon-slot[data-slot="' + id + '"]');
  if (await slot.getAttribute('aria-expanded') !== 'true') await slot.click();
  const options = page.locator('#dragon-gear-options');
  await options.waitFor({ state: 'visible' });
  assert.deepEqual(await options.locator('.dragon-gear-option').allTextContents(), names);
  assert.equal(await page.locator('.dragon-slot[aria-expanded="true"]').count(), 1);
  return options;
}

// 以原图坐标检查四条线的起点和终点，窗口缩放后也要指向同一部件。
async function waitForGearLinks(page) {
  await page.waitForFunction(() => {
    const preview = document.querySelector('#dragon-config-portrait');
    const portrait = preview.getBoundingClientRect();
    const scale = portrait.width / preview.width;
    const targets = { horns: [255, 296], eyes: [420, 746], hairpin: [1180, 574], clothes: [918, 1138] };
    const cards = [...document.querySelectorAll('.dragon-slot')];
    return cards.length === 4 && cards.every((card) => {
      const [x, y] = targets[card.dataset.slot];
      const box = card.getBoundingClientRect();
      const link = card.querySelector('.dragon-slot-link');
      const origin = link.getBoundingClientRect();
      const tip = link.querySelector('circle').getBoundingClientRect();
      const edge = box.right < portrait.left ? box.right : box.left;
      return Math.abs(origin.left - edge) <= 1
        && Math.abs(origin.top - (box.top + box.height / 2)) < 1
        && Math.abs(tip.left + tip.width / 2 - (portrait.left + x * scale)) < 1
        && Math.abs(tip.top + tip.height / 2 - (portrait.top + y * scale)) < 1;
    });
  });
}

// 额度、用量等重复推送不能重写已经显示的配置控件。
async function verifyStableGear(page) {
  await page.evaluate(() => {
    const audit = window.__gearAudit = { pushed: 0, mutations: 0 };
    const observer = new MutationObserver((records) => { audit.mutations += records.length; });
    observer.observe(document.querySelector('#dragon-config'), { subtree: true, attributes: true, childList: true });
    window.dragonGirl.onMonitor(() => audit.pushed++);
  });
  await application.evaluate(() => {
    const { monitor } = globalThis.__dragonGirlApp;
    for (let index = 0; index < 10; index++) monitor.emit('update', monitor.snapshot());
  });
  await page.waitForFunction(() => window.__gearAudit.pushed >= 10);
  assert.equal(await page.evaluate(() => window.__gearAudit.mutations), 0);
}

try {
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.mkdir(data);
  // 使用已保存的旧版发型配置启动，验证只迁移保留的瞳色和其他偏好。
  const settingsFile = path.join(data, 'settings.json');
  const retiredSettings = { dragonHairId: 'half-up', dragonFrontHairId: 'high-ponytail',
    dragonBackHairId: 'side-braid', dragonHornsVisible: false };
  await fs.writeFile(settingsFile, JSON.stringify({ mode: 'desktop', soundEnabled: false, motion: false,
    blinkEnabled: false, eyeTracking: false, dragonEyeId: 'green', ...retiredSettings }));
  const version = await readReleaseVersion(root);
  let { dashboard, pet } = await boot();
  await dashboard.waitForFunction((version) => document.querySelector('.brand #app-version').textContent === 'v' + version, version);
  const oldSettings = await dashboard.evaluate(async () => (await window.dragonGirl.command('snapshot')).settings);
  for (const key of Object.keys(retiredSettings)) assert.equal(Object.hasOwn(oldSettings, key), false, key);
  assert.equal(oldSettings.dragonEyeId, 'custom');
  assert.equal(oldSettings.dragonEyeColor, '#73b29c');
  await waitForPortrait(pet, DEFAULT_CHARACTER_ASSET);
  await pet.locator('#dragon-tinted-portrait[data-tone="#73b29c"]').waitFor({ state: 'visible' });

  for (const nav of await dashboard.locator('.main-nav button').all()) {
    await nav.click();
    const brand = await dashboard.locator('.brand-copy').textContent();
    assert.equal(brand.replace(/\s/g, ''), 'GPT龙娘v' + version);
  }
  const config = dashboard.getByRole('button', { name: '龙娘配置', exact: true });
  await config.click();
  assert.equal(await dashboard.locator('#subtitle').textContent(), '个性化你的龙娘');
  assert.deepEqual(await dashboard.locator('#dragon-equipment-left .dragon-slot').allTextContents(), ['龙角', '瞳孔']);
  assert.deepEqual(await dashboard.locator('#dragon-equipment-right .dragon-slot').allTextContents(), ['发饰', '服饰']);
  assert.equal(await dashboard.locator('button.dragon-slot').count(), 4);
  await openGearOptions(dashboard, 'hairpin', 'GPT发饰');
  await openGearOptions(dashboard, 'clothes', 'GPT白衣');
  await openGearOptions(dashboard, 'horns', 'GPT龙角');
  const preview = dashboard.locator('#dragon-config-portrait');
  const options = await openGearOptions(dashboard, 'eyes', 'GPT紫瞳', '自选瞳色');
  const preset = options.getByRole('button', { name: 'GPT紫瞳', exact: true });
  const picker = options.locator('.dragon-color-picker');
  const idleOptions = dashboard.locator('#dragon-gear-options:not([aria-busy])');
  const toast = dashboard.locator('#toast');
  assert.equal(await preset.getAttribute('aria-pressed'), 'false');
  assert.equal(await picker.getAttribute('data-selected'), '');
  await preset.click();
  await dashboard.locator('#dragon-config-portrait[data-tone="original"]').waitFor({ state: 'visible' });
  await pet.locator('#dragon-tinted-portrait').waitFor({ state: 'detached' });
  // 恢复原色和收起选项时，只更新配置页里的状态。
  await idleOptions.waitFor({ state: 'visible' });
  assert.equal(await toast.isHidden(), true);
  assert.equal(await preset.getAttribute('aria-pressed'), 'true');
  assert.equal(await picker.getAttribute('data-selected'), null);
  const original = pet.locator('#portrait');
  assert.equal(await original.evaluate((image) => getComputedStyle(image).opacity), '1');
  assert.deepEqual(await portraitDigest(preview), await portraitDigest(original));
  assert.equal(await preview.evaluate((canvas) => getComputedStyle(canvas).filter.startsWith('drop-shadow(')
    && getComputedStyle(canvas.parentElement, '::before').content === 'none'
    && getComputedStyle(canvas.parentElement, '::after').content === 'none'), true);
  await dashboard.locator('.dragon-slot[data-slot="eyes"]').click();
  assert.equal(await options.isHidden(), true);
  assert.equal(await toast.isHidden(), true);
  await dashboard.waitForFunction(() => [...document.querySelectorAll('.dragon-slot img')]
    .every((image) => image.complete && image.naturalWidth === 192 && image.naturalHeight === 192));

  // 把窗口缩到最小再检查两列卡片，以及中间完整立绘的对齐。
  const window = await application.browserWindow(dashboard);
  await window.evaluate((dashboardWindow) => dashboardWindow.setSize(880, 660));
  await dashboard.waitForFunction(() => innerWidth < 900);
  assert.equal(await dashboard.locator('.dragon-wardrobe').evaluate((wardrobe) => {
    const [left, image, right] = [...wardrobe.children].map((element) => element.getBoundingClientRect());
    const [topLeft, bottomLeft, topRight, bottomRight] = [...wardrobe.querySelectorAll('.dragon-slot')]
      .map((element) => element.getBoundingClientRect());
    return left.right < image.left && image.right < right.left && Math.abs(left.top - right.top) < 1
      && Math.abs(topLeft.top - topRight.top) < 1 && Math.abs(bottomLeft.bottom - bottomRight.bottom) < 1
      && topLeft.top < image.top + 24 && bottomLeft.bottom > image.bottom - 24
      && bottomLeft.top - topLeft.bottom > 40
      && wardrobe.scrollWidth <= wardrobe.clientWidth;
  }), true);
  await waitForGearLinks(dashboard);
  await window.evaluate((dashboardWindow) => dashboardWindow.setSize(1160, 820));
  await dashboard.waitForFunction(() => innerWidth > 1100);
  await waitForGearLinks(dashboard);
  const artifacts = path.join(root, '.artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  await dashboard.screenshot({ path: path.join(artifacts, 'dragon-config.png'), animations: 'disabled' });

  // 悬停的服饰卡整块填色，展开的选项与立绘留出间距。
  await window.evaluate((dashboardWindow) => dashboardWindow.focus());
  await dashboard.waitForFunction(() => document.hasFocus());
  await dashboard.getByRole('button', { name: '服饰', exact: true }).hover();
  await dashboard.waitForFunction(() => {
    const card = document.querySelector('.dragon-slot[data-slot="clothes"]');
    const style = getComputedStyle(card);
    return card.matches(':hover') && card.getAttribute('aria-expanded') === 'false'
      && style.backgroundColor === 'rgb(238, 229, 249)' && style.backgroundImage === 'none'
      && !style.boxShadow.includes('inset');
  });
  await openGearOptions(dashboard, 'clothes', 'GPT白衣');
  const gap = await options.locator('.dragon-gear-option').evaluate((option) => option.getBoundingClientRect().top
    - document.querySelector('#dragon-config-portrait').getBoundingClientRect().bottom);
  assert.ok(gap >= 50, `选项与立绘的间距为 ${gap} 像素`);

  // 选色拖动只更改配置页预览，提交后同步桌宠、保存设置并保留原画地址。
  await openGearOptions(dashboard, 'eyes', 'GPT紫瞳', '自选瞳色');
  const presetBox = await preset.boundingBox();
  const pickerBox = await picker.boundingBox();
  assert.ok(presetBox.x + presetBox.width < pickerBox.x && presetBox.y === pickerBox.y);
  await dashboard.screenshot({ path: path.join(artifacts, 'dragon-config-options.png'), animations: 'disabled' });
  await verifyStableGear(dashboard);
  const colorInput = picker.getByLabel('自选瞳色', { exact: true });
  await colorInput.scrollIntoViewIfNeeded();
  assert.equal(await colorInput.evaluate((input) => {
    const box = input.parentElement.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.bottom - 8) === input;
  }), true);
  const custom = '#e14b58';
  const customPreview = '#dragon-config-portrait[data-tone="' + custom + '"]';
  const tinted = '#dragon-tinted-portrait[data-tone="' + custom + '"]';
  const purple = await irisColor(original);
  await colorInput.evaluate((input, color) => {
    input.value = color;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, custom);
  await dashboard.locator(customPreview).waitFor({ state: 'visible' });
  assert.deepEqual(await irisColor(original), purple);
  assert.equal(await pet.locator('#dragon-tinted-portrait').count(), 0);
  // 用量索引维持原来的采集计时器，瞳色走独立的写入路径。
  await application.evaluate(() => {
    const { monitor } = globalThis.__dragonGirlApp;
    globalThis.__scanTimerBeforeEyeSave = monitor.scanTimer;
  });
  await colorInput.dispatchEvent('change');
  await pet.locator(tinted).waitFor({ state: 'visible' });
  await idleOptions.waitFor({ state: 'visible' });
  assert.equal(await toast.isHidden(), true);
  assert.equal(await application.evaluate(() => globalThis.__dragonGirlApp.monitor.scanTimer
    === globalThis.__scanTimerBeforeEyeSave), true);
  assert.equal(await picker.getAttribute('data-selected'), '');
  assert.deepEqual(await irisColor(preview), await irisColor(pet.locator(tinted)));
  assert.notDeepEqual(await irisColor(preview), purple);
  for (const [slotId, itemId] of [['front-hair', 'half-up'], ['back-hair', 'high-ponytail'], ['hairpin', 'hide'], ['horns', 'hide']]) {
    await assert.rejects(dashboard.evaluate((selection) => window.dragonGirl.command('dragon-equipment', selection),
      { slotId, itemId }), /找不到可切换的龙娘装备/);
  }

  // 合掌沿用原画动作素材，切到麻吕时保留龙娘的已存瞳色。
  await application.evaluate(() => globalThis.__dragonGirlTest.showExpression('prayer', { preview: true }));
  await pet.locator('#prayer-portrait').waitFor({ state: 'visible' });
  assert.equal(await pet.locator('#prayer-hands').isVisible(), true);
  await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.selectCharacter('maro'));
  await waitForPortrait(pet, MARO_ASSET, 1254);
  await dashboard.locator('#dragon-config-inactive').waitFor({ state: 'visible' });
  await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.selectCharacter('dragon'));
  await waitForPortrait(pet, DEFAULT_CHARACTER_ASSET);
  await pet.locator(tinted).waitFor({ state: 'visible' });
  await application.close();
  application = null;

  // 真正重启后仍保持原图和自选色，重新写出的设置里没有旧发型字段。
  const persisted = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(persisted.dragonEyeColor, custom);
  for (const key of Object.keys(retiredSettings)) assert.equal(Object.hasOwn(persisted, key), false, key);
  ({ dashboard, pet } = await boot());
  await waitForPortrait(pet, DEFAULT_CHARACTER_ASSET);
  await pet.locator(tinted).waitFor({ state: 'visible' });
  await dashboard.getByRole('button', { name: '龙娘配置', exact: true }).click();
  await dashboard.locator(customPreview).waitFor({ state: 'visible' });
  const reopenedOptions = await openGearOptions(dashboard, 'eyes', 'GPT紫瞳', '自选瞳色');
  assert.equal(await reopenedOptions.getByLabel('自选瞳色', { exact: true }).inputValue(), custom);
  assert.equal(await reopenedOptions.locator('.dragon-color-picker').getAttribute('data-selected'), '');
  assert.deepEqual(errors, []);
  console.log('龙娘配置验证通过：v' + version + '、四角连线、原画像素一致、独立选色与恢复、原版合掌。');
} finally {
  if (application) await application.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
