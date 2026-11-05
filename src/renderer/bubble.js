import { BUBBLE_FRAME } from '../shared/geometry.js';
import { quotaResetTime } from '../shared/time.js';
import { tokenDisplayParts } from '../shared/presentation.js';

const bridge = window.dragonGirl;
const bubble = document.getElementById('bubble');
const contentPane = document.getElementById('bubble-content');
const outline = document.getElementById('outline');
const outlinePath = document.getElementById('outline-path');
const message = document.getElementById('message');
const plan = document.getElementById('plan');
const quotaTitle = document.getElementById('quota-title');
const tail = document.getElementById('tail');
let lastInteractive = null;
let renderedRevision = -1;
let renderedShowId = -1;
let animatedShowId = -1;

// 所有动态内容都通过文本节点写入，账户名称与自定义模板不能注入 HTML。
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 用量沿用紫色漫画气泡；每个窗口保留真实重置时间，十格电量横向表示剩余额度。
function renderUsage(usage) {
  plan.textContent = usage.plan;
  plan.hidden = false;
  quotaTitle.hidden = true;
  const content = element('div', 'usage');
  content.dataset.multiple = String(usage.quotas.length > 1);
  for (const quota of usage.quotas) {
    const row = element('div', 'quota');
    row.dataset.low = String(quota.low);
    const heading = element('div', 'quota-heading');
    const remaining = quota.remaining > 0 && quota.remaining < 1 ? '<1' : Math.round(quota.remaining);
    // Pro 的补位行明确标注无限制，百分比与电量条的来源通过悬停和辅助功能说明。
    const reset = quota.isUnlimited
      ? { text: '无限制', title: '5 小时无限制；电量条和百分比参考周额度，实际可用量仍受周额度限制' }
      : quotaResetTime(quota.resetsAt, usage.timezone);
    // 周限制影响可用量，保留真实 5h 重置时间，并在悬停与辅助说明中解释原因。
    const blockedNote = quota.isBlockedByWeeklyLimit ? '周额度已耗尽，5 小时额度暂不可用' : '';
    if (blockedNote) row.title = `${blockedNote}；${reset.title}`;
    else if (quota.isUnlimited) row.title = reset.title;
    const resetTime = element('span', 'quota-reset', reset.text);
    resetTime.title = reset.title;
    heading.append(element('span', 'quota-label', quota.label), resetTime);
    const meter = element('div', 'quota-meter');
    const battery = element('div', 'quota-battery');
    battery.setAttribute('role', 'meter');
    battery.setAttribute('aria-label', quota.isUnlimited ? '5 小时展示进度（参考周额度）' : `${quota.label}剩余额度`);
    battery.setAttribute('aria-valuemin', '0');
    battery.setAttribute('aria-valuemax', '100');
    battery.setAttribute('aria-valuenow', String(quota.remaining));
    battery.setAttribute('aria-valuetext', blockedNote
      ? `剩余 0%，${blockedNote}，${reset.title}`
      : quota.isUnlimited ? `5 小时无限制；周额度剩余 ${remaining}%` : `剩余 ${remaining}%，${reset.title}`);
    // 每格保留实际填充比例，低于 10% 仍可分辨，零额度不点亮任何格子。
    for (let index = 0; index < 10; index += 1) {
      const segment = element('span', 'battery-segment');
      segment.style.setProperty('--fill', `${Math.max(0, Math.min(1, quota.remaining / 10 - index)) * 100}%`);
      segment.setAttribute('aria-hidden', 'true');
      battery.append(segment);
    }
    const value = element('span', 'quota-value', remaining);
    value.append(element('span', 'quota-unit', '%'));
    meter.append(battery, value);
    row.append(heading, meter);
    content.append(row);
  }
  if (usage.quotaNote) content.append(element('p', 'quota-note', usage.quotaNote));
  const footer = element('div', 'usage-footer');
  const today = element('div', 'today');
  // 今日用量整行居中，文字与数字使用同一小字号自然连排，数字仅通过颜色区分。
  const tokens = tokenDisplayParts(usage.tokens);
  today.append(
    element('span', 'metric-label', '今日'),
    document.createTextNode(' '),
    element('span', 'metric-value', tokens.number),
    document.createTextNode(tokens.unit ? '' : ' '),
    element('span', 'metric-unit', tokens.unit ? `${tokens.unit} Tokens` : 'Tokens'),
  );
  today.setAttribute('aria-label', `今日已用 ${usage.tokens} Tokens`);
  footer.append(today);
  content.append(footer);
  message.replaceChildren(content);
}

