import { SoundEngine } from './audio.js';
import { PressSpring } from '../shared/spring.js';
import { imagePoint, opaqueAt } from '../shared/hit-test.js';
import { EyeTracker } from './eyes.js';

const bridge = window.dragonGirl;
const stage = document.getElementById('stage');
const character = document.getElementById('character');
const portrait = document.getElementById('portrait');
const eyes = new EyeTracker(character, paintBodyPose);
const spring = new PressSpring();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const sound = new SoundEngine();
window.__soundEngine = sound;
let layout;
let assetLoading = '';
let decodedPortrait;
let mask;
let activePointer = null;
let animation = 0;
let previousTime = 0;
let pose = spring.pose();
let bodyPose = { translateX: 0, translateY: 0, angle: 0 };
let renderedPose = pose;
let lastCursor = null;
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
    !!point &&
    opaqueAt(
      mask,
      imagePoint(point, layout.rect, renderedPose),
    )
  );
}

// 只更新命中而不重新计算视线目标，身体每帧移动不会形成鼠标追逐的反馈循环。
function updateInteractive() {
  const enabled = layout?.visible !== false && (activePointer !== null || isCharacterHit(lastCursor));
  stage.dataset.hit = enabled ? 'opaque' : 'transparent';
  if (enabled === lastInteractive) return;
  lastInteractive = enabled;
  bridge.interactive(enabled);
}

// 只有真实鼠标消息改变目标，原生输入状态仍只在命中变化时切换。
function routeCursor(point) {
  lastCursor = point;
  if (point) eyes.follow(point);
  updateInteractive();
}

// 目标依据固定锚点和按压姿态计算，身体跟随的微小位移不反过来改变目标方向。
function configureEyes() {
  if (!layout || !decodedPortrait) return;
  eyes.configure(decodedPortrait, layout, {
    ...pose,
    scaleX: pose.scaleX * (layout.appearance?.settings?.flip ? -1 : 1),
  }, reducedMotion.matches, activePointer !== null);
}

// 先完整解码再替换画面与命中图，快速切换图片时丢弃过期结果，避免错套默认眼区。
async function loadPortrait(asset) {
  assetLoading = asset;
  try {
    const image = new Image();
    image.src = asset;
    await image.decode();
    if (layout.asset !== asset) return;
    const nextMask = buildAlphaMask(image);
    portrait.src = asset;
    decodedPortrait = image;
    mask = nextMask;
    configureEyes();
    routeCursor(lastCursor);
  } catch {
    if (layout.asset === asset) bridge.assetError();
  } finally {
    if (assetLoading === asset) assetLoading = '';
  }
}

// 布局变化不重建元素或手势监听，拖动中的指针捕获不会因此失效。
function applyLayout(model) {
  layout = model;
  if (model.appearance?.settings) sound.configure(model.appearance.settings);
  stage.dataset.status = model.appearance?.status || 'idle';
  if (portrait.src !== model.asset && assetLoading !== model.asset) void loadPortrait(model.asset);
  paintPose(pose);
  character.style.left = `${model.rect.x}px`;
  character.style.top = `${model.rect.y}px`;
  character.style.width = `${model.rect.width}px`;
  character.style.height = `${model.rect.height}px`;
  routeCursor(lastCursor);
}

// 将点击回弹与身体跟随合成同一份绘制姿态，命中检测也读取最终的平移、翻转和倾角。
function paintCharacter() {
  if (!layout) return;
  renderedPose = {
    ...pose, ...bodyPose,
    angle: pose.angle + bodyPose.angle,
    scaleX: pose.scaleX * (layout.appearance?.settings?.flip ? -1 : 1),
  };
  character.style.transform = `translate(${renderedPose.translateX}px, ${renderedPose.translateY}px) rotate(${renderedPose.angle}deg) scale(${renderedPose.scaleX}, ${renderedPose.scaleY})`;
  updateInteractive();
}

// 身体只改变角色的视觉姿态，不移动原生窗口、气泡或已保存的位置锚点。
function paintBodyPose(next) {
  bodyPose = next;
  paintCharacter();
}

// 按压弹簧更新后重新校准视线，但身体动画自身不触发这一步。
function paintPose(next) {
  pose = next;
  configureEyes();
  paintCharacter();
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
  await Promise.all([portrait.decode(), eyes.prepareSad()]);
  mask = buildAlphaMask(portrait);
  decodedPortrait = portrait;
  applyLayout(model);
  stage.dataset.gesture = 'idle';
  bridge.onSound((event) => {
    stage.dataset.cue = event;
    setTimeout(() => delete stage.dataset.cue, 900);
    void sound.play(event);
  });
  // 主进程区分轻点、成功与失败；声音关闭仍可显示表情，拖拽不会误触。
  bridge.onExpression((name) => {
    if (!['happy', 'sad'].includes(name)) return;
    configureEyes();
    eyes.showExpression(name);
  });
  // 手动修复后立即重新读取原声，不依赖其他布局或设置变化才能恢复播放。
  bridge.onAudioReady(() => {
    void sound.configure(sound.settings);
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
    // 离开只释放点击命中，视线继续等待全局鼠标坐标，不误看向窗口左上角。
    if (activePointer === null) routeCursor(null);
  });
  stage.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (isCharacterHit({ x: event.clientX, y: event.clientY })) bridge.menu();
  });
  window.addEventListener('blur', () => finishPointer(null, true));
  reducedMotion.addEventListener('change', configureEyes);
  document.addEventListener('visibilitychange', configureEyes);
  window.addEventListener('pagehide', () => eyes.reset());
  bridge.ready();
}

// 命中图失败时隐藏挂件并报告错误，禁止退化成一块吞掉鼠标的白色矩形。
start().catch((error) => {
  console.error('龙娘素材初始化失败：', error);
  bridge.assetError();
});
