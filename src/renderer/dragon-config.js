import { DRAGON_GEAR, dragonEyeTone } from '../shared/dragon-gear.js';
import { loadOriginalDragonPortrait, paintDragonPortrait } from './dragon-portrait.js';

const ASSET_ORIGIN = 'dragon://app/';
const SVG_NS = 'http://www.w3.org/2000/svg';

// 连线终点用原版立绘的像素坐标，随预览同比缩放。
const GEAR_TARGETS = {
  horns: [255, 296],
  eyes: [420, 746],
  hairpin: [1180, 574],
  clothes: [918, 1138],
};

// 四张分类卡和带缩略图的装备选项共用布局。
function gearView(className, tagName, item, label = item.name) {
  const tile = document.createElement(tagName);
  if (tagName === 'button') tile.type = 'button';
  tile.className = 'dragon-gear-item ' + className;
  const visual = document.createElement('span');
  visual.className = 'dragon-gear-visual';
  const image = document.createElement('img');
  image.alt = '';
  image.decoding = 'async';
  image.src = ASSET_ORIGIN + item.icon;
  const name = document.createElement('span');
  name.textContent = label;
  visual.append(image);
  tile.append(visual, name);
  return { tile, visual };
}

// 连线作为卡片的装饰，延伸到立绘且不会拦截点击或键盘操作。
function addGearLink(tile) {
  const link = document.createElementNS(SVG_NS, 'svg');
  link.classList.add('dragon-slot-link');
  link.setAttribute('aria-hidden', 'true');
  link.setAttribute('focusable', 'false');
  const line = document.createElementNS(SVG_NS, 'polyline');
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('r', '3');
  link.append(line, dot);
  tile.append(link);
  return { link, line, dot };
}

// 四角分类展开对应装备，瞳孔同时提供原色和自选色。
export class DragonConfigView {
  // 仅保存区块的引用，装备页首次打开前不请求缩略图。
  constructor(root, { save, toast }) {
    this.save = save;
    this.toast = toast;
    this.wardrobe = root.querySelector('.dragon-wardrobe');
    this.columns = [root.querySelector('#dragon-equipment-left'), root.querySelector('#dragon-equipment-right')];
    this.options = root.querySelector('#dragon-gear-options');
    this.portrait = root.querySelector('#dragon-config-portrait');
    this.inactive = root.querySelector('#dragon-config-inactive');
  }

  // 首次进入时创建四张分类卡，再次进入时收起已展开的选项。
  open(settings) {
    if (!this.slots) {
      this.slots = new Map();
      for (const [index, slot] of DRAGON_GEAR.entries()) {
        const { tile, visual } = gearView('dragon-slot', 'button', slot.choices[0], slot.label);
        tile.dataset.slot = slot.id;
        tile.setAttribute('aria-controls', this.options.id);
        tile.setAttribute('aria-expanded', 'false');
        tile.addEventListener('click', () => this.toggleSlot(slot));
        // 只有瞳孔需要在分类卡上标出用户选中的颜色。
        if (slot.setting) {
          this.eyeSwatch = document.createElement('span');
          this.eyeSwatch.className = 'dragon-gear-swatch';
          this.eyeSwatch.hidden = true;
          this.eyeSwatch.setAttribute('aria-hidden', 'true');
          visual.append(this.eyeSwatch);
        }
        const left = index < 2;
        this.columns[left ? 0 : 1].append(tile);
        this.slots.set(slot.id, { tile, ...addGearLink(tile), left });
      }
      new ResizeObserver(() => this.updateGearLinks()).observe(this.wardrobe);
    }
    this.settings = settings;
    this.toggleSlot(null);
  }

