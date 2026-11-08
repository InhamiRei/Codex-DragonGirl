import { SoundEngine } from './audio.js';
import { PressSpring } from '../shared/spring.js';
import { imagePoint, opaqueAt } from '../shared/hit-test.js';
import { EyeTracker } from './eyes.js';
import { FlipMotion } from '../shared/facing.js';
import { CharacterSprites } from './character-sprites.js';
import { characterByAsset, isCharacterMenuPoint } from '../shared/characters.js';
import { DEFAULT_CHARACTER_ASSET, EYE_ARTWORK } from '../shared/gaze.js';

// 将短过渡计入原来的祈祷时长，中间停留在定稿姿势。
const PRAYER_DURATION = 2400;
const PRAYER_ENTER = 360;
const PRAYER_EXIT = 320;
const bridge = window.dragonGirl;
const stage = document.getElementById('stage');
const character = document.getElementById('character');
const portrait = document.getElementById('portrait');
const prayerPortrait = document.getElementById('prayer-portrait');
const prayerHalf = document.getElementById('prayer-half');
const prayerHands = document.getElementById('prayer-hands');
const eyes = new EyeTracker(character, paintBodyPose);
const spring = new PressSpring();
const flip = new FlipMotion();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const sound = new SoundEngine();
window.__soundEngine = sound;
let layout;
let assetLoading = '';
let decodedPortrait;
let mask;
let baseMask;
let menuPress = null;
let activePointer = null;
let animation = 0;
let previousTime = 0;
let pose = spring.pose();
let bodyPose = { translateX: 0, translateY: 0, angle: 0 };
let renderedPose = pose;
let lastCursor = null;
let lastInteractive = null;
let prayerReady = false;
let prayerMotionReady = false;
let prayerProgress = null;
let prayerFrame = 0;
let prayerTimer = 0;
// 每次换表情或动作帧都同步命中，切回普通图片时恢复原始透明图。
const sprites = new CharacterSprites(character, portrait, (next) => {
  mask = next || baseMask;
  updateInteractive();
});

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
  if (point) {
    eyes.follow(point);
    sprites.follow(point);
  }
  updateInteractive();
}

// 提前解码定稿、半闭眼和手部图层，尺寸一致才可在原画坐标中合成。
async function preparePrayer() {
  const images = [prayerPortrait, prayerHalf, prayerHands.firstElementChild];
  const results = await Promise.allSettled(images.map((image) => image.decode()));
  const [portraitReady, halfReady, handsReady] = images.map((image, index) =>
    results[index].status === 'fulfilled'
      && image.naturalWidth === EYE_ARTWORK.width && image.naturalHeight === EYE_ARTWORK.height);
  prayerReady = portraitReady;
  prayerMotionReady = halfReady && handsReady;
  if (!prayerReady) console.warn('无法加载祈祷表情素材');
  else if (!prayerMotionReady) console.warn('无法加载祈祷动作素材');
}

// 只在已解码的默认角色可见时播放，按压、换图或关闭动态表情都会结束预览。
function canPray() {
  return prayerReady && layout?.asset === DEFAULT_CHARACTER_ASSET && decodedPortrait?.src === layout.asset
    && layout.visible !== false && !document.hidden && activePointer === null
    && layout.appearance?.settings?.expressionsEnabled !== false;
}

// 动作素材齐全且应用动画已开启时，才启用光束与合掌过渡。
function canAnimatePrayer() {
  return prayerMotionReady && layout.appearance?.settings?.motion !== false;
}

// 集中取消待机计时和过渡帧，连选时直接接上当前动作进度。
function clearPrayerTiming() {
  clearTimeout(prayerTimer);
  cancelAnimationFrame(prayerFrame);
  prayerTimer = prayerFrame = 0;
}

// 清除图层和动作，恢复原画、视线和后续表情的控制权。
function stopPrayer() {
  if (prayerProgress === null) return;
  clearPrayerTiming();
  prayerProgress = null;
  prayerPortrait.hidden = true;
  prayerHalf.hidden = true;
  prayerHands.hidden = true;
  character.removeAttribute('data-prayer-moving');
  delete character.dataset.expression;
}

// 眼睛经过半闭帧，合掌从原画下缘抬起；到位时使用完整定稿。
function paintPrayer(progress) {
  prayerProgress = progress;
  const moving = progress < 1;
  const closed = progress >= 0.42;
  // 光随抬手出现，放手时一起淡出，合掌期间由样式驱动光束。
  character.style.setProperty('--prayer-energy-opacity', String(progress));
  character.toggleAttribute('data-prayer-moving', moving);
  prayerHalf.hidden = !moving || progress < 0.12 || closed;
  prayerHands.hidden = !moving;
  if (!moving) return;
  const lift = Math.max(0, (progress - 0.12) / 0.88);
  prayerPortrait.style.setProperty('--prayer-eyes-opacity', closed ? '1' : '0');
  prayerHands.style.setProperty('--prayer-hands-offset', `${19 * (1 - lift)}%`);
}

