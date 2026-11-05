import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dialogueLine } from '../src/shared/dialogue.js';
import { quotaDisplayWindows } from '../src/shared/presentation.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-bubble-'));
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
let application, page;
const results = [];
const fixtureNow = Date.parse('2026-11-05T10:00:00+08:00');

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
  // 固定渲染页日期，真实计时器仍正常运行，截图和跨日断言不会随执行日期变化。
  await page.evaluate((now) => { Date.now = () => now; }, fixtureNow);
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
    const number = document.querySelector('.metric-value')?.getBoundingClientRect();
    const unit = document.querySelector('.metric-unit');
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
      // 今日用量改为同字号的普通单行文字，不再要求数字对准气泡中线。
      footerAlign: document.querySelector('.today') ? getComputedStyle(document.querySelector('.today')).textAlign : null,
      footerWeight: document.querySelector('.today') ? getComputedStyle(document.querySelector('.today')).fontWeight : null,
      amount: document.querySelector('.metric-value')?.textContent,
      amountSize: number ? Number.parseFloat(getComputedStyle(document.querySelector('.metric-value')).fontSize) : null,
      unit: unit?.textContent,
      unitSize: unit ? Number.parseFloat(getComputedStyle(unit).fontSize) : null,
      footerVisible: (() => {
        const footer = document.querySelector('.usage-footer')?.getBoundingClientRect();
        const viewport = pane.getBoundingClientRect();
        return !!footer && footer.top >= viewport.top && footer.bottom <= viewport.bottom + 1;
      })(),
      resets: [...document.querySelectorAll('.quota-reset')].map((node) => node.textContent),
      meters: [...document.querySelectorAll('.quota-battery')].map((node) => ({
        value: node.getAttribute('aria-valuenow'),
        segments: [...node.children].map((segment) => segment.style.getPropertyValue('--fill')),
      })),
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
        plan: 'Plus', timezone: 'Asia/Shanghai',
        quotas: [{ label: '5 小时', remaining: 79, resetsAt: Date.parse('2026-11-05T13:27:00+08:00') },
          { label: '周额度', remaining: 6, low: true, resetsAt: Date.parse('2026-11-09T13:33:00+08:00') }],
        quotaNote: '', tokens: '123.4万',
      } };
      await show(sample, font, index === 2);
      const result = await metrics();
      if (index === 0) await page.screenshot({ path: path.join(root, `.artifacts/bubble-scrollbar-${scale}.png`), omitBackground: true });
      assert.ok(result.scrollHeight <= result.clientHeight + 1, `双额度被裁成滚动区域：${JSON.stringify({ scale, font, ...result })}`);
      assert.equal(result.outside, false, '完整用量文字超出椭圆');
      assert.ok(result.labels.every((label) => label.height <= 19), '普通额度标签发生换行');
      assert.equal(result.scrollbar, 'none', '仍保留系统原生滚动条');
      assert.equal(result.gutter, 0, '滚动条挤占了内容宽度');
      assert.equal(result.footerVisible, true, '今日 Tokens 被挤出了可视区域');
      assert.equal(result.footerAlign, 'center', '今日用量没有整行居中');
      assert.equal(result.footerWeight, '400', '今日用量仍然加粗');
      assert.deepEqual(result.resets, ['13:27 重置', '11.09 13:33 重置']);
      assert.equal(result.meters[0].segments.length, 10);
      assert.equal(result.meters[0].segments.filter((fill) => fill === '100%').length, 7);
      assert.match(result.text, /今日/);
      assert.equal(result.amount, '123.4');
      assert.equal(result.unit, '万 Tokens');
      assert.equal(result.amountSize, result.unitSize, '数字与 Tokens 的字号不同');
      results.push({ scale, font: font || 'system', ...result });
      sample.usage.quotas.forEach((quota) => { quota.remaining = 100; });
      sample.text += '-100';
      await show(sample, font, index === 2);
      const full = await metrics();
      assert.ok(full.scrollHeight <= full.clientHeight + 1 && !full.outside, '三位数百分比破坏了完整布局');
      assert.ok(full.meters.every((meter) => meter.segments.every((fill) => fill === '100%')), '100% 电量没有完整填满');
      // 不同数量级均须在原椭圆内完整显示，特别覆盖之前会触发裁切的长数值。
      for (const tokens of ['0', '2715万', '9999.9万', '1.234亿', '1.234万亿', '123456789']) {
        sample.usage.tokens = tokens;
        sample.text = `Plus-${scale}-${index}-${tokens}`;
        await show(sample, font, index === 2);
        const numbers = await metrics();
        assert.ok(numbers.footerVisible && numbers.scrollHeight <= numbers.clientHeight + 1 && !numbers.outside,
          `今日 Tokens 未完整显示：${JSON.stringify({ scale, font, tokens, ...numbers })}`);
        if (tokens === '2715万') {
          assert.equal(numbers.amount, '2715');
          assert.equal(numbers.unit, '万 Tokens');
        }
      }
    }
    // 三档 Pro 与 Plus 使用相同双行布局；无限制行的电量始终跟随实际周额度。
    for (const [planType, plan] of [['prolite', 'Pro 100'], ['pro', 'Pro 200'], ['promax', 'Pro 500']]) {
      const weekly = { label: '周额度', minutes: 10080, remaining: 62,
        resetsAt: Date.parse('2026-11-09T13:33:00+08:00') };
      const pro = { text: `${plan}-${scale}`, usage: { plan, timezone: 'Asia/Shanghai',
        quotas: quotaDisplayWindows([weekly], planType), quotaNote: '', tokens: '123.4万' } };
      await show(pro);
      const proResult = await metrics();
      assert.equal(proResult.meters.length, 2);
      assert.deepEqual(proResult.resets, ['无限制', '11.09 13:33 重置']);
      assert.deepEqual(proResult.meters[0], proResult.meters[1]);
      assert.ok(proResult.footerVisible && !proResult.outside && proResult.scrollHeight <= proResult.clientHeight + 1);
      assert.equal(proResult.clientHeight, results.find((row) => row.scale === scale && row.font === 'system').clientHeight,
        'Pro 和 Plus 的双行布局高度不同');
      if (scale === 1 && planType === 'prolite') await page.screenshot({ path: path.join(root, '.artifacts/bubble-pro-unified.png'), omitBackground: true });
      pro.text += '-zero';
      pro.usage.quotas = quotaDisplayWindows([{ ...weekly, remaining: 0, low: true, resetsAt: null }], planType);
      await show(pro);
      const zero = await metrics();
      assert.ok(zero.meters.every((meter) => meter.segments.every((fill) => fill === '0%')), '0% 电量仍点亮了格子');
      assert.deepEqual(zero.resets, ['无限制', '重置时间未知']);
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
    // 强制聚焦后的按键注入仅检查渲染层滚动逻辑，不作为桌面键盘可用性的证据。
    await page.locator('#bubble').focus();
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#bubble-content').evaluate((node) => node.scrollTop), 0);
    await page.keyboard.press('End');
    assert.ok(await page.locator('#bubble-content').evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1));
    // 切到语录必须重新计时；常驻气泡保持显示，渲染层注入 Esc 时仍按关闭处理。
    if (scale === 1) {
      // 每类语录实际渲染一轮，完整文案不能超出椭圆，也不能依赖滚动才能读完。
      for (const kind of ['chat', 'complete', 'cancelled', 'error']) {
        const first = dialogueLine(kind);
        for (let index = 0; index < 100; index += 1) {
          const text = dialogueLine(kind, index);
          if (index && text === first) break;
          await show({ text });
          const result = await metrics();
          assert.ok(result.scrollHeight <= result.clientHeight + 1, `语录需要滚动才能读完：${text}`);
          assert.equal(result.outside, false, `语录超出椭圆：${text}`);
          assert.equal(await page.locator('#message').textContent(), text, '语录显示不完整');
        }
      }
      await show({ text: dialogueLine('chat', 4) });
      await page.screenshot({ path: path.join(root, '.artifacts/bubble-dialogue-preview.png'), omitBackground: true });
      const settings = await application.evaluate(() => {
        const c = globalThis.__dragonGirlTest;
        const previous = c.appearance.settings;
        c.appearance.settings = { ...previous, pinnedBubble: false, bubbleSeconds: 1 };
        return previous;
      });
      const sample = { text: '定时用量', usage: {
        plan: 'Plus', quotas: [{ label: '周额度', remaining: 89 }], quotaNote: '', tokens: '12',
      } };
      await show(sample);
      await application.evaluate(() => { globalThis.__dragonGirlTest.appearance.settings.bubbleSeconds = 1.5; });
      await page.locator('#message').click();
      await until(() => application.evaluate(() => globalThis.__dragonGirlTest.bubbleKind === 'speech'), '定时用量未切换为语录');
      // 跨过原气泡的一秒期限，确认旧计时器没有把新语录提前关闭。
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(await application.evaluate(() => globalThis.__dragonGirlTest.bubbleVisible), true, '语录沿用旧气泡计时器而提前关闭');
      await until(() => application.evaluate(() => !globalThis.__dragonGirlTest.bubbleVisible), '语录超过新期限仍未自动收起');
      await application.evaluate(() => {
        const c = globalThis.__dragonGirlTest;
        c.appearance.settings = { ...c.appearance.settings, pinnedBubble: true, bubbleSeconds: 1 };
      });
      await show(sample);
      await page.locator('#message').click();
      await until(() => application.evaluate(() => globalThis.__dragonGirlTest.bubbleKind === 'speech'), '常驻用量未切换为语录');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(await application.evaluate(() => globalThis.__dragonGirlTest.bubbleVisible), true, '常驻语录仍被自动收起');
      await page.locator('#bubble').press('Escape');
      await until(() => application.evaluate(() => !globalThis.__dragonGirlTest.bubbleVisible), '渲染层未处理注入的 Esc');
      await application.evaluate((_, settings) => { globalThis.__dragonGirlTest.appearance.settings = settings; }, settings);
    }
    await application.close(); application = null;
  }
  await fs.writeFile(path.join(root, '.artifacts/bubble-scrollbar-report.json'), JSON.stringify({ passed: true, results }, null, 2));
  console.log('气泡验证通过：四档显示比例、三组字体配置、双额度完整展示、无原生滚动条、长内容可滚动，语录重新计时、常驻与渲染层 Esc 处理。');
} finally {
  if (application) await application.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