// 判断文字是否处于固定椭圆内部，只调整内容容器，不再根据文字改写气泡尺寸。
function contentFitsEllipse() {
  const rect = bubble.getBoundingClientRect();
  const radiusX = Math.max(1, rect.width / 2 - 5);
  const radiusY = Math.max(1, rect.height / 2 - 5);
  const walker = document.createTreeWalker(contentPane, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const line of range.getClientRects()) {
      if (!line.width || !line.height) continue;
      for (const x of [line.left, line.right]) {
        for (const y of [line.top, line.bottom])
          if (((x - rect.x - rect.width / 2) / radiusX) ** 2 +
              ((y - rect.y - rect.height / 2) / radiusY) ** 2 > 1) return false;
      }
    }
  }
  return true;
}

// 固定外框内优先完整排版，放不下的内容进入居中的安全滚动区域，保留全部文字。
function measure(model, scrollTop = 0) {
  document.body.dataset.compact = 'false';
  contentPane.scrollTop = 0;
  if (document.body.dataset.layout === 'usage' &&
      (contentPane.scrollHeight > contentPane.clientHeight + 1 || !contentFitsEllipse()))
    document.body.dataset.compact = 'true';
  const scrollable = contentPane.scrollHeight > contentPane.clientHeight + 1;
  // 测量在未滚动的坐标中进行，结束后恢复已有阅读位置，不让后台刷新把长内容推回顶部。
  contentPane.scrollTop = Math.min(scrollTop, Math.max(0, contentPane.scrollHeight - contentPane.clientHeight));
  const label = model.kind === 'usage'
    ? '点击查看一句语录，点击龙娘可收起气泡'
    : '点击收起龙娘的气泡';
  bubble.setAttribute('aria-label', scrollable
    ? `${label}，长内容可用滚轮查看`
    : label);
  bridge.measureBubble({
    revision: model.revision,
    width: model.maxWidth,
    height: model.maxHeight,
  });
}

// 文字和椭圆轮廓共用交互入口，用量切换为一条语录，再点收起。
function advanceFromContent() {
  bridge.advanceBubble();
}

// 原生滚动条隐藏后保留方向键和翻页阅读，长内容仍完整存在于滚动容器中。
function scrollFromKeyboard(event) {
  if (contentPane.scrollHeight <= contentPane.clientHeight + 1) return false;
  const steps = { ArrowDown: 24, ArrowUp: -24, PageDown: contentPane.clientHeight, PageUp: -contentPane.clientHeight };
  if (Object.hasOwn(steps, event.key)) contentPane.scrollTop += steps[event.key];
  else if (event.key === 'Home') contentPane.scrollTop = 0;
  else if (event.key === 'End') contentPane.scrollTop = contentPane.scrollHeight;
  else return false;
  event.preventDefault();
  return true;
}

// 主体只绘制完整椭圆，两颗独立小泡沿下缘定位，保持原有位置和间距。
function drawOutline(model) {
  const style = getComputedStyle(bubble);
  const width = Number.parseFloat(style.width);
  const height = Number.parseFloat(style.height);
  const stroke = BUBBLE_FRAME.stroke;
  const centerX = bubble.offsetLeft + width / 2;
  const centerY = bubble.offsetTop + height / 2;
  const radiusX = width / 2 - stroke / 2;
  const radiusY = height / 2 - stroke / 2;
  outlinePath.setAttribute('d', [
    `M ${centerX} ${centerY - radiusY}`,
    `A ${radiusX} ${radiusY} 0 0 1 ${centerX + radiusX} ${centerY}`,
    `A ${radiusX} ${radiusY} 0 0 1 ${centerX} ${centerY + radiusY}`,
    `A ${radiusX} ${radiusY} 0 0 1 ${centerX - radiusX} ${centerY}`,
    `A ${radiusX} ${radiusY} 0 0 1 ${centerX} ${centerY - radiusY} Z`,
  ].join(' '));
  outlinePath.removeAttribute('transform');
  const anchorX = Math.max(centerX - radiusX + 20, Math.min(centerX + radiusX - 20, model.tailX));
  const arc = radiusY * Math.sqrt(Math.max(0, 1 - ((anchorX - centerX) / radiusX) ** 2));
  const below = model.side === 'below';
  const edge = centerY + (below ? -arc : arc);
  const rightSide = model.horizontal === 'right';
  tail.style.left = `${rightSide ? anchorX + BUBBLE_FRAME.thoughtRoot - BUBBLE_FRAME.thoughtWidth : anchorX - BUBBLE_FRAME.thoughtRoot}px`;
  tail.style.top = `${below
    ? edge - stroke / 2 - BUBBLE_FRAME.thoughtGap - BUBBLE_FRAME.thoughtHeight
    : edge + stroke / 2 + BUBBLE_FRAME.thoughtGap}px`;
}

