import { CHARACTERS, characterById } from '../shared/characters.js';
import { DRAGON_GEAR, dragonEyeTone, dragonHairstyle } from '../shared/dragon-gear.js';
import { loadDragonPortrait, paintDragonPortrait } from './dragon-portrait.js';
import { EYE_ARTWORK } from '../shared/gaze.js';

const ASSET_ORIGIN = 'dragon://app/';
const SVG_NS = 'http://www.w3.org/2000/svg';

// 连线落在各款发型都露出的部件上，发型连线指向刘海。
const GEAR_TARGETS = {
  horns: [385, 235],
  eyes: [420, 746],
  hair: [1001, 444],
  clothes: [780, 1130],
};

// 麻吕和可可萝的部件缩略图直接取自原画，裁切框和连线终点使用原图像素。
const ORIGINAL_GEAR = {
  maro: {
    size: [1254, 1254],
    parts: [
      { id: 'tuft', label: '翘发', crop: [211, 86, 151, 120], target: [278, 152] },
      { id: 'eyes', label: '瞳孔', crop: [333, 548, 170, 133], target: [440, 620] },
      { id: 'hair', label: '发型', crop: [223, 18, 716, 543], target: [843, 272] },
      { id: 'clothes', label: '服饰', crop: [375, 812, 402, 285], target: [686, 932] },
    ],
  },
  kokkoro: {
    size: [1299, 1211],
    parts: [
      { id: 'hat', label: '兔帽', crop: [163, 81, 774, 422], target: [309, 275] },
      { id: 'eyes', label: '瞳孔', crop: [268, 597, 187, 216], target: [393, 734] },
      { id: 'accessory', label: '发饰', crop: [770, 475, 399, 369], target: [1012, 680] },
      { id: 'clothes', label: '服饰', crop: [350, 1018, 372, 186], target: [641, 1174] },
    ],
  },
};

// 让裁切框等比缩放，卡片和下方的原版选项共用对应部位的缩略图。
function cropGearImage(image, { crop: [x, y, width, height], size }) {
  const frame = document.createElement('span');
  frame.className = 'dragon-gear-crop';
  const scale = 100 / Math.max(width, height);
  frame.style.width = width * scale + '%';
  frame.style.height = height * scale + '%';
  image.style.width = 100 * size[0] / width + '%';
  image.style.height = 100 * size[1] / height + '%';
  image.style.left = -100 * x / width + '%';
  image.style.top = -100 * y / height + '%';
  frame.append(image);
  return frame;
}

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
  visual.append(item.crop ? cropGearImage(image, item) : image);
  tile.append(visual, name);
  return { tile, visual, image };
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

// 共用四角部件布局，选择内置角色后同步桌宠和对应的立绘。
export class CompanionConfigView {
  // 先创建角色按钮，首次打开配置页时才载入立绘和部件缩略图。
  constructor(root, { selectCharacter, saveGear, toast }) {
    this.selectCharacter = selectCharacter;
    this.saveGear = saveGear;
    this.toast = toast;
    this.chooser = root.querySelector('#companion-chooser');
    this.wardrobe = root.querySelector('.dragon-wardrobe');
    this.columns = [root.querySelector('#dragon-equipment-left'), root.querySelector('#dragon-equipment-right')];
    this.options = root.querySelector('#dragon-gear-options');
    this.portrait = root.querySelector('#dragon-config-portrait');
    this.slots = new Map();
    this.characterButtons = new Map();
    for (const { id, name } of CHARACTERS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      // 选中状态由已保存的角色决定，点击时清除自定义原画覆盖。
      button.addEventListener('click', () => {
        if (button.getAttribute('aria-pressed') !== 'true') void this.commit(() => this.selectCharacter(id));
      });
      this.characterButtons.set(id, button);
      this.chooser.append(button);
    }
    new ResizeObserver(() => this.updateGearLinks()).observe(this.wardrobe);
  }

  // 打开页面时呈现已选角色，并收起上次展开的部件。
  open(settings) {
    this.showSlot(null);
    this.update(settings);
  }

