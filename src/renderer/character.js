import { SoundEngine } from './audio.js';
import { PressSpring } from '../shared/spring.js';
import { imagePoint, opaqueAt } from '../shared/hit-test.js';

const bridge = window.dragonGirl;
const stage = document.getElementById('stage');
const character = document.getElementById('character');
const portrait = document.getElementById('portrait');
const spring = new PressSpring();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const sound = new SoundEngine();
window.__soundEngine = sound;
let layout;
let assetLoading = false;
let mask;
let activePointer = null;
let animation = 0;
let previousTime = 0;
let pose = spring.pose();
let lastCursor = { x: -1, y: -1 };
let lastInteractive = null;

// 从原图读取一次透明度，不按白色抠图，因此白发、衣服和眼睛高光都能正常响应。
function buildAlphaMask(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const alpha = new Uint8Array(canvas.width * canvas.height);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = rgba[index * 4 + 3];
  if (!alpha.some((value) => value > 24) || !alpha.some((value) => value === 0))
    throw new Error('素材必须同时包含可见像素和真实透明区域。');
  return { width: canvas.width, height: canvas.height, alpha };
}

// 命中图与绘制共用尺寸和弹簧姿态，按压后耳尖和发丝仍与鼠标位置对应。
function isCharacterHit(point) {
  return (
    !!layout &&
    opaqueAt(
      mask,
      imagePoint(point, layout.rect, {
        ...pose,
        scaleX: pose.scaleX * (layout.appearance?.settings?.flip ? -1 : 1),
      }),
    )
  );
}

// 只有状态真正改变时通知原生窗口，避免每个鼠标事件都切换窗口属性。
function routeCursor(point) {
  lastCursor = point;
  const enabled = activePointer !== null || isCharacterHit(point);
  stage.dataset.hit = enabled ? 'opaque' : 'transparent';
  if (enabled === lastInteractive) return;
  lastInteractive = enabled;
  bridge.interactive(enabled);
}

// 布局变化不重建元素或手势监听，拖动中的指针捕获不会因此失效。
function applyLayout(model) {
  layout = model;
  if (model.appearance?.settings) sound.configure(model.appearance.settings);
  stage.dataset.status = model.appearance?.status || 'idle';
  if (portrait.src !== model.asset && !assetLoading) {
    assetLoading = true;
    portrait.src = model.asset;
    portrait
      .decode()
      .then(() => {
        mask = buildAlphaMask(portrait);
      })
      .catch(() => bridge.assetError())
      .finally(() => (assetLoading = false));
  }
  paintPose(pose);
  character.style.left = `${model.rect.x}px`;
  character.style.top = `${model.rect.y}px`;
  character.style.width = `${model.rect.width}px`;
  character.style.height = `${model.rect.height}px`;
  routeCursor(lastCursor);
}

// 每帧只更新角色自身的变换，底部中心固定，不触发整个桌面的布局计算。
function paintPose(next) {
  pose = next;
  character.style.transform = `rotate(${next.angle}deg) scale(${next.scaleX * (layout?.appearance?.settings?.flip ? -1 : 1)}, ${next.scaleY})`;
  routeCursor(lastCursor);
}

// 动画静止后停止 requestAnimationFrame，桌宠闲置时不维持空转的动画循环。
function animate(time) {
  const next = spring.step(Math.max(0, (time - previousTime) / 1000));
  previousTime = time;
  paintPose(next);
  animation = next.settled ? 0 : requestAnimationFrame(animate);
}

// 连点沿用弹簧当前速度，尊重系统减少动态效果设置。
function wakeSpring() {
  if (reducedMotion.matches || layout?.appearance?.settings?.motion === false) {
    paintPose({ scaleX: spring.target[0], scaleY: spring.target[1], angle: 0 });
    return;
  }
  if (animation) return;
  previousTime = performance.now();
  animation = requestAnimationFrame(animate);
}

// 使用屏幕坐标发送位移，原生窗口移动不会改变手势的起点。
function screenPoint(event) {
  return { x: event.screenX, y: event.screenY };
}

// 仅左键按到实际可见像素才开始手势，透明处的点击留给底下的应用。
function beginPointer(event) {
  if (
    event.button !== 0 ||
    activePointer !== null ||
    !isCharacterHit({ x: event.clientX, y: event.clientY })
  )
    return;
  event.preventDefault();
  activePointer = event.pointerId;
  stage.setPointerCapture(event.pointerId);
  stage.dataset.gesture = 'pressed';
  spring.press(((event.clientX - layout.rect.x) / layout.rect.width) * 2 - 1);
  wakeSpring();
  void sound.play('press');
  bridge.beginGesture(screenPoint(event));
  routeCursor({ x: event.clientX, y: event.clientY });
}

// 捕获期间即使鼠标移出角色，也继续发送移动直到松手或取消。
function movePointer(event) {
  routeCursor({ x: event.clientX, y: event.clientY });
  if (activePointer === event.pointerId) bridge.moveGesture(screenPoint(event));
}

// 释放捕获前先清除活动标记，避免 lostpointercapture 把正常松手误判为取消。
function finishPointer(event, cancelled, notify = true) {
  if (activePointer === null || (event && event.pointerId !== activePointer)) return;
  const pointer = activePointer;
  activePointer = null;
  if (stage.hasPointerCapture(pointer)) stage.releasePointerCapture(pointer);
  if (cancelled || stage.dataset.gesture === 'dragging') sound.cancelInteraction();
  else void sound.play('release');
  stage.dataset.gesture = 'idle';
  spring.release();
  wakeSpring();
  if (notify) {
    if (cancelled) bridge.cancelGesture();
    else bridge.endGesture(screenPoint(event));
  }
  routeCursor(lastCursor);
}

// 命中图先于窗口 ready 信号建立，启动时也不会短暂拦截透明区域。
async function start() {
  const model = await bridge.bootstrap();
  portrait.src = model.asset;
  await portrait.decode();
  mask = buildAlphaMask(portrait);
  applyLayout(model);
  stage.dataset.gesture = 'idle';
  bridge.onSound((event) => {
    stage.dataset.cue = event;
    setTimeout(() => delete stage.dataset.cue, 900);
    void sound.play(event);
  });
  bridge.onLayout(applyLayout);
  bridge.onCursor(routeCursor);
  bridge.onInputState((enabled) => {
    lastInteractive = enabled;
  });
  bridge.onDragging((dragging) => {
    if (dragging) {
      sound.cancelInteraction();
      stage.dataset.gesture = 'dragging';
      spring.release();
      wakeSpring();
    }
  });
  bridge.onCancelled(() => finishPointer(null, true, false));
  stage.addEventListener('pointerdown', beginPointer);
  stage.addEventListener('pointermove', movePointer);
  stage.addEventListener('pointerup', (event) => finishPointer(event, false));
  stage.addEventListener('pointercancel', (event) => finishPointer(event, true));
  stage.addEventListener('lostpointercapture', (event) => finishPointer(event, true));
  stage.addEventListener('pointerleave', () => {
    if (activePointer === null) routeCursor({ x: -1, y: -1 });
  });
  stage.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (isCharacterHit({ x: event.clientX, y: event.clientY })) bridge.menu();
  });
  window.addEventListener('blur', () => finishPointer(null, true));
  bridge.ready();
}

// 命中图失败时隐藏挂件并报告错误，禁止退化成一块吞掉鼠标的白色矩形。
start().catch((error) => {
  console.error('龙娘素材初始化失败：', error);
  bridge.assetError();
});
