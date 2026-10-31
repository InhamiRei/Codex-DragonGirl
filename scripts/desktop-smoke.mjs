import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUBBLE_FRAME, BUBBLE_SIZE } from '../src/shared/geometry.js';
import { dialogueLine } from '../src/shared/dialogue.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dragongirl-desktop-'));
const artifacts = path.join(root, '.artifacts');
await fs.mkdir(artifacts, { recursive: true });
const environment = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_DATA_DIR: dataDirectory };
delete environment.ELECTRON_RUN_AS_NODE;
const errors = [];
let application;

// 等待实际窗口和 IPC 状态，避免用固定延时把启动失败误判为通过。
async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(message);
}

// 每次启动使用同一份隔离配置，重启用来检验真正的磁盘恢复。
async function launch() {
  const instance = await electron.launch({ args: [root], env: environment, timeout: 30000 });
  instance.on('window', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  });
  application = instance;
  await until(async () => (await snapshot()).ready.length === 2, '角色或气泡窗口未完成初始化。');
  // CDP 输入不移动系统光标；暂停原生光标兜底，避免真实光标干扰受控的自动化输入。
  await application.evaluate(() => {
    const companion = globalThis.__dragonGirlTest;
    clearTimeout(companion.cursorTimer);
    companion.pollCursor = () => {};
  });
  return instance;
}

// 快照经主进程读取，同时核对原生窗口与渲染层反馈。
async function snapshot() {
  return application.evaluate(() => globalThis.__dragonGirlTest?.snapshot() || { ready: [] });
}

// 页面按用途匹配，不能依赖窗口创建或加载的先后顺序。
function pageFor(view) {
  return application.windows().find(page => page.url().endsWith(`/${view}.html`));
}

// 等待内容测量回传并读取真实边界，避免把旧窗口或尚未显示的一帧当作验收结果。
async function bubbleLayout(text) {
  const page = pageFor('bubble');
  await until(() => page.evaluate(async (expected) => {
    const model = await window.dragonGirl.bootstrap();
    return model.text === expected && model.measuredRevision === model.revision && document.body.dataset.ready === 'true';
  }, text), '气泡没有完成当前内容的尺寸测量。');
  return page.evaluate(async () => {
    const model = await window.dragonGirl.bootstrap();
    const card = document.getElementById('bubble').getBoundingClientRect();
    const content = document.getElementById('bubble-content');
    const viewport = content.getBoundingClientRect();
    const tip = document.getElementById('tail').getBoundingClientRect();
    const outline = document.getElementById('outline-path').getBoundingClientRect();
    // 只检查滚动区域内实际可见的文字，屏幕外内容仍保留，可通过滚动查看。
    const walker = document.createTreeWalker(document.getElementById('bubble'), NodeFilter.SHOW_TEXT);
    let textOutside = false;
    const families = new Set();
    const weights = new Set();
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const line of range.getClientRects()) {
        if (!line.width || !line.height) continue;
        const left = Math.max(line.left, viewport.left);
        const right = Math.min(line.right, viewport.right);
        const top = Math.max(line.top, viewport.top);
        const bottom = Math.min(line.bottom, viewport.bottom);
        if (right <= left || bottom <= top) continue;
        const style = getComputedStyle(walker.currentNode.parentElement);
        families.add(style.fontFamily);
        weights.add(style.fontWeight);
        for (const x of [left, right])
          for (const y of [top, bottom])
            if (((x - card.x - card.width / 2) / (card.width / 2 - 3)) ** 2 +
                ((y - card.y - card.height / 2) / (card.height / 2 - 3)) ** 2 > 1.01) textOutside = true;
      }
    }
    return {
      width: innerWidth, height: innerHeight,
      card: { x: card.x, y: card.y, width: card.width, height: card.height },
      tip: { x: tip.x, y: tip.y, width: tip.width, height: tip.height },
      outline: { x: outline.x, y: outline.y, width: outline.width, height: outline.height },
      outside: { x: model.tailX, y: model.side === 'above' ? card.bottom + 3 : card.top - 3 },
      content: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
      scrollHeight: content.scrollHeight, clientHeight: content.clientHeight,
      scrollWidth: content.scrollWidth, clientWidth: content.clientWidth,
      textOutside,
      typography: { families: [...families], weights: [...weights] },
    };
  });
}