  // 角色改变时重建四张部件卡，立绘和连线都以该角色的原生画幅定位。
  renderCharacter(character) {
    this.character = character;
    this.showSlot(null);
    this.slots.clear();
    for (const column of this.columns) column.replaceChildren();
    const original = ORIGINAL_GEAR[character.id];
    const [width, height] = original?.size ?? [EYE_ARTWORK.width, EYE_ARTWORK.height];
    this.portrait.width = width;
    this.portrait.height = height;
    this.portrait.parentElement.style.aspectRatio = width + ' / ' + height;
    this.portrait.setAttribute('aria-label', character.name + '外观预览');
    delete this.portrait.dataset.asset;
    delete this.portrait.dataset.hairstyle;
    delete this.portrait.dataset.tone;
    this.eyeTone = undefined;
    this.preview = null;

    // 原版部件复用龙角的单项展示方式，不关联可写入的设置字段。
    const gear = original ? original.parts.map(({ id, label, crop, target }) => ({
      id, label, target, choices: [{ name: '原版' + label, icon: character.image, crop, size: original.size }],
    })) : DRAGON_GEAR;
    for (const [index, slot] of gear.entries()) {
      const { tile, visual, image } = gearView('dragon-slot', 'button', slot.choices[0], slot.label);
      tile.dataset.slot = slot.id;
      tile.setAttribute('aria-controls', this.options.id);
      tile.setAttribute('aria-expanded', 'false');
      tile.addEventListener('click', () => {
        this.showSlot(this.activeSlot === slot ? null : slot);
        if (character.id === 'dragon') this.updateDragonGear();
      });
      // 龙娘的瞳孔附加自选色标记，发型显示当前款式的缩略图。
      if (slot.setting === 'dragonEyeId') {
        this.eyeSwatch = document.createElement('span');
        this.eyeSwatch.className = 'dragon-gear-swatch';
        this.eyeSwatch.hidden = true;
        this.eyeSwatch.setAttribute('aria-hidden', 'true');
        visual.append(this.eyeSwatch);
      }
      if (slot.setting === 'dragonHairstyleId') this.hairIcon = image;
      const left = index < 2;
      this.columns[left ? 0 : 1].append(tile);
      this.slots.set(slot.id, { tile, ...addGearLink(tile), left, target: slot.target ?? GEAR_TARGETS[slot.id] });
    }
    this.updateGearLinks();
  }

