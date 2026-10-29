let opened = null;
let sequence = 0;
const controls = new WeakMap();

// 原生选项继续承担表单取值，自定义控件负责一致的定位、样式和键盘交互。
export class SelectControl {
  // 创建与字段标签关联的组合框，不使用系统原生弹出菜单。
  constructor(select) {
    this.select = select;
    this.id = select.id || `choice-${++sequence}`;
    select.id = this.id;
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'select-control';
    select.before(this.wrapper);
    this.wrapper.append(select);
    select.hidden = true;
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'select-trigger';
    this.trigger.dataset.select = this.id;
    this.trigger.setAttribute('role', 'combobox');
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-controls', `${this.id}-list`);
    const label = select.labels?.[0];
    if (label) {
      label.id ||= `${this.id}-label`;
      this.trigger.setAttribute('aria-labelledby', `${label.id} ${this.id}-value`);
      label.addEventListener('click', (event) => {
        event.preventDefault();
        this.trigger.focus();
      });
    } else this.trigger.setAttribute('aria-label', select.getAttribute('aria-label') || '选择选项');
    this.value = document.createElement('span');
    this.value.id = `${this.id}-value`;
    this.value.className = 'select-value';
    this.chevron = document.createElement('span');
    this.chevron.className = 'select-chevron';
    this.chevron.setAttribute('aria-hidden', 'true');
    this.trigger.append(this.value, this.chevron);
    this.wrapper.append(this.trigger);
    this.popup = document.createElement('div');
    this.popup.id = `${this.id}-list`;
    this.popup.className = 'select-popup';
    this.popup.setAttribute('role', 'listbox');
    this.popup.setAttribute('aria-label', label?.textContent.trim() || '可选项目');
    this.popup.hidden = true;
    document.body.append(this.popup);
    this.trigger.addEventListener('click', () => (this.popup.hidden ? this.open() : this.close()));
    this.trigger.addEventListener('keydown', (event) => this.keydown(event));
    select.addEventListener('change', () => this.sync());
    this.observer = new MutationObserver(() => this.sync());
    this.observer.observe(select, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'selected', 'label'],
    });
    controls.set(select, this);
    this.sync();
  }

  // 动态表格重建前移除弹层与观察器，避免重复标识和残留菜单。
  destroy() {
    this.close();
    this.observer.disconnect();
    clearTimeout(this.searchTimer);
    this.popup.remove();
    this.wrapper.before(this.select);
    this.wrapper.remove();
    this.select.hidden = false;
    this.select.removeAttribute('aria-hidden');
    this.select.removeAttribute('tabindex');
    controls.delete(this.select);
  }

  // 程序更新选项或取消表单修改后，同步显示文本而不触发额外保存。
  sync() {
    const options = [...this.select.options];
    const chosen = options[this.select.selectedIndex];
    this.value.textContent = chosen?.label || '请选择';
    this.trigger.title = chosen?.label || '';
    this.trigger.disabled = this.select.disabled || !options.length;
    const signature = JSON.stringify(options.map((o) => [o.value, o.label, o.disabled]));
    if (signature !== this.signature) {
      this.signature = signature;
      this.popup.replaceChildren(
        ...options.map((option, index) => {
          const item = document.createElement('div');
          item.className = 'select-option';
          item.id = `${this.id}-option-${index}`;
          item.setAttribute('role', 'option');
          item.setAttribute('aria-disabled', String(option.disabled));
          item.dataset.index = index;
          item.dataset.value = option.value;
          item.title = option.label;
          const text = document.createElement('span');
          text.className = 'option-label';
          text.textContent = option.label;
          const tick = document.createElement('span');
          tick.className = 'option-tick';
          tick.setAttribute('aria-hidden', 'true');
          item.append(text, tick);
          item.addEventListener('pointerdown', (event) => event.preventDefault());
          item.addEventListener('click', () => this.commit(index));
          item.addEventListener('pointermove', () => {
            if (!option.disabled) this.highlight(index, false);
          });
          return item;
        }),
      );
    }
    for (const item of this.popup.children)
      item.setAttribute(
        'aria-selected',
        String(Number(item.dataset.index) === this.select.selectedIndex),
      );
    if (!this.select.options[this.active]) this.active = Math.max(0, this.select.selectedIndex);
    if (!this.popup.hidden) {
      this.highlight(this.active ?? this.select.selectedIndex, false);
      this.position();
    }
  }

  // 优先把控件滚动到有空间的位置，菜单始终出现在控件下方。
  open() {
    if (this.trigger.disabled) return;
    opened?.close();
    const rect = this.trigger.getBoundingClientRect();
    const clip = this.trigger.closest('.content-scroll')?.getBoundingClientRect();
    if ((clip?.bottom ?? window.innerHeight) - rect.bottom < 160)
      this.trigger.scrollIntoView({ block: 'center', behavior: 'instant' });
    opened = this;
    this.popup.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.active = Math.max(0, this.select.selectedIndex);
    this.sync();
    this.position();
    this.highlight(this.active, true);
  }

  // 弹层与触发框同宽、左边对齐；箭头内边距由统一样式控制。
  position() {
    if (this.popup.hidden) return;
    const rect = this.trigger.getBoundingClientRect();
    const clip = this.trigger.closest('.content-scroll')?.getBoundingClientRect();
    if (
      rect.top < (clip?.top ?? 0) - 1 ||
      rect.bottom > (clip?.bottom ?? window.innerHeight) + 1 ||
      this.trigger.closest('[hidden]')
    ) {
      this.close();
      return;
    }
    this.popup.style.left = `${rect.left}px`;
    this.popup.style.top = `${rect.bottom + 6}px`;
    this.popup.style.width = `${rect.width}px`;
    this.popup.style.maxHeight = `${Math.max(44, Math.min(272, (clip?.bottom ?? window.innerHeight) - rect.bottom - 12))}px`;
  }

  // 关闭只撤销悬停选择，未确认的键盘移动不改表单值。
  close() {
    this.popup.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.removeAttribute('aria-activedescendant');
    if (opened === this) opened = null;
  }

  // 确认选项后发出标准表单事件，让现有草稿和校验逻辑继续生效。
  commit(index) {
    if (this.select.options[index]?.disabled || !this.select.options[index]) return;
    this.select.selectedIndex = index;
    this.sync();
    this.close();
    this.trigger.focus({ preventScroll: true });
    this.select.dispatchEvent(new Event('input', { bubbles: true }));
    this.select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 活动选项只影响视觉焦点，原生值仍保留到确认时。
  highlight(index, scroll) {
    if (!this.popup.children[index]) return;
    this.active = index;
    for (const item of this.popup.children)
      item.classList.toggle('active', Number(item.dataset.index) === index);
    this.trigger.setAttribute('aria-activedescendant', `${this.id}-option-${index}`);
    if (scroll) this.popup.children[index].scrollIntoView({ block: 'nearest' });
  }

  // 支持方向键、首尾、确认、取消和文字查找，保持完整键盘可用性。
  keydown(event) {
    const enabled = [...this.select.options].map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    if (event.key === 'Escape') {
      if (!this.popup.hidden) {
        event.preventDefault();
        this.close();
      }
      return;
    }
    if (event.key === 'Tab') {
      this.close();
      return;
    }
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (this.popup.hidden) {
        this.open();
        if (!['Home', 'End'].includes(event.key)) return;
      } else if (['Enter', ' '].includes(event.key)) {
        this.commit(this.active);
        return;
      }
      const position = enabled.indexOf(this.active);
      const next =
        event.key === 'Home'
          ? enabled[0]
          : event.key === 'End'
            ? enabled.at(-1)
            : enabled[
                Math.max(
                  0,
                  Math.min(enabled.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1)),
                )
              ];
      this.highlight(next, true);
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      clearTimeout(this.searchTimer);
      this.search = (this.search || '') + event.key.toLocaleLowerCase();
      this.searchTimer = setTimeout(() => {
        this.search = '';
      }, 700);
      const found = enabled.find((i) =>
        this.select.options[i].label.toLocaleLowerCase().startsWith(this.search),
      );
      if (found !== undefined) {
        if (this.popup.hidden) this.open();
        this.highlight(found, true);
      }
    }
  }
}

