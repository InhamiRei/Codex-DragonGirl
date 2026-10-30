import { BUBBLE_FRAME } from '../shared/geometry.js';

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
let animatedRevision = -1;

// 所有动态内容都通过文本节点写入，账户名称与自定义模板不能注入 HTML。
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 用量以漫画对白的居中层次呈现，单个额度直接组成标题，多桶仍逐项保留。
function renderUsage(usage) {
  plan.textContent = usage.plan;
  plan.hidden = false;
  quotaTitle.textContent = usage.quotas.length === 1 ? `${usage.quotas[0].label}剩余` : '';
  quotaTitle.hidden = usage.quotas.length !== 1;
  const content = element('div', 'usage');
  content.dataset.multiple = String(usage.quotas.length > 1);
  for (const quota of usage.quotas) {
    const row = element('div', 'quota');
    row.dataset.low = String(quota.low);
    const heading = element('div', 'quota-heading');
    const remaining = quota.remaining > 0 && quota.remaining < 1 ? '<1' : Math.round(quota.remaining);
    const value = element('span', 'quota-value', remaining);
    value.append(element('span', 'quota-unit', '%'));
    // 用紧凑的剩余标签给百分比留出宽度，普通双额度不因标点和空格被挤成两行。
    heading.append(element('span', 'quota-label', `${quota.label}剩余`), value);
    row.append(heading);
    content.append(row);
  }
  if (usage.quotaNote) content.append(element('p', 'quota-note', usage.quotaNote));
  const footer = element('div', 'usage-footer');
  const today = element('div', 'today');
  today.append(
    element('span', 'metric-label', '今日已用'),
    element('span', 'metric-value', usage.tokens),
    element('span', 'metric-unit', 'Tokens'),
  );
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
function measure(model) {
  document.body.dataset.compact = 'false';
  contentPane.scrollTop = 0;
  if (document.body.dataset.layout === 'usage' &&
      (contentPane.scrollHeight > contentPane.clientHeight + 1 || !contentFitsEllipse()))
    document.body.dataset.compact = 'true';
  const scrollable = contentPane.scrollHeight > contentPane.clientHeight + 1;
  bubble.setAttribute('aria-label', scrollable
    ? '点击收起龙娘的气泡，长内容可用滚轮或上下方向键查看'
    : '点击收起龙娘的气泡');
  bridge.measureBubble({
    revision: model.revision,
    width: model.maxWidth,
    height: model.maxHeight,
  });
}

// 没有可见滚动条后，内容区域不再保留无效的点击死区。
function closeFromContent() {
  bridge.closeBubble();
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

// 内容变化才重新测量；位置与尾巴更新不重复播放动画，也不触发尺寸反馈循环。
function render(model) {
  document.body.dataset.side = model.side;
  document.body.dataset.horizontal = model.horizontal || 'left';
  document.body.dataset.kind = model.kind;
  document.body.dataset.layout = model.usage ? 'usage' : 'text';
  document.body.dataset.multiple = String((model.usage?.quotas.length || 0) > 1);
  if (renderedRevision !== model.revision) {
    // 内容变化时结束上一句的淡入，保证文字与连续轮廓同时显示。
    for (const node of [outline, bubble, tail])
      for (const animation of node.getAnimations()) animation.cancel();
    renderedRevision = model.revision;
    document.body.dataset.ready = 'false';
    document.documentElement.style.setProperty('--max-width', `${model.maxWidth}px`);
    document.documentElement.style.setProperty('--max-height', `${model.maxHeight}px`);
    plan.hidden = true;
    if (model.usage) renderUsage(model.usage);
    else message.textContent = model.text;
    measure(model);
  }
  drawOutline(model);
  const ready = model.measuredRevision === model.revision;
  document.body.dataset.ready = String(ready);
  if (!ready || animatedRevision === model.revision) return;
  animatedRevision = model.revision;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
  bubble.addEventListener('click', closeFromContent);
  outline.addEventListener('click', () => bridge.closeBubble());
  bubble.addEventListener('keydown', (event) => {
    if (scrollFromKeyboard(event)) return;
    if (['Enter', ' ', 'Escape'].includes(event.key)) {
      event.preventDefault();
      bridge.closeBubble();
    }
  });
  bridge.ready();
}

// 初始化异常时保持窗口透明、不可交互，并留下明确的诊断信息。
start().catch((error) => console.error('气泡初始化失败：', error));
