import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRAYER_PALM, PRAYER_WAVE_MS } from '../src/shared/prayer-wave.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-follow-'));
const user = path.join(temporary, 'user');
const home = path.join(user, '.codex');
const data = path.join(temporary, 'data');
const isMac = process.platform === 'darwin';
// 安装后复用同一组真实窗口验收，应用与原生桥都从指定成品内读取。
const executablePath = process.env.DRAGONGIRL_TEST_EXECUTABLE;
const applicationRoot = executablePath ? path.resolve(path.dirname(executablePath), isMac ? '../Resources/app' : 'resources/app') : root;
const bridge = path.join(applicationRoot, 'native/bin', isMac ? 'dragongirl-native' : 'dragongirl-native.exe');
const children = [];
let application, serial = 0, ids;

// 等待实际窗口与桥接状态，窗口动画和层级同步均不能靠固定延时假定完成。
async function until(check, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(message);
}

// 同一测试程序分别扮演 Codex 和覆盖它的其他应用，使用独立进程验证跨应用窗口层级。
async function fixture(name) {
  const directory = path.join(temporary, name);
  await fs.mkdir(directory, { recursive: true });
  let executable, command, args;
  if (isMac) {
    const contents = path.join(directory, `${name}.app/Contents`);
    executable = path.join(contents, 'MacOS/WindowFixture');
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>WindowFixture</string><key>CFBundleIdentifier</key><string>com.inhamirei.dragongirl.follow-${name.toLowerCase()}</string><key>CFBundleName</key><string>DragonGirl Follow Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
    command = '/usr/bin/xcrun';
    args = ['swiftc', '-module-cache-path', path.join(os.tmpdir(), 'dragongirl-swift-cache'), path.join(root, 'tests/fixtures/WindowFixture.swift'), '-o', executable];
  } else {
    executable = path.join(directory, `${name}.exe`);
    command = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    args = ['/nologo', '/target:winexe', '/platform:x64', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', `/out:${executable}`, path.join(root, 'tests/fixtures/WindowFixture.cs')];
  }
  const build = spawnSync(command, args, { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ...(isMac ? { DEVELOPER_DIR: '/Library/Developer/CommandLineTools' } : {}) } });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const child = spawn(executable, isMac ? [directory] : ['--controlled', directory], {
    stdio: 'ignore', env: { ...process.env, CODEX_HOME: home, ...(isMac ? { DRAGONGIRL_FIXTURE_SECONDARY: '1' } : {}) },
  });
  children.push({ child, directory });
  const ready = await until(async () => JSON.parse(await fs.readFile(path.join(directory, 'ready.json'), 'utf8').catch(() => 'null')), `${name} 测试窗口未就绪`);
  return { directory, child, id: String(ready.window) };
}

// 递增序号使同一个置前命令也能重复执行，不影响旧测试使用的单行指令。
async function send(target, command) {
  const value = `${command}\n${++serial}`;
  await fs.writeFile(path.join(target.directory, 'command'), value);
  await until(async () => (await fs.readFile(path.join(target.directory, 'command-complete'), 'utf8').catch(() => '')) === value, `测试窗口未处理 ${command}`);
}

// Windows 后台测试进程受前台权限限制；降低另一个自建窗口来改变遮挡顺序，不更改焦点或放宽系统权限。
async function raise(target, other) {
  if (!isMac && other) await send(other, 'lower');
  await send(target, 'raise');
}

