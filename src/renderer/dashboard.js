import { AUDIO_FILES, audioFile, eventAudioId } from '../shared/audio-library.js';
import { enhanceSelects, syncSelects, closeSelects, destroySelects } from './select.js';
import { planLabel, instanceLabel, originLabel } from '../shared/presentation.js';
import { SoundEngine } from './audio.js';
import { dayKey, midnight, nextDay } from '../shared/time.js';
import { activityCalendar, activityLevel } from '../shared/activity.js';
import { AccountTestsView } from './account-tests.js';
const bridge = window.dragonGirl,
  sound = new SoundEngine();
let state,
  draft,
  appearance,
  activeTab = 'overview',
  activeSettingsTab = 'appearance',
  report,
  filter = {},
  toastTimer,
  dirty = false,
  reportLoading = false,
  reportRequest = 0,
  threadPage = 1,
  activityMode = 'daily',
  activityYear,
  refreshing = false,
  tooltipTarget;
const THREAD_PAGE_SIZE = 20;
let accountTests;
const $ = (selector) => document.querySelector(selector);
const names = {
  press: '按下',
  release: '松开',
  complete: '任务完成',
  error: '任务异常',
  question: '等待回答',
  approval: '等待授权',
  quota: '额度提醒',
};
// 所有用户或日志文本以 textContent 创建，避免注入 HTML。
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
// 所有 IPC 错误都显示为可见反馈，操作失败不假装保存成功。
async function call(command, value) {
  try {
    return await bridge.command(command, value);
  } catch (error) {
    toast(error.message.replace(/^Error invoking remote method [^:]+: Error: /, ''));
    throw error;
  }
}
// 轻量提示不会阻塞其他账号的数据更新。
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 5000);
}
// 数字与日期展示统一使用本地界面的精度和所选时区。
function compact(n) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(
    n || 0,
  );
}
// 金额明确保留未知状态，人民币只按用户设置的参考汇率换算。
function money(value) {
  if (value === null || value === undefined) return '未定价';
  const cny = state.settings.currency === 'CNY';
  const amount = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    notation:
      Math.abs(value * (cny ? state.settings.exchangeRate : 1)) >= 10000 ? 'compact' : 'standard',
  }).format(value * (cny ? state.settings.exchangeRate : 1));
  return `${amount} ${cny ? '元' : '美元'}`;
}
// 绝对日期和倒计时同时展示，不把计时器结束当作后台已恢复额度。
function resetText(time) {
  if (!time) return '重置时间未提供';
  const remaining = time - Date.now(),
    absolute = new Intl.DateTimeFormat('zh-CN', {
      timeZone: state.settings.timezone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(time);
  if (remaining <= 0) return `等待服务确认重置 · ${absolute}`;
  const minutes = Math.ceil(remaining / 60000),
    days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60);
  return `${days ? days + '天 ' : ''}${hours}小时 ${minutes % 60}分后 · ${absolute}`;
}
// 重置卡提示只展示服务返回的可用数量与到期信息，缺失明细不推测为永久有效。
function resetCreditText(credits, stale) {
  const lines = [`可用重置卡 ${credits.count} 张`];
  if (stale) lines.push('上次读数已过期，等待刷新');
  if (credits.count === 0) lines.push('当前没有可用重置卡');
  else if (!credits.details?.length) lines.push('服务未返回到期明细');
  else {
    const format = new Intl.DateTimeFormat('zh-CN', {
      timeZone: state.settings.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    for (const [index, credit] of credits.details.entries()) {
      const expiry = !credit.expiryKnown
        ? '到期时间未知'
        : credit.expiresAt === null
          ? '无到期限制'
          : `${format.format(credit.expiresAt)} 到期${credit.expiresAt <= Date.now() ? '（等待刷新确认）' : ''}`;
      lines.push(`第 ${index + 1} 张 · ${expiry}`);
    }
    if (credits.details.length < credits.count) lines.push('其余重置卡未返回到期明细');
  }
  return lines.join('\n');
}
// 路由只切换本地内容区，设置草稿不因切页丢失。
function switchTab(tab) {
  const titles = {
    overview: ['账户总览', '查看各个实例的额度与使用情况。'],
    usage: ['用量账本', '按日期、实例和模型查看本机记录。'],
    'account-tests': ['账号测智', '统一题目和参数，对比各个账号的回答。'],
    settings: ['偏好设置', '调整显示、声音与统计偏好。'],
  };
  if (!titles[tab]) return;
  closeSelects();
  activeTab = tab;
  hideChartTooltip();
  $('#content-scroll').scrollTop = 0;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== tab;
  for (const button of document.querySelectorAll('.main-nav button')) {
    const selected = button.dataset.tab === tab;
    button.classList.toggle('selected', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('#settings-save-bar').hidden = tab !== 'settings';
  $('#title').textContent = titles[tab][0];
  $('#subtitle').textContent = titles[tab][1];
  $('#toggle-filter').hidden = tab !== 'usage';
  if (tab === 'usage') void loadReport();
  if (tab === 'account-tests') void accountTests.open().catch(() => {});
  if (tab === 'settings') {
    if (!draft) fillSettings(state.settings);
    switchSettingsTab(activeSettingsTab);
  }
}

// 设置分类使用固定行布局，同一份草稿在分类之间保留。
function switchSettingsTab(tab) {
  closeSelects();
  activeSettingsTab = tab;
  for (const pane of document.querySelectorAll('[data-settings-pane]'))
    pane.hidden = pane.dataset.settingsPane !== tab;
  for (const button of document.querySelectorAll('[data-settings-tab]')) {
    const selected = button.dataset.settingsTab === tab;
    button.classList.toggle('selected', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('#content-scroll').scrollTop = 0;
}

// 所有修改通过同一入口标记，底部保存栏准确反映草稿状态。
function markDirty() {
  dirty = true;
  $('#dirty-hint').textContent = '有未保存的修改';
  $('#dirty-hint').dataset.dirty = 'true';
}

// 滑块、数值和填充条同步更新，保持各行同一视觉基线。
function updateRange(input) {
  const min = Number(input.min) || 0,
    max = Number(input.max) || 1;
  input.style.setProperty(
    '--range-progress',
    `${Math.max(0, Math.min(100, ((Number(input.value) - min) / (max - min)) * 100))}%`,
  );
  if (input.name === 'scale')
    $('#scale-label').textContent = `${Math.round(Number(input.value) * 100)}%`;
  if (input.name === 'volume')
    $('#volume-label').textContent = `${Math.round(Number(input.value) * 100)}%`;
}
// 指标卡复用同一数据结构，空值不会被格式化成费用零。
function metrics(target, items) {
  target.replaceChildren(
    ...items.map(([label, value, note]) => {
      const card = node('article', 'metric');
      card.append(
        node('div', 'metric-label', label),
        node('div', 'metric-value', value),
        node('div', 'metric-note', note),
      );
      return card;
    }),
  );
}
// 简洁柱图提供原始数值提示，可在无图形库的离线安装包中使用。
function chart(target, daily, limit = 30) {
  const entries = Object.entries(daily || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-limit),
    max = Math.max(1, ...entries.map(([, v]) => v));
  target.replaceChildren();
  if (!entries.length) {
    target.append(node('p', 'empty', '暂无本机用量记录'));
    return;
  }
  for (const [day, value] of entries) {
    const column = node('div', 'chart-col'),
      bar = node('div', 'chart-bar');
    bar.style.height = `${Math.max(2, (value / max) * 105)}px`;
    chartHint(bar, `${day}\n${Number(value).toLocaleString('zh-CN')} Tokens`);
    column.append(bar, node('span', 'chart-label', entries.length > 15 ? day.slice(8) : day.slice(5)));
    target.append(column);
  }
}
// 账户与图表共用即时提示，键盘聚焦也能查看，不依赖系统 title 延迟。
function chartHint(element, text, key) {
  element.tabIndex = 0;
  element.dataset.tooltip = text;
  if (key) element.dataset.tooltipKey = key;
  element.setAttribute('aria-label', text.replaceAll('\n', ' · '));
  // 旧节点移除后的离开事件不能关闭已经绑定到新节点的提示。
  const hide = () => {
    if (tooltipTarget === element) hideChartTooltip();
  };
  element.addEventListener('pointerenter', () => showTooltip(element));
  // 滚动或调整窗口后继续移动鼠标，也能重新显示当前元素的提示。
  element.addEventListener('pointermove', () => {
    if (tooltipTarget !== element) showTooltip(element);
  });
  element.addEventListener('focus', () => showTooltip(element));
  element.addEventListener('pointerleave', hide);
  element.addEventListener('blur', hide);
}
// 固定提示避开视口边界，并将无障碍描述绑定到当前悬停或聚焦的元素。
function showTooltip(element) {
  tooltipTarget?.removeAttribute('aria-describedby');
  tooltipTarget = element;
  element.setAttribute('aria-describedby', 'chart-tooltip');
  const tooltip = $('#chart-tooltip');
  tooltip.textContent = element.dataset.tooltip;
  tooltip.hidden = false;
  const rect = element.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - tooltip.offsetWidth - 8, rect.x + rect.width / 2 - tooltip.offsetWidth / 2))}px`;
  const top = rect.top > tooltip.offsetHeight + 16 ? rect.top - tooltip.offsetHeight - 8 : rect.bottom + 8;
  tooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - tooltip.offsetHeight - 8, top))}px`;
}
// 页面滚动或重绘后移除旧提示，避免提示悬在已经移动的格子旁边。
function hideChartTooltip() {
  $('#chart-tooltip').hidden = true;
  tooltipTarget?.removeAttribute('aria-describedby');
  tooltipTarget = null;
}
// 全宽年度热力图按自然日补齐空格，周汇总与累计模式使用相同一份账本数据。
function renderActivity() {
  hideChartTooltip();
  const today = dayKey(Date.now(), state.settings.timezone);
  const years = [...new Set([today.slice(0, 4), ...Object.keys(report.daily).map((day) => day.slice(0, 4))])].sort().reverse();
  if (!years.includes(String(activityYear))) activityYear = Number(years[0]);
  const select = $('#activity-year');
  select.replaceChildren(...years.map((year) => new Option(`${year} 年`, year)));
  select.value = String(activityYear);
  syncSelects(select.parentElement);
  const weeks = activityCalendar(report.daily, activityYear, today);
  const days = weeks.flatMap((week) => week.days);
  const max = Math.max(0, ...days.map((day) => day.value));
  const target = $('#usage-chart');
  target.replaceChildren();
  target.dataset.mode = activityMode;
  target.style.setProperty('--weeks', weeks.length);
  const months = node('div', 'activity-months');
  let lastMonth;
  for (const [index, week] of weeks.entries()) {
    const day = week.days.find((day) => day.inYear);
    const month = day?.day.slice(5, 7);
    if (month && month !== lastMonth) {
      const label = node('span', '', `${Number(month)}月`);
      label.style.gridColumn = `${index + 1} / span 2`;
      months.append(label);
      lastMonth = month;
    }
  }
  if (activityMode === 'daily') {
    const grid = node('div', 'activity-days');
    for (const day of days) {
      const cell = node('div', 'activity-cell');
      cell.dataset.day = day.day;
      cell.dataset.level = activityLevel(day.value, max);
      // 只隐藏跨年的对齐格；本年未来日期保留占位，区别于过去真实的零用量。
      if (!day.inYear) cell.classList.add('unavailable');
      else if (!day.available) {
        cell.classList.add('future');
        chartHint(cell, `${day.day}\n尚未到来`);
      } else chartHint(cell, `${day.day}\n${day.value.toLocaleString('zh-CN')} Tokens${day.value ? '' : ' · 无用量记录'}`);
      grid.append(cell);
    }
    target.append(grid);
  } else {
    const grid = node('div', 'activity-weeks');
    const maxValue = Math.max(1, ...weeks.map((week) => activityMode === 'weekly' ? week.value : week.cumulative));
    for (const week of weeks) {
      const value = activityMode === 'weekly' ? week.value : week.cumulative;
      const column = node('div', 'activity-week');
      const bar = node('div', 'activity-week-bar');
      bar.style.height = `${Math.max(2, value / maxValue * 128)}px`;
      if (!week.from) column.classList.add('unavailable');
      else chartHint(column, `${week.from} 至 ${week.to}\n${activityMode === 'weekly' ? '本周' : '年内累计'} ${value.toLocaleString('zh-CN')} Tokens`);
      column.append(bar);
      grid.append(column);
    }
    target.append(grid);
  }
  target.append(months);
  const total = weeks.at(-1)?.cumulative || 0;
  $('#activity-summary').textContent = `${activityYear} 年 · ${total.toLocaleString('zh-CN')} Tokens · ${days.filter((day) => day.value > 0).length} 个活跃日${activityMode === 'cumulative' ? ' · 按周累计' : ''}`;
  $('.activity-legend').hidden = activityMode !== 'daily';
}
// 每个实例单独显示实时性和错误，共用账户时标明共享而不合计百分比。
function accountCard(instance) {
  const card = node('article', 'account'),
    header = node('div', 'account-head'),
    badges = node('div', 'account-badges'),
    plan = instance.account?.planType || instance.quota?.buckets[0]?.plan || null;
  // 重置卡与套餐并排放在卡片右上角，详情只在悬停或键盘聚焦时展开。
  const credits = instance.quota?.resetCredits;
  if (credits) {
    const badge = node('span', 'reset-credits', `重置卡 ${credits.count} 张`);
    chartHint(badge, resetCreditText(credits, instance.stale), instance.id);
    badges.append(badge);
  }
  badges.append(node('span', 'plan', planLabel(instance.account?.type === 'apiKey' ? 'apiKey' : plan)));
  header.append(
    node('div', 'account-name', instanceLabel(instance, state.settings)),
    badges,
  );
  // 今日用量按当前实例统计，放到运行信息旁，避免在额度下方重复占用一整行。
  const meta = node('div', 'account-meta');
  meta.append(
    node(
      'span',
      instance.running ? 'online' : '',
      instance.running ? `${instance.pids.length} 个进程运行中` : '未运行',
    ),
    node('span', '', `· ${originLabel(instance.origin)}`),
    node(
      'span',
      'account-usage',
      state.today
        ? `· 今日消耗 ${compact(state.today.homes[instance.id])} Tokens`
        : '· 今日消耗正在统计',
    ),
  );
  card.append(header, meta);
  const duplicate = state.instances.find(
    (i) => i.id !== instance.id && instance.identity && i.identity === instance.identity,
  );
  if (duplicate)
    card.append(
      node(
        'div',
        'account-note',
        `与「${instanceLabel(duplicate, state.settings)}」共享账户额度；本机记录各自归属。`,
      ),
    );
  if (instance.quota?.buckets.length) {
    for (const bucket of instance.quota.buckets) {
      if (instance.quota.buckets.length > 1) card.append(node('span', 'muted', bucket.name));
      for (const window of bucket.windows) {
        const row = node(
            'div',
            `quota-row ${instance.stale ? 'stale' : ''} ${window.remaining <= 20 ? 'critical' : window.remaining <= 50 ? 'warning' : ''}`,
          ),
          top = node('div', 'quota-top'),
          track = node('div', 'track'),
          fill = node('div', 'fill');
        top.append(
          node('span', '', window.label),
          node(
            'span',
            'quota-value',
            `${window.remaining > 0 && window.remaining < 1 ? '不足 1' : window.remaining.toFixed(0)}% 剩余`,
          ),
        );
        fill.style.width = `${window.remaining}%`;
        track.append(fill);
        row.append(top, track, node('div', 'quota-reset', resetText(window.resetsAt)));
        card.append(row);
      }
    }
    if (instance.quota.allowed === false)
      card.append(node('div', 'account-note error-note', '服务当前报告：普通额度不可用'));
  } else
    card.append(
      node('div', 'account-note', instance.loading ? '正在读取官方额度…' : '尚未取得额度数据'),
    );
  if (instance.error || instance.stale)
    card.append(
      node(
        'div',
        'account-note error-note',
        instance.error || (instance.quota ? '上次读数已过期，等待刷新' : '暂未连接'),
      ),
    );
  const foot = node('div', 'account-footer'),
    focus = node('button', '', instance.running ? '定位窗口' : '查看账本');
  focus.addEventListener('click', () => {
    if (instance.running) void call('focus', instance.id);
    else {
      $('#filter-home').value = instance.id;
      filter = { home: instance.id };
      threadPage = 1;
      updateFilterButton();
      switchTab('usage');
    }
  });
  foot.append(
    node(
      'span',
      '',
      instance.loading
        ? '正在刷新…'
        : `${instance.taskState === 'working' ? '● 工作中 · ' : ''}${instance.quota ? `更新于 ${new Date(instance.quota.capturedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '等待连接'}`,
    ),
    focus,
  );
  card.append(foot);
  return card;
}
// 概览仅按索引已完成的实际数据展示，并持续报告首次扫描进度。
function renderOverview() {
  const instances = state.instances || [],
    today = state.today;
  $('#connection').textContent =
    `${instances.filter((i) => i.running).length} / ${instances.length} 实例在线`;
  $('#instance-count').textContent = instances.length;
  metrics($('#metrics'), [
    [
      '今日本机用量',
      today ? compact(today.total) : '—',
      today ? '已索引记录 · Tokens' : '正在读取本机记录',
    ],
    [
      '运行实例',
      `${instances.filter((i) => i.running).length} / ${instances.length}`,
      '自动发现 · 独立目录',
    ],
    [
      '缓存命中',
      today?.input ? `${Math.round((today.cached / today.input) * 100)}%` : '—',
      '缓存读取 / 全部输入',
    ],
    ['今日参考费用', money(today?.cost), `定价覆盖 ${Math.round((today?.coverage || 0) * 100)}%`],
  ]);
  // 后台会频繁推送状态；按实例恢复原提示，避免读卡片详情时被重绘打断。
  const hint = tooltipTarget?.dataset.tooltipKey
    ? {
        key: tooltipTarget.dataset.tooltipKey,
        focused: document.activeElement === tooltipTarget,
        rect: tooltipTarget.getBoundingClientRect(),
      }
    : null;
  $('#accounts').replaceChildren(...instances.map(accountCard));
  if (hint) {
    const next = [...document.querySelectorAll('#accounts [data-tooltip-key]')].find(
      (element) => element.dataset.tooltipKey === hint.key,
    );
    if (next && hint.focused) next.focus({ preventScroll: true });
    else if (next) {
      const rect = next.getBoundingClientRect();
      if (Math.abs(rect.x - hint.rect.x) < 1 && Math.abs(rect.y - hint.rect.y) < 1) showTooltip(next);
      else hideChartTooltip();
    } else hideChartTooltip();
  }
  if (!instances.length)
    $('#accounts').append(node('div', 'panel empty', '尚未发现数据目录，可以手动添加。'));
  chart($('#overview-chart'), state.summary?.daily, 14);
  $('#updated').textContent = state.indexedAt
    ? `索引更新 ${new Date(state.indexedAt).toLocaleTimeString()}`
    : '正在准备统计记录';
  const progress = state.progress || {};
  $('#index-state').textContent =
    state.indexError ||
    (!progress.complete && progress.total
      ? `正在建立本机账本 ${progress.done} / ${progress.total} · 账户额度可独立查看`
      : progress.errors?.length
        ? `${progress.errors.length} 份日志无法读取，可导出诊断查看`
        : '');
  $('#index-state').hidden = !$('#index-state').textContent;
}
// 选择列表更新时保留用户的筛选，不把前台实例变化当作筛选切换。
function updateSelect(selector, values, first) {
  const select = $(selector),
    previous = select.value;
  const next = [['', first], ...values];
  const current = [...select.options].map((o) => [o.value, o.label]);
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    select.replaceChildren(...next.map(([value, label]) => new Option(label, value)));
    select.value = next.some(([value]) => value === previous) ? previous : '';
  }
  syncSelects(select.parentElement);
}
// 桌面后台推送不会覆盖用户正在编辑的表单。
function receive(next) {
  state = { ...state, ...next };
  renderOverview();
  renderRefresh();
  accountTests?.updateAccounts();
  updateSelect(
    '#filter-home',
    state.instances.map((i) => [i.id, instanceLabel(i, state.settings)]),
    '全部实例',
  );
  updateSelect(
    '#filter-project',
    (state.projects || []).map((p) => [p, p.split('/').pop() || p]),
    '全部项目',
  );
  updateSelect(
    '#filter-model',
    Object.keys(state.summary?.models || {})
      .sort()
      .map((m) => [m, m]),
    '全部模型',
  );
  if (activeTab === 'usage' && !reportLoading && next.indexedAt !== report?.indexedAt) void loadReport();
}
// 筛选面板只是草稿；按钮标记仅由已经提交的条件决定。
function updateFilterButton() {
  const count = Object.values(filter).filter((value) => value !== '' && value !== undefined).length;
  $('#filter-button-label').textContent = count ? '筛选 · 已启用' : '筛选';
  $('#toggle-filter').classList.toggle('active', count > 0);
}
// 刷新结果区分失败、退避与成功；数值未变化时仍显示本次读取时间。
function refreshText(result) {
  if (result.running) return `正在刷新 ${result.success + result.failed} / ${result.total} 个账户与本机账本…`;
  if (!result.finishedAt) return '';
  return `${new Date(result.finishedAt).toLocaleTimeString('zh-CN', { hour12: false })} · ${result.success} 个账户已更新${result.failed ? `，${result.failed} 个失败` : ''}${result.skipped ? `，${result.skipped} 个限流待重试` : ''} · ${result.indexError || (result.scanErrors ? `账本已更新，${result.scanErrors} 份日志读取失败` : '本机账本已更新')}`;
}
// 手动刷新期间禁用重复请求，菜单发起的同一轮刷新也同步到界面。
function renderRefresh() {
  const result = state.refreshState;
  const busy = refreshing || result?.running;
  $('#refresh').disabled = !!busy;
  $('#refresh').setAttribute('aria-busy', String(!!busy));
  $('#refresh-label').textContent = busy ? '正在刷新…' : '刷新账户';
  $('#refresh-status').hidden = !result;
  $('#refresh-status').textContent = result ? refreshText(result) : '';
}
// 按钮等待后台真实完成，再查询当前已应用条件，保留用户尚未提交的筛选草稿。
async function refreshAccounts() {
  if (refreshing) return;
  refreshing = true;
  renderRefresh();
  try {
    const result = await call('refresh');
    receive(await call('snapshot'));
    state.refreshState = result;
    if (activeTab === 'usage') await loadReport();
    toast(refreshText(result));
  } finally {
    refreshing = false;
    renderRefresh();
  }
}
// 日期筛选采用所选时区的自然日边界，结束日期包含整天。
function currentFilter() {
  return {
    home: $('#filter-home').value,
    model: $('#filter-model').value,
    source: $('#filter-source').value,
    project: $('#filter-project').value,
    tier: $('#filter-tier').value,
    ...($('#filter-from').value
      ? { from: midnight($('#filter-from').value, state.settings.timezone) }
      : {}),
    ...($('#filter-to').value
      ? { to: midnight(nextDay($('#filter-to').value), state.settings.timezone) }
      : {}),
  };
}
// 查询只在必要时执行，失败后保留上次完整结果。
async function loadReport() {
  if (!state) return;
  const request = ++reportRequest;
  const query = { ...filter };
  const indexedAt = state.indexedAt;
  reportLoading = true;
  $('#apply-filter').disabled = true;
  try {
    const next = await call('report', query);
    if (request !== reportRequest) return;
    report = { ...next, indexedAt, filter: query };
    renderReport();
  } catch {
  } finally {
    if (request === reportRequest) {
      reportLoading = false;
      $('#apply-filter').disabled = false;
    }
  }
}
// 子树合计只计算显式父子关系，并通过 visited 防止损坏关系形成循环。
function subtree(thread, all, visited = new Set()) {
  const id = thread.home + thread.thread;
  if (visited.has(id)) return 0;
  visited.add(id);
  return (
    thread.tokens +
    all
      .filter((t) => t.home === thread.home && t.parent === thread.thread)
      .reduce((sum, t) => sum + subtree(t, all, visited), 0)
  );
}
// 账本模型分布、图表与表格都来自同一次筛选后的聚合。
function renderReport() {
  if (!report) return;
  metrics($('#usage-metrics'), [
    ['本机 Tokens', compact(report.total), `${report.requests.toLocaleString()} 条请求 / 增量记录`],
    [
      '输入 Tokens',
      compact(report.input),
      `输出 ${compact(report.output)} · 缓存 ${compact(report.cached)}`,
    ],
    ['推理 Tokens', compact(report.reasoning), '包含在输出中，不重复累加'],
    ['参考费用', money(report.cost), `定价覆盖 ${Math.round(report.coverage * 100)}%`],
  ]);
  renderActivity();
  const models = $('#model-bars');
  models.replaceChildren();
  for (const [model, count] of Object.entries(report.models)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)) {
    const row = node('div', 'model-row'),
      labels = node('div'),
      track = node('div', 'track'),
      fill = node('div', 'fill');
    labels.append(node('span', '', model), node('span', '', compact(count)));
    fill.style.width = `${(count / Math.max(report.total, 1)) * 100}%`;
    track.append(fill);
    row.append(labels, track);
    models.append(row);
  }
  renderThreads();
}
// 搜索只展示项目名与会话标识，账本从不存储提示词或模型回答。
function renderThreads() {
  const search = $('#thread-search').value.toLowerCase(),
    threads = report.threads.filter((t) => `${t.project} ${t.thread}`.toLowerCase().includes(search));
  const body = $('#thread-rows');
  body.replaceChildren();
  const pages = Math.max(1, Math.ceil(threads.length / THREAD_PAGE_SIZE));
  threadPage = Math.max(1, Math.min(threadPage, pages));
  const start = (threadPage - 1) * THREAD_PAGE_SIZE;
  for (const t of threads.slice(start, start + THREAD_PAGE_SIZE)) {
    const row = node('tr'),
      name = node('td', '', `${t.parent ? '↳ ' : ''}${t.project.split('/').pop() || '未记录项目'}`);
    name.title = t.project;
    name.append(node('small', 'thread-sub', t.thread.slice(0, 18)));
    row.append(
      name,
      node(
        'td',
        '',
        instanceLabel(
          state.instances.find((i) => i.id === t.home) || { name: '历史实例' },
          state.settings,
        ),
      ),
      node('td', '', t.source),
      node('td', '', compact(t.tokens)),
      node('td', '', compact(subtree(t, report.threads))),
      node('td', '', t.pricedTokens ? t.cost.toFixed(4) : '未定价'),
      node('td', '', new Date(t.lastAt).toLocaleDateString('zh-CN')),
    );
    body.append(row);
  }
  if (!threads.length) {
    const row = node('tr');
    const empty = node('td', 'empty', '没有匹配的会话');
    empty.colSpan = 7;
    row.append(empty);
    body.append(row);
  }
  $('#row-count').textContent =
    `共 ${threads.length} 个会话 · 每页 ${THREAD_PAGE_SIZE} 条${threads.length ? ` · 当前 ${start + 1}–${Math.min(start + THREAD_PAGE_SIZE, threads.length)} 条` : ''}`;
  $('#thread-page').textContent = `${threadPage} / ${pages}`;
  $('#threads-prev').disabled = threadPage <= 1;
  $('#threads-next').disabled = threadPage >= pages;
}
// 表单草稿与已保存设置分离，试听不会提前保存。
function fillSettings(settings) {
  draft = structuredClone(settings);
  dirty = false;
  const form = $('#settings-form');
  for (const [key, value] of Object.entries(draft)) {
    const field = form.elements.namedItem(key);
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = value;
    else if (typeof value !== 'object') field.value = value;
  }
  updateSelect(
    '#selected-home',
    state.instances.map((i) => [i.home, instanceLabel(i, state.settings)]),
    '自动跟随前台实例',
  );
  form.elements.selectedHome.value = draft.selectedHome;
  form.elements.scale.value = appearance?.scale || 1;
  form.elements.snapEnabled.checked = appearance?.snapEnabled ?? true;
  $('#scale-label').textContent = `${Math.round(form.elements.scale.value * 100)}%`;
  $('#permission-status').textContent = state.screenPermission
    ? '已获得窗口信息权限。'
    : '跟随异常时可检查权限，统计功能仍可使用。';
  renderSoundSettings();
  void refreshAudioStatus();
  renderInstanceSettings();
  renderPrices();
  syncSelects(form);
  for (const range of form.querySelectorAll('input[type=range]')) updateRange(range);
  $('#dirty-hint').textContent = '更改将在保存后生效';
  $('#dirty-hint').dataset.dirty = 'false';
}
// 读取控件只修改草稿，不变更后台采集器。
function readDraft() {
  const form = $('#settings-form');
  for (const key of Object.keys(draft)) {
    const field = form.elements.namedItem(key);
    if (!field) continue;
    if (field.type === 'checkbox') draft[key] = field.checked;
    else if (field.type === 'number' || field.type === 'range') draft[key] = Number(field.value);
    else draft[key] = field.value;
  }
  return draft;
}
// 点击使用成对原声，其他事件仅从原项目现有的九段音频中选择。
function renderSoundSettings() {
  const box = $('#sound-rows');
  destroySelects(box);
  box.replaceChildren();
  for (const [key, label] of Object.entries(names)) {
    const row = node('div', 'sound-row'),
      slider = node('input'),
      value = node('output', 'sound-value');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '.05';
    slider.value = draft.eventVolumes[key];
    slider.setAttribute('aria-label', `${label}音量`);
    value.textContent = `${Math.round(Number(slider.value) * 100)}%`;
    updateRange(slider);
    slider.oninput = () => {
      draft.eventVolumes[key] = Number(slider.value);
      value.textContent = `${Math.round(Number(slider.value) * 100)}%`;
      updateRange(slider);
      markDirty();
    };
    let selection;
    if (key === 'press' || key === 'release') {
      selection = node('span', 'sound-original', audioFile(eventAudioId(key, draft)).label);
      selection.title = '跟随上方选择的点击音效组';
    } else {
      selection = node('select');
      selection.id = `event-audio-${key}`;
      selection.setAttribute('aria-label', `${label}原声音效`);
      selection.append(...AUDIO_FILES.map((file) => new Option(file.label, file.id)));
      selection.value = eventAudioId(key, draft);
      selection.onchange = () => {
        draft.eventSounds[key] = selection.value;
        markDirty();
      };
    }
    const preview = node('button', '', '试听');
    preview.type = 'button';
    preview.onclick = async () => {
      sound.configure(readDraft());
      await sound.play(key, true);
      if (sound.lastError) toast(sound.lastError);
    };
    row.append(node('span', '', label), selection, slider, value, preview);
    box.append(row);
  }
  enhanceSelects(box);
}

// 内置原声与旧版本机原声均计入就绪状态，新安装直接显示可离线播放。
async function refreshAudioStatus() {
  try {
    const status = await call('audio-status');
    $('#audio-library-status').textContent = status.complete
      ? `${status.bundled ? '应用已内置原声音效' : '本机原声音效已就绪'}：两组点击音效，共九段原声，离线可用。`
      : `原声音效库已就绪 ${status.installed} / ${status.total} 段，可点击下方按钮修复。`;
  } catch {}
}
// 别名和显示隐藏仅属于龙娘，不改变 Cockpit 的实例注册表。
function renderInstanceSettings() {
  const box = $('#instance-settings');
  box.replaceChildren();
  for (const i of state.instances) {
    const row = node('div', 'instance-setting'),
      label = node('div', '', instanceLabel(i, state.settings)),
      input = node('input'),
      hide = node('button', '', '隐藏');
    label.append(node('small', '', i.home));
    input.value = draft.aliases[i.home] || '';
    input.placeholder = '自定义别名';
    input.setAttribute('aria-label', `${i.name}别名`);
    input.oninput = () => {
      draft.aliases[i.home] = input.value;
      markDirty();
    };
    hide.type = 'button';
    hide.onclick = () => {
      draft.hiddenHomes = [...new Set([...draft.hiddenHomes, i.home])];
      row.hidden = true;
      markDirty();
    };
    row.append(label, input, hide);
    box.append(row);
  }
  if (draft.hiddenHomes.length) {
    const reset = node('button', '', '恢复隐藏实例');
    reset.type = 'button';
    reset.onclick = () => {
      draft.hiddenHomes = [];
      markDirty();
      toast('保存后重新发现隐藏实例');
    };
    box.append(reset);
  }
}
// 价格只按明确填写的模型匹配，不将未知内部模型猜成其他公开模型。
function renderPrices() {
  const box = $('#price-list');
  box.replaceChildren();
  for (const [model, p] of Object.entries(draft.prices)) {
    const row = node('div', 'price-item'),
      remove = node('button', '', '移除');
    remove.type = 'button';
    remove.onclick = () => {
      delete draft.prices[model];
      markDirty();
      renderPrices();
    };
    row.append(
      node('span', '', `${model} · 输入 ${p.input} / 缓存 ${p.cached} / 输出 ${p.output}`),
      remove,
    );
    box.append(row);
  }
}
// 为普通按钮安装统一错误边界，避免 Promise 失败形成未处理异常。
function action(id, callback) {
  $(id).addEventListener('click', () =>
    Promise.resolve()
      .then(callback)
      .catch(() => {}),
  );
}
// 初始化事件只注册一次，后续实时推送不重建导航监听。
async function start() {
  enhanceSelects();
  state = await call('snapshot');
  accountTests = new AccountTestsView({ call, toast, getState: () => state });
  bridge.onAccountTests((run) => accountTests.receive(run));
  appearance = state.appearance;
  renderOverview();
  receive(state);
  bridge.onMonitor(receive);
  // 修复后的试听与角色播放同步恢复，设置草稿保持当前内容。
  bridge.onAudioReady(() => {
    void sound.configure(sound.settings);
    void refreshAudioStatus();
  });
  for (const b of document.querySelectorAll('.main-nav button'))
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  for (const button of document.querySelectorAll('[data-settings-tab]'))
    button.addEventListener('click', () => switchSettingsTab(button.dataset.settingsTab));
  for (const button of document.querySelectorAll('[data-insert]'))
    button.addEventListener('click', () => {
      const field = $('#bubble-template');
      const position = field.selectionStart;
      field.setRangeText(`{${button.dataset.insert}}`, position, field.selectionEnd, 'end');
      field.focus();
      markDirty();
    });
  action('#refresh', refreshAccounts);
  action('#add-home', () => call('add-home'));
  action('#settings-add-home', () => call('add-home'));
  action('#goto-usage', () => switchTab('usage'));
  action('#toggle-filter', () => {
    const panel = $('#filter-panel');
    panel.hidden = !panel.hidden;
    $('#toggle-filter').setAttribute('aria-expanded', String(!panel.hidden));
    closeSelects();
  });
  action('#apply-filter', async () => {
    const next = currentFilter();
    if (next.from && next.to && next.from >= next.to) {
      toast('开始日期不能晚于结束日期');
      return;
    }
    filter = next;
    threadPage = 1;
    activityYear = Number(($('#filter-from').value || $('#filter-to').value).slice(0, 4)) || undefined;
    updateFilterButton();
    await loadReport();
  });
  action('#clear-filter', async () => {
    for (const field of document.querySelectorAll('#filter-panel select, #filter-panel input')) field.value = '';
    syncSelects($('#filter-panel'));
    for (const button of document.querySelectorAll('[data-range]'))
      button.classList.toggle('selected', button.dataset.range === 'all');
    filter = {};
    threadPage = 1;
    activityYear = undefined;
    updateFilterButton();
    await loadReport();
  });
  action('#export-csv', () => call('export-csv', report?.filter || filter));
  action('#export-json', () => call('export-json', report?.filter || filter));
  $('#thread-search').addEventListener('input', () => {
    threadPage = 1;
    if (report) renderThreads();
  });
  for (const [id, delta] of [['#threads-prev', -1], ['#threads-next', 1]])
    action(id, () => {
      threadPage += delta;
      renderThreads();
      $('.records-panel').scrollIntoView({ block: 'start' });
    });
  $('#activity-year').addEventListener('change', () => {
    activityYear = Number($('#activity-year').value);
    if (report) renderActivity();
  });
  for (const button of document.querySelectorAll('[data-activity-mode]'))
    button.addEventListener('click', () => {
      activityMode = button.dataset.activityMode;
      for (const mode of document.querySelectorAll('[data-activity-mode]')) {
        mode.classList.toggle('selected', mode === button);
        mode.setAttribute('aria-pressed', String(mode === button));
      }
      if (report) renderActivity();
    });
  document.addEventListener('scroll', hideChartTooltip, true);
  window.addEventListener('resize', hideChartTooltip);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideChartTooltip();
  });
  for (const b of document.querySelectorAll('[data-range]'))
    b.onclick = () => {
      const today = dayKey(Date.now(), state.settings.timezone);
      $('#filter-to').value = b.dataset.range === 'all' ? '' : today;
      const d = new Date(today + 'T12:00:00Z');
      if (b.dataset.range === 'month') d.setUTCDate(1);
      else if (b.dataset.range !== 'today' && b.dataset.range !== 'all')
        d.setUTCDate(d.getUTCDate() - Number(b.dataset.range) + 1);
      $('#filter-from').value = b.dataset.range === 'all' ? '' : d.toISOString().slice(0, 10);
      for (const button of document.querySelectorAll('[data-range]'))
        button.classList.toggle('selected', button === b);
    };
  for (const date of [$('#filter-from'), $('#filter-to')])
    date.addEventListener('input', () => {
      for (const button of document.querySelectorAll('[data-range]')) button.classList.remove('selected');
    });
  $('#settings-form').addEventListener('input', (event) => {
    markDirty();
    if (event.target.name === 'soundTheme') {
      readDraft();
      renderSoundSettings();
    }
    if (event.target.type === 'range') updateRange(event.target);
  });
  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#save-settings').disabled = true;
    try {
      const settings = await call('settings', readDraft());
      appearance = await call('appearance', {
        scale: Number($('#settings-form').elements.scale.value),
        snapEnabled: $('#settings-form').elements.snapEnabled.checked,
      });
      state.settings = settings;
      fillSettings(settings);
      toast('设置已保存');
    } catch {
    } finally {
      $('#save-settings').disabled = false;
    }
  });
  action('#cancel-settings', () => fillSettings(state.settings));
  action('#reset-settings', async () => {
    fillSettings(await call('default-settings'));
    markDirty();
    $('#dirty-hint').textContent = '已恢复默认草稿，保存后生效';
  });
  action('#permission', () => call('permission'));
  // 修复优先使用内置原声，缺少可用副本时才需要下载，并显示实际失败原因。
  action('#install-audio', async () => {
    const button = $('#install-audio');
    button.disabled = true;
    button.textContent = '正在修复并校验…';
    try {
      await call('install-audio');
      await refreshAudioStatus();
      toast('九段原声音效已就绪');
    } catch (error) {
      toast(error.message || '音效修复失败，请重试');
    } finally {
      button.disabled = false;
      button.textContent = '修复原声音效';
    }
  });
  action('#import-character', async () => {
    const name = await call('import-character');
    if (name) {
      draft.characterAsset = name;
      markDirty();
      toast('角色已导入，保存后应用');
    }
  });
  action('#reset-character', () => {
    draft.characterAsset = '';
    markDirty();
    toast('保存后恢复默认角色');
  });
  action('#save-price', () => {
    const model = $('#price-model').value.trim(),
      values = ['input', 'cached', 'output'].map((k) => $('#price-' + k).value);
    if (!model || values.some((v) => v === '' || !Number.isFinite(Number(v)) || Number(v) < 0)) {
      toast('请填写模型名及三项有效价格');
      return;
    }
    draft.prices[model] = {
      input: Number(values[0]),
      cached: Number(values[1]),
      output: Number(values[2]),
      fast: Math.max(0, Number($('#price-fast').value) || 1),
      flex: Math.max(0, Number($('#price-flex').value) || 1),
      cacheWrite:
        $('#price-write').value === ''
          ? Number(values[0])
          : Math.max(0, Number($('#price-write').value)),
      effective: $('#price-effective').value
        ? new Date(midnight($('#price-effective').value, state.settings.timezone)).toISOString()
        : '',
    };
    markDirty();
    renderPrices();
  });
  for (const id of ['export-settings', 'backup', 'rebuild', 'diagnostics'])
    action('#' + id, () => call(id));
  action('#import-settings', async () => {
    const imported = await call('import-settings');
    if (imported) {
      const clean = await call('normalize-settings', imported);
      fillSettings(clean);
      markDirty();
      toast('设置已载入草稿，检查后保存');
    }
  });
}
start().catch((error) => toast('界面初始化失败：' + error.message));
