import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { CHARACTERS, DEFAULT_CHARACTER_ASSET, KANNA_ASSET, KOKKORO_ASSET, MARO_ASSET } from '../src/shared/characters.js';
import { DRAGON_HAIRSTYLES, DRAGON_OUTFITS } from '../src/shared/dragon-gear.js';
import { KANNA_OUTFITS } from '../src/shared/kanna-outfits.js';
import { MARO_OUTFITS } from '../src/shared/maro-outfits.js';
import { prepareHairstyleActions, verifyHairstyleActions } from './dragon-hairstyle-actions.mjs';
import {
  captureFixedPortrait, verifyFixedPortrait, verifyRightPonytail, verifyStraightBangsPortrait,
} from './dragon-hairstyle-pixels.mjs';
import { readReleaseVersion } from './release-payload.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const hairstyleNames = DRAGON_HAIRSTYLES.map(({ name }) => name);
const outfitNames = DRAGON_OUTFITS.map(({ name }) => name);
const companionOutfits = { maro: MARO_OUTFITS, kanna: KANNA_OUTFITS };
// 原薄荷帽尾超出右角的区域，现在应完整露出所选发型的底图。
const mintHoodTailArea = [1210, 310, 102, 150];
// 鱼尾收在左侧衣缝，右侧要露出当前发型或透明背景。
const outsideFishTail = [1091, 1027, 117, 140];
// 用原发型的整个头顶核对去帽效果，另取耳侧旧流苏经过的区域检查替换。
const pumpkinCrownArea = [0, 0, 1330, 450];
// 两块区域完全位于左右角尖和鳞纹内部，角旁露出的帽布不参与原画像素比对。
const hornAreas = [[453, 74, 48, 85], [968, 107, 42, 99]];
const oldTasselArea = [1110, 740, 70, 135];
// 散发与单马尾已有独立的初始切换和保存检查，其余款式共用逐款验收。
const additionalHairstyles = DRAGON_HAIRSTYLES.filter(({ id }) => id !== 'loose' && id !== 'ponytail');
const ponytailAsset = 'dragon://app/assets/characters/codex-dragon-girl-ponytail.png';
// 固定部件各有原版缩略图，连线和预览尺寸按每个角色的原图验证。
const originalCompanions = [
  { id: 'maro', name: '麻吕', asset: MARO_ASSET, size: [1254, 1254], parts: {
    tuft: ['翘发', [278, 152]], eyes: ['瞳孔', [440, 620]], hair: ['发型', [843, 272]], clothes: ['服饰', [686, 932]],
  } },
  { id: 'kokkoro', name: '可可萝', asset: KOKKORO_ASSET, size: [1299, 1211], parts: {
    hat: ['兔帽', [309, 275]], eyes: ['瞳孔', [393, 734]], accessory: ['发饰', [1012, 680]], clothes: ['服饰', [641, 1174]],
  } },
  { id: 'kanna', name: '康娜', asset: KANNA_ASSET, size: [1254, 1254], parts: {
    horns: ['龙角', [265, 287]], eyes: ['瞳孔', [452, 682]], beads: ['发珠', [1005, 999]], clothes: ['服饰', [740, 1164]],
  } },
];
// 验证实际渲染出的连线、悬停和展开高亮使用所选角色的配色。
const companionColors = {
  maro: { line: 'rgb(214, 149, 112)', activeLine: 'rgb(185, 101, 57)', fill: 'rgb(255, 240, 229)' },
  kokkoro: { line: 'rgb(155, 183, 135)', activeLine: 'rgb(104, 147, 85)', fill: 'rgb(237, 246, 230)' },
  kanna: { line: 'rgb(193, 162, 202)', activeLine: 'rgb(146, 100, 156)', fill: 'rgb(248, 237, 248)' },
};
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

// 用像素签名核对整张原画或指定区域，包括半透明发梢和衣服轮廓。
async function portraitDigest(locator, area = null) {
  return locator.evaluate(async (source, area) => {
    const { width, height } = source instanceof HTMLCanvasElement
      ? source : { width: source.naturalWidth, height: source.naturalHeight };
    const [x, y, w, h] = area ?? [0, 0, width, height];
    const surface = new OffscreenCanvas(w, h);
    const context = surface.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, -x, -y);
    const pixels = context.getImageData(0, 0, w, h).data;
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))];
  }, area);
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

