import { SoundEngine } from './audio.js';
import { PressSpring } from '../shared/spring.js';
import { imagePoint, opaqueAt } from '../shared/hit-test.js';
import { EyeTracker } from './eyes.js';
import { DragonMotion } from './dragon-motion.js';
import { DragonFaces } from './dragon-expressions.js';
import { FlipMotion } from '../shared/facing.js';
import { CharacterSprites } from './character-sprites.js';
import { PortraitFace } from './portrait-face.js';
import { PORTRAIT_ARTWORK } from './portrait-artwork.js';
import { REST_POSE } from './portrait-motion.js';
import { characterByAsset, isCharacterMenuPoint, isDragonAsset } from '../shared/characters.js';
import { EYE_ARTWORK } from '../shared/gaze.js';
import { isDragonFace } from '../shared/expression.js';
import { dragonEyeTone } from '../shared/dragon-gear.js';
import { loadDragonPortrait, tintedDragonPortrait } from './dragon-portrait.js';

// 将短过渡计入原来的祈祷时长，中间停留在定稿姿势。
const PRAYER_DURATION = 2400;
const PRAYER_ENTER = 360;
const PRAYER_EXIT = 320;
// 半闭眼与闭眼共用眼区，合掌期间保留当前发型。
const PRAYER_EYE_AREA = [319, 602, 718, 273];
const bridge = window.dragonGirl;
const stage = document.getElementById('stage');
const character = document.getElementById('character');
const portraitSlot = document.getElementById('portrait-slot');
const prayerPortrait = document.getElementById('prayer-portrait');
const prayerHalf = document.getElementById('prayer-half');
const prayerHands = document.getElementById('prayer-hands');
const dragonMotion = new DragonMotion(document.getElementById('dragon-motion'), paintCharacter);
const dragonFaces = new DragonFaces(document.getElementById('dragon-expression'));
const eyes = new EyeTracker(character, paintBodyPose, { onFace: paintDragonFace });
const spring = new PressSpring();
const flip = new FlipMotion();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const sound = new SoundEngine();
window.__soundEngine = sound;
let layout;
let assetLoading;
// 用序号识别仍在解码的预览，后续表情或手势可以作废它。
let expressionRequest = 0;
let decodedPortrait;
let portraitArtwork;
let paintedAsset;
let paintedKey;
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
let prayerEyes;
let dragonActionsReady;
let prayerTone;
let prayerProgress = null;
let prayerFrame = 0;
let prayerTimer = 0;
// 每次换表情或动作帧都同步命中，切回普通图片时恢复原始透明图。
const sprites = new CharacterSprites(character, portraitSlot, (next) => {
  mask = next || baseMask;
  updateInteractive();
});
// 局部表情沿用底图的透明命中区域，同时只保留当前角色的控制器。
let portraitFace;

// 从原图读取一次透明度，不按白色抠图，因此白发、衣服和眼睛高光都能正常响应。
function buildAlphaMask(image) {
  // 在独立画布取样，避免读取显示画布切换其渲染路径，影响半透明描边。
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth ?? image.width;
  canvas.height = image.naturalHeight ?? image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const alpha = new Uint8Array(canvas.width * canvas.height);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = rgba[index * 4 + 3];
  if (!alpha.some((value) => value > 24) || !alpha.some((value) => value === 0))
    throw new Error('素材必须同时包含可见像素和真实透明区域。');
  return { width: canvas.width, height: canvas.height, alpha };
}

// 先还原角色整体姿态，再读取局部动画或原画的透明度，发梢和耳尖的点击范围跟随轮廓。
function isCharacterHit(point) {
  if (!layout || !point) return false;
  const imageLocation = imagePoint(point, layout.rect, renderedPose);
  return dragonMotion.hit(imageLocation) ?? opaqueAt(mask, imageLocation);
}

// 只更新命中而不重新计算视线目标，身体每帧移动不会形成鼠标追逐的反馈循环。
function updateInteractive() {
  const enabled = layout?.visible !== false && (activePointer !== null || isCharacterHit(lastCursor));
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
    portraitFace?.follow(point);
  }
  updateInteractive();
}