// 先记录真实窗口与像素，交互验收期间不创建额外窗口，避免迟到的焦点事件取消拖动。
async function captureCompanionPreview() {
  const state = await snapshot();
  const images = await Promise.all([
    pageFor('character').screenshot({ omitBackground: true }),
    pageFor('bubble').screenshot({ omitBackground: true }),
  ]);
  const left = Math.min(state.character.x, state.windows.bubble.x) - 12;
  const top = Math.min(state.character.y, state.windows.bubble.y) - 12;
  const width = Math.ceil(Math.max(state.character.x + state.character.width, state.windows.bubble.x + state.windows.bubble.width) - left + 12);
  const height = Math.ceil(Math.max(state.character.y + state.character.height, state.windows.bubble.y + state.windows.bubble.height) - top + 12);
  const source = images.map((image, index) => {
    const bounds = state.windows[index ? 'bubble' : 'character'];
    return `<img alt="" src="data:image/png;base64,${image.toString('base64')}" style="position:absolute;left:${bounds.x - left}px;top:${bounds.y - top}px;width:${bounds.width}px;height:${bounds.height}px">`;
  }).join('');
  return { width, height, source };
}

// 所有拖动和取消验收结束后再合成预览，图片仍使用当时捕获的窗口几何。
async function saveCompanionPreview(preview, filename = 'bubble-upper-left.png') {
  await application.evaluate(async ({ BrowserWindow }, preview) => {
    const window = new BrowserWindow({ width: preview.width, height: preview.height, show: false, frame: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
    globalThis.__bubblePreview = window;
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><title>气泡位置预览</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f5f2f9}</style>${preview.source}`));
  }, preview);
  await until(() => Promise.resolve(application.windows().some((page) => !page.isClosed() && page.url().startsWith('data:text/html'))), '位置预览窗口未就绪。');
  const page = application.windows().find((page) => !page.isClosed() && page.url().startsWith('data:text/html'));
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  await page.screenshot({ path: path.join(artifacts, filename) });
  await application.evaluate(() => { globalThis.__bubblePreview.destroy(); delete globalThis.__bubblePreview; });
}

// 面颊处是稳定的非透明区域，适合验证按压、点击与拖动。
async function facePoint() {
  return pageFor('character').evaluate(async () => {
    const { rect } = await window.dragonGirl.bootstrap();
    return { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.72 };
  });
}

// 气泡点击与截图会切换 CDP 焦点，开始角色手势前先恢复目标并等待布局事件完成。
async function prepareCharacterInput() {
  const page = pageFor('character');
  await page.bringToFront();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// 窗口移动后重新换算本地指针位置，模拟屏幕上的同一个真实鼠标落点。
async function dragTo(x, y) {
  const page = pageFor('character');
  await prepareCharacterInput();
  const before = await snapshot();
  const face = await facePoint();
  const offset = { x: before.character.x - before.windows.character.x, y: before.character.y - before.windows.character.y };
  const target = { x: x + face.x - offset.x, y: y + face.y - offset.y };
  await page.mouse.move(face.x, face.y);
  await page.mouse.down();
  await page.mouse.move(target.x - before.windows.character.x, target.y - before.windows.character.y);
  await until(async () => (await snapshot()).dragging, '拖动没有跨过阈值。');
  const moved = await snapshot();
  await page.mouse.move(target.x - moved.windows.character.x, target.y - moved.windows.character.y);
  await page.mouse.up();
  await until(async () => !(await snapshot()).dragging, '松手后仍处于拖动状态。');
}

try {
  await launch();
  const page = pageFor('character');
  const bubble = pageFor('bubble');
  assert.ok(page && bubble && page !== bubble, '角色与气泡必须是独立页面和原生窗口。');
  await bubble.emulateMedia({ reducedMotion: 'reduce' });

  // 检查真实窗口与角色局部坐标的组合，防止系统收回透明留白后出现底部空隙。
  const initial = await snapshot();
  const workArea = await application.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const initialLayout = await page.evaluate(() => window.dragonGirl.bootstrap());
  assert.equal(initial.windows.character.y + initialLayout.rect.y + initialLayout.rect.height, workArea.y + workArea.height);
  assert.equal(initial.windows.character.x + initialLayout.rect.x + initialLayout.rect.width, workArea.x + workArea.width);
  await until(() => page.evaluate(async () => {
    const model = await window.dragonGirl.bootstrap();
    // 身体跟随只改变视觉姿态，检查原始排版锚点，避免把正常倾斜当作窗口错位。
    const rect = getComputedStyle(document.getElementById('character'));
    return Math.abs(parseFloat(rect.left) - model.rect.x) < 1 && Math.abs(parseFloat(rect.top) - model.rect.y) < 1;
  }), '首次显示后的角色绘制坐标与气泡锚点不一致。');
  console.log('✓ 初次启动的实际角色底边与右边贴齐工作区，透明窗口留白不产生间距。');

  // 原图必须真透明，同时保留白发和衣服内的实心白色像素。
  const alpha = await page.evaluate(() => {
    const image = document.getElementById('portrait');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let clear = 0; let solidWhite = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] === 0) clear += 1;
      // 角色主体的 Alpha 为 254；将量化误差与真正抠除白色表面区分开。
      if (data[index + 3] >= 250 && data[index] > 235 && data[index + 1] > 235 && data[index + 2] > 235) solidWhite += 1;
    }
    return { clear, solidWhite };
  });
  assert.ok(alpha.clear > 10000 && alpha.solidWhite > 10000, `透明背景或白色角色表面不正确：${JSON.stringify(alpha)}`);
  console.log('✓ 素材是真透明 PNG，白发与衣服保持不透明。');

  // 默认贴边已单独验过；受控输入移到屏幕中部，避免与用户正在运行的右下角角色重叠。
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    const area = c.display.workArea;
    c.character = { ...c.character, x: Math.round(area.x + area.width * .4), y: Math.round(area.y + area.height * .4) };
    c.applyCharacter();
  });

  // 验证渲染命中结果确实驱动了原生 setIgnoreMouseEvents 状态。
  await page.mouse.move(2, 2);
  await until(async () => (await snapshot()).interactive.character === false, '透明区域仍接收鼠标。');
  const face = await facePoint();
  await page.mouse.move(face.x, face.y);
  await until(async () => (await snapshot()).interactive.character === true, '可见角色不能恢复鼠标输入。');
  console.log('✓ 透明区释放原生输入，可见像素恢复交互。');

  // 隐藏或原生光标兜底释放输入后，渲染层不能仍缓存旧的可交互状态。
  await application.evaluate(() => globalThis.__dragonGirlTest.setInteractive('character', false));
  await page.mouse.move(face.x + 1, face.y);
  await until(async () => (await snapshot()).interactive.character === true, '原生释放输入后，重新进入角色无法恢复交互。');
  console.log('✓ 原生输入状态变化后，重新进入角色仍可操作。');

  // 按下必须压缩，松开必须回到单位变换，并且只产生一个气泡。
  await page.mouse.down();
  // 原生按压失败时保留当前几何与手势，区分窗口覆盖和绘制问题。
  await until(() => page.evaluate(() => new DOMMatrix(getComputedStyle(document.getElementById('character')).transform).d < 0.96), '按压没有产生形变。').catch(async (error) => {
    const rendered = await page.evaluate(async () => ({
      model: await window.dragonGirl.bootstrap(),
      stage: { ...document.getElementById('stage').dataset },
      transform: getComputedStyle(document.getElementById('character')).transform,
      focused: document.hasFocus(),
    }));
    await fs.writeFile(path.join(artifacts, 'desktop-input-failure.json'), JSON.stringify({ rendered, native: await snapshot(), errors }, null, 2));
    throw error;
  });
  await page.mouse.up();
  await until(async () => (await snapshot()).bubbleVisible, '轻点后气泡没有显示。');
  await bubbleLayout(await application.evaluate(() => globalThis.__dragonGirlTest.bubbleModel.text));
  await until(() => page.evaluate(() => Math.abs(new DOMMatrix(getComputedStyle(document.getElementById('character')).transform).d - 1) < 0.001), '回弹后没有恢复原比例。');
  await page.screenshot({ path: path.join(artifacts, 'character.png'), omitBackground: true });
  await bubble.screenshot({ path: path.join(artifacts, 'bubble.png'), omitBackground: true });
  await bubble.locator('#bubble').click();
  await until(async () => !(await snapshot()).bubbleVisible, '气泡无法独立关闭。');
  console.log('✓ 按压回弹、轻点气泡和独立关闭通过。');

  // 长短文本必须使用同一固定外框；超长内容完整保留，并能通过真实滚轮读到末尾。
  const longText = '这是一段用于验证自动换行的较长消息。'.repeat(10);
  await application.evaluate((_, text) => globalThis.__dragonGirlTest.showBubble(text, 'speech'), longText);
  const longBubble = await bubbleLayout(longText);
  assert.deepEqual([longBubble.width, longBubble.height], [BUBBLE_SIZE.width, BUBBLE_SIZE.height], '长文本改变了固定外框。');
  assert.ok(longBubble.scrollHeight > longBubble.clientHeight + 1, '超长文本没有进入内部滚动区域。');
  assert.ok(longBubble.scrollWidth <= longBubble.clientWidth + 1, '长文本出现横向溢出。');
  assert.equal(longBubble.textOutside, false, '长句超出了漫画气泡的椭圆轮廓。');
  assert.equal(await bubble.locator('#message').textContent(), longText, '长文字被静默截断。');
  const longBounds = (await snapshot()).windows.bubble;
  await bubble.mouse.move(longBubble.content.x + longBubble.content.width / 2, longBubble.content.y + longBubble.content.height / 2);
  await bubble.mouse.wheel(0, 10000);
  await until(() => bubble.locator('#bubble-content').evaluate((node) => node.scrollTop > 0 && node.scrollTop + node.clientHeight >= node.scrollHeight - 1), '无法滚动读取长文本末尾。');
  assert.deepEqual((await snapshot()).windows.bubble, longBounds, '内部滚动改变了气泡外框。');
  await application.evaluate(() => globalThis.__dragonGirlTest.showBubble('在呢！', 'speech'));
  const shortBubble = await bubbleLayout('在呢！');
  assert.deepEqual([shortBubble.width, shortBubble.height], [longBubble.width, longBubble.height], '短句与长句的外框不一致。');
  assert.ok(Math.abs(shortBubble.width - shortBubble.card.width - BUBBLE_FRAME.width) <= 1, '固定主体与窗口边距不一致。');
  assert.ok(Math.abs(shortBubble.height - shortBubble.card.height - BUBBLE_FRAME.height) <= 1, '气泡底部保留了多余空白。');
  assert.equal(shortBubble.textOutside, false, '短句超出了漫画气泡的椭圆轮廓。');
  assert.ok(shortBubble.tip.x >= 0 && shortBubble.tip.x + shortBubble.tip.width <= shortBubble.width, '短句的小圆泡被窗口横向裁切。');
  const shortBounds = (await snapshot()).windows.bubble;
  assert.deepEqual(shortBounds, longBounds, '切换长短文字时气泡位置发生跳动。');
  assert.equal(shortBounds.width, shortBubble.width);
  assert.equal(shortBounds.height, shortBubble.height);
  // 旧消息、非法尺寸和较小的内容测量都不能改变固定外框。
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlTest;
    c.resizeBubble({ revision: c.bubbleModel.revision - 1, width: 320, height: 420 });
    c.resizeBubble({ revision: c.bubbleModel.revision, width: Infinity, height: -1 });
    c.resizeBubble({ revision: c.bubbleModel.revision, width: c.bubbleModel.maxWidth - 20, height: c.bubbleModel.maxHeight - 20 });
  });
  assert.deepEqual((await snapshot()).windows.bubble, shortBounds);
  await bubble.mouse.move(shortBubble.card.x + shortBubble.card.width / 2, shortBubble.card.y + shortBubble.card.height / 2);
  await until(async () => (await snapshot()).interactive.bubble === true, '气泡中心不能点击。');
  await bubble.mouse.move(shortBubble.card.x + shortBubble.card.width * .12, shortBubble.card.y + shortBubble.card.height * .12);
  await until(async () => (await snapshot()).interactive.bubble === false, '椭圆四角空白没有释放鼠标。');
  await bubble.mouse.move(shortBubble.tip.x + shortBubble.tip.width / 2, shortBubble.tip.y + shortBubble.tip.height / 2);
  await until(async () => (await snapshot()).interactive.bubble === false, '装饰思绪泡没有穿透鼠标。');
  await bubble.screenshot({ path: path.join(artifacts, 'bubble-short.png'), omitBackground: true });
  // 去掉凸点后，原凸点位置必须同时释放原生输入，不能留下看不见的点击障碍。
  assert.ok(shortBubble.outline.y + shortBubble.outline.height <= shortBubble.card.y + shortBubble.card.height + .5, '大气泡轮廓仍向下凸出。');
  await bubble.mouse.move(shortBubble.outside.x, shortBubble.outside.y);
  await until(async () => (await snapshot()).interactive.bubble === false, '移除凸点后的空白仍接收点击。');
  await bubble.locator('#bubble').click();
  await until(async () => !(await snapshot()).bubbleVisible, '椭圆主体无法点击收起。');
  console.log(`✓ 长短文字保持 ${shortBubble.width}×${shortBubble.height} 固定外框，内部换行、滚动与透明区域穿透通过。`);

  // 按用户当前的 60% 角色大小核对相对位置，额度与用量使用隔离的示例数据。
  await application.evaluate(() => globalThis.__dragonGirlTest.setScale(.6));
  const usageText = 'Pro 100\n周额度 11%\n今日 2.7亿 Tokens';
  await application.evaluate((_, text) => globalThis.__dragonGirlTest.showBubble({
    text,
    usage: { plan: 'Pro 100', quotas: [{ label: '周额度', remaining: 11, low: true }], quotaNote: '', tokens: '2.7亿' },
  }, 'usage'), usageText);
  const usageBubble = await bubbleLayout(usageText);
  assert.equal(usageBubble.textOutside, false, '用量文字超出了漫画气泡轮廓。');
  assert.deepEqual([usageBubble.card.width, usageBubble.card.height], [shortBubble.card.width, shortBubble.card.height], '用量和对话的轮廓尺寸不同。');
  const usageState = await snapshot();
  assert.ok(usageState.windows.bubble.x + usageState.windows.bubble.width / 2 <= usageState.character.x - usageState.character.width * .24, '大气泡主体没有明显左移。');
  assert.ok(usageState.windows.bubble.y < usageState.character.y, '气泡没有贴在角色上方。');
  assert.doesNotMatch(await bubble.locator('#bubble').innerText(), /工作中|任务完成|任务异常|状态待更新/, '默认用量气泡仍显示任务状态行。');
  await bubble.screenshot({ path: path.join(artifacts, 'bubble-comic-usage.png'), omitBackground: true });
  const taskPreview = await captureCompanionPreview();

  // 双额度覆盖三位数与两位数的列对齐，以及标题、额度行、今日用量之间的统一间距。
  const plusText = 'Plus\n5 小时 100% · 周额度 54%\n今日 57117 Tokens';
  await application.evaluate((_, text) => globalThis.__dragonGirlTest.showBubble({
    text,
    usage: { plan: 'Plus', quotas: [{ label: '5 小时', remaining: 100, low: false }, { label: '周额度', remaining: 54, low: false }], quotaNote: '', tokens: '57117' },
  }, 'usage'), plusText);
  const plusBubble = await bubbleLayout(plusText);
  assert.deepEqual([plusBubble.card.width, plusBubble.card.height], [usageBubble.card.width, usageBubble.card.height], '双额度改变了固定轮廓。');
  assert.equal(plusBubble.textOutside, false, '双额度文字超出椭圆轮廓。');
  assert.ok(plusBubble.scrollWidth <= plusBubble.clientWidth + 1, '双额度出现横向溢出。');
  assert.ok(plusBubble.scrollHeight <= plusBubble.clientHeight + 1, '普通双额度不应裁切或需要滚动。');
  assert.equal(await bubble.locator('#bubble-content').evaluate((pane) => getComputedStyle(pane).scrollbarWidth), 'none');
  const plusLayout = await bubble.evaluate(() => {
    const header = document.querySelector('.bubble-header').getBoundingClientRect();
    const rows = [...document.querySelectorAll('.quota-heading')].map((node) => node.getBoundingClientRect());
    const footer = document.querySelector('.usage-footer').getBoundingClientRect();
    const card = document.getElementById('bubble').getBoundingClientRect();
    const title = document.getElementById('plan').getBoundingClientRect();
    return {
      gaps: [rows[0].top - header.bottom, rows[1].top - rows[0].bottom, footer.top - rows[1].bottom],
      heights: rows.map((row) => row.height),
      labelStarts: [...document.querySelectorAll('.quota-label')].map((node) => node.getBoundingClientRect().left),
      valueEnds: [...document.querySelectorAll('.quota-value')].map((node) => node.getBoundingClientRect().right),
      titleOffset: title.left + title.width / 2 - card.left - card.width / 2,
    };
  });
  assert.ok(Math.max(...plusLayout.gaps) - Math.min(...plusLayout.gaps) < 1, 'Plus 各行上下间距不一致。');
  assert.ok(Math.abs(plusLayout.heights[0] - plusLayout.heights[1]) < 1, 'Plus 两条额度的行高不同。');
  assert.ok(Math.abs(plusLayout.labelStarts[0] - plusLayout.labelStarts[1]) < 1, '额度标签没有左对齐。');
  assert.ok(Math.abs(plusLayout.valueEnds[0] - plusLayout.valueEnds[1]) < 1, '额度百分比没有右对齐。');
  assert.ok(Math.abs(plusLayout.titleOffset) < 1, 'Plus 标题没有居中。');
  await bubble.screenshot({ path: path.join(artifacts, 'bubble-plus.png'), omitBackground: true });
  const plusPreview = await captureCompanionPreview();

  // 复现用户截图中的任务提示，文字完整换行，轮廓与用量气泡保持完全一致。
  const speechText = dialogueLine('complete', 1);
  await application.evaluate((_, text) => globalThis.__dragonGirlTest.showBubble(text, 'notice'), speechText);
  const speechBubble = await bubbleLayout(speechText);
  assert.deepEqual([speechBubble.card.width, speechBubble.card.height], [plusBubble.card.width, plusBubble.card.height], '任务提示把气泡撑扁或拉长。');
  assert.equal(speechBubble.textOutside, false, '任务提示排到了固定椭圆之外。');
  assert.ok(speechBubble.scrollHeight <= speechBubble.clientHeight + 1, '普通任务提示不应需要滚动。');
  await bubble.screenshot({ path: path.join(artifacts, 'bubble-fixed-speech.png'), omitBackground: true });
  const speechPreview = await captureCompanionPreview();
  await application.evaluate(() => globalThis.__dragonGirlTest.hideBubble());
  // 后续拖动和翻转继续使用标准大小，同时覆盖两种角色比例。
  await application.evaluate(() => globalThis.__dragonGirlTest.setScale(1));

  await dragTo(workArea.x + 18, workArea.y + 18);
  const snapped = await snapshot();
  assert.equal(snapped.character.x, workArea.x);
  assert.equal(snapped.character.y, workArea.y);
  // 顶边同样受系统菜单栏约束，渲染坐标必须跟随实际窗口位置换算。
  const topLayout = await page.evaluate(() => window.dragonGirl.bootstrap());
  assert.equal(snapped.windows.character.y + topLayout.rect.y, workArea.y);
  assert.equal(snapped.windows.character.x + topLayout.rect.x, workArea.x);
  assert.equal(snapped.bubbleVisible, false, '拖动结束不应误触气泡。');
  assert.equal(snapped.state.placement.horizontal.edge, 'start');
  assert.equal(snapped.state.placement.vertical.edge, 'start');
  console.log('✓ 拖动后贴边吸附，松手不会误弹气泡。');
  // 同一短句在顶部翻转后仍然紧贴尾巴，不能因朝向变化恢复成固定大窗口。
  await application.evaluate(() => globalThis.__dragonGirlTest.showBubble('在呢！', 'speech'));
  const belowBubble = await bubbleLayout('在呢！');
  assert.equal(await bubble.locator('body').getAttribute('data-side'), 'below');
  assert.equal(await bubble.locator('body').getAttribute('data-horizontal'), 'right');
  assert.equal(belowBubble.width, shortBubble.width);
  assert.equal(belowBubble.height, shortBubble.height);
  assert.ok(belowBubble.tip.y >= 0 && belowBubble.tip.y + belowBubble.tip.height <= belowBubble.height, '翻转后的尾巴被原生窗口裁切。');
  assert.ok(belowBubble.tip.x >= 0 && belowBubble.tip.x + belowBubble.tip.width <= belowBubble.width, '镜像后的小圆泡被窗口横向裁切。');
  assert.ok(belowBubble.outline.y >= belowBubble.card.y - .5, '翻转后的主体轮廓仍向外凸出。');
  await bubble.mouse.move(belowBubble.outside.x, belowBubble.outside.y);
  await until(async () => (await snapshot()).interactive.bubble === false, '翻转后原凸点位置仍接收点击。');
  await bubble.locator('#bubble').click();
  await until(async () => !(await snapshot()).bubbleVisible, '翻转后的椭圆主体无法关闭气泡。');

  // 取消手势后既恢复几何位置，也保留上一次已保存的配置。
  await prepareCharacterInput();
  const beforeCancel = await snapshot();
  const localFace = await facePoint();
  await page.mouse.move(localFace.x, localFace.y);
  await page.mouse.down();
  await page.mouse.move(localFace.x + 90, localFace.y + 70);
  await until(async () => (await snapshot()).dragging, '取消场景未进入拖动。');
  await page.evaluate(() => window.dragonGirl.cancelGesture());
  await until(async () => !(await snapshot()).dragging, '取消未结束手势。');
  await page.mouse.up();
  assert.deepEqual((await snapshot()).character, beforeCancel.character);
  assert.deepEqual((await snapshot()).state, beforeCancel.state);
  console.log('✓ 取消拖动恢复原位且不写入异常位置。');

  // 缩放恢复单独建立确定的拖动提交，避免上一段 CDP 取消事件干扰此处的位置前提。
  await application.evaluate(() => {
    const companion = globalThis.__dragonGirlTest;
    companion.cancelGesture();
    const rect = { ...companion.character }, area = companion.display.workArea;
    const start = { x: rect.x + 20, y: rect.y + 20 };
    const end = { x: start.x + area.x + area.width * 0.4 - rect.x, y: start.y + area.y + area.height * 0.5 - rect.y };
    companion.gesture.begin(start, rect);
    companion.moveGesture(end);
    companion.endGesture(end);
  });
  const beforeScale = await snapshot();
  await application.evaluate(() => globalThis.__dragonGirlTest.setScale(1.25));
  const resized = await snapshot();
  assert.equal(resized.character.y + resized.character.height, beforeScale.character.y + beforeScale.character.height);
  await application.evaluate(async () => { await globalThis.__dragonGirlTest.store.flush(); });
  await application.close();
  application = null;
  await launch();
  const restored = await snapshot();
  assert.deepEqual(restored.state, resized.state);
  assert.deepEqual(restored.character, resized.character);
  console.log('✓ 缩放固定底边，退出重开后恢复位置、锚点与大小。');
  // 激活已有实例不应创建第二份窗口；退出时的迟到激活也不能访问已销毁托盘。
  const windowCount = await application.evaluate(({ app, BrowserWindow }) => {
    app.emit('second-instance', {}, [], '');
    app.once('will-quit', () => {
      globalThis.__dragonGirlTest.show();
      globalThis.__dragonGirlTest.updateMenu();
    });
    return BrowserWindow.getAllWindows().length;
  });
  assert.equal(windowCount, 2);
  await saveCompanionPreview(taskPreview);
  await saveCompanionPreview(plusPreview, 'bubble-plus-preview.png');
  await saveCompanionPreview(speechPreview, 'bubble-fixed-speech-preview.png');
  await application.close();
  application = null;
  console.log('✓ 重复激活保持单实例，退出时的迟到激活安全忽略。');
  assert.deepEqual(errors, [], '桌面窗口出现了脚本或资源加载错误。');
  await fs.writeFile(path.join(artifacts, 'desktop-report.json'), JSON.stringify({ passed: true, alpha, restored, bubbles: { short: shortBubble, long: longBubble, usage: usageBubble, plus: plusBubble, plusLayout, speech: speechBubble, below: belowBubble } }, null, 2));
  console.log('桌面集成检查全部通过。截图与报告位于 .artifacts/。');
} finally {
  await application?.close().catch(() => {});
  await fs.rm(dataDirectory, { recursive: true, force: true });
}