// 系统顺序独立于 Electron 的 isVisible，能发现窗口仍可见但错误浮在其他应用上方的问题。
function systemState(pid) {
  const result = spawnSync(bridge, ['--once'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  return { host: snapshot.processes.find((row) => row.pid === pid), order: snapshot.windowOrder.map(String), normal: snapshot.normalWindows, raised: snapshot.topmostWindows?.map(String) || [] };
}

// 只读本次隔离应用的实际状态，不采集其他应用的标题、屏幕或账户内容。
async function companionState() {
  return application.evaluate(() => {
    const { companion, monitor } = globalThis.__dragonGirlApp;
    return {
      visible: companion.visible, character: companion.character,
      windows: Object.fromEntries([...companion.windows].map(([view, window]) => [view, {
        visible: window.isVisible(), topmost: window.isAlwaysOnTop(),
      }])),
      dragging: companion.gesture.active, sequence: monitor.nativeSequence,
      follow: { frame: companion.followTarget, normal: companion.followNormalWindows?.slice(0, 12), bubble: companion.windows.get('bubble').getBounds(), menu: !!companion.contextMenu, mode: companion.followMode },
    };
  });
}

// 角色与气泡必须紧邻宿主，覆盖应用始终在整组之前；部分遮挡时仍保持窗口可见。
async function expectStack(host, cover, covered, bubble = true, raised = !covered) {
  let last;
  try { return await until(async () => {
    const { order, normal, raised: actualRaised } = systemState(host.child.pid);
    const position = order.indexOf(host.id);
    const state = await companionState();
    const characterPosition = order.indexOf(ids.character), bubblePosition = order.indexOf(ids.bubble);
    const coverFrame = normal?.find((frame) => String(frame.id) === cover.id);
    const areas = [state.character, ...(bubble ? [state.follow.bubble] : [])];
    const coverOverlaps = !isMac || !!coverFrame && areas.some((area) => coverFrame.x < area.x + area.width
      && coverFrame.x + coverFrame.width > area.x && coverFrame.y < area.y + area.height && coverFrame.y + coverFrame.height > area.y);
    // 浮动层与普通层之间可能存在其他屏幕上的窗口，验收实际前后关系，不要求跨层全局编号相邻。
    const layered = (isMac ? state.windows.character.topmost : actualRaised.includes(ids.character))
      ? characterPosition >= 0 && characterPosition < position && (!bubble || bubblePosition >= 0 && bubblePosition < characterPosition)
      : position > 0 && order[position - 1] === ids.character && (!bubble || order[position - 2] === ids.bubble);
    last = { order: order.filter((id) => [host.id, cover.id, ...Object.values(ids)].includes(id)), frontOrder: order.slice(0, 16), normal: normal?.slice(0, 12), ids, host: host.id, cover: cover.id, state, actualRaised };
    return state.windows.character.visible && (!bubble || state.windows.bubble.visible)
      // Windows 由原生桥直接设置层级，以真实 Win32 样式为准，Electron 缓存仅用于诊断。
      && (!isMac || !covered || !coverOverlaps || !state.windows.character.topmost && !state.windows.bubble.topmost)
      && (isMac || actualRaised.includes(ids.character) === raised && (!bubble || actualRaised.includes(ids.bubble) === raised))
      && layered
      && (covered ? order.indexOf(cover.id) >= 0 && order.indexOf(cover.id) < position
        && (!coverOverlaps || order.indexOf(cover.id) < (bubble ? bubblePosition : characterPosition))
        : order.indexOf(cover.id) > position)
      && state;
  }, covered ? '龙娘或气泡仍浮在覆盖应用前面' : '宿主置前后角色或气泡未恢复到相邻层级'); }
  catch (error) { throw new Error(`${error.message}\n${JSON.stringify(last)}`); }
}

// 使用真实跟随宿主，跳到气泡播完的时刻以独立验收原生窗口和波前。
async function releasePrayerWave() {
  await application.evaluate(() => globalThis.__dragonGirlApp.companion.prayForCode());
  await until(() => application.evaluate(() => {
    const c = globalThis.__dragonGirlApp.companion;
    return c.bubbleModel.typingId != null && c.windows.get('bubble').isVisible();
  }), '祷文气泡没有显示');
  await application.evaluate(() => {
    const c = globalThis.__dragonGirlApp.companion;
    c.finishPrayerTyping(c.bubbleModel.typingId, true);
  });
  return until(() => application.windows().find((page) => page.url().endsWith('/prayer-wave.html')), '没有创建震荡波窗口');
}

try {
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ mode: 'follow', volume: 0, pinnedBubble: true }));
  const host = await fixture('Codex');
  const cover = await fixture('Cover');
  const env = { ...process.env, DRAGONGIRL_TEST: '1', DRAGONGIRL_MONITOR_TEST: '1',
    DRAGONGIRL_DATA_DIR: data, DRAGONGIRL_FIXTURE_HOME: user };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 60000 });
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp?.dashboard.latest?.instances.length === 1
    && globalThis.__dragonGirlApp.dashboard.window?.isVisible()), '隔离应用尚未完成管理窗口与目录初始化');
  ids = await application.evaluate((_, pid) => {
    const { monitor, dashboard, companion } = globalThis.__dragonGirlApp;
    dashboard.window.hide();
    // 保留真实原生桥、消息接收与跟随链路，只允许本测试宿主进入实例列表。
    const receive = monitor.receiveNative.bind(monitor);
    monitor.receiveNative = (state, bridge) => receive({ ...state, processes: state.processes.filter((row) => row.pid === pid) }, bridge);
    monitor.startNative();
    return Object.fromEntries([...companion.windows].map(([view, window]) => [view, window.getMediaSourceId().split(':')[1]]));
  }, host.child.pid);
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.companion.windows.get('character').isVisible()), '角色没有跟随真实宿主显示');
  await raise(host, cover);
  // Windows 的前台窗口需要真实标题栏点击来激活。
  await send(host, 'click');
  await until(() => systemState(host.child.pid).host?.frontmost, '标题栏点击没有激活测试宿主');
  await expectStack(host, cover, false, false);
  const frontBeforeWave = systemState(host.child.pid).host.frontmost;
  // 测试只记录本次特效窗口的原生鼠标穿透设置。
  await application.evaluate(({ BrowserWindow }) => {
    const original = BrowserWindow.prototype.setIgnoreMouseEvents;
    BrowserWindow.prototype.setIgnoreMouseEvents = function (ignore, ...args) {
      if (this.getTitle() === '祈祷震荡波') globalThis.__prayerWavePassesMouse = ignore;
      return original.call(this, ignore, ...args);
    };
  });
  const wavePage = await releasePrayerWave();
  const wave = await until(() => application.evaluate(() => {
    const c = globalThis.__dragonGirlApp.companion;
    const window = c.prayerWave?.window;
    return window?.isVisible() && c.prayerWave.started && {
      bounds: window.getBounds(), focusable: window.isFocusable(), mouse: globalThis.__prayerWavePassesMouse,
      bubble: c.bubbleVisible || c.windows.get('bubble').isVisible(), frame: c.followTarget,
      character: c.character, id: window.getMediaSourceId().split(':')[1],
    };
  }), '震荡波没有显示');
  const waveObservedAt = performance.now();
  for (const key of ['x', 'y', 'width', 'height'])
    assert.ok(Math.abs(wave.bounds[key] - wave.frame[key]) <= 1, '震荡波窗口没有贴合 Codex 边缘');
  assert.equal(wave.focusable, false, '震荡波窗口会抢焦点');
  assert.equal(wave.mouse, true, '震荡波窗口没有打开原生鼠标穿透');
  assert.equal(wave.bubble, false, '震荡波放出时气泡没有立即收起');
  // 气泡收起后，后台任务完成也不能重新打开气泡或打断这轮扩散。
  assert.ok(await application.evaluate(() => {
    const c = globalThis.__dragonGirlApp.companion;
    const wave = c.prayerWave;
    c.notify('complete', '后台任务已完成');
    return wave?.started && c.prayerWave === wave && !c.bubbleVisible && !c.windows.get('bubble').isVisible();
  }), '后台任务通知打断了震荡波');
  const waveStack = systemState(host.child.pid);
  assert.ok(waveStack.order.includes(wave.id) && waveStack.order.indexOf(wave.id) < waveStack.order.indexOf(host.id),
    '震荡波窗口没有叠在宿主上');
  assert.equal(waveStack.host.frontmost, frontBeforeWave, '震荡波改变了前台应用');
  // 沿着穿过波心的一行采样，连续色带应有足够多的半透明层次。
  const palm = {
    x: wave.character.x + wave.character.width * PRAYER_PALM.x - wave.bounds.x,
    y: wave.character.y + wave.character.height * PRAYER_PALM.y - wave.bounds.y,
  };
  await wavePage.waitForFunction(({ x, y }) => {
    const canvas = document.querySelector('canvas');
    const scaleX = canvas.width / innerWidth, scaleY = canvas.height / innerHeight;
    const row = Math.max(0, Math.min(canvas.height - 1, Math.floor(y * scaleY)));
    const pixels = canvas.getContext('2d').getImageData(0, row, canvas.width, 1).data;
    const levels = new Set();
    for (let col = 0; col < canvas.width; col++) {
      const alpha = pixels[col * 4 + 3];
      if (Math.abs(col / scaleX - x) > 150 && alpha >= 12) levels.add(alpha);
    }
    return levels.size >= 30;
  }, palm, { polling: 120, timeout: 4000 });

  // 测量远角到达时间和结束时间，防止渐变重新变成一闪而过。
  const corner = {
    x: palm.x > wave.bounds.width / 2 ? 10 : wave.bounds.width - 11,
    y: palm.y > wave.bounds.height / 2 ? 10 : wave.bounds.height - 11,
  };
  await wavePage.waitForFunction(({ x, y }) => {
    const canvas = document.querySelector('canvas');
    return canvas.getContext('2d').getImageData(Math.floor(x * canvas.width / innerWidth),
      Math.floor(y * canvas.height / innerHeight), 1, 1).data[3] >= 12;
  }, corner, { timeout: PRAYER_WAVE_MS + 500 });
  assert.ok(performance.now() - waveObservedAt >= 3000, '震荡波过快扫到了远角');
  await until(() => application.evaluate(() => {
    const c = globalThis.__dragonGirlApp.companion;
    return !c.prayerWave && !c.bubbleVisible;
  }), '震荡波播完后没有清理窗口与气泡');
  assert.ok(performance.now() - waveObservedAt >= 7000, '震荡波没有完整渐隐就提前结束了');

  console.log(JSON.stringify({ bubbleClosedAtStart: !wave.bubble, waveDurationMs: Math.round(performance.now() - waveObservedAt) }));
  // 遮挡应用在波纹上方；最小化时取消进行中的波纹，不留下透明窗口。
  await raise(cover, host);
  await expectStack(host, cover, true, false);
  await releasePrayerWave();
  const coveredWaveId = await until(() => application.evaluate(() => {
    const wave = globalThis.__dragonGirlApp.companion.prayerWave;
    return wave?.started && wave.window.getMediaSourceId().split(':')[1];
  }), '被覆盖时没有创建宿主绑定的震荡波');
  await until(() => {
    const { order } = systemState(host.child.pid);
    return order.includes(coveredWaveId) && order.indexOf(cover.id) < order.indexOf(coveredWaveId)
      && order.indexOf(coveredWaveId) < order.indexOf(host.id);
  }, '震荡波浮到了遮挡应用上方');
  await send(host, 'minimize');
  await until(() => application.evaluate(() => {
    const c = globalThis.__dragonGirlApp.companion;
    return !c.prayerWave && !c.bubbleVisible && !c.windows.get('character').isVisible();
  }), '宿主最小化后仍留下震荡波');
  console.log('发布包祈祷震荡波验收通过');
} finally {
  try { await application?.close(); }
  finally {
    for (const { child, directory } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        // 先正常关闭测试窗口，让正在拖动的线程释放鼠标；进程失去响应时才强制清理。
        const exited = new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
        await fs.writeFile(path.join(directory, 'command'), `quit\n${++serial}`).catch(() => {});
        let timer;
        await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 2500); })]);
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
      }
    }
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