// 提前解码闭眼、半闭眼和手部图层，尺寸一致才可在原画坐标中合成。
async function preparePrayer() {
  const sources = ['codex-dragon-girl-prayer.png', 'codex-dragon-girl-prayer-half.png'];
  prayerEyes = sources.map((file) => {
    const image = new Image();
    image.src = new URL('../../assets/characters/' + file, import.meta.url).href;
    return image;
  });
  const hands = prayerHands.firstElementChild;
  hands.src = new URL('../../assets/characters/codex-dragon-girl-prayer-hands.png', import.meta.url).href;
  const images = [...prayerEyes, hands];
  const results = await Promise.allSettled(images.map((image) => image.decode()));
  const [portraitReady, halfReady, handsReady] = images.map((image, index) =>
    results[index].status === 'fulfilled'
      && image.naturalWidth === EYE_ARTWORK.width && image.naturalHeight === EYE_ARTWORK.height);
  prayerReady = portraitReady && handsReady;
  prayerMotionReady = halfReady && handsReady;
  if (prayerMotionReady) {
    prayerHalf.width = EYE_ARTWORK.width;
    prayerHalf.height = EYE_ARTWORK.height;
  }
  if (!prayerReady) console.warn('无法加载祈祷表情素材');
  else if (!prayerMotionReady) console.warn('无法加载祈祷动作素材');
}

// 只在已解码的内置龙娘可见时播放，按压、换图或关闭动态表情都会结束预览。
function canPray() {
  return prayerReady && isDragonAsset(layout?.asset) && paintedAsset === layout.asset
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
  delete character.dataset.expression;
}

// 眼睛经过半闭帧，手部按同一姿势抬起和放下。
function paintPrayer(progress) {
  prayerProgress = progress;
  const closed = progress >= 0.42;
  // 光随抬手出现，放手时一起淡出，合掌期间由样式驱动光束。
  character.style.setProperty('--prayer-energy-opacity', String(progress));
  prayerHalf.toggleAttribute('hidden', !prayerMotionReady || progress < 0.12 || closed);
  prayerPortrait.toggleAttribute('hidden', !closed);
  const lift = Math.max(0, (progress - 0.12) / 0.88);
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
    // 合掌时冻结待机局部动作，由独立的手部和眼睑接管。
    prayerProgress = 0;
    dragonMotion.reset();
    eyes.reset();
    prayerHands.hidden = false;
    character.dataset.expression = 'prayer';
  }
  transitionPrayer(1);
}

// 内置龙娘待机时播放局部动作，拖动、祈祷和减少动态效果时收起。
function configureDragonMotion(nativeResolution = !dragonFaces.canvas.hidden) {
  const dragging = activePointer !== null && stage.dataset.gesture === 'dragging';
  const blocked = paintedAsset !== layout.asset || reducedMotion.matches || prayerProgress !== null || dragging;
  dragonMotion.configure(portraitArtwork, layout, blocked, activePointer !== null, nativeResolution);
}

// 眼神和收耳在同一帧合成，结束或切换表情时交回待机姿态。
function paintDragonFace(name, amount, elapsed, frame) {
  if (!name || amount <= 0) {
    if (dragonFaces.canvas.hidden) return;
    dragonMotion.setHeartTuck(0);
    dragonFaces.reset();
    configureDragonMotion();
    return;
  }
  if (dragonFaces.canvas.hidden) configureDragonMotion(true);
  dragonMotion.setHeartTuck(frame.tuck ?? 0);
  dragonFaces.paint(portraitArtwork, dragonMotion, name, amount, elapsed, layout.rect, !reducedMotion.matches);
}

// 康娜用等效的中心升降响应点头和按压，原画比例与笔宽固定。镜像仍共用原来的翻转进度。
function gesturePose(swayScale = 1) {
  const scaleY = pose.scaleY * swayScale;
  if (portraitFace?.artwork.preserveScale) {
    return { ...pose, scaleX: flip.value, scaleY: 1, translateY: layout.rect.height * (1 - scaleY) / 2 };
  }
  return { ...pose, scaleX: pose.scaleX * flip.value, scaleY, translateY: 0 };
}

// 目标依据固定锚点和按压姿态计算，身体跟随的微小位移不反过来改变目标方向。
function configureEyes() {
  if (!layout || !decodedPortrait) return;
  // 先清理旧角色的图层和计时器，正在解码的旧表情也不能接管新的立绘。
  const artwork = PORTRAIT_ARTWORK.get(layout.asset);
  if (portraitFace?.artwork !== artwork) {
    portraitFace?.destroy();
    portraitFace = artwork ? new PortraitFace(character, paintCharacter, artwork) : null;
    if (lastCursor) portraitFace?.follow(lastCursor);
  }
  if (prayerProgress !== null) {
    if (canPray()) return;
    stopPrayer();
  }
  // 换回龙娘原画或重新允许动态表情时，仍在打字才补上合掌姿势。
  if (layout.praying && canPray()) {
    showPrayer();
    return;
  }
  configureDragonMotion();
  const pressed = activePointer !== null;
  const gazePose = gesturePose();
  // 解码完成以前保留上一张立绘，等新画面提交后再让眼区动作接管。
  if (paintedAsset === layout.asset) eyes.configure(portraitArtwork, layout, gazePose, reducedMotion.matches, pressed);
  else eyes.reset();
  sprites.configure(layout, reducedMotion.matches, pressed, gazePose);
  portraitFace?.configure(decodedPortrait, layout, gazePose, reducedMotion.matches, pressed);
}