  // 以卡片的内侧中点为起点，先水平引出，再折向对应部件。
  updateGearLinks() {
    const portrait = this.portrait.getBoundingClientRect();
    if (!portrait.width) return;
    const scale = portrait.width / this.portrait.width;
    for (const [id, { link, line, dot, left }] of this.slots) {
      const [targetX, targetY] = GEAR_TARGETS[id];
      const origin = link.getBoundingClientRect();
      const elbow = 0.75 * ((left ? portrait.left : portrait.right) - origin.left);
      const x = portrait.left - origin.left + targetX * scale;
      const y = portrait.top - origin.top + targetY * scale;
      line.setAttribute('points', `0,0 ${elbow},0 ${x},${y}`);
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);
    }
  }

  // 同一时刻展开一张卡，再点当前卡片时收起并撤回未应用的色彩预览。
  toggleSlot(slot) {
    this.slots.get(this.activeSlot?.id)?.tile.setAttribute('aria-expanded', 'false');
    this.activeSlot = this.activeSlot === slot ? null : slot;
    this.draftColor = null;
    this.options.hidden = !this.activeSlot;
    this.options.replaceChildren();
    this.color = null;
    if (this.activeSlot) {
      this.slots.get(slot.id).tile.setAttribute('aria-expanded', 'true');
      this.options.setAttribute('aria-label', '选择' + slot.label);
      if (slot.setting) {
        this.showEyeOptions(slot);
      } else {
        const { tile } = gearView('dragon-gear-option', 'div', slot.choices[0]);
        tile.dataset.selected = '';
        this.options.append(tile);
      }
    }
    this.update(this.settings);
  }

  // 原色卡可一键恢复紫瞳，自选色卡单独打开原生调色板。
  showEyeOptions(slot) {
    const [original, custom] = slot.choices;
    const { tile: preset } = gearView('dragon-gear-option', 'button', original);
    preset.disabled = !!this.pending;
    preset.addEventListener('click', () => {
      if (preset.getAttribute('aria-pressed') !== 'true') void this.commit({ slotId: slot.id, itemId: original.id });
    });

    const picker = document.createElement('label');
    picker.className = 'dragon-gear-item dragon-gear-option dragon-color-picker';
    const chip = document.createElement('span');
    chip.className = 'dragon-color-chip';
    chip.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = custom.name;
    const input = document.createElement('input');
    input.id = 'dragon-eye-color';
    input.type = 'color';
    input.disabled = !!this.pending;
    // 拖动时更新立绘，选定颜色时直接应用到桌宠。
    input.addEventListener('input', () => {
      if (this.color?.input !== input) return;
      this.draftColor = input.value;
      this.update(this.settings);
    });
    input.addEventListener('change', () => {
      if (this.color?.input === input) void this.commit({ slotId: slot.id, itemId: custom.id, color: input.value });
    });
    picker.append(chip, name, input);
    this.options.append(preset, picker);
    this.color = { preset, picker, chip, input };
  }

  // 只有角色或瞳色变化才更新相应控件，额度推送不重写配置页。
  update(settings) {
    this.settings = settings;
    const inactiveHidden = settings.characterId === 'dragon' && !settings.characterAsset;
    if (this.inactive.hidden !== inactiveHidden) this.inactive.hidden = inactiveHidden;
    const savedTone = dragonEyeTone(settings);
    if (this.eyeTone !== savedTone) {
      this.eyeTone = savedTone;
      this.eyeSwatch.hidden = savedTone === null;
      if (savedTone !== null) this.eyeSwatch.style.backgroundColor = savedTone;
    }
    const tone = this.draftColor ?? savedTone;
    if (this.color) {
      const { preset, picker, chip, input } = this.color;
      const value = tone ?? settings.dragonEyeColor;
      if (this.color.value !== value) {
        this.color.value = value;
        if (input.value !== value) input.value = value;
        chip.style.backgroundColor = value;
      }
      if (this.color.tone !== tone) {
        this.color.tone = tone;
        preset.toggleAttribute('data-selected', tone === null);
        preset.setAttribute('aria-pressed', String(tone === null));
        picker.toggleAttribute('data-selected', tone !== null);
      }
    }
    if (this.previewTone !== tone) {
      this.previewTone = tone;
      cancelAnimationFrame(this.previewFrame);
      this.previewFrame = requestAnimationFrame(() => void this.updatePortrait(tone));
    }
  }

  // 直接绘制原画；快速选色时只显示最后一次预览。
  async updatePortrait(tone) {
    try {
      const original = await loadOriginalDragonPortrait();
      if (this.previewTone !== tone) return;
      paintDragonPortrait(this.portrait, original, tone);
      this.portrait.dataset.tone = tone ?? 'original';
    } catch {
      if (this.previewTone === tone) {
        this.previewTone = undefined;
        this.toast('龙娘预览暂时无法加载');
      }
    }
  }

  // 保存成功后只刷新选中状态和预览，已提交的设置不受切换类别影响。
  async commit(selection) {
    if (this.pending) return;
    this.pending = true;
    if (this.color) this.color.input.disabled = this.color.preset.disabled = true;
    this.options.setAttribute('aria-busy', 'true');
    try {
      const settings = await this.save(selection);
      this.draftColor = null;
      this.update(settings);
    } catch {
      // 保存失败时撤回预览，具体错误由命令入口显示。
      this.draftColor = null;
      this.update(this.settings);
    } finally {
      this.pending = false;
      if (this.color) this.color.input.disabled = this.color.preset.disabled = false;
      this.options.removeAttribute('aria-busy');
    }
  }
}
