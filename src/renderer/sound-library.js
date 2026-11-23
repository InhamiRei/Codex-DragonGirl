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
  button.onclick = () => void callback(button).catch(() => {});
  return button;
}

// 音效库独立保存片段，事件表单只订阅可选音效的变化。
export class SoundLibraryView {
  // 文件输入放在偏好表单外，打开、试听和取消裁剪都不会弄脏设置草稿。
  constructor({ call, toast, engine, settings, change }) {
    this.call = call;
    this.toast = toast;
    this.engine = engine;
    this.settings = settings;
    this.change = change;
    this.custom = [];
    this.revision = 0;
    this.editor = new AudioEditor({
      volume: () => this.settings().volume,
      save: (clip) => this.call('import-audio-clip', clip),
      saved: (clip) => {
        this.update([clip, ...this.custom]);
        $('sound-catalog').open = true;
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
      this.engine.stop();
      void this.editor.open(file.name.replace(/\.[^.]+$/, '') || '音效片段', () => file.arrayBuffer());
    };
    $('audio-rename-cancel').onclick = () => $('audio-rename').close();
    $('audio-rename').querySelector('form').onsubmit = (event) => {
      event.preventDefault();
      void this.saveName().catch(() => {});
    };
  }

  // 同一份列表用于音效库、按下、松开以及所有提醒事件。
  get files() {
    return [...this.custom, ...AUDIO_FILES];
  }

  // 列表读取较慢时，不让旧结果覆盖刚刚导入或重命名的片段。
  async refresh() {
    const revision = ++this.revision;
    const clips = await this.call('list-audio-clips');
    if (this.revision === revision) this.update(clips);
  }

  // 局部刷新保留音量、事件分配和其他设置草稿。
  update(clips) {
    this.revision++;
    this.custom = clips;
    $('sound-library-count').textContent = `${AUDIO_FILES.length} 段内置 · ${clips.length} 段导入`;
    $('sound-library-list').replaceChildren(...this.files.map((clip) => this.row(clip)));
    this.change();
  }

  // 每段音效都可以试听或另存选区，已导入的片段还可维护名称和移除。
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
    actions.append(clipButton('试听', clip, (button) => this.preview(clip, button)),
      clipButton('裁剪', clip, async () => {
        this.engine.stop();
        await this.editor.open(clip.label + ' · 片段', async () => {
          const result = await fetch(audioUrl(clip.id));
          if (!result.ok) throw new Error('读取音频失败。');
          return result.arrayBuffer();
        });
      }));
    if (custom) {
      actions.append(clipButton('重命名', clip, async () => {
        this.renaming = clip.id;
        $('audio-new-name').value = clip.label;
        $('audio-rename').showModal();
        $('audio-new-name').select();
      }), clipButton('移除', clip, async () => {
        if (Object.values(this.settings().eventSounds).includes(clip.id)) {
          this.toast('此音效已分配给事件，请先更换并保存设置。');
          return;
        }
        if (await this.call('remove-audio-clip', clip.id)) {
          this.engine.stop();
          this.update(this.custom.filter((item) => item.id !== clip.id));
          this.toast('片段已移到系统回收站');
        }
      }));
    }
    row.dataset.clipId = clip.id;
    row.append(info, actions);
    return row;
  }

  // 库内试听按总音量播放，正在播放的行可随时停止。
  async preview(clip, button) {
    if (button.textContent === '停止') {
      this.engine.stop();
      return;
    }
    const settings = this.settings();
    if (!settings.volume) { this.toast('当前总音量为零'); return; }
    void this.engine.configure(settings);
    const voice = await this.engine.play('library', true, clip.id);
    if (!voice) { if (this.engine.lastError) this.toast(this.engine.lastError); return; }
    button.textContent = '停止';
    const cleanup = voice.node.onended;
    voice.node.onended = () => { cleanup(); button.textContent = '试听'; };
  }

  // 重命名完成后更新选项文本，引用此片段的事件继续持有原编号。
  async saveName() {
    const dialog = $('audio-rename'), label = $('audio-new-name').value.trim();
    const id = this.renaming, submit = dialog.querySelector('[type=submit]');
    if (!label || submit.disabled) return;
    submit.disabled = true;
    try {
      await this.call('rename-audio-clip', { id, label });
      this.update(this.custom.map((clip) => clip.id === id ? { ...clip, label } : clip));
      dialog.close();
    } finally {
      submit.disabled = false;
    }
  }
}