// 内容版本只负责排版，显示轮次才负责入场动画；可见内容刷新始终在原位完成。
function render(model) {
  const showId = model.showId ?? 0;
  // 丢弃迟到的启动快照或旧布局，防止已显示的新内容被旧消息覆盖并重新隐藏。
  if (model.revision < renderedRevision || showId < renderedShowId) return;
  const opening = showId !== renderedShowId;
  const keepVisible = !opening && document.body.dataset.ready === 'true';
  const scrollTop = !opening && document.body.dataset.kind === 'usage' && model.kind === 'usage'
    ? contentPane.scrollTop : 0;
  if (opening) {
    renderedShowId = showId;
    // 只有新一轮打开才结束旧动画，后台更新不能打断正在进行的淡入或把透明度跳回零。
    for (const node of [outline, bubble, tail])
      for (const animation of node.getAnimations()) animation.cancel();
  }
  document.body.dataset.side = model.side;
  document.body.dataset.horizontal = model.horizontal || 'left';
  document.body.dataset.kind = model.kind;
  document.body.dataset.layout = model.usage ? 'usage' : 'text';
  document.body.dataset.multiple = String((model.usage?.quotas.length || 0) > 1);
  if (renderedRevision !== model.revision) {
    renderedRevision = model.revision;
    if (!keepVisible) document.body.dataset.ready = 'false';
    document.documentElement.style.setProperty('--max-width', `${model.maxWidth}px`);
    document.documentElement.style.setProperty('--max-height', `${model.maxHeight}px`);
    plan.hidden = true;
    if (model.usage) renderUsage(model.usage);
    else message.textContent = model.text;
    measure(model, scrollTop);
  }
  drawOutline(model);
  const measured = model.measuredRevision === model.revision;
  const ready = keepVisible || measured;
  document.body.dataset.ready = String(ready);
  if (!measured || animatedShowId === showId) return;
  animatedShowId = showId;
  if (showId === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const node of [outline, bubble, tail])
    node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
}

// 直接按完整椭圆命中，移除凸点后的空白与两颗独立小泡都继续穿透。
function routeCursor(point) {
  const matrix = outlinePath.getScreenCTM();
  const local = matrix && new DOMPoint(point.x, point.y).matrixTransform(matrix.inverse());
  const enabled = document.body.dataset.ready === 'true' && !!local &&
    (outlinePath.isPointInFill(local) || outlinePath.isPointInStroke(local));
  if (enabled === lastInteractive) return;
  lastInteractive = enabled;
  bridge.interactive(enabled);
}

// 等字体可用后再测量首屏，避免初始化阶段的替代字体把气泡撑大。
async function start() {
  await document.fonts.ready;
  bridge.onBubble(render);
  render(await bridge.bootstrap());
  bridge.onCursor(routeCursor);
  bridge.onInputState((enabled) => {
    lastInteractive = enabled;
  });
  window.addEventListener('pointermove', (event) => routeCursor({ x: event.clientX, y: event.clientY }));
  window.addEventListener('pointerleave', () => routeCursor({ x: -1, y: -1 }));
  bubble.addEventListener('click', advanceFromContent);
  outline.addEventListener('click', advanceFromContent);
  bubble.addEventListener('keydown', (event) => {
    if (scrollFromKeyboard(event)) return;
    // 键盘激活与鼠标点击行为一致，Esc 单独保留收起操作。
    if (['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      advanceFromContent();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      bridge.closeBubble();
    }
  });
  bridge.ready();
}

// 初始化异常时保持窗口透明、不可交互，并留下明确的诊断信息。
start().catch((error) => console.error('气泡初始化失败：', error));
