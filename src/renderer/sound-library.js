import { AUDIO_FILES, audioUrl, isCustomAudioId } from '../shared/audio-library.js';
import { AudioEditor } from './audio-editor.js';

// 音效库使用固定的本地界面控件。
const $ = (id) => document.getElementById(id);

// 操作按钮保留完整的无障碍名称，列表中重复的「试听」也能区分。
function clipButton(label, clip, callback) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.setAttribute('aria-label', label + ' ' + clip.label);
  if (label === '试听') button.setAttribute('aria-pressed', 'false');
  button.onclick = () => void callback(button).catch(() => {});
  return button;
}

// 音效库独立保存片段，事件表单只订阅可选音效的变化。
export class SoundLibraryView {
  // 文件输入放在偏好表单外，打开、试听和取消裁剪都不会弄脏设置草稿。
  constructor({ call, importClip, toast, engine, settings, change }) {
    this.call = call;
    this.toast = toast;
    this.engine = engine;
    this.settings = settings;
    this.change = change;
    this.files = AUDIO_FILES;
    this.revision = 0;
    const catalog = $('sound-catalog');
    catalog.ontoggle = () => this.renderCatalog();
    this.editor = new AudioEditor({
      volume: () => this.settings().volume,
      save: importClip,
      saved: (clip) => {
        catalog.open = true;
        void this.refresh().catch(() => {});
        $('sound-library-list').scrollTop = 0;
        this.toast(`已将「${clip.label}」保存到音效库`);
      },
    });
    $('import-audio').onclick = () => $('audio-source-file').click();
    $('audio-source-file').onchange = () => {
      const input = $('audio-source-file'), file = input.files[0];
      input.value = '';
      if (!file) return;
      if (!file.size || file.size > 64 * 1024 * 1024) {
        this.toast('请选择大小在 64 MB 以内的非空音频文件。');
        return;
      }
      this.stopPreview();
      void this.editor.open(file.name.replace(/\.[^.]+$/, '') || '音效片段', () => file.arrayBuffer());
    };
    $('audio-rename-cancel').onclick = () => $('audio-rename').close();
    $('audio-new-name').oninput = () => $('audio-new-name').setCustomValidity('');
    $('audio-rename').querySelector('form').onsubmit = (event) => {
      event.preventDefault();
      void this.saveName().catch(() => {});
    };
  }

  // 以磁盘为准刷新一次。首次载入和导入并发时，较慢的旧读数不会覆盖新记录。
  async refresh() {
    const revision = ++this.revision;
    try {
      const clips = await this.call('list-audio-clips');
      if (this.revision === revision) this.files = [...clips, ...AUDIO_FILES];
    } finally {
      if (this.revision === revision) {
        $('sound-library-count').textContent = `${AUDIO_FILES.length} 段内置 · ${this.files.length - AUDIO_FILES.length} 段导入`;
        this.renderCatalog();
        this.change();
      }
    }
  }

  // 展开时才生成音效行，收起时释放按钮与关联的回调。
  renderCatalog() {
    const list = $('sound-library-list');
    const files = $('sound-catalog').open ? this.files : null;
    if (this.displayedFiles === files) return;
    if (this.previewSession && list.contains(this.previewSession.button)) this.stopPreview();
    this.displayedFiles = files;
    list.replaceChildren(...(files || []).map((clip) => this.row(clip)));
  }

  // 内置原声只提供试听，只有用户导入的片段才显示裁剪、重命名和移除。
  row(clip) {
    const row = document.createElement('li'), info = document.createElement('div');
    const name = document.createElement('strong'), detail = document.createElement('small');
    const custom = isCustomAudioId(clip.id);
    name.textContent = name.title = clip.label;
    detail.textContent = custom ? (clip.available === false ? '音频文件缺失' :
      '已导入' + (clip.duration ? ` · ${clip.duration.toFixed(3)} 秒` : '')) : '内置原声';
    info.append(name, detail);
    const actions = document.createElement('div');
    actions.className = 'sound-library-actions';
    const preview = clipButton('试听', clip, (button) => this.preview(button, 'library', clip.id));
    preview.disabled = clip.available === false;
    actions.append(preview);
    if (custom) {
      const trim = clipButton('裁剪', clip, async () => {
        this.stopPreview();
        await this.editor.open(clip.label + ' · 片段', async () => {
          const result = await fetch(audioUrl(clip.id));
          if (!result.ok) throw new Error('读取音频失败。');
          return result.arrayBuffer();
        });
      });
      // 录音文件缺失时仍能整理或移除这条记录。
      trim.disabled = clip.available === false;
      actions.append(trim, clipButton('重命名', clip, async () => {
        this.renaming = clip.id;
        $('audio-new-name').setCustomValidity('');
        $('audio-new-name').value = clip.label;
        $('audio-rename').showModal();
        $('audio-new-name').select();
      }), clipButton('移除', clip, async () => {
        if (Object.values(this.settings().eventSounds).includes(clip.id)) {
          this.toast('此音效已分配给事件，请先更换并保存设置。');
          return;
        }
        if (await this.call('remove-audio-clip', clip.id)) {
          this.stopPreview();
          await this.refresh();
          this.toast('片段已移到系统回收站');
        }
      }));
    }
    row.dataset.clipId = clip.id;
    row.append(info, actions);
    return row;
  }

  // 事件表和音效库共用试听通道，解码尚未完成时也能取消，迟到的结束事件不会重置新按钮。
  async preview(button, event, id) {
    const togglingOff = this.previewSession?.button === button;
    this.stopPreview();
    if (togglingOff) return;
    const settings = this.settings();
    if (!settings.volume) { this.toast('当前总音量为零'); return; }
    const session = { button };
    this.previewSession = session;
    button.textContent = '停止';
    button.setAttribute('aria-pressed', 'true');
    let voice;
    try {
      void this.engine.configure(settings);
      voice = await this.engine.play(event, true, id);
    } catch {
      if (this.previewSession === session) {
        this.stopPreview();
        this.toast('无法试听，请检查音频输出设备。');
      }
      return;
    }
    if (this.previewSession !== session) return;
    if (!voice) {
      this.stopPreview();
      if (this.engine.lastError) this.toast(this.engine.lastError);
      return;
    }
    const cleanup = voice.node.onended;
    voice.node.onended = () => {
      cleanup();
      if (this.previewSession === session) this.stopPreview();
    };
  }

  // 离开声音页或替换试听控件前收回播放，避免长录音失去停止入口。
  stopPreview() {
    if (!this.previewSession) return;
    const { button } = this.previewSession;
    this.previewSession = null;
    button.textContent = '试听';
    button.setAttribute('aria-pressed', 'false');
    this.engine.stop();
  }

  // 重命名完成后更新选项文本，引用此片段的事件继续持有原编号。
  async saveName() {
    const dialog = $('audio-rename'), label = $('audio-new-name').value.trim();
    const id = this.renaming, submit = dialog.querySelector('[type=submit]');
    if (!label) {
      $('audio-new-name').setCustomValidity('请输入音效名称');
      $('audio-new-name').reportValidity();
      return;
    }
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      await this.call('rename-audio-clip', { id, label });
      dialog.close();
      await this.refresh();
    } finally {
      submit.disabled = false;
    }
  }
}
