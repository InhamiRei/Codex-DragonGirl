import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { KANNA_OUTFITS } from '../src/shared/kanna-outfits.js';
import { KANNA_PORTRAIT } from '../src/renderer/portrait-artwork.js';
import { watchKannaLinework } from './kanna-linework.mjs';

// 用实际浏览器画布取样，比较配置预览与桌宠的所有 RGBA 像素。
async function portraitDigest(locator) {
  return locator.evaluate(async (source) => {
    const canvas = new OffscreenCanvas(source.naturalWidth ?? source.width, source.naturalHeight ?? source.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))];
  });
}

// 截取实际缩放后的头部，防止原版与换装使用不同渲染方式导致细线变锐。
async function displayedHead(pet) {
  await pet.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const { x, y, width, height } = await pet.locator('#character').boundingBox();
  const clip = { x: Math.ceil(x), y: Math.ceil(y), width: Math.floor(width - 1), height: Math.floor(height * 0.69) };
  return pet.screenshot({ clip, omitBackground: true, scale: 'css' });
}

// 截图按预乘透明度比较，避免近透明像素转成 PNG 时把一档舍入放大成明显的 RGB 差值。
async function displayedHeadDifference(pet, before, after) {
  return pet.evaluate(async (images) => {
    const [a, b] = await Promise.all(images.map(async (data) => {
      const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      const head = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const surface = new OffscreenCanvas(head.width, head.height);
      const context = surface.getContext('2d', { willReadFrequently: true });
      context.drawImage(head, 0, 0);
      head.close();
      return context.getImageData(0, 0, surface.width, surface.height);
    }));
    if (a.width !== b.width || a.height !== b.height) return 255;
    let largest = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const alphaA = a.data[i + 3], alphaB = b.data[i + 3];
      largest = Math.max(largest, Math.abs(alphaA - alphaB));
      for (let channel = 0; channel < 3; channel++) {
        const left = Math.round(a.data[i + channel] * alphaA / 255);
        const right = Math.round(b.data[i + channel] * alphaB / 255);
        largest = Math.max(largest, Math.abs(left - right));
      }
    }
    return largest;
  }, [before.toString('base64'), after.toString('base64')]);
}

