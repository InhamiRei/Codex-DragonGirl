import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { DEFAULT_CHARACTER_ASSET, KOKKORO_ASSET, MARO_ASSET } from '../src/shared/characters.js';
import { DRAGON_HAIRSTYLES } from '../src/shared/dragon-gear.js';
import { prepareHairstyleActions, verifyHairstyleActions } from './dragon-hairstyle-actions.mjs';
import {
  captureFixedPortrait, verifyFixedPortrait, verifyRightPonytail, verifyStraightBangsPortrait,
} from './dragon-hairstyle-pixels.mjs';
import { readReleaseVersion } from './release-payload.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const hairstyleNames = DRAGON_HAIRSTYLES.map(({ name }) => name);
// 散发与单马尾已有独立的初始切换和保存检查，其余款式共用逐款验收。
const additionalHairstyles = DRAGON_HAIRSTYLES.filter(({ id }) => id !== 'loose' && id !== 'ponytail');
const ponytailAsset = 'dragon://app/assets/characters/codex-dragon-girl-ponytail.png';
// 固定部件应各有原版缩略图，连线和预览尺寸按两个角色的原图验证。
const originalCompanions = [
  { id: 'maro', name: '麻吕', asset: MARO_ASSET, size: [1254, 1254], parts: {
    tuft: ['翘发', [278, 152]], eyes: ['瞳孔', [440, 620]], hair: ['发型', [843, 272]], clothes: ['服饰', [686, 932]],
  } },
  { id: 'kokkoro', name: '可可萝', asset: KOKKORO_ASSET, size: [1299, 1211], parts: {
    hat: ['兔帽', [309, 275]], eyes: ['瞳孔', [393, 734]], accessory: ['发饰', [1012, 680]], clothes: ['服饰', [641, 1174]],
  } },
];
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

