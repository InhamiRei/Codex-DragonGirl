import test from 'node:test';
import assert from 'node:assert/strict';
import { snapCharacter, constrainCharacter, capturePlacement, restorePlacement, characterSize,
  resizeCharacter, placeBubble, bubbleDimensions, bubbleOutline, stageBounds, EDGE_MARGIN, BUBBLE_FRAME } from '../src/shared/geometry.js';
import { normalizeState } from '../src/shared/state.js';

const display = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 850 } };
const size = { width: 260, height: 231 };

// 同时验证左右和上下边，吸附依据角色而不是透明窗口边距。
test('四边与角落吸附，关闭吸附仍保留屏幕边界保护', () => {
  const area = display.workArea;
  assert.deepEqual(snapCharacter({ ...size, x: 20, y: 45 }, area), { ...size, x: 0, y: 25 });
  assert.deepEqual(snapCharacter({ ...size, x: 1155, y: 620 }, area), { ...size, x: 1180, y: 644 });
  assert.deepEqual(snapCharacter({ ...size, x: 20, y: 45 }, area, false), { ...size, x: 20, y: 45 });
  assert.equal(constrainCharacter({ ...size, x: -999, y: -999 }, area).y, 25);
});

// 多显示器左侧和上方可以使用负坐标，不应错误夹到主屏幕原点。
test('负坐标副屏可以吸附与恢复', () => {
  const secondary = { id: 2, workArea: { x: -1920, y: -100, width: 1920, height: 1080 } };
  const rect = snapCharacter({ ...size, x: -1910, y: -90 }, secondary.workArea);
  const saved = capturePlacement(rect, secondary);
  assert.deepEqual(restorePlacement(saved, secondary, size), rect);
  assert.equal(rect.x, -1920);
  assert.equal(rect.y, -100);
});

// 临时缩小显示器只限制当前显示，不改变原来的自由摆放比例。
test('工作区变化后仍保留自由位置意图', () => {
  const original = { ...size, x: 438, y: 360 };
  const saved = capturePlacement(original, display);
  const encoded = JSON.stringify(saved);
  const small = { id: 1, workArea: { x: 0, y: 25, width: 800, height: 550 } };
  const temporary = restorePlacement(saved, small, size);
  assert.ok(temporary.x >= 0 && temporary.x + size.width <= 800);
  assert.equal(JSON.stringify(saved), encoded);
  assert.deepEqual(restorePlacement(saved, display, size), original);
});

// 放大角色时已经吸附的右边和底边不应跳动。
test('调整大小保留底边与吸附边', () => {
  const original = restorePlacement(null, display, size);
  const saved = capturePlacement(original, display);
  const larger = resizeCharacter(original, { width: 325, height: 289 }, saved, display.workArea);
  assert.equal(larger.x + larger.width, original.x + original.width);
  assert.equal(larger.y + larger.height, original.y + original.height);
});

// 气泡在顶部空间不足时翻到下方，左右靠边时也不会跑出屏幕。
test('独立气泡自动避让上边与右边', () => {
  const top = placeBubble({ ...size, x: 1168, y: 37 }, display.workArea);
  assert.equal(top.side, 'below');
  assert.ok(top.bounds.x + top.bounds.width <= 1436);
  const bottom = placeBubble({ ...size, x: 12, y: 632 }, display.workArea);
  assert.equal(bottom.side, 'above');
  assert.ok(bottom.bounds.x >= 4);
});