// 用衣柜内的 GPT 白衣作尺寸参照，核对节日缩略图从领口到下摆连续、居中且高度相近。
async function verifyOutfitThumbnails(options, artifacts) {
  const heights = new Map();
  for (const outfit of DRAGON_OUTFITS) {
    const thumbnail = options.getByRole('button', { name: outfit.name, exact: true }).locator('img');
    assert.equal(await thumbnail.getAttribute('src'), 'dragon://app/' + outfit.icon);
    const silhouette = await thumbnail.evaluate(async (image) => {
      await image.decode();
      const { naturalWidth: width, naturalHeight: height } = image;
      const ctx = new OffscreenCanvas(width, height).getContext('2d');
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, width, height);
      // 单件衣服的轮廓在纵向连续，单独的头饰会与衣服隔开一段透明区域。
      const visibleRows = Array.from({ length: height }, (_, y) => {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] >= 32) return true;
        }
        return false;
      });
      const top = visibleRows.indexOf(true), bottom = visibleRows.lastIndexOf(true);
      return {
        centered: top >= 0 && Math.abs(top - (height - 1 - bottom)) <= 2,
        continuous: visibleRows.slice(top, bottom + 1).every(Boolean),
        height: (bottom - top + 1) / height,
      };
    });
    assert.ok(silhouette.centered && silhouette.continuous, outfit.name + '缩略图应只展示居中的衣服');
    heights.set(outfit.id, silhouette.height);
  }
  const whiteHeight = heights.get('white');
  for (const { id, name } of DRAGON_OUTFITS) {
    assert.ok(Math.abs(heights.get(id) - whiteHeight) <= 0.05, name + '在衣柜中的显示高度与 GPT 白衣差异过大');
  }
  // 从已经解码的真实选项导出等比例对照图，测试窗口被遮住时也能看到全部服装。
  const png = await options.evaluate((row) => {
    const cards = [...row.querySelectorAll('button')];
    const canvas = document.createElement('canvas');
    canvas.width = cards.length * 124;
    canvas.height = 121;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f7f7fa';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#4c405c';
    ctx.font = '600 14px system-ui';
    ctx.textAlign = 'center';
    ctx.imageSmoothingQuality = 'high';
    cards.forEach((card, i) => {
      const center = i * 124 + 62;
      ctx.drawImage(card.querySelector('img'), center - 46, 0, 92, 92);
      ctx.fillText(card.textContent.trim(), center, 108);
    });
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await fs.writeFile(path.join(artifacts, 'dragon-outfit-thumbnails.png'), Buffer.from(png, 'base64'));
}

// 仅统计水平视口内完整显示的卡片，同时检查每件衣服都与第一件在同一行。
async function visibleOutfits(row) {
  const result = await row.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const cards = [...element.children];
    const first = cards[0].getBoundingClientRect();
    const visible = cards.filter((card) => {
      const bounds = card.getBoundingClientRect();
      return bounds.left >= box.left - 1 && bounds.right <= box.right + 1;
    });
    return { singleRow: cards.every((card) => card.getBoundingClientRect().top === first.top),
      names: visible.map((card) => card.textContent) };
  });
  assert.ok(result.singleRow, '服饰卡片发生换行');
  return result.names;
}