  // 以卡片的内侧中点为起点，先水平引出，再折向对应部件。
  updateGearLinks() {
    const portrait = this.portrait.getBoundingClientRect();
    if (!portrait.width) return;
    const scale = portrait.width / this.portrait.width;
    for (const { link, line, dot, left, target: [targetX, targetY] } of this.slots.values()) {
      const origin = link.getBoundingClientRect();
      const elbow = 0.75 * ((left ? portrait.left : portrait.right) - origin.left);
      const x = portrait.left - origin.left + targetX * scale;
      const y = portrait.top - origin.top + targetY * scale;
      line.setAttribute('points', `0,0 ${elbow},0 ${x},${y}`);
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);
    }
  }

  // 同一时刻只展开一张卡，收起或换部件时丢弃未应用的瞳色预览。
  showSlot(slot) {
    this.slots.get(this.activeSlot?.id)?.tile.setAttribute('aria-expanded', 'false');
    this.activeSlot = slot;
    this.draftColor = null;
    this.options.hidden = !this.activeSlot;
    this.options.replaceChildren();
    this.color = null;
    this.hairOptions = null;
    if (!slot) return;
    this.slots.get(slot.id).tile.setAttribute('aria-expanded', 'true');
    this.options.setAttribute('aria-label', slot.setting ? '选择' + slot.label : slot.label + '原版');
    if (slot.setting === 'dragonEyeId') {
      this.showEyeOptions(slot);
    } else if (slot.setting === 'dragonHairstyleId') {
      this.showHairstyleOptions(slot);
    } else {
      const { tile } = gearView('dragon-gear-option', 'div', slot.choices[0]);
      tile.dataset.selected = '';
      this.options.append(tile);
    }
    if (this.pending) this.setOptionsDisabled(true);
  }

  // 每张发型缩略图都是可用键盘操作的按钮，已选款式无需再次保存。
  showHairstyleOptions(slot) {
    this.hairOptions = new Map();
    for (const item of slot.choices) {
      const { tile } = gearView('dragon-gear-option', 'button', item);
      tile.addEventListener('click', () => {
        if (tile.getAttribute('aria-pressed') !== 'true')
          void this.commit(() => this.saveGear({ slotId: slot.id, itemId: item.id }));
      });
      this.hairOptions.set(item.id, tile);
      this.options.append(tile);
    }
  }

  // 原色卡可一键恢复紫瞳，自选色卡单独打开原生调色板。
  showEyeOptions(slot) {
    const [original, custom] = slot.choices;
    const { tile: preset } = gearView('dragon-gear-option', 'button', original);
    preset.addEventListener('click', () => {
      if (preset.getAttribute('aria-pressed') !== 'true')
        void this.commit(() => this.saveGear({ slotId: slot.id, itemId: original.id }));
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
    // 拖动时更新立绘，选定颜色时直接应用到桌宠。
    input.addEventListener('input', () => {
      if (this.color?.input !== input) return;
      this.draftColor = input.value;
      this.updateDragonGear();
    });
    input.addEventListener('change', () => {
      if (this.color?.input === input)
        void this.commit(() => this.saveGear({ slotId: slot.id, itemId: custom.id, color: input.value }));
    });
    picker.append(chip, name, input);
    this.options.append(preset, picker);
    this.color = { preset, picker, chip, input };
  }

  // 角色设置的推送同步选中状态，额度推送不重建部件控件。
  update(settings) {
    this.settings = settings;
    const character = characterById(settings.characterId);
    if (this.character !== character) this.renderCharacter(character);
    for (const [id, button] of this.characterButtons) {
      const pressed = String(id === character.id && !settings.characterAsset);
      if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    }
    if (character.id === 'dragon') this.updateDragonGear();
    else this.queuePreview({ image: character.image });
  }

  // 仅为龙娘更新发型按钮、瞳色标记和配色预览。
  updateDragonGear() {
    const settings = this.settings;
    const hairstyle = dragonHairstyle(settings.dragonHairstyleId);
    const icon = ASSET_ORIGIN + hairstyle.icon;
    if (this.hairIcon.src !== icon) this.hairIcon.src = icon;
    for (const [id, tile] of this.hairOptions ?? []) {
      const selected = id === hairstyle.id;
      if (tile.getAttribute('aria-pressed') === String(selected)) continue;
      tile.toggleAttribute('data-selected', selected);
      tile.setAttribute('aria-pressed', String(selected));
    }
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
    this.queuePreview({ image: hairstyle.image, hairstyle, tone });
  }

  // 同一帧多次调色时只排队最后一个立绘请求。
  queuePreview(preview) {
    if (this.preview?.image === preview.image && this.preview.tone === preview.tone) return;
    this.preview = preview;
    cancelAnimationFrame(this.previewFrame);
    this.previewFrame = requestAnimationFrame(() => void this.updatePortrait(preview));
  }

  // 切换角色、发型或瞳色时只绘制最新的立绘请求，保留原画透明像素。
  async updatePortrait(preview) {
    const { image, hairstyle, tone } = preview;
    const asset = ASSET_ORIGIN + image;
    try {
      if (hairstyle) {
        const portrait = await loadDragonPortrait(asset);
        if (this.preview !== preview) return;
        paintDragonPortrait(this.portrait, portrait, tone);
        this.portrait.dataset.hairstyle = hairstyle.id;
        this.portrait.dataset.tone = tone ?? 'original';
      } else {
        const portrait = new Image();
        portrait.src = asset;
        await portrait.decode();
        if (this.preview !== preview) return;
        const context = this.portrait.getContext('2d');
        context.clearRect(0, 0, this.portrait.width, this.portrait.height);
        context.drawImage(portrait, 0, 0);
      }
      this.portrait.dataset.asset = asset;
    } catch {
      if (this.preview === preview) {
        this.preview = null;
        this.toast(this.character.name + '预览暂时无法加载');
      }
    }
  }

  // 保存时标记角色和部件选项暂不可用，保留亮度和键盘焦点。
  setOptionsDisabled(disabled) {
    for (const button of [...this.characterButtons.values(), ...this.options.querySelectorAll('button')]) {
      if (disabled) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
    // 原生调色板暂时禁止打开，避免保存期间编辑另一种颜色。
    if (this.color) this.color.input.disabled = disabled;
  }

  // 角色和部件共用保存顺序，避免快速点击后旧请求覆盖当前选择。
  async commit(save) {
    if (this.pending) return;
    this.pending = true;
    this.setOptionsDisabled(true);
    this.options.setAttribute('aria-busy', 'true');
    try {
      const settings = await save();
      this.draftColor = null;
      this.update(settings);
    } catch {
      // 保存失败时撤回预览，具体错误由命令入口显示。
      this.draftColor = null;
      this.update(this.settings);
    } finally {
      this.pending = false;
      this.setOptionsDisabled(false);
      this.options.removeAttribute('aria-busy');
    }
  }
}