// 用反馈图的二倍像素坐标复现半大小角色：用量椭圆中心约在 (208, 359)，头像左上角在 (370, 468)。
test('半大小用量气泡回到标出的头侧位置，贴左时镜像，泡尾与角色之间留空', () => {
  const workArea = { x: -400, y: -400, width: 1750, height: 1500 };
  const character = { x: 185, y: 234, width: 130, height: 116 };
  const dims = bubbleDimensions(character.width, workArea);
  const layout = placeBubble(character, workArea);
  assert.equal(layout.side, 'above');
  assert.equal(layout.horizontal, 'left');
  const center = bubbleOutline({ width: dims.width / dims.scale, height: dims.height / dims.scale }, layout.tailX / dims.scale);
  assert.ok(Math.abs((layout.bounds.x + center.centerX * dims.scale) * 2 - 208) <= 4, '气泡中心未落回红框横向位置');
  assert.ok(Math.abs((layout.bounds.y + center.centerY * dims.scale) * 2 - 359) <= 4, '气泡中心未落回红框纵向位置');
  const reach = (BUBBLE_FRAME.thoughtWidth - BUBBLE_FRAME.thoughtRoot) * dims.scale;
  const leftGap = character.x - (layout.bounds.x + layout.tailX + reach);
  assert.ok(leftGap >= 4 && leftGap <= 8, '左侧最小圆泡应靠近头部且避开龙角');

  const leftEdge = { ...character, x: workArea.x };
  const mirror = placeBubble(leftEdge, workArea);
  assert.equal(mirror.horizontal, 'right');
  assert.equal(mirror.side, layout.side);
  assert.equal(mirror.bounds.y, layout.bounds.y);
  const rightGap = mirror.bounds.x + mirror.tailX - reach - (leftEdge.x + leftEdge.width);
  assert.ok(Math.abs(rightGap - leftGap) <= 1, '左右位置的泡尾净距不一致');
});

// 狭窄的工作区会把椭圆推回头像上方或下方。沿实际描边采样，包含负坐标和两种翻转。
test('侧面空间不足时，椭圆靠角色的一段仍保持间距', () => {
  const area = { x: -520, y: -180, width: 290, height: 540 };
  for (const x of [area.x + 74, area.x + 86]) for (const y of [area.y + 4, area.y + 260]) {
    const character = { x, y, width: 130, height: 116 };
    const dims = bubbleDimensions(character.width, area);
    const { bounds, side, tailX } = placeBubble(character, area);
    const shape = bubbleOutline({ width: bounds.width / dims.scale, height: bounds.height / dims.scale }, tailX / dims.scale);
    for (let degree = 0; degree < 360; degree++) {
      const angle = degree * Math.PI / 180;
      const arcX = bounds.x + (shape.centerX + shape.radiusX * Math.cos(angle)) * dims.scale;
      const localY = (shape.centerY + shape.radiusY * Math.sin(angle)) * dims.scale;
      const arcY = bounds.y + (side === 'above' ? localY : bounds.height - localY);
      const dx = Math.max(0, x - arcX, arcX - x - character.width);
      const dy = Math.max(0, y - arcY, arcY - y - character.height);
      assert.ok(Math.hypot(dx, dy) - BUBBLE_FRAME.stroke * dims.scale / 2 >= 4, '空间夹紧后描边压到了角色');
    }
  }
});

// 低矮副屏上方和下方都放不下时，两种镜像方向都能把气泡放到角色旁边。
test('上下空间不足时选能容纳气泡的一侧，窗口夹紧后也不碰角色', () => {
  const area = { x: -1180, y: -310, width: 1000, height: 320 };
  for (const offset of [80, 640]) {
    const character = { ...size, x: area.x + offset, y: area.y + 45 };
    const { bounds, horizontal } = placeBubble(character, area);
    assert.equal(horizontal, offset === 80 ? 'right' : 'left');
    const gap = horizontal === 'right' ? bounds.x - (character.x + character.width) : character.x - (bounds.x + bounds.width);
    assert.ok(gap >= 6 && gap <= 7);
    assert.ok(bounds.y >= area.y + 4 && bounds.y + bounds.height <= area.y + area.height - 4);
  }
});