// 只在抬手和放手时请求动画帧，合掌停留期间只保留一次计时。
function transitionPrayer(target) {
  clearPrayerTiming();
  const from = prayerProgress;
  const started = performance.now();
  const duration = (target === 1 ? PRAYER_ENTER : PRAYER_EXIT) * Math.abs(target - from);
  // 按经过时间插值，掉帧或临时切换减少动态效果时仍能正常结束。
  function step(time) {
    if (!canPray()) {
      stopPrayer();
      configureEyes();
      return;
    }
    const animated = canAnimatePrayer() && !reducedMotion.matches;
    const amount = animated && duration > 0 ? Math.max(0, (time - started) / duration) : 1;
    if (amount < 1) {
      const eased = amount * amount * (3 - 2 * amount);
      paintPrayer(from + (target - from) * eased);
      prayerFrame = requestAnimationFrame(step);
    } else if (target === 1) {
      paintPrayer(1);
      prayerFrame = 0;
      // 表情预览按原时长结束；祈祷式编程由气泡打完或收起时解除合掌。
      if (!layout.praying) {
        const hold = animated ? PRAYER_DURATION - PRAYER_ENTER - PRAYER_EXIT : PRAYER_DURATION;
        prayerTimer = setTimeout(() => transitionPrayer(0), hold);
      }
    } else {
      stopPrayer();
      configureEyes();
    }
  }
  step(started);
}

// 接管祈祷眼区，连续触发时从当前姿势进入，结束后恢复自然眨眼。
function showPrayer() {
  if (!canPray()) return;
  if (prayerProgress === null) {
    eyes.reset();
    prayerProgress = 0;
    prayerPortrait.hidden = false;
    character.dataset.expression = 'prayer';
  }
  transitionPrayer(1);
}

// 目标依据固定锚点和按压姿态计算，身体跟随的微小位移不反过来改变目标方向。
function configureEyes() {
  if (!layout || !decodedPortrait) return;
  if (prayerProgress !== null) {
    if (canPray()) return;
    stopPrayer();
  }
  // 换回龙娘原画或重新允许动态表情时，仍在打字才补上合掌姿势。
  if (layout.praying && canPray()) {
    showPrayer();
    return;
  }
  eyes.configure(decodedPortrait, layout, {
    ...pose,
    scaleX: pose.scaleX * flip.value,
  }, reducedMotion.matches, activePointer !== null);
  sprites.configure(layout, reducedMotion.matches, activePointer !== null, {
    ...pose, scaleX: pose.scaleX * flip.value,
  });
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
    baseMask = nextMask;
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
  const wasPraying = !!layout?.praying;
  const immediate = !layout || model.visible === false || document.hidden || model.asset !== layout.asset
    || reducedMotion.matches || model.appearance?.settings?.motion === false;
  layout = model;
  // 应用设置控制光束开关，系统减少动态效果由 CSS 媒体查询即时响应。
  character.toggleAttribute('data-prayer-flow', canAnimatePrayer());
  // 正在预览时开启祷文会延长停留，打完则从当前动作进度放下双手。
  if (prayerProgress !== null && wasPraying !== !!model.praying && canPray())
    transitionPrayer(model.praying ? 1 : 0);
  flip.setFlipped(model.flipped ?? !!model.appearance?.settings?.flip, immediate);
  if (model.appearance?.settings) sound.configure(model.appearance.settings);
  stage.dataset.status = model.appearance?.status || 'idle';
  const definition = characterByAsset(model.asset);
  portrait.alt = definition ? `${definition.name}桌面角色` : '自定义桌面角色';
  stage.setAttribute('aria-label', `${definition?.name || '桌面角色'}，可以拖动，轻点说话，右键切换角色`);
  if (portrait.src !== model.asset && assetLoading !== model.asset) void loadPortrait(model.asset);
  paintPose(pose);
  character.style.left = `${model.rect.x}px`;
  character.style.top = `${model.rect.y}px`;
  character.style.width = `${model.rect.width}px`;
  character.style.height = `${model.rect.height}px`;
  routeCursor(lastCursor);
  if (!flip.settled || (animation && immediate)) wakeSpring();
}