// 等待相应发型实际提交，同时确认角色原生画幅。
async function waitForPortrait(page, asset, width = 1330) {
  await page.waitForFunction(({ asset, width }) => {
    const image = document.getElementById('portrait');
    return image?.dataset.asset === asset && (image.naturalWidth ?? image.width) === width;
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

// 逐张点击缩略图，核对配置页和桌宠显示同一幅画面，并与散发比对固定部位。
async function verifyAdditionalHairstyles(dashboard, pet, options, tone) {
  const artwork = pet.locator(tone === 'original' ? '#portrait[data-tone="original"]' : '#portrait[data-tone="' + tone + '"]');
  const pixels = {};
  for (const { id, name, image } of additionalHairstyles) {
    await options.getByRole('button', { name, exact: true }).click();
    const preview = dashboard.locator('#dragon-config-portrait[data-hairstyle="' + id + '"][data-tone="' + tone + '"]');
    await preview.waitFor({ state: 'visible' });
    await waitForPortrait(pet, 'dragon://app/' + image);
    assert.deepEqual(await portraitDigest(preview), await portraitDigest(artwork), name + '在桌宠与配置页的画面不一致');
    pixels[id] = id === 'straight-bangs' ? await verifyStraightBangsPortrait(preview) : await verifyFixedPortrait(preview);
  }
  return pixels;
}

// 分别检查固定装备、发型和瞳孔的选项数量及排列顺序。
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
async function waitForGearLinks(page, targets = { horns: [385, 235], eyes: [420, 746], hair: [1001, 444], clothes: [780, 1130] }) {
  await page.waitForFunction((anchors) => {
    const preview = document.querySelector('#dragon-config-portrait');
    const portrait = preview.getBoundingClientRect();
    const scale = portrait.width / preview.width;
    const cards = [...document.querySelectorAll('.dragon-slot')];
    return cards.length === 4 && cards.every((card) => {
      const target = anchors[card.dataset.slot];
      if (!target) return false;
      const [x, y] = target;
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
  }, targets);
}

// 从陪伴配置切换桌宠，核对原画、菜单和每张部件卡的单项展开。
async function verifyOriginalCompanion(page, pet, { id, name, asset, size, parts }) {
  const chooser = page.getByRole('group', { name: '切换桌面角色' });
  const selected = chooser.getByRole('button', { name, exact: true });
  await selected.click();
  const preview = page.locator('#dragon-config-portrait[data-asset="' + asset + '"]');
  await preview.waitFor({ state: 'visible' });
  await waitForPortrait(pet, asset, size[0]);
  assert.deepEqual(await preview.evaluate((canvas) => [canvas.width, canvas.height]), size);
  assert.equal(await preview.getAttribute('aria-label'), name + '外观预览');
  assert.deepEqual(await portraitDigest(preview), await portraitDigest(pet.locator('#portrait')));
  assert.equal(await selected.getAttribute('aria-pressed'), 'true');
  assert.equal(await chooser.locator('button[aria-pressed="true"]').count(), 1);
  assert.equal(await page.locator('#character-id').inputValue(), id);
  assert.deepEqual(await page.locator('.dragon-slot').allTextContents(), Object.values(parts).map(([label]) => label));
  await waitForGearLinks(page, Object.fromEntries(Object.entries(parts).map(([slot, [, target]]) => [slot, target])));
  const checked = await application.evaluate(() => globalThis.__dragonGirlTest.characterMenuItems()
    .find(({ checked }) => checked)?.label);
  assert.equal(checked, name);
  assert.equal(await page.locator('#dragon-gear-options').isHidden(), true);
  for (const [slot, [label]] of Object.entries(parts)) {
    // 核对卡片读取独立的方形缩略图，画布四角保留透明。
    const icon = page.locator('.dragon-slot[data-slot="' + slot + '"] img');
    const source = 'dragon://app/assets/characters/' + id + '/gear/' + slot + '.webp';
    assert.equal(await icon.evaluate(async (image, source) => {
      await image.decode();
      if (image.src !== source || image.naturalWidth !== 192 || image.naturalHeight !== 192) return false;
      const canvas = new OffscreenCanvas(192, 192);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return [[0, 0], [191, 0], [0, 191], [191, 191]].every(([x, y]) =>
        context.getImageData(x, y, 1, 1).data[3] === 0);
    }, source), true, name + '的' + label + '缺少独立透明缩略图');
    const options = await openGearOptions(page, slot, '原版' + label);
    assert.equal(await options.locator('div.dragon-gear-option[data-selected]').count(), 1);
    assert.equal(await options.locator('button, input, select').count(), 0);
    // 展开后的原版卡加载与分类卡相同的图片。
    assert.equal(await options.locator('img').evaluate(async (image) => {
      await image.decode();
      return image.src;
    }), source);
    await page.locator('.dragon-slot[data-slot="' + slot + '"]').click();
    assert.equal(await options.isHidden(), true);
  }
}

// 额度、用量等重复推送不能重写已经显示的配置控件。
async function verifyStableGear(page) {
  await page.evaluate(() => {
    const audit = window.__gearAudit = { pushed: 0, mutations: 0 };
    const observer = new MutationObserver((records) => { audit.mutations += records.length; });
    observer.observe(document.querySelector('#dragon-config'), { subtree: true, attributes: true, childList: true });
    const unsubscribe = window.dragonGirl.onMonitor(() => audit.pushed++);
    // 每次验收结束后释放观察器，瞳色和发型各自统计新的推送。
    audit.stop = () => {
      observer.disconnect();
      unsubscribe();
      delete window.__gearAudit;
    };
  });
  try {
    await application.evaluate(() => {
      const { monitor } = globalThis.__dragonGirlApp;
      for (let index = 0; index < 10; index++) monitor.emit('update', monitor.snapshot());
    });
    await page.waitForFunction(() => window.__gearAudit.pushed >= 10);
    assert.equal(await page.evaluate(() => window.__gearAudit.mutations), 0);
  } finally {
    await page.evaluate(() => window.__gearAudit.stop());
  }
}

// 暂停一次真实保存，逐张检查等待期间的透明度和键盘焦点。
async function switchHairstyleWithoutFlicker(page, option) {
  const row = page.locator('#dragon-gear-options');
  const idleOpacity = await row.getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => getComputedStyle(button).opacity));
  await application.evaluate(() => {
    const { dashboard } = globalThis.__dragonGirlApp;
    const select = dashboard.selectDragonGear;
    const save = globalThis.__hairstyleSave = { calls: 0 };
    const gate = new Promise((resolve) => {
      save.release = () => {
        dashboard.selectDragonGear = select;
        resolve();
      };
    });
    dashboard.selectDragonGear = async (selection) => {
      save.calls++;
      await gate;
      return select.call(dashboard, selection);
    };
  });
  try {
    await option.focus();
    await page.keyboard.press('Space');
    await page.locator('#dragon-gear-options[aria-busy="true"]').waitFor({ state: 'visible' });
    const savingOpacity = await row.getByRole('button').evaluateAll((buttons) =>
      buttons.map((button) => getComputedStyle(button).opacity));
    assert.deepEqual(savingOpacity, idleOpacity, '保存时整排发型卡片的透明度不应变化');
    assert.equal(await option.evaluate((button) => button === document.activeElement), true, '保存期间应保留键盘焦点');
    assert.equal(await option.getAttribute('aria-disabled'), 'true');
    // 再触发键盘与点击事件，用同一 IPC 通道确认重复操作没有发出保存请求。
    await page.keyboard.press('Space');
    await option.dispatchEvent('click');
    await page.evaluate(async () => { await window.dragonGirl.command('snapshot'); });
    assert.equal(await application.evaluate(() => globalThis.__hairstyleSave.calls), 1);
  } finally {
    await application.evaluate(() => {
      globalThis.__hairstyleSave.release();
      delete globalThis.__hairstyleSave;
    });
  }
}

try {
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.mkdir(data);
  // 使用已移除的发型及旧版配置启动，确认会回到散发并迁移保留的瞳色。
  const settingsFile = path.join(data, 'settings.json');
  const retiredSettings = { dragonHairId: 'half-up', dragonFrontHairId: 'high-ponytail',
    dragonBackHairId: 'side-braid', dragonHornsVisible: false };
  const fixture = { mode: 'desktop', soundEnabled: false, motion: false, blinkEnabled: false, eyeTracking: false };
  await fs.writeFile(settingsFile, JSON.stringify({
    ...fixture, dragonHairstyleId: 'shoulder-bob', dragonEyeId: 'green', ...retiredSettings,
  }));
  const version = await readReleaseVersion(root);
  let { dashboard, pet } = await boot();
  await dashboard.waitForFunction((version) => document.querySelector('.brand #app-version').textContent === 'v' + version, version);
  const oldSettings = await dashboard.evaluate(async () => (await window.dragonGirl.command('snapshot')).settings);
  for (const key of Object.keys(retiredSettings)) assert.equal(Object.hasOwn(oldSettings, key), false, key);
  assert.equal(oldSettings.dragonEyeId, 'custom');
  assert.equal(oldSettings.dragonEyeColor, '#73b29c');
  assert.equal(oldSettings.dragonHairstyleId, 'loose');
  await waitForPortrait(pet, DEFAULT_CHARACTER_ASSET);
  await pet.locator('#portrait[data-tone="#73b29c"]').waitFor({ state: 'visible' });
  assert.equal(await pet.locator('#portrait-slot > img').count(), 0, '内置龙娘不应再加载一张隐藏底图');

  for (const nav of await dashboard.locator('.main-nav button').all()) {
    await nav.click();
    const brand = await dashboard.locator('.brand-copy').textContent();
    assert.equal(brand.replace(/\s/g, ''), 'GPT龙娘v' + version);
  }
  const config = dashboard.getByRole('button', { name: '陪伴配置', exact: true });
  await config.click();
  assert.equal(await dashboard.locator('#title').textContent(), '陪伴配置');
  const chooser = dashboard.getByRole('group', { name: '切换桌面角色' });
  assert.deepEqual(await chooser.getByRole('button').allTextContents(), ['龙娘', '麻吕', '可可萝']);
  assert.equal(await chooser.getByRole('button', { name: '龙娘', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await dashboard.locator('#dragon-equipment-left .dragon-slot').allTextContents(), ['龙角', '瞳孔']);
  assert.deepEqual(await dashboard.locator('#dragon-equipment-right .dragon-slot').allTextContents(), ['发型', '服饰']);
  assert.equal(await dashboard.locator('button.dragon-slot').count(), 4);
  await openGearOptions(dashboard, 'hair', ...hairstyleNames);
  await dashboard.waitForFunction(() => [...document.querySelectorAll('#dragon-gear-options img')]
    .every((image) => image.complete && image.naturalWidth === 192 && image.naturalHeight === 192));
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
  await pet.locator('#portrait[data-tone^="#"]').waitFor({ state: 'detached' });
  // 恢复原色和收起选项时，只更新配置页里的状态。
  await idleOptions.waitFor({ state: 'visible' });
  assert.equal(await toast.isHidden(), true);
  assert.equal(await preset.getAttribute('aria-pressed'), 'true');
  assert.equal(await picker.getAttribute('data-selected'), null);
  const original = pet.locator('#portrait[data-tone="original"]');
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
  // 发型卡允许换行，最小窗口也要完整可见和可点。
  const compactOptions = await openGearOptions(dashboard, 'hair', ...hairstyleNames);
  assert.ok(await compactOptions.evaluate((row) => {
    const { left, right } = row.getBoundingClientRect();
    return [...row.querySelectorAll('button')].every((button) => {
      const bounds = button.getBoundingClientRect();
      return bounds.left >= left && bounds.right <= right && button.clientWidth >= 48;
    });
  }));
  await dashboard.getByRole('button', { name: '发型', exact: true }).click();
  await waitForGearLinks(dashboard);
  await window.evaluate((dashboardWindow) => dashboardWindow.setSize(1160, 820));
  await dashboard.waitForFunction(() => innerWidth > 1100);
  await waitForGearLinks(dashboard);
  const artifacts = path.join(root, '.artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  await dashboard.screenshot({ path: path.join(artifacts, 'dragon-config.png'), animations: 'disabled' });

  // 先用散发和单马尾核对切换后中央预览和桌宠使用同一张立绘。
  const originalDigest = await portraitDigest(original);
  await openGearOptions(dashboard, 'hair', ...hairstyleNames);
  const loose = options.getByRole('button', { name: '散发', exact: true });
  const ponytail = options.getByRole('button', { name: '单马尾', exact: true });
  const ponytailPreview = dashboard.locator('#dragon-config-portrait[data-hairstyle="ponytail"]');
  assert.equal(await loose.getAttribute('aria-pressed'), 'true');
  await captureFixedPortrait(preview);
  await verifyStableGear(dashboard);
  await switchHairstyleWithoutFlicker(dashboard, ponytail);
  await ponytailPreview.waitFor({ state: 'visible' });
  await waitForPortrait(pet, ponytailAsset);
  await idleOptions.waitFor({ state: 'visible' });
  assert.equal(await ponytail.getAttribute('aria-disabled'), null);
  console.log('发型缩略图通过后台刷新、保存期间透明度、键盘焦点与重复操作验证。');
  assert.equal(await ponytail.getAttribute('aria-pressed'), 'true');
  assert.match(await dashboard.locator('.dragon-slot[data-slot="hair"] img').getAttribute('src'), /hair-ponytail\.webp$/);
  const ponytailDigest = await portraitDigest(original);
  assert.notDeepEqual(ponytailDigest, originalDigest);
  assert.deepEqual(await portraitDigest(ponytailPreview), ponytailDigest);
  const defaultPixels = { ponytail: await verifyRightPonytail(ponytailPreview) };
  await dashboard.screenshot({ path: path.join(artifacts, 'dragon-config-ponytail.png'), animations: 'disabled' });
  Object.assign(defaultPixels, await verifyAdditionalHairstyles(dashboard, pet, options, 'original'));
  await loose.click();
  await dashboard.locator('#dragon-config-portrait[data-hairstyle="loose"]').waitFor({ state: 'visible' });
  await waitForPortrait(pet, DEFAULT_CHARACTER_ASSET);
  assert.deepEqual(await portraitDigest(preview), originalDigest);

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
  const tinted = '#portrait[data-tone="' + custom + '"]';
  const purple = await irisColor(original);
  await colorInput.evaluate((input, color) => {
    input.value = color;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, custom);
  await dashboard.locator(customPreview).waitFor({ state: 'visible' });
  assert.deepEqual(await irisColor(original), purple);
  assert.equal(await pet.locator('#portrait[data-tone^="#"]').count(), 0);
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
  for (const [slotId, itemId] of [['front-hair', 'half-up'], ['back-hair', 'high-ponytail'], ['hairpin', 'hide'],
    ['horns', 'hide'], ['hair', '../portrait.png']]) {
    await assert.rejects(dashboard.evaluate((selection) => window.dragonGirl.command('dragon-equipment', selection),
      { slotId, itemId }), /找不到可切换的龙娘装备/);
  }

  // 发型与自选瞳色同时应用，保存另一页的旧草稿时保留最新的外观。
  await openGearOptions(dashboard, 'hair', ...hairstyleNames);
  await captureFixedPortrait(preview);
  const customPixels = await verifyAdditionalHairstyles(dashboard, pet, options, custom);
  await ponytail.click();
  await ponytailPreview.waitFor({ state: 'visible' });
  await waitForPortrait(pet, ponytailAsset);
  await idleOptions.waitFor({ state: 'visible' });
  assert.deepEqual(await portraitDigest(ponytailPreview), await portraitDigest(pet.locator(tinted)));
  customPixels.ponytail = await verifyRightPonytail(ponytailPreview);
  const preferences = await dashboard.evaluate((settings) => window.dragonGirl.command('settings', settings), oldSettings);
  assert.equal(preferences.dragonHairstyleId, 'ponytail');
  assert.equal(preferences.dragonEyeColor, custom);

  // 合掌只覆盖眼区和手部，切换桌宠后仍记住所选发型与瞳色。
  await application.evaluate(() => globalThis.__dragonGirlTest.showExpression('prayer', { preview: true }));
  await pet.locator('#prayer-portrait').waitFor({ state: 'visible' });
  assert.equal(await pet.locator('#prayer-hands').isVisible(), true);
  assert.equal(await pet.locator('#prayer-half').evaluate((canvas) => canvas.getContext('2d')
    .getImageData(100, 858, 1, 1).data[3]), 0);
  // 普通偏好草稿保留未保存的改动，随后保存也不会切回旧角色。
  const settingsNav = dashboard.getByRole('button', { name: '偏好设置', exact: true });
  await settingsNav.click();
  await dashboard.locator('#natural-blink').setChecked(true);
  await config.click();
  for (const companion of originalCompanions) {
    await verifyOriginalCompanion(dashboard, pet, companion);
    await openGearOptions(dashboard, 'clothes', '原版服饰');
    await dashboard.locator('#content-scroll').evaluate((element) => { element.scrollTop = 0; });
    await dashboard.screenshot({ path: path.join(artifacts, 'companion-config-' + companion.id + '.png'), animations: 'disabled' });
  }
  await verifyStableGear(dashboard);
  await settingsNav.click();
  assert.equal(await dashboard.locator('#natural-blink').isChecked(), true);
  await dashboard.locator('#save-settings').click();
  await dashboard.locator('#dirty-hint[data-dirty="false"]').waitFor({ state: 'visible' });
  const savedCompanion = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(savedCompanion.characterId, 'kokkoro');
  assert.equal(savedCompanion.blinkEnabled, true);
  await config.click();
  await chooser.getByRole('button', { name: '龙娘', exact: true }).click();
  await ponytailPreview.waitFor({ state: 'visible' });
  await waitForPortrait(pet, ponytailAsset);
  await pet.locator(tinted).waitFor({ state: 'visible' });
  await application.close();
  application = null;

  // 重启后恢复单马尾和自选色，已淘汰的发型字段不再写入。
  const persisted = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(persisted.dragonEyeColor, custom);
  assert.equal(persisted.dragonHairstyleId, 'ponytail');
  for (const key of Object.keys(retiredSettings)) assert.equal(Object.hasOwn(persisted, key), false, key);
  ({ dashboard, pet } = await boot());
  await waitForPortrait(pet, ponytailAsset);
  await pet.locator(tinted).waitFor({ state: 'visible' });
  await dashboard.getByRole('button', { name: '陪伴配置', exact: true }).click();
  await dashboard.locator(customPreview).waitFor({ state: 'visible' });
  await openGearOptions(dashboard, 'hair', ...hairstyleNames);
  assert.equal(await dashboard.getByRole('button', { name: '单马尾', exact: true }).getAttribute('aria-pressed'), 'true');
  const reopenedOptions = await openGearOptions(dashboard, 'eyes', 'GPT紫瞳', '自选瞳色');
  assert.equal(await reopenedOptions.getByLabel('自选瞳色', { exact: true }).inputValue(), custom);
  assert.equal(await reopenedOptions.locator('.dragon-color-picker').getAttribute('data-selected'), '');

  await application.close();
  application = null;

  // 每款从独立窗口开始，前一款动作、缓存或焦点变化不会影响取样。
  const hairstyleArtifacts = path.join(artifacts, 'dragon-hairstyles');
  await fs.mkdir(hairstyleArtifacts, { recursive: true });
  await fs.writeFile(path.join(hairstyleArtifacts, 'pixel-report.json'),
    JSON.stringify({ default: defaultPixels, custom: customPixels }, null, 2));
  const verified = [];
  for (const { id, name, image } of DRAGON_HAIRSTYLES) {
    try {
      await fs.writeFile(settingsFile, JSON.stringify({
        ...fixture, dragonHairstyleId: id === 'loose' ? 'ponytail' : 'loose',
      }));
      ({ dashboard, pet } = await boot());
      await dashboard.getByRole('button', { name: '陪伴配置', exact: true }).click();
      const hairstyleOptions = await openGearOptions(dashboard, 'hair', ...hairstyleNames);
      await prepareHairstyleActions(application, pet);
      await hairstyleOptions.getByRole('button', { name, exact: true }).click();
      const selected = dashboard.locator('#dragon-config-portrait[data-hairstyle="' + id + '"][data-tone="original"]');
      await selected.waitFor({ state: 'visible' });
      await waitForPortrait(pet, 'dragon://app/' + image);
      assert.deepEqual(await portraitDigest(selected), await portraitDigest(pet.locator('#portrait[data-tone="original"]')));
      await waitForGearLinks(dashboard);
      await pet.screenshot({ path: path.join(hairstyleArtifacts, id + '.png'), omitBackground: true });
      if (id === 'ponytail')
        await dashboard.screenshot({ path: path.join(hairstyleArtifacts, 'configuration.png'), animations: 'disabled' });
      if (additionalHairstyles.some((style) => style.id === id))
        await dashboard.screenshot({ path: path.join(hairstyleArtifacts, 'configuration-' + id + '.png'), animations: 'disabled' });
      await verifyHairstyleActions(application, pet);
      verified.push({ id, name, passed: true });
      console.log(name + '通过视线、眨眼、回弹、表情、合掌和镜像验证。');
    } catch (error) {
      throw new Error(name + '的画面或动作验证失败', { cause: error });
    } finally {
      if (application) await application.close().catch(() => {});
      application = null;
    }
  }
  await fs.writeFile(path.join(hairstyleArtifacts, 'report.json'), JSON.stringify(verified, null, 2));
  assert.deepEqual(errors, []);
  console.log('陪伴配置验证通过：v' + version + '，三角色切换、原版部件、龙娘换装与瞳色、重启恢复及全部发型的动作。');
} finally {
  if (application) await application.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
