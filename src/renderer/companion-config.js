import { CHARACTERS, characterById } from '../shared/characters.js';
import { DRAGON_GEAR, dragonEyeTone, dragonHairstyle, dragonOutfit } from '../shared/dragon-gear.js';
import { KANNA_OUTFITS, kannaOutfit } from '../shared/kanna-outfits.js';
import { loadDragonPortrait, paintDragonPortrait } from './dragon-portrait.js';
import { EYE_ARTWORK } from '../shared/gaze.js';
import { MARO_OUTFITS, maroOutfit } from '../shared/maro-outfits.js';
import { loadMaroOutfitLayer, paintMaroOutfitLayer } from './maro-outfit.js';

const ASSET_ORIGIN = 'dragon://app/';
const SVG_NS = 'http://www.w3.org/2000/svg';

// 连线落在各款发型都露出的部件上，发型连线指向刘海。
const GEAR_TARGETS = {
  horns: [385, 235],
  eyes: [420, 746],
  hair: [1001, 444],
  clothes: [780, 1130],
};

// 部件各有独立的透明缩略图，连线终点仍按立绘的原生像素记录。
const ORIGINAL_GEAR = {
  maro: {
    size: [1254, 1254],
    parts: [
      { id: 'tuft', label: '翘发', target: [278, 152] },
      { id: 'eyes', label: '瞳孔', target: [440, 620] },
      { id: 'hair', label: '发型', target: [843, 272] },
      { id: 'clothes', label: '服饰', target: [686, 932], setting: 'maroOutfitId', choices: MARO_OUTFITS },
    ],
  },
  // 兔帽、瞳孔、发饰和服饰各用原版部件，连线沿用原画坐标。
  kokkoro: {
    size: [1299, 1211],
    parts: [
      { id: 'hat', label: '兔帽', target: [309, 275] },
      { id: 'eyes', label: '瞳孔', target: [393, 734] },
      { id: 'accessory', label: '发饰', target: [1012, 680] },
      { id: 'clothes', label: '服饰', target: [641, 1174] },
    ],
  },
  // 连线分别落在康娜的左角、蓝瞳、右侧发珠和披肩绣边上。
  kanna: {
    size: [1254, 1254],
    parts: [
      { id: 'horns', label: '龙角', target: [265, 287] },
      { id: 'eyes', label: '瞳孔', target: [452, 682] },
      { id: 'beads', label: '发珠', target: [1005, 999] },
      { id: 'clothes', label: '服饰', target: [740, 1164], setting: 'kannaOutfitId', choices: KANNA_OUTFITS },
    ],
  },
};

