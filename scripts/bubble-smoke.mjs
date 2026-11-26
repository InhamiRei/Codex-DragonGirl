import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dialogueLine } from '../src/shared/dialogue.js';
import { completionBubble, quotaDisplayWindows } from '../src/shared/presentation.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-bubble-'));
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
let application, page;
const results = [];
const clearances = [];
const fixtureNow = Date.parse('2026-11-05T10:00:00+08:00');
// 两个场景共用菜单中的六档尺寸，避免独立调整导致覆盖漏档。
const petScales = [.5, .6, .75, 1, 1.25, 1.5];

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
  // 主进程就绪与 Playwright 接入渲染页是两件事，等两边都完成再测量文字。
  await until(() => {
    page = application.windows().find((window) => window.url().endsWith('/bubble.html'));
    return page;
  }, '气泡渲染页未连接');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // 固定渲染页日期，真实计时器仍正常运行，截图和跨日断言不会随执行日期变化。
  await page.evaluate((now) => { Date.now = () => now; }, fixtureNow);
  await application.evaluate(() => {
    const companion = globalThis.__dragonGirlTest;
    clearTimeout(companion.cursorTimer);
    companion.pollCursor = () => {};
  });
}

// 逐行比较两个隔离窗口的实际着色像素，包含龙角、椭圆和两颗小泡；透明角落不会被算成碰撞。
async function paintedGap() {
  return application.evaluate(async ({ nativeImage }) => {
    const windows = globalThis.__dragonGirlTest.windows;
    const [dragon, bubble] = await Promise.all(['character', 'bubble'].map(async view => {
      const win = windows.get(view), bounds = win.getContentBounds();
      // 以图片实际像素取样，再映射回窗口的逻辑坐标，同一断言也适用于高 DPI。
      const image = nativeImage.createFromBuffer((await win.capturePage()).toPNG());
      const { width, height } = image.getSize(), pixels = image.toBitmap();
      const runs = [], stepX = bounds.width / width, stepY = bounds.height / height;
      for (let y = 0; y < height; y++) {
        let start = -1;
        for (let x = 0; x <= width; x++) {
          if (x < width && pixels[(y * width + x) * 4 + 3] >= 32) {
            if (start < 0) start = x;
          } else if (start >= 0) {
            runs.push({ left: bounds.x + start * stepX, right: bounds.x + x * stepX,
              top: bounds.y + y * stepY, bottom: bounds.y + (y + 1) * stepY });
            start = -1;
          }
        }
      }
      if (!runs.length) throw new Error(view + ' 窗口没有可见像素');
      return runs;
    }));
    // 每一段都按原生窗口的屏幕坐标比较，返回最近两处描边之间的逻辑像素距离。
    let squaredGap = Infinity;
    for (const a of dragon) for (const b of bubble) {
      const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
      if (dy * dy >= squaredGap) continue;
      const dx = Math.max(0, a.left - b.right, b.left - a.right);
      squaredGap = Math.min(squaredGap, dx * dx + dy * dy);
    }
    return Math.sqrt(squaredGap);
  });
}

// 使用真实渲染和主进程测量协议，不直接改写测试期望的窗口几何。
async function show(content, font = '', narrow = false) {
  await page.evaluate(({ font, narrow }) => {
    document.documentElement.style.fontFamily = font;
    document.getElementById('bubble-content').style.width = narrow ? '152px' : '';
  }, { font, narrow });
  await application.evaluate((_, content) => {
    globalThis.__dragonGirlTest.showBubble(content, content.kind ?? (content.usage ? 'usage' : 'speech'));
  }, content);
  await until(() => page.evaluate(async (text) => {
    const model = await window.dragonGirl.bootstrap();
    return model.text === text && model.measuredRevision === model.revision && document.body.dataset.ready === 'true';
  }, content.text), '气泡内容没有完成测量');
}