// 用实际按钮、横向滚轮和键盘试穿，核对默认、最窄和全部卡片放得下时的行为。
async function verifyOutfitPaging(page, pet, win, row, artifacts) {
  const previous = page.getByRole('button', { name: '上一页服饰' });
  const next = page.getByRole('button', { name: '下一页服饰' });
  const first = row.getByRole('button', { name: outfitNames[0], exact: true });
  const lastOutfit = DRAGON_OUTFITS.at(-1);
  const last = row.getByRole('button', { name: lastOutfit.name, exact: true });
  const slot = page.locator('.dragon-slot[data-slot="clothes"]');
  assert.deepEqual(await visibleOutfits(row), outfitNames.slice(0, 6));
  assert.ok(await previous.isDisabled());
  const originalY = await page.locator('#content-scroll').evaluate((el) => el.scrollTop);
  for (let offset = 6; offset < outfitNames.length; offset += 6) await next.click();
  assert.ok(await next.isDisabled());
  assert.deepEqual(await visibleOutfits(row), outfitNames.slice(-6));
  await verifyStableGear(page);
  assert.deepEqual(await visibleOutfits(row), outfitNames.slice(-6), '后台刷新把衣柜拉回了首页');
  assert.equal(await pet.locator('#portrait').getAttribute('data-outfit'), 'white');
  assert.equal(await first.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#content-scroll').evaluate((el) => el.scrollTop), originalY);

  await row.hover();
  await page.mouse.wheel(-1600, 0);
  await page.waitForFunction(() => document.querySelector('[data-page="previous"]').ariaDisabled === 'true');
  assert.deepEqual(await visibleOutfits(row), outfitNames.slice(0, 6));
  await first.focus();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await row.locator(':focus').textContent(), outfitNames.at(-2));
  assert.equal(await first.getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await pet.locator('#portrait[data-outfit="' + lastOutfit.id + '"]').waitFor({ state: 'visible' });
  await previous.click();
  await slot.click();
  await slot.click();
  assert.ok((await visibleOutfits(row)).includes(outfitNames.at(-1)), '重开衣柜应能看到身上穿的服饰');
  assert.equal(await last.getAttribute('aria-pressed'), 'true');
  await page.locator('.dragon-gear-picker').screenshot({ path: path.join(artifacts, 'dragon-outfit-page.png'), animations: 'disabled' });

  try {
    // 模拟宽窗口，按当前衣柜数量和可用宽度核对是否还需要翻页。
    await win.evaluate((window) => window.webContents.setZoomFactor(0.75));
    await page.waitForFunction(() => innerWidth > 1400);
    const allFit = await row.evaluate((el) => {
      const step = el.children[1].getBoundingClientRect().left - el.children[0].getBoundingClientRect().left;
      return el.children.length * step <= el.parentElement.clientWidth + 1;
    });
    if (allFit) {
      await next.waitFor({ state: 'hidden' });
      assert.deepEqual(await visibleOutfits(row), outfitNames);
      assert.equal(await previous.isVisible(), false);
    } else {
      assert.ok(await next.isVisible());
    }
    await win.evaluate((window) => { window.setSize(880, 660); window.webContents.setZoomFactor(1); });
    await page.waitForFunction(() => innerWidth === 880 && document.querySelector('.dragon-gear-picker[data-paged]'));
    await slot.click();
    await slot.click();
    assert.deepEqual(await visibleOutfits(row), outfitNames.slice(-4));
    const lastPage = Math.ceil(outfitNames.length / 4) - 1;
    for (let pageIndex = lastPage - 1; pageIndex >= 0; pageIndex--) {
      await previous.click();
      assert.deepEqual(await visibleOutfits(row), outfitNames.slice(pageIndex * 4, pageIndex * 4 + 4));
    }
    assert.deepEqual(await visibleOutfits(row), outfitNames.slice(0, 4));
    for (let pageIndex = 0; pageIndex < lastPage; pageIndex++) await next.click();
    assert.deepEqual(await visibleOutfits(row), outfitNames.slice(-4));
  } finally {
    await win.evaluate((window) => { window.webContents.setZoomFactor(1); window.setSize(1160, 820); });
  }
  await first.click();
  await pet.locator('#portrait[data-outfit="white"]').waitFor({ state: 'visible' });
}

// 验证原龙角与呆毛完全露出、小南瓜和两片墨紫叶戴在耳侧、翻领仍为炭黑。
async function verifyPumpkinPinAndCollar(preview, originalCrown) {
  assert.deepEqual(await portraitDigest(preview, pumpkinCrownArea), originalCrown, '南瓜套装遮住了原发型的头顶');
  const [pumpkin, leftLeaf, rightLeaf, leftCollar, rightCollar] = await preview.evaluate((canvas) => {
    const ctx = canvas.getContext('2d');
    return [[1111, 596], [1035, 589], [1159, 548], [583, 988], [791, 988]].map(([x, y]) =>
      [...ctx.getImageData(x, y, 1, 1).data]);
  });
  assert.ok(pumpkin[0] > 220 && pumpkin[1] > 70 && pumpkin[1] < 170 && pumpkin[2] < 65 && pumpkin[3] >= 250,
    '耳侧菜单点击位置未显示橙色小南瓜');
  for (const [r, g, b, a] of [leftLeaf, rightLeaf]) {
    assert.ok(a >= 250 && r < 115 && r > g + 20 && b > g + 20, '小南瓜发夹的墨紫叶片缺失');
  }
  for (const [r, g, b, a] of [leftCollar, rightCollar]) {
    assert.ok(a >= 245 && r > 35 && r < 115 && Math.max(r, g, b) - Math.min(r, g, b) < 23, '南瓜斗篷翻领不是炭黑');
  }
}

// 幽灵的嘴绣在双角中间，帽尾收在右角内，胸前保留青绿玻璃。
async function verifyMintGhost(preview, background) {
  assert.deepEqual(await portraitDigest(preview, mintHoodTailArea), background, '薄荷兜帽右侧仍有多余布料');
  const { mouthCenter, glass } = await preview.evaluate((canvas) => {
    const ctx = canvas.getContext('2d');
    // 只取绣嘴的下缘，左右两只绣眼都在这段扫描带上方。
    const { data, width } = ctx.getImageData(605, 270, 126, 14);
    let left = width, right = -1;
    for (let p = 0; p < data.length; p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      if (g > r + 25 && b > r + 16 && g < 150) {
        const x = (p / 4) % width;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    return {
      mouthCenter: right >= left ? 605 + (left + right) / 2 : null,
      glass: [[684, 1067], [682, 1073], [683, 1091], [682, 1096]].map(([x, y]) =>
        [...ctx.getImageData(x, y, 1, 1).data]),
    };
  });
  assert.ok(mouthCenter !== null && Math.abs(mouthCenter - 678) <= 6, '薄荷头套的幽灵脸偏离额头中心');
  for (const [r, g, b, a] of glass) {
    assert.ok(a >= 250 && g > r + 40 && b > r + 35, '薄荷胸针仍有烛身、火焰或空洞');
  }
}

// 核对羊帽右侧的发际线，以及左角根部沿羊毛卷连续绘制的深色轮廓。
async function verifyLambHat(preview, outfit) {
  const { band, covered, rim } = await preview.evaluate(async (canvas, asset) => {
    const image = new Image();
    image.src = 'dragon://app/' + asset;
    await image.decode();
    const swatch = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    const portrait = canvas.getContext('2d');
    const hairline = [[298, 383], [420, 271], [900, 236], [924, 250], [1017, 363], [1032, 384],
      [1087, 476], [1096, 485], [1112, 486]];
    const covered = hairline.every(([x, y]) => {
      swatch.clearRect(0, 0, 1, 1);
      swatch.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
      const cloth = swatch.getImageData(0, 0, 1, 1).data;
      const worn = portrait.getImageData(x, y, 1, 1).data;
      return cloth[3] === 255 && cloth.every((channel, index) => Math.abs(channel - worn[index]) <= 1);
    });
    // 找到每一列最上方的羊毛实色边缘，再检查实穿画面在这里是否保留了帽缘描线。
    const x0 = 415, y0 = 120, w = 116, h = 184;
    const patch = new OffscreenCanvas(w, h).getContext('2d');
    patch.drawImage(image, -x0, -y0);
    const fabric = patch.getImageData(0, 0, w, h).data;
    const worn = portrait.getImageData(x0, y0, w, h).data;
    const rim = Array.from({ length: w }, (_, x) => {
      for (let y = 0; y < h - 4; y++) {
        const edge = 4 * (y * w + x);
        if (fabric[edge + 3] < 244) continue;
        return [0, 1, 2, 3, 4].some((dy) => {
          const p = edge + 4 * dy * w;
          return fabric[p + 3] >= 247 && worn[p] < 105 && worn[p + 1] < 90
            && worn[p + 2] < 128 && worn[p + 2] > worn[p + 1] + 9;
        });
      }
      return false;
    }).every(Boolean);
    return { covered, rim, band: [...portrait.getImageData(685, 526, 1, 1).data] };
  }, outfit.overlay);
  assert.ok(covered, outfit.name + '的帽缘和角根之间透出了原发顶');
  assert.ok(rim, outfit.name + '左侧龙角与羊毛相接的弧形描边有断口');
  const [r, g, b, a] = band;
  const cream = r > 220 && g > 210 && b > 200;
  const red = r > 160 && r > g + 75 && r > b + 50;
  assert.ok(a > 245 && (outfit.id === 'milk-lamb' ? cream : red), outfit.name + '的帽檐颜色不对');
}

// 圣诞帽盖住两侧的鳞纹，原来突出的角尖处只应看到当前发型的后发或透明背景。
async function verifyClosedCap(preview, style, outfit) {
  const hidden = await preview.evaluate(async (canvas, { overlay, rear, mirrorRear }) => {
    // 与合成器独立取样，按原生像素比较帽布、镜像后发和当前实穿画面。
    async function decode(asset) {
      const image = new Image();
      image.src = 'dragon://app/' + asset;
      await image.decode();
      return image;
    }
    const [cap, hair] = await Promise.all([decode(overlay), rear ? decode(rear) : null]);
    const swatch = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    const portrait = canvas.getContext('2d');
    const checks = [[456, 53, false], [479, 82, false], [1011, 91, false], [1000, 106, false],
      [490, 145, true], [425, 218, true], [983, 152, true], [1042, 226, true]];
    return checks.every(([x, y, cloth]) => {
      swatch.clearRect(0, 0, 1, 1);
      const source = cloth ? cap : hair;
      const sourceX = !cloth && mirrorRear ? canvas.width - 1 - x : x;
      if (source) swatch.drawImage(source, sourceX, y, 1, 1, 0, 0, 1, 1);
      const expected = swatch.getImageData(0, 0, 1, 1).data;
      const actual = portrait.getImageData(x, y, 1, 1).data;
      return (!cloth || expected[3] === 255) && expected.every((n, i) => Math.abs(n - actual[i]) <= 1);
    });
  }, { overlay: outfit.overlay, rear: style.layered ? style.artwork : null, mirrorRear: style.mirrorRear });
  assert.ok(hidden, style.name + '搭配' + outfit.name + '时有龙角外露或帽面缺口');
}

// 实穿时核对鱼头套、正面衣襟、垂袖、双瓣鱼尾，以及跨过短鬓接缝的右绒球。
async function verifyFishOutfit(preview, originalBackground) {
  assert.deepEqual(await portraitDigest(preview, outsideFishTail), originalBackground, '鲸尾原来所在的画面右侧应露出当前发型或透明背景');
  const { colors, placket } = await preview.evaluate((canvas) => {
    const ctx = canvas.getContext('2d');
    // 保留双瓣尾鳍各自的取样高度，按镜像后的位置检查原有斜度。
    const colors = [[700, 190], [435, 1155], [925, 1160], [263, 1027], [182, 1079], [1126, 923]].map(([x, y]) =>
      [...ctx.getImageData(x, y, 1, 1).data]);
    // 测量领结下方和衣扣下方白色门襟的中点，两个高度应对齐。
    const placket = [1040, 1175].map((y) => {
      const { data } = ctx.getImageData(640, y, 72, 1);
      const white = [];
      for (let x = 0; x < 72; x++) {
        const p = x * 4;
        if (data[p] > 225 && data[p + 1] > 222 && data[p + 2] > 212 && data[p + 3] > 248) white.push(x);
      }
      return (white[0] + white.at(-1)) / 2;
    });
    return { colors, placket };
  });
  const [hood, leftSleeve, rightSleeve, upperFluke, lowerFluke, pom] = colors;
  assert.ok(Math.abs(placket[0] - placket[1]) <= 2, '大肥鱼外套的门襟应正面竖直');
  assert.ok(hood[3] === 255 && hood[2] > 165 && hood[2] > hood[0] + 75, '头顶未显示蓝色鱼头套');
  // 旧稿两处正对白绒袖口，新稿在相同位置应是向下延伸的藏蓝色袖身。
  for (const [r, , b, a] of [leftSleeve, rightSleeve]) {
    assert.ok(a === 255 && r < 90 && b > r + 40, '两侧袖身应自然垂下，胸前出现了举起的袖口');
  }
  for (const fluke of [upperFluke, lowerFluke]) {
    assert.ok(fluke[3] === 255 && fluke[2] > fluke[0] + 75
      && fluke.slice(0, 3).every((n, i) => Math.abs(n - leftSleeve[i]) <= 32),
      '画面左侧应露出斜向伸展的两瓣海蓝鲸尾');
  }
  assert.ok(pom[3] === 255 && pom[0] > 205 && pom[2] > 225, '右侧绒球在短鬓图层的接缝处被裁断');
}

// 通过实际按钮试穿每种组合，核对两端像素、瞳色、服饰图标，并从配置页画布收集对照图。
async function verifyOutfitCombinations(dashboard, pet, artifacts, tone) {
  const ready = dashboard.locator('#dragon-gear-options:not([aria-busy])');
  const seen = new Set();
  await dashboard.evaluate(({ hairs, outfits }) => {
    const sheet = window.__outfitSheet = document.createElement('canvas');
    sheet.width = 126 + hairs.length * 240;
    sheet.height = 54 + outfits.length * 222;
    const ctx = sheet.getContext('2d');
    ctx.fillStyle = '#f8f6fa';
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    ctx.font = '600 20px system-ui'; ctx.fillStyle = '#483b52';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    hairs.forEach((name, col) => ctx.fillText(name, 246 + col * 240, 26));
    outfits.forEach((name, row) => {
      ctx.fillStyle = ['#faf3e9', '#f5edf2', '#edf6f3'][row % 3];
      ctx.fillRect(0, 54 + row * 222, sheet.width, 220);
      ctx.fillStyle = '#493e50'; ctx.fillText(name, 64, 165 + row * 222);
    });
  }, { hairs: hairstyleNames, outfits: outfitNames.slice(1) });
  for (const [column, style] of DRAGON_HAIRSTYLES.entries()) {
    await openGearOptions(dashboard, 'hair', ...hairstyleNames);
    await ready.getByRole('button', { name: style.name, exact: true }).click();
    await ready.waitFor({ state: 'visible' });
    await openGearOptions(dashboard, 'clothes', ...outfitNames);
    const bodices = new Set();
    const earPixels = new Map();
    let originalIris;
    let backgroundBehindHood;
    let backgroundBesideFish;
    let originalCrown;
    let originalHorns;
    for (const [row, outfit] of DRAGON_OUTFITS.entries()) {
      const choice = ready.getByRole('button', { name: outfit.name, exact: true });
      await choice.click();
      const attrs = '[data-outfit="' + outfit.id + '"][data-tone="' + tone + '"]';
      const preview = dashboard.locator('#dragon-config-portrait[data-hairstyle="' + style.id + '"]' + attrs);
      const worn = pet.locator('#portrait[data-asset="dragon://app/' + style.image + '"]' + attrs);
      await Promise.all([preview.waitFor({ state: 'visible' }), worn.waitFor({ state: 'visible' })]);
      assert.equal(await choice.getAttribute('aria-pressed'), 'true');
      assert.equal(await dashboard.locator('[data-slot="clothes"] img').getAttribute('src'), 'dragon://app/' + outfit.icon);
      const [shown, onDesktop] = await Promise.all([portraitDigest(preview), portraitDigest(worn)]);
      assert.deepEqual(shown, onDesktop, style.name + '搭配' + outfit.name + '在预览和桌面不一致');
      earPixels.set(outfit.id, await portraitDigest(preview, oldTasselArea));
      if (outfit.id === 'white') {
        originalCrown = await portraitDigest(preview, pumpkinCrownArea);
        originalHorns = await Promise.all(hornAreas.map((area) => portraitDigest(preview, area)));
        backgroundBehindHood = await portraitDigest(preview, mintHoodTailArea);
        backgroundBesideFish = await portraitDigest(preview, outsideFishTail);
      }
      if (outfit.id === 'pumpkin-witch') await verifyPumpkinPinAndCollar(preview, originalCrown);
      if (outfit.id === 'mint-ghost') await verifyMintGhost(preview, backgroundBehindHood);
      if (outfit.hat === 'sheep-hat' || outfit.hat === 'fish-hood' || outfit.id === 'mint-ghost') {
        const horns = await Promise.all(hornAreas.map((area) => portraitDigest(preview, area)));
        assert.deepEqual(horns, originalHorns, style.name + '搭配' + outfit.name + '时两只原画龙角应完整露出角尖和鳞纹');
      }
      if (outfit.hat === 'sheep-hat') await verifyLambHat(preview, outfit);
      if (outfit.hat === 'fish-hood') await verifyFishOutfit(preview, backgroundBesideFish);
      if (outfit.hat === 'closed-cap') await verifyClosedCap(preview, style, outfit);
      if (outfit.id === 'gingerbread-baker')
        assert.deepEqual(await portraitDigest(preview, pumpkinCrownArea), originalCrown, '姜饼发夹遮住了头顶');
      seen.add(shown.join(','));
      const iris = await irisColor(preview);
      if (row === 0) originalIris = iris;
      else assert.deepEqual(iris, originalIris, outfit.name + '改变了原本的瞳色');
      const chest = await preview.evaluate((canvas, { row, column }) => {
        if (row > 0) {
          const sheet = window.__outfitSheet.getContext('2d');
          sheet.imageSmoothingQuality = 'high';
          sheet.drawImage(canvas, 129 + column * 240, 60 + (row - 1) * 222, 234, 208);
        }
        // 取领扣与衣料的颜色，识别只换了帽饰、躯干仍是白衣的回归。
        const ctx = canvas.getContext('2d');
        return [1025, 1060, 1110, 1150].flatMap((y) => [...ctx.getImageData(675, y, 1, 1).data]).join(',');
      }, { row, column });
      bodices.add(chest);
      // 导出原生试穿画面，便于放大查看两个角根和鱼尾与左袖的衔接。
      if (outfit.id === 'plump-fish' && style.id === 'loose') {
        const png = await preview.evaluate((canvas) => canvas.toDataURL('image/png').split(',')[1]);
        await fs.writeFile(path.join(artifacts, 'dragon-plump-fish.png'), Buffer.from(png, 'base64'));
      }
    }
    assert.equal(bodices.size, DRAGON_OUTFITS.length, style.name + '有衣服未实际更换');
    // 两套短发夹都应露出相同的耳线和后发，与仍挂白流苏的原版形成区别。
    assert.deepEqual(earPixels.get('pumpkin-witch'), earPixels.get('crimson-count'), style.name + '的发夹下仍残留旧流苏');
    assert.notDeepEqual(earPixels.get('pumpkin-witch'), earPixels.get('white'), style.name + '未替换白流苏');
  }
  assert.equal(seen.size, DRAGON_HAIRSTYLES.length * DRAGON_OUTFITS.length, '有穿搭回退到了相同的画面');
  const png = await dashboard.evaluate(() => window.__outfitSheet.toDataURL('image/png').split(',')[1]);
  await fs.writeFile(path.join(artifacts, 'dragon-seasonal-outfits.png'), Buffer.from(png, 'base64'));
}

// 对比选中的头像小卡和展开的部件卡，确认底色、边框及文字颜色来自同一角色配色。
async function waitForChooserTheme(page, fill) {
  await page.waitForFunction((expected) => {
    const selected = document.querySelector('#companion-chooser button[aria-pressed="true"]');
    const expanded = document.querySelector('.dragon-slot[aria-expanded="true"]');
    if (!selected || !expanded) return false;
    const avatar = getComputedStyle(selected);
    const part = getComputedStyle(expanded);
    return avatar.backgroundColor === expected && avatar.backgroundColor === part.backgroundColor
      && avatar.borderColor === part.borderColor && avatar.color === part.color;
  }, fill);
}

// 以原图坐标检查四条线的起点和终点，窗口缩放后也要指向同一部件。
async function waitForGearLinks(page, targets = { horns: [385, 235], eyes: [420, 746], hair: [1001, 444], clothes: [780, 1130] }) {
  await page.waitForFunction((anchors) => {
    const preview = document.querySelector('#dragon-config-portrait');
    const portrait = preview.getBoundingClientRect();
    const scale = portrait.width / preview.width;
    const cards = [...document.querySelectorAll('.dragon-slot')];
    return cards.length === Object.keys(anchors).length && cards.every((card) => {
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
  const colors = companionColors[id];
  const links = await page.locator('.dragon-slot-link polyline')
    .evaluateAll((lines) => lines.map((line) => getComputedStyle(line).stroke));
  assert.deepEqual(links, Array(Object.keys(parts).length).fill(colors.line));
  // 等到颜色过渡结束，再确认悬停的卡片和对应连线一起高亮。
  await page.locator('.dragon-slot').first().hover();
  await page.waitForFunction(({ activeLine, fill }) => {
    const hovered = document.querySelector('.dragon-slot:hover[aria-expanded="false"]');
    return hovered && getComputedStyle(hovered).backgroundColor === fill
      && getComputedStyle(hovered.querySelector('polyline')).stroke === activeLine;
  }, colors);
  for (const [slot, [label]] of Object.entries(parts)) {
    // 核对卡片读取独立的方形缩略图，画布四角保留透明。
    const icon = page.locator('.dragon-slot[data-slot="' + slot + '"] img');
    const outfits = slot === 'clothes' ? companionOutfits[id] : null;
    const source = 'dragon://app/' + (outfits?.[0].icon ?? `assets/characters/${id}/gear/${slot}.webp`);
    assert.equal(await icon.evaluate(async (image, source) => {
      await image.decode();
      if (image.src !== source || image.naturalWidth !== 192 || image.naturalHeight !== 192) return false;
      const canvas = new OffscreenCanvas(192, 192);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return [[0, 0], [191, 0], [0, 191], [191, 191]].every(([x, y]) =>
        context.getImageData(x, y, 1, 1).data[3] === 0);
    }, source), true, name + '的' + label + '缺少独立透明缩略图');
    const names = outfits ? outfits.map(({ name }) => name) : ['原版' + label];
    const options = await openGearOptions(page, slot, ...names);
    const choice = options.locator('.dragon-gear-option[data-selected]');
    assert.equal(await choice.count(), 1);
    assert.equal(await choice.evaluate((tile) => getComputedStyle(tile).backgroundColor), colors.fill);
    assert.equal(await options.locator('button, input, select').count(), outfits?.length ?? 0);
    // 展开后的所有服饰缩略图均要真实解码，并保持清单顺序。
    assert.deepEqual(await options.locator('img').evaluateAll((images) => Promise.all(images.map(async (image) => {
      await image.decode();
      return image.src;
    }))), outfits ? outfits.map(({ icon }) => 'dragon://app/' + icon) : [source]);
    await page.locator('.dragon-slot[data-slot="' + slot + '"]').click();
    assert.equal(await options.isHidden(), true);
  }
}

// 从窗口实际显示的画布取样，比较服饰中心和完全位于头部内的原画像素。
async function maroPixels(locator, region) {
  return locator.evaluate(async (canvas, [x, y, width, height]) => {
    // 独立拷贝被测区域，绕开实时硬件画布反复读回时会出现的低位噪点。
    const surface = new OffscreenCanvas(width, height);
    const context = surface.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, x, y, width, height, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))];
  }, region);
}

// 衣服同步配置和桌宠，切换时失败表情仍保留原像素和停留状态。
async function verifyMaroOutfits(dashboard, pet, options) {
  const preview = dashboard.locator('#dragon-config-portrait');
  const character = pet.locator('#character');
  const artwork = character.locator('.character-sprites');
  const head = [340, 130, 480, 635];
  const torso = [463, 1003, 242, 45];
  // 等原版绘制后再读取基准，避免窗口刚切换时取到前一位角色。
  await pet.locator('#character[data-outfit="original"][data-sprite-state="idle"]').waitFor();
  const originalHead = await maroPixels(artwork, head);
  const originalClothes = await maroPixels(artwork, torso);
  const signatures = [originalClothes.join(',')];
  for (const { id, name, icon } of MARO_OUTFITS.slice(1)) {
    const option = options.getByRole('button', { name, exact: true });
    await option.click();
    await dashboard.locator('#dragon-config-portrait[data-outfit="' + id + '"]').waitFor();
    await pet.locator('#character[data-outfit="' + id + '"][data-sprite-state="idle"]').waitFor();
    assert.equal(await option.getAttribute('aria-pressed'), 'true');
    assert.equal(await dashboard.locator('.dragon-slot[data-slot="clothes"] img').getAttribute('src'),
      'dragon://app/' + icon);
    assert.deepEqual(await maroPixels(artwork, head), originalHead, name + '改变了原画头部像素');
    const clothes = await maroPixels(artwork, torso);
    assert.deepEqual(await maroPixels(preview, torso), clothes, name + '在配置页与桌宠的服饰不同步');
    signatures.push(clothes.join(','));
  }
  assert.equal(new Set(signatures).size, MARO_OUTFITS.length);

  await application.evaluate(() => globalThis.__dragonGirlTest.showExpression('sad', { preview: true }));
  await pet.locator('#character[data-sprite-state="sad"]').waitFor();
  const failure = await maroPixels(artwork, head);
  await options.getByRole('button', { name: '原版服饰', exact: true }).click();
  await pet.locator('#character[data-outfit="original"][data-sprite-state="sad"]').waitFor();
  assert.deepEqual(await maroPixels(artwork, head), failure, '换回原版时失败表情的创可贴或眼睛发生变化');
  await options.getByRole('button', { name: '焦糖开衫', exact: true }).click();
  await pet.locator('#character[data-outfit="cardigan-redraw"][data-sprite-state="sad"]').waitFor();
  assert.deepEqual(await maroPixels(artwork, head), failure, '换装使失败表情发生变化');
  await assert.rejects(dashboard.evaluate(() => window.dragonGirl.command('maro-outfit', 'winter')),
    /找不到可切换的麻吕服饰/);
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
    ...fixture, dragonHairstyleId: 'shoulder-bob', dragonOutfitId: 'retired', dragonEyeId: 'green', ...retiredSettings,
  }));
  const version = await readReleaseVersion(root);
  let { dashboard, pet } = await boot();
  await dashboard.waitForFunction((version) => document.querySelector('.brand #app-version').textContent === 'v' + version, version);
  const oldSettings = await dashboard.evaluate(async () => (await window.dragonGirl.command('snapshot')).settings);
  for (const key of Object.keys(retiredSettings)) assert.equal(Object.hasOwn(oldSettings, key), false, key);
  assert.equal(oldSettings.dragonEyeId, 'custom');
  assert.equal(oldSettings.dragonEyeColor, '#73b29c');
  assert.equal(oldSettings.dragonHairstyleId, 'loose');
  assert.equal(oldSettings.dragonOutfitId, 'white');
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
  assert.deepEqual(await chooser.getByRole('button').allTextContents(), ['龙娘', '麻吕', '可可萝', '康娜']);
  // 逐一解码安装包中的小头像，用包含留白的外框尺寸核对按钮布局。
  assert.deepEqual(await chooser.locator('button > img').evaluateAll((images) =>
    Promise.all(images.map(async (image) => {
      await image.decode();
      const { width, height } = image.getBoundingClientRect();
      return [image.src, image.alt, image.naturalWidth, width, height];
    }))), CHARACTERS.map(({ avatar }) => ['dragon://app/' + avatar, '', 112, 28, 28]));
  assert.equal(await chooser.getByRole('button', { name: '龙娘', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await dashboard.locator('#dragon-equipment-left .dragon-slot').allTextContents(), ['龙角', '瞳孔']);
  assert.deepEqual(await dashboard.locator('#dragon-equipment-right .dragon-slot').allTextContents(), ['发型', '服饰']);
  assert.equal(await dashboard.locator('button.dragon-slot').count(), 4);
  await openGearOptions(dashboard, 'hair', ...hairstyleNames);
  await dashboard.waitForFunction(() => [...document.querySelectorAll('#dragon-gear-options img')]
    .every((image) => image.complete && image.naturalWidth === 192 && image.naturalHeight === 192));
  await openGearOptions(dashboard, 'clothes', ...outfitNames);
  await openGearOptions(dashboard, 'horns', 'GPT龙角');
  await waitForChooserTheme(dashboard, 'rgb(238, 229, 249)');
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
  // 等原生窗口的焦点切换完成再移入卡片，迟到的离开事件不会抵消测试的悬停。
  await dashboard.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await dashboard.getByRole('button', { name: '服饰', exact: true }).hover();
  // 鼠标实际命中卡片后，只在测试页保持悬停，避免系统鼠标移动打断颜色过渡。
  const hover = await dashboard.context().newCDPSession(dashboard);
  await hover.send('DOM.enable');
  await hover.send('CSS.enable');
  const { root: documentNode } = await hover.send('DOM.getDocument');
  const { nodeId } = await hover.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '.dragon-slot[data-slot="clothes"]' });
  try {
    await hover.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    await dashboard.waitForFunction(() => {
      const card = document.querySelector('.dragon-slot[data-slot="clothes"]');
      const style = getComputedStyle(card);
      return card.matches(':hover') && card.getAttribute('aria-expanded') === 'false'
        && style.backgroundColor === 'rgb(238, 229, 249)' && style.backgroundImage === 'none'
        && !style.boxShadow.includes('inset');
    });
  } finally {
    await hover.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    await hover.detach();
  }
  await openGearOptions(dashboard, 'clothes', ...outfitNames);
  const gap = await options.locator('.dragon-gear-option').first().evaluate((option) => option.getBoundingClientRect().top
    - document.querySelector('#dragon-config-portrait').getBoundingClientRect().bottom);
  assert.ok(gap >= 50, `选项与立绘的间距为 ${gap} 像素`);
  await verifyOutfitThumbnails(options, artifacts);
  await verifyOutfitPaging(dashboard, pet, window, options, artifacts);

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
    ['horns', 'hide'], ['hair', '../portrait.png'], ['clothes', '../costume.png']]) {
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
  // 原色制作穿搭对照图，再恢复自选瞳色，检查换衣和偏好草稿互不覆盖。
  await openGearOptions(dashboard, 'eyes', 'GPT紫瞳', '自选瞳色');
  await preset.click();
  await verifyOutfitCombinations(dashboard, pet, artifacts, 'original');
  await openGearOptions(dashboard, 'hair', ...hairstyleNames);
  await ponytail.click();
  await ponytailPreview.waitFor({ state: 'visible' });
  await openGearOptions(dashboard, 'clothes', ...outfitNames);
  await idleOptions.getByRole('button', { name: '红夹克绵羊', exact: true }).click();
  await pet.locator('#portrait[data-outfit="berry-lamb"]').waitFor({ state: 'visible' });
  await openGearOptions(dashboard, 'eyes', 'GPT紫瞳', '自选瞳色');
  await colorInput.evaluate((input, value) => {
    input.value = value; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, custom);
  await pet.locator('#portrait[data-outfit="berry-lamb"][data-tone="' + custom + '"]').waitFor({ state: 'visible' });
  const preferences = await dashboard.evaluate((settings) => window.dragonGirl.command('settings', settings), oldSettings);
  assert.equal(preferences.dragonHairstyleId, 'ponytail');
  assert.equal(preferences.dragonOutfitId, 'berry-lamb');
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
    const names = companionOutfits[companion.id]?.map(({ name }) => name) ?? ['原版服饰'];
    const outfitOptions = await openGearOptions(dashboard, 'clothes', ...names);
    if (companion.id === 'maro') await verifyMaroOutfits(dashboard, pet, outfitOptions);
    if (companion.id === 'kanna') {
      // 保存另一页已有的偏好草稿后，浴衣选择仍应保留。
      await outfitOptions.getByRole('button', { name: '夏祭绣球花浴衣', exact: true }).click();
      await pet.locator('#portrait[data-outfit="yukata"]').waitFor();
      await dashboard.locator('#dragon-config-portrait[data-outfit="yukata"]').waitFor();
    }
    await waitForChooserTheme(dashboard, companionColors[companion.id].fill);
    await dashboard.locator('#content-scroll').evaluate((element) => { element.scrollTop = 0; });
    await dashboard.screenshot({ path: path.join(artifacts, 'companion-config-' + companion.id + '.png'), animations: 'disabled' });
  }
  await verifyStableGear(dashboard);
  await settingsNav.click();
  assert.equal(await dashboard.locator('#natural-blink').isChecked(), true);
  await dashboard.locator('#save-settings').click();
  await dashboard.locator('#dirty-hint[data-dirty="false"]').waitFor({ state: 'visible' });
  const savedCompanion = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(savedCompanion.characterId, 'kanna');
  assert.equal(savedCompanion.maroOutfitId, 'cardigan-redraw');
  assert.equal(savedCompanion.kannaOutfitId, 'yukata');
  assert.equal(savedCompanion.blinkEnabled, true);
  await config.click();
  await chooser.getByRole('button', { name: '龙娘', exact: true }).click();
  await ponytailPreview.waitFor({ state: 'visible' });
  // 切回龙娘时连线恢复紫色，原版角色的配色不跨角色保留。
  assert.equal(await dashboard.locator('.dragon-slot-link polyline').first()
    .evaluate((line) => getComputedStyle(line).stroke), 'rgb(189, 168, 216)');
  await waitForPortrait(pet, ponytailAsset);
  await pet.locator(tinted).waitFor({ state: 'visible' });
  await application.close();
  application = null;

  // 重启后恢复单马尾和自选色，已淘汰的发型字段不再写入。
  const persisted = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(persisted.dragonEyeColor, custom);
  assert.equal(persisted.dragonHairstyleId, 'ponytail');
  assert.equal(persisted.dragonOutfitId, 'berry-lamb');
  for (const key of Object.keys(retiredSettings)) assert.equal(Object.hasOwn(persisted, key), false, key);
  ({ dashboard, pet } = await boot());
  await waitForPortrait(pet, ponytailAsset);
  await pet.locator(tinted).waitFor({ state: 'visible' });
  await dashboard.getByRole('button', { name: '陪伴配置', exact: true }).click();
  await dashboard.locator(customPreview).waitFor({ state: 'visible' });
  // 重启后切换角色时，配置预览和桌宠都应恢复该角色上次穿的衣服。
  const reopenedChooser = dashboard.getByRole('group', { name: '切换桌面角色' });
  await reopenedChooser.getByRole('button', { name: '麻吕', exact: true }).click();
  await dashboard.locator('#dragon-config-portrait[data-outfit="cardigan-redraw"]').waitFor();
  await pet.locator('#character[data-outfit="cardigan-redraw"]').waitFor();
  await reopenedChooser.getByRole('button', { name: '康娜', exact: true }).click();
  await dashboard.locator('#dragon-config-portrait[data-outfit="yukata"]').waitFor();
  await pet.locator('#portrait[data-outfit="yukata"]').waitFor();
  await reopenedChooser.getByRole('button', { name: '龙娘', exact: true }).click();
  await dashboard.locator(customPreview).waitFor({ state: 'visible' });
  const restored = await openGearOptions(dashboard, 'clothes', ...outfitNames);
  assert.equal(await restored.getByRole('button', { name: '红夹克绵羊', exact: true }).getAttribute('aria-pressed'), 'true');
  await pet.locator('#portrait[data-outfit="berry-lamb"]').waitFor({ state: 'visible' });
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
  // 每件套装都走一次动作验证，同时轮换六种发型。
  for (const [index, outfit] of DRAGON_OUTFITS.slice(1).entries()) {
    const { id, name, image } = DRAGON_HAIRSTYLES[index % DRAGON_HAIRSTYLES.length];
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
      // 从配置页试穿，确保视线、眨眼、回弹、表情、合掌和镜像使用实际选择的衣帽。
      await openGearOptions(dashboard, 'clothes', ...outfitNames);
      await dashboard.getByRole('button', { name: outfit.name, exact: true }).click();
      await pet.locator('#portrait[data-outfit="' + outfit.id + '"]').waitFor({ state: 'visible' });
      await verifyHairstyleActions(application, pet, outfit);
      verified.push({ id, name, outfit: outfit.id, passed: true });
      console.log(name + '搭配' + outfit.name + '通过视线、眨眼、回弹、表情、合掌和镜像验证。');
    } catch (error) {
      throw new Error(name + '的画面或动作验证失败', { cause: error });
    } finally {
      if (application) await application.close().catch(() => {});
      application = null;
    }
  }
  await fs.writeFile(path.join(hairstyleArtifacts, 'report.json'), JSON.stringify(verified, null, 2));
  assert.deepEqual(errors, []);
  console.log('陪伴配置验证通过：v' + version + '，四角色切换、原版部件、龙娘换装与瞳色、重启恢复及全部发型的动作。');
} finally {
  if (application) await application.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