// 角色在各个大小下使用统一比例缩放气泡；小屏幕按短边限制，不挤扁轮廓或裁掉尾巴。
test('气泡随角色缩放，最小档文字可读，四角和负坐标屏幕内保留完整边界', () => {
  for (const area of [display.workArea, { x: -320, y: -160, width: 220, height: 175 }]) {
    let previous = 0;
    for (const factor of [.5, .6, .75, 1, 1.25, 1.5]) {
      const size = characterSize(factor, area);
      const dims = bubbleDimensions(size.width, area);
      assert.ok(dims.width >= previous);
      if (area === display.workArea) {
        assert.ok(dims.width > previous);
        assert.ok(dims.scale * 16 >= 12);
      }
      previous = dims.width;
      for (const x of [area.x, area.x + area.width - size.width])
        for (const y of [area.y, area.y + area.height - size.height]) {
          const { bounds, horizontal, tailX } = placeBubble({ ...size, x, y }, area);
          assert.deepEqual([bounds.width, bounds.height], [dims.width, dims.height]);
          assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width);
          assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
          const left = tailX - dims.scale * (horizontal === 'left' ? BUBBLE_FRAME.thoughtRoot : BUBBLE_FRAME.thoughtWidth - BUBBLE_FRAME.thoughtRoot);
          assert.ok(left >= 0 && left + dims.scale * BUBBLE_FRAME.thoughtWidth <= bounds.width);
        }
    }
  }
});

// 主体左移后，短句的泡链可能接近窄窗口边缘，左右两种方向都必须完整保留小圆泡。
test('短句泡链在偏左和镜像布局中都不会超出窗口', () => {
  for (const x of [600, 0]) {
    const layout = placeBubble({ ...size, x, y: 400 }, display.workArea, { width: 109, height: 89 });
    const start = layout.horizontal === 'left'
      ? layout.tailX - BUBBLE_FRAME.thoughtRoot
      : layout.tailX + BUBBLE_FRAME.thoughtRoot - BUBBLE_FRAME.thoughtWidth;
    assert.ok(start >= 0 && start + BUBBLE_FRAME.thoughtWidth <= layout.bounds.width);
  }
});

// 定位计算遵守传入的窗口边界，小工作区与负坐标显示器也不能越界。
test('气泡矩形自动避让，并约束到负坐标的小工作区', () => {
  const character = { ...size, x: 1180, y: 155 };
  assert.equal(placeBubble(character, display.workArea, { width: 150, height: 100 }).side, 'above');
  assert.equal(placeBubble(character, display.workArea, { width: 320, height: 240 }).side, 'below');
  const area = { x: -200, y: -100, width: 190, height: 180 };
  const layout = placeBubble({ x: -150, y: -90, width: 80, height: 60 }, area, { width: 320, height: 420 });
  assert.ok(layout.bounds.x >= area.x + 4 && layout.bounds.y >= area.y + 4);
  assert.ok(layout.bounds.x + layout.bounds.width <= area.x + area.width - 4);
  assert.ok(layout.bounds.y + layout.bounds.height <= area.y + area.height - 4);
});

// 小显示器临时缩放，与用户保存的 scale 分开。
test('角色可适应小工作区且保留回弹边距', () => {
  const small = characterSize(1.5, { x: 0, y: 0, width: 240, height: 200 });
  assert.ok(small.width <= 240 && small.height <= 200);
  const rect = { ...small, x: EDGE_MARGIN, y: EDGE_MARGIN };
  assert.equal(stageBounds(rect).width - small.width, 64);
});

// 损坏的首选项不能让角色变成无限大或移动到 NaN 坐标。
test('异常配置回退到有限、安全的位置与比例', () => {
  const state = normalizeState({ version: 1, scale: Infinity, snapEnabled: 'false',
    placement: { displayId: '1', horizontal: { edge: null, ratio: NaN }, vertical: { edge: 'end', ratio: 1 } } });
  assert.equal(state.scale, 1);
  assert.equal(state.snapEnabled, true);
  assert.equal(state.placement, null);
});
