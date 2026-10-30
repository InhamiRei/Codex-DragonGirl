import { PELICAN_PROMPT, EFFORT_LABELS, extractTestHtml } from '../shared/account-tests.js';
import { instanceLabel, planLabel } from '../shared/presentation.js';
import { syncSelects } from './select.js';
import { TestPreview } from './test-preview.js';

// 账号和回答一律按纯文本创建，生成页面只进入独立来源的沙箱。
function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = String(text);
  return item;
}

// 耗时和用量使用一致的紧凑排版，未返回的数据保持未知。
function metrics(duration, tokens) {
  return [`${Number.isFinite(duration) ? (duration / 1000).toFixed(1) : '—'} 秒`, `${Number.isFinite(tokens) ? tokens.toLocaleString('zh-CN') : '—'} Tokens`];
}

// 运行中的时间按开始时刻持续更新，结束后保留服务记录的真实耗时。
function elapsed(result) {
  return result.status === 'running' && result.startedAt ? Date.now() - result.startedAt : result.durationMs;
}

// 不完整的页面与 HTML 片段在缩略区域显示占位状态，不把标签当作回答正文展示。
function looksLikeMarkup(text) {
  return /^\s*(?:<!doctype|<(?:html|head|body|svg|div|style|script|main|canvas)\b|```(?:html|svg))/i.test(text || '');
}

// 阶段状态直接显示在画面中，缩略图和详情共用相同的加载与失败反馈。
function previewState(container, status, error = '') {
  const pending = status === 'queued' || status === 'running';
  const node = element('div', 'test-preview-state');
  node.dataset.state = status;
  node.setAttribute('role', 'status');
  const icon = element('span', pending ? 'test-loading' : 'test-state-icon', pending ? '' : status === 'failed' ? '!' : status === 'completed' ? '—' : '×');
  icon.setAttribute('aria-hidden', 'true');
  const labels = { queued: '等待测试', running: '正在生成', failed: '测试失败', cancelled: '已取消', interrupted: '已中断', completed: '暂无可用预览' };
  node.append(icon, element('strong', '', labels[status] || '暂无预览'));
  if (error) node.append(element('p', 'test-state-message', error));
  container.replaceChildren(node);
}

// 新建、记录和详情各自占用一个页面，切页不会中断后台生成。
export class AccountTestsView {
  // 固定初始参数并绑定一次事件，后台推送不覆盖草稿。
  constructor({ call, toast, getState }) {
    Object.assign(this, { call, toast, getState, pane: 'new', historyPage: 1, catalogRequest: 0, modelChoice: 'gpt-6-astra', effortChoice: 'medium' });
    this.root = document.getElementById('account-tests');
    this.selected = new Set();
    this.catalog = [];
    this.catalogErrors = new Map();
    this.cards = new Map();
    this.thumbnails = [];
    this.historyCards = new Map();
    // 长时间思考没有文本事件时，时间仍然更新，不重建画面或加载动画。
    setInterval(() => this.updateTimes(), 1000);
    this.$('#test-prompt').value = PELICAN_PROMPT;
    this.promptCount();
    for (const button of this.root.querySelectorAll('[data-test-tab]')) this.bindElement(button, () => this.switchPane(button.dataset.testTab));
    this.bind('#test-back-history', () => this.switchPane('history'));
    this.bind('#test-reset-prompt', () => { this.$('#test-prompt').value = PELICAN_PROMPT; this.promptCount(); this.controls(); });
    this.$('#test-kind').addEventListener('change', () => this.changeKind());
    this.$('#test-prompt').addEventListener('input', () => { this.promptCount(); this.controls(); });
    this.$('#test-model').addEventListener('change', () => { this.modelChoice = this.$('#test-model').value; this.effortChoice = 'medium'; this.modelStatus(''); this.efforts(); });
    this.$('#test-effort').addEventListener('change', () => { this.effortChoice = this.$('#test-effort').value; });
    this.$('#test-account-search').addEventListener('input', () => this.accounts());
    this.bind('#test-select-all', () => {
      const ids = this.getState().instances.map((i) => i.id);
      this.selected = this.selected.size === ids.length ? new Set() : new Set(ids.slice(0, 20));
      this.selectionChanged();
    });
    this.bind('#test-load-models', () => this.loadModels());
    this.bind('#test-current', async () => { if (this.activeId) this.show(await this.call('test-read', this.activeId)); });
    this.bind('#test-cancel', async () => {
      this.$('#test-cancel').disabled = true;
      try { await this.call('test-cancel', this.record.id); } finally { this.controls(); }
    });
    this.bind('#test-export-run', async () => { if (await this.call('test-export', { id: this.record.id })) this.toast('测试记录已导出'); });
    this.bind('#test-refresh-history', () => this.history());
    this.bind('#test-history-prev', () => { this.historyPage--; return this.history(); });
    this.bind('#test-history-next', () => { this.historyPage++; return this.history(); });
    this.$('#test-form').addEventListener('submit', (event) => { event.preventDefault(); void this.start().catch(() => {}); });
  }

  // 控件查找仅限于测试页。
  $(selector) { return this.root.querySelector(selector); }

  // 静态和动态按钮共用异步错误边界。
  bindElement(button, callback) { button.addEventListener('click', () => { void Promise.resolve().then(callback).catch(() => {}); }); }

  // 静态按钮按标识查找后绑定。
  bind(selector, callback) { this.bindElement(this.$(selector), callback); }

  // 重开管理窗口时恢复活动测试，已完成记录保持从列表进入。
  async open() {
    this.updateAccounts();
    if (this.initialized) return;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const history = await this.call('test-list', 1);
      this.activeId = history.activeId;
      if (this.activeId) this.show(await this.call('test-read', this.activeId));
      this.initialized = true;
      this.controls();
    })().finally(() => { this.opening = null; });
    return this.opening;
  }

  // 两类题目分别保存草稿，输出展示方式按实际回答决定。
  changeKind() {
    const custom = this.$('#test-kind').value === 'custom';
    if (custom) { this.pelicanDraft = this.$('#test-prompt').value; this.$('#test-prompt').value = this.customDraft || ''; }
    else { this.customDraft = this.$('#test-prompt').value; this.$('#test-prompt').value = this.pelicanDraft || PELICAN_PROMPT; }
    this.$('#test-reset-prompt').hidden = custom;
    this.promptCount();
    this.controls();
  }

  // 字数占用固定位置，输入不会改变表单布局。
  promptCount() { this.$('#test-prompt-count').textContent = `${this.$('#test-prompt').value.length.toLocaleString('zh-CN')} / 20,000`; }

  // 账号刷新保留勾选与模型，仅数据有变化时重建列表。
  updateAccounts() {
    const instances = this.getState()?.instances || [];
    const removed = [...this.selected].some((id) => !instances.some((i) => i.id === id));
    for (const id of this.selected) if (!instances.some((i) => i.id === id)) this.selected.delete(id);
    const signature = JSON.stringify(instances.map((i) => [i.id, i.name, i.account, i.identity, i.quota?.capturedAt]));
    if (signature !== this.accountSignature) { this.accountSignature = signature; this.accounts(); }
    if (removed) this.selectionChanged();
    this.controls();
  }

  // 套餐紧跟账号名称放在同一行，运行状态单独换行，额度保持在列表右侧。
  accounts() {
    const state = this.getState();
    if (!state) return;
    const query = this.$('#test-account-search').value.toLocaleLowerCase().trim();
    const instances = state.instances.filter((i) => instanceLabel(i, state.settings).toLocaleLowerCase().includes(query));
    const box = this.$('#test-accounts');
    box.replaceChildren();
    for (const instance of instances) {
      const row = element('label', 'test-account'), check = element('input');
      Object.assign(check, { type: 'checkbox', value: instance.id, checked: this.selected.has(instance.id), disabled: !!this.activeId || !!this.starting });
      check.addEventListener('change', () => {
        if (check.checked) {
          if (this.selected.size >= 20) { check.checked = false; this.toast('一次最多选择 20 个实例'); return; }
          this.selected.add(instance.id);
        } else this.selected.delete(instance.id);
        this.selectionChanged();
      });
      const copy = element('span', 'test-account-copy'), heading = element('span', 'test-account-heading');
      const name = element('strong', 'test-account-name', instanceLabel(instance, state.settings));
      const plan = element('span', 'test-plan', planLabel(instance.account?.type === 'apiKey' ? 'apiKey' : instance.account?.planType || instance.quota?.buckets?.[0]?.plan));
      const failure = this.catalogErrors.get(instance.id);
      const shared = instance.identity && state.instances.some((i) => i.id !== instance.id && i.identity === instance.identity);
      heading.append(name, plan);
      copy.append(heading, element('span', failure ? 'test-error' : 'hint', failure || `${instance.running ? '运行中' : '未运行'}${shared ? ' · 共享账号额度' : ''}`));
      const quotas = element('span', 'test-account-quotas');
      for (const window of (instance.quota?.buckets?.[0]?.windows || []).slice(0, 2)) quotas.append(element('span', 'hint', `${window.label} ${instance.stale ? '待刷新' : `${Math.round(window.remaining)}%`}`));
      row.append(check, copy, quotas);
      box.append(row);
    }
    if (!instances.length) box.append(element('p', 'empty', state.instances.length ? '没有匹配的实例' : '还没有发现实例，请先在账户总览添加目录并登录。'));
    this.$('#test-selection-count').textContent = `${this.selected.size} / ${state.instances.length}`;
    this.$('#test-select-all').textContent = state.instances.length && this.selected.size === state.instances.length ? '取消全选' : '全选';
  }

  // 勾选变化立即废弃旧目录，初始型号仍为 GPT-6 Astra。
  selectionChanged() {
    this.catalogRequest++;
    this.catalog = [];
    this.loadingModels = false;
    this.catalogErrors.clear();
    this.modelStatus('');
    this.setModels();
    this.accounts();
    clearTimeout(this.catalogTimer);
    if (this.selected.size) this.catalogTimer = setTimeout(() => { void this.loadModels().catch(() => {}); }, 250);
    this.controls();
  }

  // 模型成功读取后不显示说明，只保留必要的错误反馈。
  modelStatus(text) { this.$('#test-model-status').textContent = text; this.$('#test-model-status').hidden = !text; }

  // 异步目录与本次账号选择绑定，过期响应不能覆盖新选择。
  async loadModels() {
    if (!this.selected.size || this.activeId) return;
    clearTimeout(this.catalogTimer);
    const request = ++this.catalogRequest;
    this.loadingModels = true;
    this.catalog = [];
    this.setModels();
    this.modelStatus('');
    this.controls();
    try {
      const catalog = await this.call('test-models', [...this.selected]);
      if (request !== this.catalogRequest) return;
      this.catalog = catalog.models;
      this.catalogErrors = new Map(catalog.accounts.filter((a) => a.error).map((a) => [a.id, a.error]));
      this.setModels();
      if (this.catalogErrors.size) this.modelStatus('部分账号读取失败，请处理账号行中的提示后重试。');
      else if (!this.catalog.length) this.modelStatus('所选账号没有共同可用的模型，请调整账号选择。');
      else if (!this.catalog.some((m) => m.id === this.modelChoice)) this.modelStatus('所选账号暂不支持当前模型，请选择其他可用型号。');
      this.accounts();
    } catch (error) {
      if (request === this.catalogRequest) this.modelStatus('模型读取失败，请重试。');
      throw error;
    } finally { if (request === this.catalogRequest) { this.loadingModels = false; this.controls(); } }
  }

  // 指定型号不可用时不静默替换，用户可以主动选择其他可用型号。
  setModels() {
    const select = this.$('#test-model');
    select.replaceChildren();
    if (!this.catalog.some((model) => model.id === this.modelChoice)) {
      const option = new Option(this.modelChoice === 'gpt-6-astra' ? 'GPT-6 Astra' : this.modelChoice, this.modelChoice, false, true);
      option.disabled = true;
      select.add(option);
    }
    for (const model of this.catalog) select.add(new Option(model.name, model.id));
    select.value = this.modelChoice;
    this.efforts();
  }

  // 思考强度初始为中，之后保留用户选择并遵守模型能力。
  efforts() {
    const model = this.catalog.find((m) => m.id === this.$('#test-model').value), select = this.$('#test-effort');
    select.replaceChildren();
    for (const effort of model?.efforts || []) select.add(new Option(EFFORT_LABELS[effort] || effort, effort));
    if (!select.options.length) select.add(new Option(model ? '模型默认' : '中', model ? '' : 'medium'));
    select.value = model?.efforts.includes(this.effortChoice) ? this.effortChoice : model?.efforts.includes('medium') ? 'medium' : select.options[0].value;
    this.controls();
  }

  // 生成时锁定草稿，保留当前测试入口和停止能力。
  controls() {
    const busy = !!this.activeId || !!this.starting;
    this.$('#test-fields').disabled = busy;
    this.$('#test-model').disabled = busy || this.loadingModels || !this.catalog.length;
    this.$('#test-effort').disabled = busy || !this.catalog.length;
    this.$('#test-load-models').disabled = busy || this.loadingModels || !this.selected.size;
    this.$('#test-load-models').textContent = this.loadingModels ? '读取中…' : '刷新模型';
    this.$('#test-start').disabled = busy || this.loadingModels || !this.selected.size || !this.catalog.some((model) => model.id === this.$('#test-model').value) || !this.$('#test-prompt').value.trim();
    this.$('#test-start').textContent = busy ? '测试进行中…' : '开始测试';
    this.$('#test-current').hidden = !this.activeId || (this.pane === 'detail' && this.record?.id === this.activeId);
    this.$('#test-cancel').hidden = !this.activeId || this.record?.id !== this.activeId;
    this.$('#test-cancel').disabled = !!this.record?.cancelling;
    for (const check of this.root.querySelectorAll('.test-account input')) check.disabled = busy;
    syncSelects(this.root);
  }

  // 开始后进入独立详情，运行过程不会附加到新建表单下方。
  async start() {
    if (this.$('#test-start').disabled) return;
    this.starting = true;
    this.controls();
    try {
      const kind = this.$('#test-kind').value;
      const run = await this.call('test-start', { kind, prompt: this.$('#test-prompt').value, model: this.$('#test-model').value, effort: this.$('#test-effort').value, concurrency: Number(this.$('#test-concurrency').value), format: kind === 'pelican' ? 'html' : 'text', instanceIds: [...this.selected] });
      this.show(run);
    } finally { this.starting = false; this.controls(); }
  }

  // 三个视图互斥显示，详情归属记录页，切换时统一回到内容顶部。
  async switchPane(pane) {
    this.pane = pane;
    this.$('#test-new').hidden = pane !== 'new';
    this.$('#test-history').hidden = pane !== 'history';
    this.$('#test-detail').hidden = pane !== 'detail';
    for (const button of this.root.querySelectorAll('[data-test-tab]')) {
      const selected = button.dataset.testTab === (pane === 'detail' ? 'history' : pane);
      button.classList.toggle('selected', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    document.getElementById('content-scroll').scrollTop = 0;
    this.controls();
    if (pane === 'history') await this.history();
  }

  // 推送只更新当前记录的数据，不抢走用户正在看的新建或历史页面。
  receive(run) {
    this.latestRun = run;
    if (run.status === 'running') this.activeId = run.id;
    else if (this.activeId === run.id) this.activeId = null;
    if (this.record?.id === run.id) { this.record = run; if (this.pane === 'detail') this.renderDetail(); }
    this.controls();
    if (this.pane === 'history') {
      if (!this.updateHistoryRun(run) && run.status !== 'running') void this.history().catch(() => {});
    }
  }

  // 仅明确开始或查看时进入详情，过期快照不能覆盖较新的结果。
  show(run) {
    if (this.latestRun?.id === run.id && this.latestRun.revision > run.revision) run = this.latestRun;
    if (this.record?.id !== run.id) {
      for (const card of this.cards.values()) card.preview.destroy();
      this.cards.clear();
      this.$('#test-results').replaceChildren();
      this.$('#test-detail-prompt').textContent = run.prompt;
    }
    this.record = run;
    if (run.status === 'running') this.activeId = run.id;
    else if (this.activeId === run.id) this.activeId = null;
    this.renderDetail();
    void this.switchPane('detail');
  }

  // 标题、参数和始终可见的提示词收进同一块区域，避免零散的信息行。
  renderDetail() {
    const run = this.record;
    this.$('#test-detail-title').textContent = run.kind === 'pelican' ? '鹈鹕动画' : '自定义提示词';
    this.$('#test-detail-meta').textContent = `${this.modelName(run.model)} · 思考强度 ${EFFORT_LABELS[run.effort] || run.effort || '模型默认'} · ${new Date(run.createdAt).toLocaleString('zh-CN')}`;
    const progress = run.storageError || `${run.results.filter((r) => r.status === 'completed').length} / ${run.results.length}`;
    if (this.$('#test-detail-status').textContent !== progress) this.$('#test-detail-status').textContent = progress;
    for (const result of run.results) this.resultCard(run, result);
    this.controls();
  }

  // 固定卡片骨架只更新内部内容，生成、完成和源码切换都保持等高。
  resultCard(run, result) {
    let card = this.cards.get(result.instanceId);
    if (!card) {
      card = element('article', 'panel test-result');
      card.dataset.instanceId = result.instanceId;
      const heading = element('div', 'test-result-heading'), name = element('div', 'test-name-plan'), title = element('h3', '', result.name);
      title.title = result.name;
      name.append(title, element('span', 'test-plan', result.plan));
      heading.append(name);
      const tools = element('div', 'test-result-tools'), tabs = element('div', 'test-view-tabs');
      card.meta = element('span', 'hint');
      card.previewButton = element('button', '', '预览');
      card.sourceButton = element('button', '', '源码');
      tabs.append(card.previewButton, card.sourceButton);
      tools.append(card.meta, tabs);
      const content = element('div', 'test-result-content');
      card.stage = element('div', 'test-preview-stage');
      card.placeholder = element('div', 'test-result-placeholder');
      card.output = element('pre', 'test-output');
      content.append(card.stage, card.placeholder, card.output);
      card.preview = new TestPreview(card.stage, `${result.name}的回答预览`);
      for (const [button, view] of [[card.previewButton, 'preview'], [card.sourceButton, 'source']]) this.bindElement(button, () => { card.view = view; card.chosenView = true; this.cardView(card); });
      card.append(heading, tools, content);
      this.cards.set(result.instanceId, card);
      this.$('#test-results').append(card);
    }
    card.current = result;
    card.dataset.status = result.status;
    card.meta.textContent = metrics(elapsed(result), result.usage?.totalTokens).join(' · ');
    card.output.textContent = result.text || '暂无回答';
    card.html = result.status === 'completed' && extractTestHtml(result.text);
    card.expectsHtml = run.kind === 'pelican' || !!card.html || looksLikeMarkup(result.text);
    const stateKey = `${result.status}:${result.error || ''}`;
    if (card.stateKey !== stateKey) {
      previewState(card.placeholder, result.status, result.error);
      card.stateKey = stateKey;
      if (['failed', 'cancelled', 'interrupted'].includes(result.status)) { card.view = 'preview'; card.chosenView = true; }
    }
    if (!card.chosenView) card.view = card.expectsHtml ? 'preview' : 'text';
    card.preview.setSource(card.html ? `dragon-preview://test/${run.id}/${result.instanceId}` : null);
    this.cardView(card);
  }

  // 源码和纯文本允许内部滚动，HTML 预览始终在固定区域内完整缩放。
  cardView(card) {
    const showingPage = card.view === 'preview' && !!card.html;
    const showingText = card.view === 'source' || (card.current.status === 'completed' && !card.expectsHtml && !!card.current.text);
    card.stage.hidden = !showingPage;
    card.output.hidden = !showingText;
    card.placeholder.hidden = showingPage || showingText;
    card.previewButton.textContent = card.expectsHtml ? '预览' : '回答';
    card.sourceButton.hidden = !card.expectsHtml;
    card.sourceButton.disabled = !card.current.text;
    card.previewButton.classList.toggle('selected', card.view !== 'source');
    card.sourceButton.classList.toggle('selected', card.view === 'source');
    card.preview.mount();
  }

  // 界面优先显示可读的模型名称，历史中的未知型号保持原样。
  modelName(model) {
    return this.catalog.find((entry) => entry.id === model)?.name || (model === 'gpt-6-astra' ? 'GPT-6 Astra' : model);
  }

  // 列表快照与实时事件按版本合并，加载列表期间完成的账号不会停留在加载动画。
  updateHistoryRun(run) {
    const card = this.historyCards.get(run.id);
    if (!card) return false;
    if ((run.revision || 0) < (card.revision || 0)) return true;
    card.revision = run.revision;
    card.remove.disabled = run.status === 'running';
    for (const result of run.results) {
      const mini = card.results.get(result.instanceId);
      if (mini) this.updateThumbnail(mini, run, result);
    }
    return true;
  }

  // 缩略图仅在状态改变时切换内容，已完成的画面不因时间刷新而重新加载。
  updateThumbnail(mini, run, result) {
    mini.current = result;
    const html = result.status === 'completed' && (result.html === true || !!extractTestHtml(result.text));
    const isMarkup = looksLikeMarkup(result.text);
    const stateKey = `${result.status}:${html ? 'html' : isMarkup ? 'markup' : 'text'}:${result.error || ''}`;
    if (mini.stateKey !== stateKey) {
      mini.preview?.destroy();
      mini.preview = null;
      mini.stage.replaceChildren();
      if (html) {
        mini.preview = new TestPreview(mini.stage, `${result.name}的历史预览`);
        mini.preview.setSource(`dragon-preview://test/${run.id}/${result.instanceId}`);
        this.thumbnails.push(mini.preview);
      } else if (result.status === 'completed' && !isMarkup && result.text) {
        mini.stage.append(element('pre', 'test-thumbnail-text', result.text.slice(0, 2000)));
      } else previewState(mini.stage, result.status, result.error);
      mini.stateKey = stateKey;
    }
    const [time, tokens] = metrics(elapsed(result), result.totalTokens ?? result.usage?.totalTokens);
    mini.time.textContent = time;
    mini.tokens.textContent = tokens;
  }

  // 只更新可见视图中的计时文字，不重新读取历史或重建 iframe。
  updateTimes() {
    if (this.root.hidden) return;
    if (this.pane === 'history') for (const card of this.historyCards.values())
      for (const mini of card.results.values()) if (mini.current.status === 'running') mini.time.textContent = metrics(elapsed(mini.current), null)[0];
    if (this.pane === 'detail') for (const card of this.cards.values())
      if (card.current.status === 'running') card.meta.textContent = metrics(elapsed(card.current), card.current.usage?.totalTokens).join(' · ');
  }

  // 历史每页十条，卡片直接包含账号预览、状态、耗时和 Token 用量。
  async history() {
    const request = this.historyRequest = (this.historyRequest || 0) + 1;
    const history = await this.call('test-list', this.historyPage);
    if (request !== this.historyRequest) return;
    this.historyPage = history.page;
    this.activeId = history.activeId;
    for (const preview of this.thumbnails) preview.destroy();
    this.thumbnails = [];
    this.historyCards.clear();
    const box = this.$('#test-history-list');
    box.replaceChildren();
    for (const run of history.records) {
      const card = element('article', 'panel test-history-card'), header = element('div', 'test-history-heading'), copy = element('div', 'test-history-copy');
      card.dataset.recordId = run.id;
      copy.append(element('h3', '', run.kind === 'pelican' ? '鹈鹕动画' : '自定义提示词'), element('p', 'hint', `${this.modelName(run.model)} · ${EFFORT_LABELS[run.effort] || run.effort || '模型默认'}`), element('p', 'hint', new Date(run.createdAt).toLocaleString('zh-CN')));
      const actions = element('div', 'test-history-actions'), view = element('button', 'test-history-action', '查看'), remove = element('button', 'test-history-action', '删除');
      remove.disabled = history.activeId === run.id;
      this.bindElement(view, async () => this.show(await this.call('test-read', run.id)));
      this.bindElement(remove, async () => {
        if (remove.dataset.confirm !== 'yes') { remove.dataset.confirm = 'yes'; remove.textContent = '确认删除'; return; }
        remove.disabled = true;
        try { await this.call('test-delete', run.id); if (this.record?.id === run.id) this.record = null; await this.history(); }
        catch (error) { remove.disabled = false; throw error; }
      });
      actions.append(view, remove);
      header.append(copy, actions);
      const previews = element('div', 'test-history-previews');
      const group = { results: new Map(), remove, revision: run.revision };
      this.historyCards.set(run.id, group);
      for (const result of run.previews || []) {
        const mini = element('div', 'test-history-preview'), name = element('div', 'test-name-plan'), title = element('strong', '', result.name);
        title.title = result.name;
        name.append(title, element('span', 'test-plan', result.plan));
        const stage = element('div', 'test-preview-stage test-thumbnail-stage');
        const footer = element('div', 'test-thumbnail-footer');
        mini.stage = stage;
        mini.time = element('span', 'hint test-thumbnail-time');
        mini.tokens = element('span', 'hint test-thumbnail-tokens');
        footer.append(mini.time, mini.tokens);
        group.results.set(result.instanceId, mini);
        this.updateThumbnail(mini, run, result);
        mini.append(name, stage, footer);
        previews.append(mini);
      }
      card.append(header, previews);
      box.append(card);
    }
    if (!history.records.length) box.append(element('div', 'panel empty', '还没有测试记录'));
    if (this.latestRun) this.updateHistoryRun(this.latestRun);
    this.$('#test-history-page').textContent = `第 ${history.page} / ${history.pages} 页 · 共 ${history.total} 条`;
    this.$('#test-history-prev').disabled = history.page <= 1;
    this.$('#test-history-next').disabled = history.page >= history.pages;
    this.controls();
  }
}
