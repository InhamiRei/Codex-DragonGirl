import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-bubble-'));
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
let application, page;
const results = [];

// 测量回传完成后再检查，避免透明首帧被误认为内容没有溢出。
async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

// 每个显示比例使用独立进程和临时配置，实际执行 Electron 的缩放与字体排版。
async function launch(scale) {
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: path.join(temporary, String(scale)) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DRAGONGIRL_MONITOR_TEST;
  application = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : [root]), `--force-device-scale-factor=${scale}`, '--disable-features=OverlayScrollbar'],
    env, timeout: 60000,
  });
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest?.ready.size === 2), '气泡窗口未就绪');
  page = application.windows().find((window) => window.url().endsWith('/bubble.html'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await application.evaluate(() => {
    const companion = globalThis.__dragonGirlTest;
    clearTimeout(companion.cursorTimer);
    companion.pollCursor = () => {};
  });
}

// 使用真实渲染和主进程测量协议，不直接改写测试期望的窗口几何。
async function show(content, font = '', narrow = false) {
  await page.evaluate(({ font, narrow }) => {
    document.documentElement.style.fontFamily = font;
    document.getElementById('bubble-content').style.width = narrow ? '152px' : '';
  }, { font, narrow });
  await application.evaluate((_, content) => globalThis.__dragonGirlTest.showBubble(content, content.usage ? 'usage' : 'speech'), content);
  await until(() => page.evaluate(async (text) => {
    const model = await window.dragonGirl.bootstrap();
    return model.text === text && model.measuredRevision === model.revision && document.body.dataset.ready === 'true';
  }, content.text), '气泡内容没有完成测量');
}

// 检查实际文字边界、滚动空间和系统滚动条占宽，不能仅靠隐藏溢出来通过。
async function metrics() {
  return page.evaluate(() => {
    const pane = document.getElementById('bubble-content');
    const card = document.getElementById('bubble').getBoundingClientRect();
    const range = document.createRange();
    const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
    let outside = false;
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue;
      range.selectNodeContents(walker.currentNode);
      for (const line of range.getClientRects()) {
        if (!line.width || !line.height) continue;
        for (const x of [line.left, line.right]) for (const y of [line.top, line.bottom])
          if (((x - card.x - card.width / 2) / (card.width / 2 - 5)) ** 2
            + ((y - card.y - card.height / 2) / (card.height / 2 - 5)) ** 2 > 1.01) outside = true;
      }
    }
    return {
      clientHeight: pane.clientHeight, scrollHeight: pane.scrollHeight,
      clientWidth: pane.clientWidth, scrollWidth: pane.scrollWidth,
      gutter: pane.offsetWidth - pane.clientWidth, scrollbar: getComputedStyle(pane).scrollbarWidth,
      compact: document.body.dataset.compact, outside,
      labels: [...document.querySelectorAll('.quota-label')].map((label) => ({ text: label.textContent, height: label.getBoundingClientRect().height })),
      text: pane.innerText,
    };
  });
}

try {
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  for (const scale of [1, 1.25, 1.5, 2]) {
    await launch(scale);
    for (const [index, font] of ['', 'Microsoft YaHei, sans-serif', 'Arial, sans-serif'].entries()) {
      const sample = { text: `Plus-${scale}-${index}`, usage: {
        plan: 'Plus', quotas: [{ label: '5 小时', remaining: 32 }, { label: '周额度', remaining: 89 }], quotaNote: '', tokens: '57117',
      } };
      await show(sample, font, index === 2);
      const result = await metrics();
      if (index === 0) await page.screenshot({ path: path.join(root, `.artifacts/bubble-scrollbar-${scale}.png`), omitBackground: true });
      assert.ok(result.scrollHeight <= result.clientHeight + 1, `双额度被裁成滚动区域：${JSON.stringify({ scale, font, ...result })}`);
      assert.equal(result.outside, false, '完整用量文字超出椭圆');
      assert.ok(result.labels.every((label) => label.height <= 19), '普通额度标签发生换行');
      assert.equal(result.scrollbar, 'none', '仍保留系统原生滚动条');
      assert.equal(result.gutter, 0, '滚动条挤占了内容宽度');
      assert.match(result.text, /今日已用/);
      assert.match(result.text, /57117/);
      results.push({ scale, font: font || 'system', ...result });
      sample.usage.quotas.forEach((quota) => { quota.remaining = 100; });
      sample.text += '-100';
      await show(sample, font, index === 2);
      const full = await metrics();
      assert.ok(full.scrollHeight <= full.clientHeight + 1 && !full.outside, '三位数百分比破坏了完整布局');
    }
    // 保留真正超长的内容，隐藏滚动条后依然能用滚轮读到最后一行。
    const longText = '这是需要完整保留的长消息。'.repeat(30) + '最后一行';
    await show({ text: longText });
    const long = await metrics();
    assert.ok(long.scrollHeight > long.clientHeight);
    assert.equal(long.scrollbar, 'none');
    assert.equal(long.gutter, 0);
    assert.equal(await page.locator('#message').textContent(), longText);
    const bounds = await page.locator('#bubble-content').boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 10000);
    await until(() => page.locator('#bubble-content').evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1), '隐藏滚动条后无法阅读长消息末尾');
    await page.locator('#bubble').focus();
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#bubble-content').evaluate((node) => node.scrollTop), 0);
    await page.keyboard.press('End');
    assert.ok(await page.locator('#bubble-content').evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1));
    await application.close(); application = null;
  }
  await fs.writeFile(path.join(root, '.artifacts/bubble-scrollbar-report.json'), JSON.stringify({ passed: true, results }, null, 2));
  console.log('气泡验证通过：四档显示比例、三组字体配置、双额度完整展示、无原生滚动条、长内容可滚动。');
} finally {
  if (application) await application.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