// 按原画坐标对比衣料以外的每个像素，再逐帧核对实际显示的五官层。
async function auditOutfit(captures, artwork) {
  return captures.evaluate(async (frames, art) => {
    const { KANNA_OUTFIT_REGION: region } = await import('dragon://app/src/shared/kanna-outfits.js');
    const { loadPortraitFrames } = await import('dragon://app/src/renderer/portrait-frames.js');
    const base = new Image();
    base.src = art.asset;
    const mask = new Image();
    mask.src = 'dragon://app/' + region.mask;
    const [, , expectedFrames] = await Promise.all([base.decode(), mask.decode(), loadPortraitFrames(art)]);
    const canvas = new OffscreenCanvas(art.width, art.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(base, 0, 0);
    const original = new Uint32Array(ctx.getImageData(0, 0, art.width, art.height).data.buffer);
    ctx.clearRect(0, 0, art.width, art.height);
    ctx.drawImage(document.getElementById('portrait'), 0, 0);
    const dressed = new Uint32Array(ctx.getImageData(0, 0, art.width, art.height).data.buffer);
    ctx.clearRect(0, 0, art.width, art.height);
    ctx.drawImage(mask, region.x, region.y);
    const permission = ctx.getImageData(0, 0, art.width, art.height).data;
    let changed = 0;
    for (let i = 0; i < original.length; i++) {
      if (original[i] === dressed[i]) continue;
      const x = i % art.width, y = Math.floor(i / art.width);
      if (permission[i * 4 + 3] !== 255) throw new Error('换衣改动了遮罩外的原画像素：' + x + ',' + y);
      if (y < art.face.y + art.face.height) throw new Error('衣服盖住了原有表情区域：' + x + ',' + y);
      changed++;
    }
    // 这些发丝和发珠切面按原画标记，防止遮罩本身越过线条却通过遮罩比较。
    const protectedRows = [
      [940, 239, 259], [955, 585, 730], [960, 607, 684], [1000, 268, 345], [1050, 280, 351],
      [1100, 280, 294], [1100, 308, 352], [1152, 319, 337],
      [1000, 825, 898], [1100, 804, 874], [1150, 809, 848],
      [1150, 858, 868], [1188, 826, 841], [1100, 952, 1010], [1240, 214, 231],
    ];
    for (const [y, first, last] of protectedRows) {
      for (let x = first; x <= last; x++) {
        const i = y * art.width + x;
        if (original[i] !== dressed[i]) throw new Error('换衣改变了发丝或发珠：' + x + ',' + y);
      }
    }
    const surface = new OffscreenCanvas(art.face.width, art.face.height);
    const face = surface.getContext('2d', { willReadFrequently: true });
    for (const [name, expected] of expectedFrames) {
      const actual = frames.get(name);
      if (!actual) throw new Error('服装下缺少实际播放的表情：' + name);
      const coordinates = [art.face.x, art.face.y, art.face.width, art.face.height];
      if (actual.rect.some((value, index) => Math.abs(value - coordinates[index]) > 0.25))
        throw new Error('服装下表情坐标偏移：' + name);
      face.clearRect(0, 0, surface.width, surface.height);
      face.drawImage(expected, 0, 0);
      const pixels = face.getImageData(0, 0, surface.width, surface.height).data;
      if (!pixels.every((value, index) => value === actual.pixels.data[index]))
        throw new Error('服装下的表情像素有变化：' + name);
    }
    return changed;
  }, artwork);
}

// 点真实服饰按钮，验证桌宠即时切换、表情不中断和所选款式写入偏好。
export async function verifyKannaOutfits(pet, dashboard, clickMenu, data, artifacts) {
  await dashboard.getByRole('button', { name: '陪伴配置', exact: true }).click();
  await dashboard.getByRole('button', { name: '服饰', exact: true }).click();
  const options = dashboard.getByRole('group', { name: '选择服饰', exact: true });
  assert.deepEqual(await options.getByRole('button').allTextContents(), KANNA_OUTFITS.map(({ name }) => name));
  const originalOption = options.getByRole('button', { name: '原版服饰', exact: true });
  assert.equal(await originalOption.getAttribute('aria-pressed'), 'true');
  const originalDigest = await portraitDigest(pet.locator('#portrait'));
  const originalHead = await displayedHead(pet);
  const changedPixels = [];

  for (const { id, name, icon } of KANNA_OUTFITS.slice(1)) {
    await pet.emulateMedia({ reducedMotion: 'no-preference' });
    await clickMenu('失败', '动作');
    const sad = pet.locator('#character[data-kanna-frame="sad"]');
    await sad.waitFor();
    const button = options.getByRole('button', { name, exact: true });
    await button.click();
    const dressed = pet.locator('#portrait[data-outfit="' + id + '"]');
    const preview = dashboard.locator('#dragon-config-portrait[data-outfit="' + id + '"]');
    await Promise.all([dressed.waitFor(), preview.waitFor()]);
    assert.equal(await sad.count(), 1, name + '切换时中断了失败表情');
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    await dashboard.waitForFunction((source) => document.querySelector('[data-slot="clothes"] img').src === source,
      'dragon://app/' + icon);
    assert.deepEqual(await portraitDigest(preview), await portraitDigest(dressed), name + '的预览和桌宠不一致');

    const captures = await watchKannaLinework(pet, KANNA_PORTRAIT);
    try {
      await clickMenu('完成', '动作');
      await pet.locator('#character[data-kanna-frame="happy"]').waitFor();
      await clickMenu('失败', '动作');
      await sad.waitFor();
      await pet.waitForFunction((frames) => frames.size === 4, captures, { timeout: 15000 });
      const changed = await auditOutfit(captures, KANNA_PORTRAIT);
      assert.ok(changed > 50000, name + '没有在原生画幅绘制完整的衣料');
      changedPixels.push(changed);
    } finally {
      await captures.dispose();
    }
    await pet.emulateMedia({ reducedMotion: 'reduce' });
    await pet.locator('.kanna-face:not([hidden])').waitFor({ state: 'hidden' });
    const difference = await displayedHeadDifference(pet, originalHead, await displayedHead(pet));
    assert.ok(difference <= 1, name + '在实际桌宠尺寸下改变了头部线条，最大通道差 ' + difference);
  }

  await originalOption.click();
  const restored = pet.locator('#portrait[data-outfit="original"]');
  await restored.waitFor();
  assert.deepEqual(await portraitDigest(restored), originalDigest, '恢复原版后仍残留新衣料');
  const final = KANNA_OUTFITS.at(-1);
  await options.getByRole('button', { name: final.name, exact: true }).click();
  await pet.locator('#portrait[data-outfit="' + final.id + '"]').waitFor();
  await assert.rejects(dashboard.evaluate(() => window.dragonGirl.command('kanna-outfit', 'apron')),
    /找不到可切换的康娜服饰/);
  await dashboard.screenshot({ path: path.join(artifacts, 'outfit-picker.png'), animations: 'disabled' });
  // 普通偏好保存也应保留刚选的衣服，避免旧草稿覆盖款式。
  await dashboard.getByRole('button', { name: '偏好设置', exact: true }).click();
  await dashboard.locator('#natural-blink').setChecked(false);
  await dashboard.locator('#save-settings').click();
  await dashboard.locator('#dirty-hint[data-dirty="false"]').waitFor();
  const saved = JSON.parse(await fs.readFile(path.join(data, 'settings.json'), 'utf8'));
  assert.equal(saved.kannaOutfitId, final.id);
  assert.equal(saved.blinkEnabled, false);
  console.log('康娜三套服饰逐像素核对通过，改动像素数 ' + changedPixels.join('、') + '，只在允许的服装区域。');
  return final.id;
}