// 仅增强尚未处理的单选框，避免实时推送重复绑定事件。
export function enhanceSelects(root = document) {
  for (const select of root.querySelectorAll('select'))
    if (!controls.has(select)) new SelectControl(select);
}

// 批量同步表单的程序赋值，取消和导入设置后也保持文本一致。
export function syncSelects(root = document) {
  for (const select of root.querySelectorAll('select')) controls.get(select)?.sync();
}

// 切换页面时显式收起弹层，避免悬浮到其他设置内容上。
export function closeSelects() {
  opened?.close();
}

document.addEventListener('pointerdown', (event) => {
  if (opened && !opened.wrapper.contains(event.target) && !opened.popup.contains(event.target))
    opened.close();
});
document.addEventListener('focusin', (event) => {
  if (opened && !opened.wrapper.contains(event.target) && !opened.popup.contains(event.target))
    opened.close();
});
// 滚动和缩放后重新锚定菜单，浮层不会遗留在旧坐标。
window.addEventListener('resize', () => opened?.position());
document.addEventListener(
  'scroll',
  (event) => {
    if (opened && event.target !== opened.popup) opened.position();
  },
  true,
);

// 动态选项表格清空前调用，释放对应的浮层和事件状态。
export function destroySelects(root) {
  for (const select of root.querySelectorAll('select')) controls.get(select)?.destroy();
}