// 分类卡和下方装备选项共用对应部件的完整缩略图。
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
  // 先创建角色按钮，打开配置页时才载入头像、立绘和部件缩略图。
  constructor(root, { selectCharacter, saveGear, toast }) {
    this.root = root;
    this.selectCharacter = selectCharacter;
    this.saveGear = saveGear;
    this.toast = toast;
    this.chooser = root.querySelector('#companion-chooser');
    this.wardrobe = root.querySelector('.dragon-wardrobe');
    this.columns = [root.querySelector('#dragon-equipment-left'), root.querySelector('#dragon-equipment-right')];
    this.picker = root.querySelector('.dragon-gear-picker');
    this.options = root.querySelector('#dragon-gear-options');
    this.previousPage = this.picker.querySelector('[data-page="previous"]');
    this.nextPage = this.picker.querySelector('[data-page="next"]');
    // 翻页和触控板滚动只浏览卡片，服饰选择继续由卡片本身提交。
    this.previousPage.addEventListener('click', () => this.pageOutfits(-1));
    this.nextPage.addEventListener('click', () => this.pageOutfits(1));
    this.options.addEventListener('scroll', () => this.updateOutfitPages(), { passive: true });
    this.options.addEventListener('keydown', (event) => this.focusOutfit(event));
    new ResizeObserver(() => this.updateOutfitPages()).observe(this.picker);
    this.portrait = root.querySelector('#dragon-config-portrait');
    this.slots = new Map();
    this.characterButtons = new Map();
    for (const { id, name, avatar } of CHARACTERS) {
      const button = document.createElement('button');
      button.type = 'button';
      // 头像使用专用的小图，按钮直接用角色名字作为可访问名称。
      const image = document.createElement('img');
      image.alt = '';
      image.width = image.height = 28;
      image.decoding = 'async';
      image.loading = 'lazy';
      image.src = ASSET_ORIGIN + avatar;
      button.append(image, name);
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

  // 角色改变时重建部件卡，立绘和连线都以该角色的原生画幅定位。
  renderCharacter(character) {
    this.character = character;
    // 以当前预览角色为准，为头像小卡、部件卡和连线提供同一套配色。
    this.root.dataset.character = character.id;
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
    delete this.portrait.dataset.outfit;
    delete this.portrait.dataset.tone;
    this.eyeTone = undefined;
    this.preview = null;

    // 固定部件沿用原版图，可切换的服饰从内置清单读取。
    const gear = original ? original.parts.map((part) => ({
      ...part,
      choices: part.choices ?? [{ name: '原版' + part.label, icon: `assets/characters/${character.id}/gear/${part.id}.webp` }],
    })) : DRAGON_GEAR;
    for (const [index, slot] of gear.entries()) {
      const { tile, visual, image } = gearView('dragon-slot', 'button', slot.choices[0], slot.label);
      tile.dataset.slot = slot.id;
      tile.setAttribute('aria-controls', this.options.id);
      tile.setAttribute('aria-expanded', 'false');
      tile.addEventListener('click', () => {
        this.showSlot(this.activeSlot === slot ? null : slot);
        this.updateGear();
      });
      // 龙娘的瞳孔附加自选色标记，各款发型和服饰直接显示对应缩略图。
      if (slot.setting === 'dragonEyeId') {
        this.eyeSwatch = document.createElement('span');
        this.eyeSwatch.className = 'dragon-gear-swatch';
        this.eyeSwatch.hidden = true;
        this.eyeSwatch.setAttribute('aria-hidden', 'true');
        visual.append(this.eyeSwatch);
      }
      const left = index < 2;
      this.columns[left ? 0 : 1].append(tile);
      this.slots.set(slot.id, { tile, image, ...addGearLink(tile), left, target: slot.target ?? GEAR_TARGETS[slot.id] });
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
    this.picker.hidden = !slot;
    this.picker.toggleAttribute('data-outfits', slot?.setting === 'dragonOutfitId');
    this.picker.removeAttribute('data-paged');
    this.options.replaceChildren();
    this.color = null;
    this.choiceOptions = null;
    if (!slot) return;
    this.slots.get(slot.id).tile.setAttribute('aria-expanded', 'true');
    this.options.setAttribute('aria-label', slot.setting ? '选择' + slot.label : slot.label + '原版');
    if (slot.setting === 'dragonEyeId') {
      this.showEyeOptions(slot);
    } else if (slot.setting) {
      this.showGearOptions(slot);
    } else {
      const { tile } = gearView('dragon-gear-option', 'div', slot.choices[0]);
      tile.dataset.selected = '';
      this.options.append(tile);
    }
    if (this.pending) this.setOptionsDisabled(true);
    if (slot.setting === 'dragonOutfitId') {
      this.options.scrollTo({ left: 0, behavior: 'instant' });
      this.updateOutfitPages();
    }
  }

  // 按整行可用宽度判断是否需要箭头，按钮出现后再用实际视口计算两个端点。
  updateOutfitPages() {
    if (this.activeSlot?.setting !== 'dragonOutfitId' || !this.picker.clientWidth) return;
    const row = this.options;
    const paged = row.scrollWidth > this.picker.clientWidth + 1;
    const wasPaged = this.picker.hasAttribute('data-paged');
    this.picker.toggleAttribute('data-paged', paged);
    if (!paged) return;
    // 宽窗口原本能展示全部服饰，缩窄后让正在穿的那套继续可见。
    if (!wasPaged) {
      const selected = row.querySelector('[aria-pressed="true"]');
      if (selected) this.revealOutfit(selected);
    }
    const atStart = String(row.scrollLeft <= 1);
    const atEnd = String(row.scrollLeft + row.clientWidth >= row.scrollWidth - 1);
    if (this.previousPage.ariaDisabled !== atStart) this.previousPage.ariaDisabled = atStart;
    if (this.nextPage.ariaDisabled !== atEnd) this.nextPage.ariaDisabled = atEnd;
  }

  // 翻到相邻的一屏，最后一屏未排满时向左仍回到上一屏的起点。
  pageOutfits(direction) {
    const button = direction < 0 ? this.previousPage : this.nextPage;
    if (button.ariaDisabled === 'true') return;
    const row = this.options;
    const page = direction < 0
      ? Math.ceil((row.scrollLeft - 1) / row.clientWidth) - 1
      : Math.floor((row.scrollLeft + 1) / row.clientWidth) + 1;
    row.scrollTo({ left: page * row.clientWidth, behavior: 'instant' });
    this.updateOutfitPages();
  }

  // 仅在卡片越过可见边缘时横向滚动，保持预览在页面上的位置。
  revealOutfit(tile) {
    const box = tile.getBoundingClientRect(), viewport = this.options.getBoundingClientRect();
    if (box.left < viewport.left || box.right > viewport.right)
      tile.scrollIntoView({ block: 'nearest', inline: 'nearest', container: 'nearest', behavior: 'instant' });
  }

  // 方向键在卡片之间移动焦点，回车或空格沿用按钮原有的试穿操作。
  focusOutfit(event) {
    if (this.activeSlot?.setting !== 'dragonOutfitId' || event.altKey || event.ctrlKey || event.metaKey) return;
    const tile = event.target.closest('.dragon-gear-option');
    if (!tile) return;
    const neighbors = { ArrowLeft: tile.previousElementSibling, ArrowRight: tile.nextElementSibling,
      Home: this.options.firstElementChild, End: this.options.lastElementChild };
    if (!Object.hasOwn(neighbors, event.key)) return;
    event.preventDefault();
    const next = neighbors[event.key];
    if (next) {
      next.focus({ preventScroll: true });
      this.revealOutfit(next);
    }
  }

  // 发型和服饰共用键盘可操作的款式按钮，保存时只提交当前部件。
  showGearOptions(slot) {
    const characterId = this.character.id;
    this.choiceOptions = new Map();
    for (const item of slot.choices) {
      const { tile } = gearView('dragon-gear-option', 'button', item);
      tile.addEventListener('click', () => {
        if (tile.getAttribute('aria-pressed') !== 'true')
          void this.commit(() => this.saveGear({ characterId, slotId: slot.id, itemId: item.id }));
      });
      this.choiceOptions.set(item.id, tile);
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
    this.updateGear();
  }

  // 同步当前款式的缩略图与立绘，固定部件角色直接绘制原画。
  updateGear() {
    const { id, image } = this.character;
    if (id === 'dragon') {
      this.updateDragonGear();
      return;
    }
    let outfit;
    if (id === 'kanna') outfit = kannaOutfit(this.settings.kannaOutfitId);
    if (id === 'maro') outfit = maroOutfit(this.settings.maroOutfitId);
    if (outfit) this.updateChoice('clothes', outfit);
    this.queuePreview({ image, outfit });
  }

  // 分类卡始终显示穿戴中的部件，只有展开的那一组需要同步按钮状态。
  updateChoice(slotId, item) {
    const image = this.slots.get(slotId).image;
    const icon = ASSET_ORIGIN + item.icon;
    if (image.src !== icon) image.src = icon;
    if (this.activeSlot?.id !== slotId) return;
    for (const [id, tile] of this.choiceOptions) {
      const selected = id === item.id;
      if (tile.getAttribute('aria-pressed') === String(selected)) continue;
      tile.toggleAttribute('data-selected', selected);
      tile.setAttribute('aria-pressed', String(selected));
      if (selected && slotId === 'clothes') this.revealOutfit(tile);
    }
  }

  // 独立读取发型、服饰和瞳色，让换装与调色共用同一张试穿预览。
  updateDragonGear() {
    const settings = this.settings;
    const hairstyle = dragonHairstyle(settings.dragonHairstyleId);
    const outfit = dragonOutfit(settings.dragonOutfitId);
    this.updateChoice('hair', hairstyle);
    this.updateChoice('clothes', outfit);
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
    this.queuePreview({ image: hairstyle.image, hairstyle, outfit, tone });
  }

  // 同一帧多次调色时只排队最后一个立绘请求。
  queuePreview(preview) {
    if (this.preview?.image === preview.image && this.preview.outfit === preview.outfit && this.preview.tone === preview.tone) return;
    this.preview = preview;
    cancelAnimationFrame(this.previewFrame);
    this.previewFrame = requestAnimationFrame(() => void this.updatePortrait(preview));
  }

  // 切换角色或装备时只绘制最新的立绘请求，保留原画透明像素。
  async updatePortrait(preview) {
    const { image, hairstyle, outfit, tone } = preview;
    const asset = ASSET_ORIGIN + image;
    try {
      if (hairstyle) {
        const portrait = await loadDragonPortrait(asset, outfit);
        if (this.preview !== preview) return;
        paintDragonPortrait(this.portrait, portrait, tone);
        this.portrait.dataset.hairstyle = hairstyle.id;
        this.portrait.dataset.outfit = outfit.id;
        this.portrait.dataset.tone = tone ?? 'original';
      } else {
        const portrait = new Image();
        portrait.src = outfit?.image ? ASSET_ORIGIN + outfit.image : asset;
        // 各角色预览沿用桌宠对应的成图，麻吕还要叠加待机衣料。
        const [, layer] = await Promise.all([
          portrait.decode(),
          outfit?.layerDirectory ? loadMaroOutfitLayer(outfit, 'idle') : null,
        ]);
        if (this.preview !== preview) return;
        const context = this.portrait.getContext('2d');
        context.clearRect(0, 0, this.portrait.width, this.portrait.height);
        context.drawImage(portrait, 0, 0);
        paintMaroOutfitLayer(context, layer);
        if (outfit) this.portrait.dataset.outfit = outfit.id;
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