// 将点击回弹与身体跟随合成同一份绘制姿态，命中检测也读取最终的平移、翻转和倾角。
function paintCharacter() {
  if (!layout) return;
  renderedPose = {
    ...pose, ...bodyPose,
    angle: pose.angle + bodyPose.angle,
    scaleX: pose.scaleX * flip.value,
  };
  character.dataset.flipping = String(!flip.settled);
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
  const seconds = Math.max(0, (time - previousTime) / 1000);
  flip.step(seconds);
  const next = spring.step(seconds);
  previousTime = time;
  paintPose(next);
  animation = next.settled && flip.settled ? 0 : requestAnimationFrame(animate);
}

// 连点沿用弹簧当前速度，尊重系统减少动态效果设置。
function wakeSpring() {
  if (reducedMotion.matches || layout?.visible === false || document.hidden || layout?.appearance?.settings?.motion === false) {
    cancelAnimationFrame(animation);
    animation = 0;
    flip.finish();
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
  menuPress = isCharacterMenuPoint(layout.asset,
    imagePoint({ x: event.clientX, y: event.clientY }, layout.rect, renderedPose))
    ? screenPoint(event) : null;
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
  if (menuPress && Math.hypot(event.screenX - menuPress.x, event.screenY - menuPress.y) > 5) menuPress = null;
  routeCursor({ x: event.clientX, y: event.clientY });
  if (activePointer === event.pointerId) bridge.moveGesture(screenPoint(event));
}

// 释放捕获前先清除活动标记，避免 lostpointercapture 把正常松手误判为取消。
function finishPointer(event, cancelled, notify = true) {
  if (activePointer === null || (event && event.pointerId !== activePointer)) return;
  const pointer = activePointer;
  const openCharacterMenu = !cancelled && menuPress && event && stage.dataset.gesture !== 'dragging'
    && Math.hypot(event.screenX - menuPress.x, event.screenY - menuPress.y) <= 5;
  menuPress = null;
  activePointer = null;
  if (stage.hasPointerCapture(pointer)) stage.releasePointerCapture(pointer);
  if (cancelled || stage.dataset.gesture === 'dragging') sound.cancelInteraction();
  else void sound.play('release');
  stage.dataset.gesture = 'idle';
  spring.release();
  wakeSpring();
  if (notify) {
    if (openCharacterMenu) {
      bridge.cancelGesture();
      bridge.characterMenu(screenPoint(event));
    } else if (cancelled) bridge.cancelGesture();
    else bridge.endGesture(screenPoint(event));
  }
  routeCursor(lastCursor);
}

// 命中图先于窗口 ready 信号建立，启动时也不会短暂拦截透明区域。
async function start() {
  const model = await bridge.bootstrap();
  portrait.src = model.asset;
  await Promise.all([portrait.decode(), eyes.prepareSad(), preparePrayer()]);
  mask = buildAlphaMask(portrait);
  baseMask = mask;
  decodedPortrait = portrait;
  applyLayout(model);
  stage.dataset.gesture = 'idle';
  bridge.onSound((event) => {
    stage.dataset.cue = event;
    setTimeout(() => delete stage.dataset.cue, 900);
    void sound.play(event);
  });
  // 短表情可互相接替；读祷文时保留合掌，后台任务不能打断。
  bridge.onExpression((message) => {
    if (layout.praying) return;
    const name = typeof message === 'string' ? message : message?.name;
    if (name === 'prayer') {
      showPrayer();
      return;
    }
    if (!['happy', 'sad', 'hair'].includes(name)) return;
    stopPrayer();
    configureEyes();
    if (!sprites.showExpression(name, { source: message?.source })) eyes.showExpression(name);
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
    // 右键菜单使用本次事件的屏幕坐标，不依赖透明窗口缓存的旧鼠标位置。
    if (isCharacterHit({ x: event.clientX, y: event.clientY })) bridge.menu(screenPoint(event));
  });
  window.addEventListener('blur', () => finishPointer(null, true));
  // 系统减少动态效果或窗口隐藏时同步结束翻转，重新显示不从一半继续播放。
  reducedMotion.addEventListener('change', () => applyLayout(layout));
  document.addEventListener('visibilitychange', () => applyLayout(layout));
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(animation);
    animation = 0;
    flip.finish();
    stopPrayer();
    eyes.reset();
    sprites.destroy();
  });
  bridge.ready();
}

// 命中图失败时隐藏挂件并报告错误，禁止退化成一块吞掉鼠标的白色矩形。
start().catch((error) => {
  console.error('龙娘素材初始化失败：', error);
  bridge.assetError();
});