// 发型随立绘地址一起参与缓存，瞳色单独参与绘制。
function portraitKey(model) {
  const tone = isDragonAsset(model.asset) ? dragonEyeTone(model.appearance?.settings) : null;
  return `${model.asset}|${tone ?? ''}`;
}

// 内置龙娘复用合成画布。普通图片解码后直接显示，两种来源都只加载一次。
async function preparePortrait(asset) {
  if (isDragonAsset(asset)) {
    // 首次选中龙娘时并行准备原画和专属动作，换发型复用已解码的泪眼及合掌图层。
    dragonActionsReady ??= Promise.all([eyes.prepareSad(), preparePrayer()]);
    const [image] = await Promise.all([loadDragonPortrait(asset), dragonActionsReady]);
    return image;
  }
  const image = new Image();
  image.src = asset;
  await image.decode();
  return image;
}

// 同时提交画面与透明命中，只调瞳色时复用透明度。
function displayPortrait(raw, model, key) {
  const { asset } = model;
  const dragon = isDragonAsset(asset);
  const tone = dragon ? dragonEyeTone(model.appearance?.settings) : null;
  const geometryChanged = !baseMask || raw !== decodedPortrait;
  const nextMask = geometryChanged ? buildAlphaMask(raw) : baseMask;
  const image = tintedDragonPortrait(raw, tone);
  image.id = 'portrait';
  image.dataset.asset = asset;
  if (dragon) {
    image.dataset.tone = tone ?? 'original';
    image.setAttribute('aria-hidden', 'true');
  } else {
    const definition = characterByAsset(asset);
    image.alt = definition ? `${definition.name}桌面角色` : '自定义桌面角色';
    image.draggable = false;
  }
  portraitSlot.replaceChildren(image);
  decodedPortrait = raw;
  portraitArtwork = image;
  paintedAsset = asset;
  if (dragon && prayerReady) preparePrayerFrames(tone);
  paintedKey = key;
  if (geometryChanged) mask = baseMask = nextMask;
  if (prayerProgress !== null) paintPrayer(prayerProgress);
}

// 两帧都只覆盖眼区，半闭帧随当前瞳色重绘。
function preparePrayerFrames(tone) {
  if (prayerPortrait.width !== EYE_ARTWORK.width) {
    prayerPortrait.width = EYE_ARTWORK.width;
    prayerPortrait.height = EYE_ARTWORK.height;
    prayerPortrait.getContext('2d').drawImage(prayerEyes[0], ...PRAYER_EYE_AREA, ...PRAYER_EYE_AREA);
  }
  if (prayerMotionReady && prayerTone !== tone) {
    const artwork = tintedDragonPortrait(prayerEyes[1], tone);
    const context = prayerHalf.getContext('2d');
    context.clearRect(...PRAYER_EYE_AREA);
    context.drawImage(artwork, ...PRAYER_EYE_AREA, ...PRAYER_EYE_AREA);
    prayerTone = tone;
  }
}

// 只提交最后一次解码请求，在调色和读取命中图以前丢弃过期结果。
async function loadPortrait(model, key) {
  const request = assetLoading = { key };
  try {
    const raw = await preparePortrait(model.asset);
    if (assetLoading !== request) return;
    displayPortrait(raw, model, key);
    configureEyes();
    paintCharacter();
    routeCursor(lastCursor);
  } catch {
    if (assetLoading === request) bridge.assetError();
  } finally {
    if (assetLoading === request) assetLoading = null;
  }
}

// 布局变化不重建元素或手势监听，拖动中的指针捕获不会因此失效。
function applyLayout(model) {
  const wasPraying = !!layout?.praying;
  const immediate = !layout || model.visible === false || document.hidden || model.asset !== layout.asset
    || reducedMotion.matches || model.appearance?.settings?.motion === false;
  // 隐藏、换角色和祈祷都会作废还在解码的预览，恢复后不重播旧请求。
  if (model.asset !== layout?.asset || model.visible === false || document.hidden || model.praying
    || model.appearance?.settings?.expressionsEnabled === false) expressionRequest += 1;
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
  stage.setAttribute('aria-label', `${definition?.name || '桌面角色'}，可以拖动，轻点说话，右键切换角色`);
  const artworkKey = portraitKey(model);
  if (paintedKey === artworkKey) assetLoading = null;
  else if (assetLoading?.key !== artworkKey) void loadPortrait(model, artworkKey);
  paintPose(pose);
  character.style.left = `${model.rect.x}px`;
  character.style.top = `${model.rect.y}px`;
  character.style.width = `${model.rect.width}px`;
  character.style.height = `${model.rect.height}px`;
  routeCursor(lastCursor);
  if (!flip.settled || (animation && immediate)) wakeSpring();
}

