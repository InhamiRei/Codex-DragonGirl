import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-bubble-refresh-'));
const artifacts = path.join(root, '.artifacts');
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
const errors = [];
let application, page;

// 等待真正的显示、布局和内容回执，固定延时只用于模拟异步测量的竞争窗口。
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

// 测量完成才继续，防止上一版内容或迟到的测量被当作更新成功。
async function measured() {
  await until(() => page.evaluate(async () => {
    const model = await window.dragonGirl.bootstrap();
    return model.measuredRevision === model.revision && document.body.dataset.ready === 'true';
  }), '最新气泡内容未完成测量');
}

// 每帧读取实际透明度、文字坐标和窗口位置，记录可见气泡的重排、闪烁与重复淡入。
async function record() {
  await page.evaluate(() => {
    window.__bubbleFrames = [];
    window.__recordBubble = true;
    const frame = time => {
      if (!window.__recordBubble) return;
      const bubble = document.getElementById('bubble');
      const style = getComputedStyle(bubble);
      const header = document.getElementById('plan').getBoundingClientRect();
      const footer = document.querySelector('.usage-footer')?.getBoundingClientRect();
      window.__bubbleFrames.push({ time, ready: document.body.dataset.ready,
        visibility: style.visibility, opacity: Number(style.opacity), x: screenX, y: screenY,
        header: { x: header.x, y: header.y }, footer: footer && { x: footer.x, y: footer.y } });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

// 只读取测试实例的原生调用计数，不改写真实窗口的可见性或几何结果。
async function nativeCalls() {
  return application.evaluate(() => ({ ...globalThis.__dragonGirlTest.bubbleCalls }));
}

try {
  await fs.mkdir(artifacts, { recursive: true });
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DRAGONGIRL_MONITOR_TEST;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env, timeout: 30000 });
  await until(() => application.evaluate(() => globalThis.__dragonGirlTest?.ready.size === 2), '测试窗口未就绪');
  page = application.windows().find(window => window.url().endsWith('/bubble.html'));
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await measured();
  await page.evaluate(() => {
    window.__bubbleAnimations = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (this.id === 'bubble') window.__bubbleAnimations += 1;
      return animate.apply(this, args);
    };
  });
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    clearTimeout(c.cursorTimer);
    c.pollCursor = () => {};
    c.appearance.settings = { pinnedBubble: true, soundEnabled: false, autoFlip: false };
    const area = c.display.workArea;
    c.character = { ...c.character, x: area.x + Math.round(area.width * .6), y: area.y + Math.round(area.height * .55) };
    c.applyCharacter();
    c.bubbleFixture = { text: 'Pro 100\n周额度 5%\n今日 1亿 Tokens', usage: {
      plan: 'Pro 100', quotas: [{ label: '周额度', remaining: 5.1, low: true }], quotaNote: '', tokens: '1亿',
    } };
    c.delegate = { bubbleFor: () => c.bubbleFixture };
    c.bubbleCalls = { shows: 0, bounds: 0 };
    const window = c.windows.get('bubble');
    const show = window.showInactive.bind(window);
    const bounds = window.setBounds.bind(window);
    window.showInactive = (...args) => { c.bubbleCalls.shows += 1; return show(...args); };
    window.setBounds = (...args) => { c.bubbleCalls.bounds += 1; return bounds(...args); };
    c.showBubble(c.bubbleFixture, 'usage');
  });
  await measured();
  await until(() => page.locator('#bubble').evaluate(node => Number(getComputedStyle(node).opacity) >= .25), '气泡未进入可见淡入阶段');
  const before = await nativeCalls();
  const staleModel = await application.evaluate(() => structuredClone(globalThis.__dragonGirlTest.bubbleModel));
  const text = await page.locator('#bubble').innerText();
  await record();
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    const resize = c.resizeBubble.bind(c);
    // 延迟真实测量回执，放大“刚打开气泡，同时后台额度更新”的正常异步时序。
    c.resizeBubble = measurement => setTimeout(() => resize(measurement), 80);
    c.bubbleFixture = structuredClone(c.bubbleFixture);
    c.bubbleFixture.usage.quotas[0].remaining = 5.11;
    c.refreshUsageBubble();
  });
  await measured();
  await page.waitForTimeout(180);
  const frames = await page.evaluate(() => { window.__recordBubble = false; return window.__bubbleFrames; });
  const after = await nativeCalls();
  const animations = await page.evaluate(() => window.__bubbleAnimations);
  const report = { frames, before, after, animations, textUnchanged: await page.locator('#bubble').innerText() === text };
  await fs.writeFile(path.join(artifacts, 'bubble-refresh-report.json'), JSON.stringify(report, null, 2));
  assert.ok(frames.length >= 5, '未记录到足够的真实绘制帧');
  assert.ok(frames.every(frame => frame.ready === 'true' && frame.visibility === 'visible'), '后台更新把已经显示的气泡重新隐藏');
  assert.ok(frames.every((frame, index) => !index || frame.opacity >= frames[index - 1].opacity - .02), '后台更新重启淡入，造成透明度回跳');
  assert.equal(animations, 1, '同一次开泡重复播放了淡入');
  assert.equal(report.textUnchanged, true, '测试应覆盖显示数字不变的原始额度微小变化');
  assert.deepEqual(after, before, '相同位置的后台更新重复操作原生窗口');
  const first = frames[0];
  assert.ok(frames.every(frame => ['x', 'y'].every(axis => Math.abs(frame[axis] - first[axis]) < 1)
    && ['header', 'footer'].every(part => ['x', 'y'].every(axis => Math.abs(frame[part][axis] - first[part][axis]) < .5))), '相同内容更新时文字或窗口发生位置跳动');

  // 持续更新与重开分开验证，后台更新不淡入，真正关闭后再次打开仍只淡入一次。
  for (let index = 0; index < 12; index += 1) {
    await application.evaluate(() => {
      const c = globalThis.__dragonGirlTest;
      c.bubbleFixture = structuredClone(c.bubbleFixture);
      c.bubbleFixture.usage.quotas[0].remaining += .001;
      c.refreshUsageBubble();
    });
    await measured();
  }
  assert.equal(await page.evaluate(() => window.__bubbleAnimations), 1);
  assert.deepEqual(await nativeCalls(), before);

  // 延后抵达的旧快照不能把已经更新的文字回退，也不能重新播放入场动画。
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    c.bubbleFixture = structuredClone(c.bubbleFixture);
    c.bubbleFixture.text = 'Pro 100\n周额度 5%\n今日 1.1亿 Tokens';
    c.bubbleFixture.usage.tokens = '1.1亿';
    c.refreshUsageBubble();
  });
  await measured();
  await application.evaluate((_, model) => globalThis.__dragonGirlTest.windows.get('bubble').webContents.send('dg:bubble', model), staleModel);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.metric-value').textContent(), '1.1', '旧快照覆盖了新用量');
  assert.equal(await page.locator('.metric-unit').textContent(), '亿 Tokens', '更新后的数量单位不正确');
  assert.equal(await page.evaluate(() => window.__bubbleAnimations), 1);

  // 自定义长用量更新保留阅读位置，切换语录则回到开头。
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    c.bubbleFixture = '这是自定义用量的一行，阅读位置不能因为刷新而跳回顶部。\n'.repeat(8);
    c.showBubble(c.bubbleFixture, 'usage');
  });
  await measured();
  const pane = page.locator('#bubble-content');
  await pane.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const scrollTop = await pane.evaluate(node => node.scrollTop);
  assert.ok(scrollTop > 0);
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    c.bubbleFixture += '新的用量';
    c.refreshUsageBubble();
  });
  await measured();
  assert.equal(await pane.evaluate(node => node.scrollTop), scrollTop, '后台更新把阅读位置跳回顶部');
  await page.locator('#bubble').click();
  await measured();
  assert.equal(await pane.evaluate(node => node.scrollTop), 0, '切换语录没有回到开头');

  // 等待测量期间关闭，迟到的回执不能重新弹出；反复重开都应只有一次新淡入。
  for (let index = 0; index < 10; index += 1) {
    await application.evaluate(() => {
      const c = globalThis.__dragonGirlTest;
      c.hideBubble();
      c.showBubble(c.bubbleFixture, 'usage');
      c.hideBubble();
    });
    await page.waitForTimeout(100);
    assert.equal(await application.evaluate(() => globalThis.__dragonGirlTest.windows.get('bubble').isVisible()), false, '迟到测量重新显示了已关闭的气泡');
  }
  const previousAnimations = await page.evaluate(() => window.__bubbleAnimations);
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    c.showBubble(c.bubbleFixture, 'usage');
  });
  await measured();
  assert.equal(await page.evaluate(() => window.__bubbleAnimations), previousAnimations + 1, '新一轮开泡未单独播放一次淡入');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'bubble-refresh-report.json'), JSON.stringify({ ...report, passed: true, repeatedRefreshes: 12, cancelledOpenings: 10, scrollPreserved: true, staleSnapshotIgnored: true }, null, 2));
  console.log('气泡刷新验收通过：可见内容不闪、不重播淡入、不重复定位、文字坐标稳定，长内容保留阅读位置，关闭后的迟到测量不重开。');
} finally {
  await application?.close().catch(() => {});
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