// 分别检查椭圆边界和内容区边界，文字在椭圆内时也可能被滚动区域裁掉。
async function metrics() {
  return page.evaluate(() => {
    const pane = document.getElementById('bubble-content');
    const viewport = pane.getBoundingClientRect();
    const card = document.getElementById('bubble').getBoundingClientRect();
    const message = document.getElementById('message');
    const number = document.querySelector('.metric-value')?.getBoundingClientRect();
    const unit = document.querySelector('.metric-unit');
    const range = document.createRange();
    const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
    let outside = false, clipped = false;
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue;
      range.selectNodeContents(walker.currentNode);
      for (const line of range.getClientRects()) {
        if (!line.width || !line.height) continue;
        if (line.top < viewport.top - .5 || line.bottom > viewport.bottom + .5
          || line.left < viewport.left - .5 || line.right > viewport.right + .5) clipped = true;
        for (const x of [line.left, line.right]) for (const y of [line.top, line.bottom])
          if (((x - card.x - card.width / 2) / (card.width / 2 - 5)) ** 2
            + ((y - card.y - card.height / 2) / (card.height / 2 - 5)) ** 2 > 1.01) outside = true;
      }
    }
    return {
      clientHeight: pane.clientHeight, scrollHeight: pane.scrollHeight,
      clientWidth: pane.clientWidth, scrollWidth: pane.scrollWidth,
      messageLines: Math.round(message.offsetHeight / Number.parseFloat(getComputedStyle(message).lineHeight)),
      gutter: pane.offsetWidth - pane.clientWidth, scrollbar: getComputedStyle(pane).scrollbarWidth,
      compact: document.body.dataset.compact, outside, clipped,
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
    // 三档 Pro 默认使用单行布局，开启后与 Plus 的双行布局一致。
    for (const [planType, plan] of [['prolite', 'Pro 100'], ['pro', 'Pro 200'], ['promax', 'Pro 500']]) {
      const weekly = { label: '周额度', minutes: 10080, remaining: 62,
        resetsAt: Date.parse('2026-11-09T13:33:00+08:00') };
      const pro = { text: `${plan}-${scale}-weekly`, usage: { plan, timezone: 'Asia/Shanghai',
        quotas: quotaDisplayWindows([weekly], planType), quotaNote: '', tokens: '123.4万' } };
      await show(pro);
      const single = await metrics();
      assert.deepEqual(single.resets, ['11.09 13:33 重置']);
      assert.equal(single.meters.length, 1);
      assert.ok(single.footerVisible && !single.outside && single.scrollHeight <= single.clientHeight + 1);
      if (scale === 1 && planType === 'prolite') await page.screenshot({ path: path.join(root, '.artifacts/bubble-pro-weekly.png'), omitBackground: true });
      pro.text += '-five-hour';
      pro.usage.quotas = quotaDisplayWindows([weekly], planType, true);
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
      pro.usage.quotas = quotaDisplayWindows([{ ...weekly, remaining: 0, low: true, resetsAt: null }], planType, true);
      await show(pro);
      const zero = await metrics();
      assert.ok(zero.meters.every((meter) => meter.segments.every((fill) => fill === '0%')), '0% 电量仍点亮了格子');
      assert.deepEqual(zero.resets, ['无限制', '重置时间未知']);
    }
    // 用截图里的取消通知核对两行居中，确认只去掉整段最后一个句号。
    const notice = dialogueLine('cancelled', 1);
    await show({ text: notice, kind: 'notice' });
    const noticeLayout = await metrics();
    assert.equal(noticeLayout.messageLines, 2, '任务取消提示在句内折行');
    assert.ok(!noticeLayout.outside && noticeLayout.scrollHeight <= noticeLayout.clientHeight + 1);
    assert.equal(await page.locator('#message').textContent(), '收到，任务取消。\n尾巴刹住了，等你想好再出发');
    const lineOffsets = await page.locator('#message').evaluate((node) => {
      const card = document.getElementById('bubble').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].filter((line) => line.width > 0)
        .map((line) => (line.left + line.right - card.left - card.right) / 2);
    });
    assert.equal(lineOffsets.length, 2);
    assert.ok(lineOffsets.every((offset) => Math.abs(offset) <= 1), `取消台词没有居中：${lineOffsets}`);
    if (scale === 1)
      await page.screenshot({ path: path.join(root, '.artifacts/bubble-dialogue-no-final-period.png'), scale: 'css', omitBackground: true });

    // 六档角色尺寸在每档显示缩放下都走真实通知排版，覆盖备用字体和长用量数值。
    const completionCases = [
      ['', completionBubble({ input: 18200, output: 1400, cached: 14378 })],
      ['Microsoft YaHei, sans-serif', completionBubble({ input: 128734012, output: 984567, cached: 128734012 })],
      ['Arial, sans-serif', completionBubble({ input: 998900000000000, output: 999900000000000, cached: 998900000000000 })],
    ];
    for (const petScale of petScales) {
      await application.evaluate((_, value) => globalThis.__dragonGirlTest.setScale(value), petScale);
      await show({ text: notice, kind: 'notice' });
      // 等视口和原生窗口一起缩放完毕，再将普通通知的尺寸作为完成通知的对照。
      await until(() => page.evaluate(async () => {
        const { maxWidth, maxHeight } = await window.dragonGirl.bootstrap();
        return Math.abs(innerWidth - maxWidth) <= 1 && Math.abs(innerHeight - maxHeight) <= 1;
      }), '完成通知的缩放视口未就绪');
      const outline = await page.locator('#outline-path').getAttribute('d');
      const noticeSize = await page.evaluate(() => [innerWidth, innerHeight]);
      for (const [font, content] of completionCases) {
        await show({ ...content, kind: 'notice' }, font);
        const summary = await metrics();
        assert.equal(await page.locator('#outline-path').getAttribute('d'), outline, '完成用量改变了气泡轮廓');
        assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), noticeSize, '完成用量改变了气泡尺寸');
        assert.ok(!summary.clipped && !summary.outside && summary.scrollWidth <= summary.clientWidth + 1
          && summary.scrollHeight <= summary.clientHeight + 1,
          `完成通知的文字被裁切：${JSON.stringify({ scale, petScale, font, ...summary })}`);
        // 按文字实际绘制边界查折行，保留 15px 标题、13px 指标和一致的字体及字重。
        const textStyles = await page.locator('.completion-title, .completion-label, .completion-value')
          .evaluateAll((nodes) => nodes.map((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const { fontFamily, fontSize, fontWeight } = getComputedStyle(node);
            return { font: [fontFamily, fontWeight].join('|'), lines: range.getClientRects().length, fontSize };
          }));
        assert.equal(textStyles.length, 7);
        const [titleStyle, ...metricStyles] = textStyles;
        assert.equal(titleStyle.fontSize, '15px');
        assert.ok(metricStyles.every(({ fontSize }) => fontSize === '13px'));
        assert.ok(textStyles.every(({ lines }) => lines === 1), '完成气泡出现折行');
        assert.equal(new Set(textStyles.map(({ font }) => font)).size, 1, '完成气泡的字体或字重不一致');
        assert.equal(await page.locator('.completion-title').textContent(), '本轮任务完成啦');
        assert.deepEqual(await page.locator('.completion-label').allTextContents(), content.completion.metrics.map(({ label }) => label));
        assert.deepEqual(await page.locator('.completion-value').allTextContents(), content.completion.metrics.map(({ value }) => value));
        if (scale === 2 && petScale === 1 && font === 'Microsoft YaHei, sans-serif')
          await page.screenshot({ path: path.join(root, '.artifacts/bubble-turn-usage.png'), omitBackground: true });
      }
    }
    await application.evaluate(() => globalThis.__dragonGirlTest.setScale(1));

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
      // 四位角色的任务文案通过通知入口验证，每条最多三行并完整落在椭圆内。
      for (const characterId of ['dragon', 'maro', 'kokkoro', 'kanna']) {
        for (const kind of ['chat', 'complete', 'cancelled', 'error']) {
          const first = dialogueLine(kind, 0, characterId);
          for (let index = 0; index < 100; index += 1) {
            const text = dialogueLine(kind, index, characterId);
            if (index && text === first) break;
            await show({ text, kind: kind === 'chat' ? 'speech' : 'notice' });
            const result = await metrics();
            assert.ok(result.scrollHeight <= result.clientHeight + 1, `语录需要滚动才能读完：${text}`);
            assert.equal(result.outside, false, `语录超出椭圆：${text}`);
            if (kind !== 'chat') assert.ok(result.messageLines <= 3, `任务提示超过三行：${text}`);
            assert.equal(await page.locator('#message').textContent(), text.slice(0, -1), '台词应只去掉末尾标点');
          }
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
      // 从真实渲染页记录两段透明度动画，确认额度先淡出、语录随后淡入。
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.evaluate(() => {
        const pane = document.getElementById('bubble-content');
        const animate = pane.animate.bind(pane);
        window.__speechFades = [];
        pane.animate = (frames, options) => {
          window.__speechFades.push([document.body.dataset.kind, ...frames.map(frame => frame.opacity)]);
          return animate(frames, options);
        };
      });
      await application.evaluate(() => { globalThis.__dragonGirlTest.appearance.settings.bubbleSeconds = 1.5; });
      await page.locator('#message').click();
      await until(() => application.evaluate(() => globalThis.__dragonGirlTest.bubbleKind === 'speech'), '定时用量未切换为语录');
      // 跨过原气泡的一秒期限，确认旧计时器没有把新语录提前关闭。
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(await application.evaluate(() => globalThis.__dragonGirlTest.bubbleVisible), true, '语录沿用旧气泡计时器而提前关闭');
      assert.deepEqual(await page.evaluate(() => window.__speechFades), [['usage', 1, 0], ['speech', 0, 1]], '换句未平滑过渡');
      await until(() => application.evaluate(() => !globalThis.__dragonGirlTest.bubbleVisible), '语录超过新期限仍未自动收起');
      await application.evaluate(() => {
        const c = globalThis.__dragonGirlTest;
        c.appearance.settings = { ...c.appearance.settings, pinnedBubble: true, bubbleSeconds: 1 };
      });
      await show(sample);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.locator('#message').click();
      await until(() => application.evaluate(() => globalThis.__dragonGirlTest.bubbleKind === 'speech'), '常驻用量未切换为语录');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(await application.evaluate(() => globalThis.__dragonGirlTest.bubbleVisible), true, '常驻语录仍被自动收起');
      assert.equal(await page.evaluate(() => window.__speechFades.length), 2, '减少动态效果时仍然播放换句动画');
      await page.locator('#bubble').press('Escape');
      await until(() => application.evaluate(() => !globalThis.__dragonGirlTest.bubbleVisible), '渲染层未处理注入的 Esc');
      await application.evaluate((_, settings) => { globalThis.__dragonGirlTest.appearance.settings = settings; }, settings);
    }
    // 同一只已经打开的气泡连续调大小。分别核对窗口、绘制后的字高和内边距，也覆盖 Windows 的 DPI 换算。
    const sentence = '今天也一起工作吧。';
    await show({ text: sentence });
    let previousLayout;
    for (const petScale of petScales) {
      const target = await application.evaluate((_, value) => {
        const c = globalThis.__dragonGirlTest;
        c.setScale(value);
        return { width: c.bubbleModel.maxWidth, revision: c.bubbleModel.revision };
      }, petScale);
      // 系统窗口调整大小和渲染进程更新视口是独立消息，须等两者都到达本轮目标。
      let nativeWidth, viewport;
      await until(async () => {
        nativeWidth = await application.evaluate(() => globalThis.__dragonGirlTest.windows.get('bubble').getContentBounds().width);
        viewport = await page.evaluate(() => innerWidth);
        return Math.abs(target.width - nativeWidth) <= 1 && Math.abs(nativeWidth - viewport) <= 1;
      }, '缩放后的原生窗口与视口不一致').catch(error => {
        throw new Error(`${error.message}：${JSON.stringify({ scale, petScale, target, nativeWidth, viewport })}`);
      });
      await until(() => page.evaluate(async revision => {
        const model = await window.dragonGirl.bootstrap();
        return model.measuredRevision === revision && document.body.dataset.ready === 'true';
      }, target.revision), '角色缩放后已打开的气泡没有更新');
      const layout = await page.evaluate(() => {
        const card = document.getElementById('bubble').getBoundingClientRect();
        const message = document.getElementById('message'), range = document.createRange();
        range.selectNodeContents(message);
        return { width: card.width, text: range.getBoundingClientRect().height, inset: card.left, viewport: innerWidth };
      });
      assert.ok(layout.width < nativeWidth);
      assert.ok(layout.text >= 12, '最小角色的正文字高不足');
      if (previousLayout) assert.ok(layout.width > previousLayout.width && layout.text > previousLayout.text
        && layout.inset > previousLayout.inset, '角色变大时气泡、字号和内边距没有同步放大');
      previousLayout = layout;
      // 两侧屏幕边缘都复现小头像，150% 系统缩放放在顶部，检查气泡翻到角色下方时的净空。
      if (scale !== 1 && petScale > .75) continue;
      const atTop = scale === 1.5;
      for (const edge of ['right', 'left']) {
        await application.evaluate((_, { edge, atTop }) => {
          const c = globalThis.__dragonGirlTest, area = c.display.workArea;
          c.character.x = edge === 'left' ? area.x : area.x + area.width - c.character.width;
          c.character.y = atTop ? area.y : area.y + area.height - c.character.height;
          c.applyCharacter();
        }, { edge, atTop });
        const direction = edge === 'right' ? 'left' : 'right';
        await page.waitForFunction(direction => document.body.dataset.horizontal === direction, direction);
        // 对照反馈中的半大小头像和红框中心，检查实际窗口与网页椭圆组合后的屏幕位置。
        if (petScale === .5 && scale === 1 && edge === 'right') {
          const { character, frame } = await application.evaluate(() => {
            const c = globalThis.__dragonGirlTest;
            return { character: c.character, frame: c.windows.get('bubble').getContentBounds() };
          });
          const card = await page.locator('#bubble').boundingBox();
          assert.ok(Math.abs(frame.x + card.x + card.width / 2 - character.x + 81) <= 3, '半大小气泡横向偏离红框中心');
          assert.ok(Math.abs(frame.y + card.y + card.height / 2 - character.y + 54) <= 3, '半大小气泡纵向偏离红框中心');
        }
        const gap = await paintedGap();
        assert.ok(gap >= 3, `气泡或泡尾进入龙娘轮廓：系统缩放 ${scale}，角色 ${petScale}，${edge}，描边间距 ${gap}`);
        clearances.push({ scale, petScale, edge, atTop, gap });
      }
    }
    await application.close(); application = null;
  }
  await fs.writeFile(path.join(root, '.artifacts/bubble-scrollbar-report.json'), JSON.stringify({ passed: true, results, clearances }, null, 2));
  console.log(`气泡验收通过：${clearances.length} 组截图中角色与泡尾均有净空，四档显示比例、文字排版、滚动、计时与收起正常。`);
} finally {
  if (application) await application.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