// 呼吸让整张原画轻轻起伏，头脸和脖子的比例保持不变；命中与绘制共用这个姿态。
function paintCharacter() {
  if (!layout) return;
  dragonFaces.updateMotion(portraitArtwork, dragonMotion, layout.rect);
  // 身体轻摆、脸部图层与透明点击区域共用同一变换。
  const sway = portraitFace?.pose ?? REST_POSE;
  renderedPose = gesturePose(sway.scaleY);
  renderedPose.translateX = bodyPose.translateX + sway.translateX;
  renderedPose.translateY = renderedPose.translateY + bodyPose.translateY + sway.translateY - layout.rect.height * dragonMotion.breath;
  renderedPose.angle = pose.angle + bodyPose.angle + sway.angle;
  const flipping = String(!flip.settled);
  if (character.dataset.flipping !== flipping) character.dataset.flipping = flipping;
  character.style.transform = `translate(${renderedPose.translateX}px, ${renderedPose.translateY}px) rotate(${renderedPose.angle}deg) scale(${renderedPose.scaleX}, ${renderedPose.scaleY})`;
  updateInteractive();
}

// 把身体方向传给耳朵和头发作延迟跟随，镜像只改变头发的原画方向。
function paintBodyPose(next, direction = 0, held = false) {
  dragonMotion.setBreathPaused(held);
  dragonMotion.follow(direction, flip.value < 0);
  // 表情暂停身体且姿态未变时，不重复写入变换或检查鼠标命中。
  if (next.translateX === bodyPose.translateX && next.translateY === bodyPose.translateY && next.angle === bodyPose.angle) return;
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
  expressionRequest += 1;
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

// 局部表情只对可见的内置龙娘开放，解码前后都检查当前角色和手势。
function canPreviewDragonFace() {
  return isDragonAsset(layout?.asset) && paintedAsset === layout.asset
    && layout.visible !== false && !document.hidden && !layout.praying && activePointer === null
    && layout.appearance?.settings?.expressionsEnabled !== false;
}

// 短表情可互相接替；读祷文时保留合掌，后台任务不能打断。
async function showExpression(message) {
  const request = ++expressionRequest;
  if (layout.praying) return;
  const name = typeof message === 'string' ? message : message?.name;
  // 半身立绘由同一个控制器播放和排队，表情素材取自当前角色。
  if (portraitFace) {
    portraitFace.play(name);
    return;
  }
  if (name === 'prayer') {
    showPrayer();
    return;
  }
  if (isDragonFace(name)) {
    if (!canPreviewDragonFace()) return;
    if (!dragonFaces.canPlay(name) && (!(await dragonFaces.prepare(name))
      || request !== expressionRequest || !canPreviewDragonFace())) return;
  } else if (name !== 'happy' && name !== 'sad' && name !== 'hair') return;
  stopPrayer();
  configureEyes();
  // 两套角色渲染都接收来源，手动切换只播放局部表情。
  const options = { source: message?.source };
  if (!sprites.showExpression(name, options)) eyes.showExpression(name, options);
}

// 命中图先于窗口 ready 信号建立，启动时也不会短暂拦截透明区域。
async function start() {
  const model = await bridge.bootstrap();
  const picture = await preparePortrait(model.asset);
  displayPortrait(picture, model, portraitKey(model));
  applyLayout(model);
  stage.dataset.gesture = 'idle';
  bridge.onSound((event) => {
    stage.dataset.cue = event;
    setTimeout(() => delete stage.dataset.cue, 900);
    void sound.play(event);
  });
  bridge.onExpression(showExpression);
  // 手动修复后立即重新读取原声，不依赖其他布局或设置变化才能恢复播放。
  bridge.onAudioReady(() => {
    void sound.recheckLibrary();
  });
  bridge.onLayout(applyLayout);
  bridge.onCursor(routeCursor);
  // 主进程确认是轻戳后才让耳尖和发梢回弹，拖拽不会误触。
  bridge.onPoke(() => {
    configureDragonMotion();
    dragonMotion.poke();
  });
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
    expressionRequest += 1;
    cancelAnimationFrame(animation);
    animation = 0;
    flip.finish();
    stopPrayer();
    dragonFaces.reset();
    dragonMotion.reset();
    eyes.reset();
    sprites.destroy();
    portraitFace?.destroy();
  });
  bridge.ready();
}

// 命中图失败时隐藏挂件并报告错误，禁止退化成一块吞掉鼠标的白色矩形。
start().catch((error) => {
  console.error('龙娘素材初始化失败：', error);
  bridge.assetError();
});
