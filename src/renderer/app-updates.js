// 从管理窗口取出更新控件，页面中的每个 ID 只对应一个元素。
const $ = (id) => document.getElementById(id);

// 发布说明只生成文字、段落和列表；远端 HTML、图片和任意外链都不会执行或加载。
function renderNotes(text) {
  const notes = $('update-notes');
  const content = document.createDocumentFragment();
  let list;
  for (const line of (text.trim() || '此版本的详细说明可在 GitHub 发布页查看。').split(/\r?\n/)) {
    const clean = line.trim().replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|\x60/g, '');
    if (!clean) { list = null; continue; }
    const bullet = /^[-*]\s+/.test(clean);
    if (bullet && !list) { list = document.createElement('ul'); content.append(list); }
    if (!bullet) list = null;
    const element = document.createElement(bullet ? 'li' : /^#{1,6}\s/.test(clean) ? 'h4' : 'p');
    element.textContent = clean.replace(/^(?:#{1,6}|[-*])\s+/, '');
    (list || content).append(element);
  }
  notes.replaceChildren(content);
  notes.scrollTop = 0;
}

// 每个状态都明确下一步，便携用户在点击安装前能看到迁移说明。
function presentation({ status, installed, release, error }) {
  const format = release.asset?.format;
  switch (status) {
    case 'checking': return ['正在检查更新', '正在连接 GitHub Releases…', '检查中…'];
    case 'available':
      if (!format) return ['发现新版本', '当前系统的安装包尚未就绪，可以前往发布页查看。', '重新检查', 'update-check'];
      return ['发现新版本', '', error ? '重新下载' : format === 'setup' && !installed ? '下载安装版' : '下载更新', 'update-download'];
    case 'downloading': return ['正在下载更新', '', '下载中…'];
    case 'opening': return ['正在准备安装', '', '请稍候…'];
    case 'ready':
      return ['更新已就绪', '', format === 'setup' ? (installed ? '重启并更新' : '切换到安装版并重启')
        : format === 'dmg' ? '打开安装包' : '打开压缩包', 'update-apply'];
    case 'opened':
      if (format === 'setup') return ['正在重启更新', '', '正在重启…'];
      return [format === 'dmg' ? '已打开安装包' : '已打开压缩包', '', '再次打开', 'update-apply'];
  }
}

// 订阅一次主进程，与五个管理页面共享同一枚按钮以及可用键盘操作的更新窗口。
export function bindAppUpdates(bridge, call) {
  const dialog = $('app-update-dialog'), button = $('app-update-button'), primary = $('update-primary');
  const badge = $('app-update-badge'), progress = $('update-progress');
  let state, renderedNotes, renderedDate;

  // 弹窗内只改进度条和按钮读数，关闭后由侧栏单独显示进度。
  function renderProgress(percent) {
    if (!dialog.open) return;
    progress.value = percent;
    primary.textContent = `下载中 ${percent}%`;
  }

  // 仅在打开弹窗或切换阶段时更新正文，下载过程中保留说明节点、滚动位置和焦点。
  function renderDialog() {
    if (!dialog.open || !state?.release) return;
    const { status, current, release, error } = state;
    const [title, message, action, command] = presentation(state);
    $('update-heading').textContent = title;
    $('update-current').textContent = `当前 v${current}`;
    $('update-next').textContent = `v${release.version}`;
    if (renderedNotes !== release.notes) { renderNotes(release.notes); renderedNotes = release.notes; }
    if (renderedDate !== release.published) {
      const date = new Date(release.published);
      $('update-date').textContent = Number.isNaN(date.getTime()) ? ''
        : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
      renderedDate = release.published;
    }
    progress.hidden = status !== 'downloading';
    $('update-message').textContent = error || message;
    $('update-message').hidden = !error && !message;
    $('update-message').dataset.error = String(Boolean(error));
    if (status === 'downloading') renderProgress(state.percent);
    else primary.textContent = action;
    primary.disabled = !command;
    primary.dataset.command = command || '';
  }

  // 快照描述阶段，数字只描述进度。初次查询也走同一推送通道，命令结果不再重复绘制。
  bridge.onAppUpdate((next) => {
    if (typeof next === 'number') {
      if (state?.status === 'downloading') {
        state.percent = next;
        badge.textContent = `${next}%`;
        renderProgress(next);
      }
      return;
    }
    state = next;
    const { status, release } = state;
    // 只有主进程确认更高的正式版本才显示入口。版本已追平或发布撤回时，同时收起旧弹窗。
    button.hidden = !release;
    if (!release) {
      badge.textContent = '';
      if (dialog.open) dialog.close();
      return;
    }
    button.title = `查看 v${release.version} 更新`;
    button.setAttribute('aria-label', button.title);
    badge.textContent = status === 'downloading' ? `${state.percent}%` : status === 'ready' ? '已就绪' : '有更新';
    renderDialog();
  });
  // 命令错误由管理页的公共提示展示，后台状态由主进程单独推送。
  const execute = (command) => { void call(command).catch(() => {}); };
  execute('update-status');
  button.addEventListener('click', () => {
    if (!state?.release) return;
    if (!dialog.open) dialog.showModal();
    renderDialog();
  });
  $('update-close').addEventListener('click', () => dialog.close());
  $('update-release').addEventListener('click', () => execute('update-release'));
  primary.addEventListener('click', () => {
    if (primary.dataset.command) execute(primary.dataset.command);
  });
}
