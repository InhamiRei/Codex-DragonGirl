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

// 先写完临时文件再发布命令；Windows 文件短暂占用时等待下一次尝试。
async function writeCommand(directory, value) {
  const file = path.join(directory, 'command');
  const temporary = file + '.tmp';
  await fs.writeFile(temporary, value);
  await until(async () => {
    try {
      await fs.rename(temporary, file);
      return true;
    } catch (error) {
      if (['EBUSY', 'EPERM'].includes(error.code)) return false;
      throw error;
    }
  }, '测试窗口指令文件持续被占用');
}

// 递增序号使同一个置前命令也能重复执行，不影响旧测试使用的单行指令。
async function send(target, command) {
  const value = `${command}\n${++serial}`;
  await writeCommand(target.directory, value);
  await until(async () => (await fs.readFile(path.join(target.directory, 'command-complete'), 'utf8').catch(() => '')) === value, `测试窗口未处理 ${command}`);
}

// Windows 后台测试进程受前台权限限制；降低另一个自建窗口来改变遮挡顺序，不更改焦点或放宽系统权限。
async function raise(target, other) {
  if (!isMac && other) await send(other, 'lower');
  await send(target, 'raise');
}

// 系统顺序独立于 Electron 的 isVisible，能发现窗口仍可见但错误浮在其他应用上方的问题。
function systemState(pid) {
  const result = spawnSync(bridge, ['--once'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  return { host: snapshot.processes.find((row) => row.pid === pid), order: snapshot.windowOrder.map(String), normal: snapshot.normalWindows, raised: snapshot.topmostWindows?.map(String) || [] };
}

// 只读本次隔离应用的实际状态，不采集其他应用的标题、屏幕或账户内容。
async function companionState() {
  return application.evaluate(({ screen }) => {
    const { companion, monitor } = globalThis.__dragonGirlApp;
    return {
      visible: companion.visible, character: companion.character,
      windows: Object.fromEntries([...companion.windows].map(([view, window]) => [view, {
        visible: window.isVisible(), topmost: window.isAlwaysOnTop(),
        bounds: process.platform === 'win32' ? screen.dipToScreenRect(window, window.getBounds()) : window.getBounds(),
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
    const { order: systemOrder, normal, raised: actualRaised } = systemState(host.child.pid);
    // macOS 只比较本次创建的真实窗口，用户窗口插在中间不会破坏测试的相邻关系。
    const fixtureIds = new Set([host.id, cover.id, ...Object.values(ids)]);
    const order = isMac ? systemOrder.filter((id) => fixtureIds.has(id)) : systemOrder;
    const position = order.indexOf(host.id);
    const state = await companionState();
    const characterPosition = order.indexOf(ids.character), bubblePosition = order.indexOf(ids.bubble);
    const coverFrame = normal?.find((frame) => String(frame.id) === cover.id);
    const areas = [isMac ? state.character : state.windows.character.bounds, ...(bubble ? [state.windows.bubble.bounds] : [])];
    const coverOverlaps = actualRaised.includes(cover.id) || !!coverFrame && areas.some((area) => coverFrame.x < area.x + area.width
      && coverFrame.x + coverFrame.width > area.x && coverFrame.y < area.y + area.height && coverFrame.y + coverFrame.height > area.y);
    // 浮动层与普通层之间可能存在其他屏幕上的窗口，验收实际前后关系，不要求跨层全局编号相邻。
    const layered = isMac && !state.windows.character.topmost
      ? position > 0 && order[position - 1] === ids.character && (!bubble || order[position - 2] === ids.bubble)
      : characterPosition >= 0 && characterPosition < position && (!bubble || bubblePosition >= 0 && bubblePosition < characterPosition);
    last = { order: order.filter((id) => fixtureIds.has(id)), frontOrder: systemOrder.slice(0, 16), normal: normal?.slice(0, 12), ids, host: host.id, cover: cover.id, state, actualRaised };
    return state.windows.character.visible && (!bubble || state.windows.bubble.visible)
      // Windows 由原生桥直接设置层级，以真实 Win32 样式为准，Electron 缓存仅用于诊断。
      && (!isMac || !covered || !coverOverlaps || !state.windows.character.topmost && !state.windows.bubble.topmost)
      && (isMac || raised === null || actualRaised.includes(ids.character) === raised && (!bubble || actualRaised.includes(ids.bubble) === raised))
      && layered
      && (covered ? order.indexOf(cover.id) >= 0 && order.indexOf(cover.id) < position
        && (!coverOverlaps || order.indexOf(cover.id) < (bubble ? bubblePosition : characterPosition))
        : order.indexOf(cover.id) > position)
      && state;
  }, covered ? '龙娘或气泡仍浮在覆盖应用前面' : '宿主置前后角色或气泡未恢复到相邻层级'); }
  catch (error) { throw new Error(`${error.message}\n${JSON.stringify(last)}`); }
}

// 两个夹具始终各露出一部分，复现用户直接点击切换。取两个合成后的屏幕像素验证半遮挡。
async function checkWindowsSwitching(host, cover) {
  const area = await application.evaluate(({ screen }) => screen.dipToScreenRect(null, screen.getPrimaryDisplay().workArea));
  const hostX = area.x + Math.round(area.width * .18), hostY = area.y + Math.round(area.height * .08);
  const hostWidth = Math.round(area.width * .76), hostHeight = Math.round(area.height * .76);
  const coverX = area.x + 10, coverY = hostY + 55;
  // 调整的是测试窗体，传给夹具的边界和采样点都使用 Windows 物理像素。
  const sizeCover = (right) => send(cover, `video-bounds ${coverX} ${coverY} ${right - coverX} ${hostHeight}`);
  await send(host, 'restore');
  await send(host, `video-bounds ${hostX} ${hostY} ${hostWidth} ${hostHeight}`);
  await sizeCover(hostX + Math.round(hostWidth / 2));
  // 先把两个测试窗口放回桌面图标上面。此前的层级用例会把其中一个窗口送到整个桌面的底层。
  await send(cover, 'raise');
  await send(host, 'raise');
  // 由交互桌面内的夹具直接核对实际前台 HWND，轮询期间不启动另一个可能干扰焦点的控制台进程。
  async function clickWindow(target) {
    await send(target, 'click-exposed');
    const point = await fs.readFile(path.join(target.directory, 'click-point'), 'utf8');
    assert.notEqual(point, 'none', `窗口 ${target.id} 没有可安全点击的客户区`);
    let foreground;
    await until(async () => {
      await send(target, 'foreground');
      foreground = await fs.readFile(path.join(target.directory, 'foreground'), 'utf8');
      return foreground === target.id;
    }, '点击后前台窗口未切换').catch(error => {
      throw new Error(`${error.message}：目标 ${target.id}，点击 ${point}，实际前台 ${foreground}`);
    });
  }
  await clickWindow(host);
  await expectStack(host, cover, false, false);
  await until(() => application.evaluate(({ screen }, expected) => {
    const frame = globalThis.__dragonGirlApp.companion.followTarget;
    if (!frame) return false;
    const actual = screen.dipToScreenRect(null, frame);
    return Object.keys(expected).every(key => Math.abs(actual[key] - expected[key]) <= 2);
  }, { x: hostX, y: hostY, width: hostWidth, height: hostHeight }), '角色尚未移动到录屏场景中的宿主位置');
  const points = await application.evaluate(({ screen }) => {
    const c = globalThis.__dragonGirlApp.companion.character;
    return [.42, .67].map(fraction => screen.dipToScreenPoint({
      x: Math.round(c.x + c.width * fraction), y: Math.round(c.y + c.height * .68),
    }));
  });
  const characterPage = application.windows().find(page => page.url().endsWith('/character.html'));
  // 两个色标绘制在真实角色窗口内；它们经历与角色立绘相同的系统合成、遮挡和显隐。
  await characterPage.evaluate(async () => {
    const { rect } = await window.dragonGirl.bootstrap();
    for (const fraction of [.42, .67]) {
      const point = document.createElement('i');
      point.style.cssText = `position:absolute;z-index:999;pointer-events:none;background:#e629d8;width:12px;height:12px;left:${rect.x + rect.width * fraction - 6}px;top:${rect.y + rect.height * .68 - 6}px`;
      document.body.append(point);
    }
  });
  // 等待取样而非只检查 isVisible；同时检测错误置顶、被宿主压住和只露出半边时整只隐藏。
  async function expectPixels(left, right) {
    let last;
    await until(async () => {
      await send(host, 'sample ' + points.flatMap(p => [p.x, p.y]).join(' '));
      last = await fs.readFile(path.join(host.directory, 'pixels'), 'utf8');
      return last === `${left} ${right}`;
    }, '角色与遮挡窗口的实际屏幕像素不符').catch(error => { throw new Error(`${error.message}，期望 ${left} ${right}，实测 ${last}`); });
  }
  const petColor = 'E629D8', coverColor = '1B8E44';
  for (const bubbleOpen of [false, true]) {
    if (bubbleOpen) await application.evaluate(() => globalThis.__dragonGirlApp.companion.showBubble('切窗验收', 'speech'));
    await expectPixels(petColor, petColor);
    await clickWindow(cover);
    await expectStack(host, cover, true, bubbleOpen);
    await expectPixels(petColor, petColor);
    await sizeCover(Math.round((points[0].x + points[1].x) / 2));
    await expectPixels(coverColor, petColor);
    await sizeCover(hostX + hostWidth + 8);
    await expectPixels(coverColor, coverColor);
    await clickWindow(host);
    await expectStack(host, cover, false, bubbleOpen);
    await expectPixels(petColor, petColor);
    await sizeCover(hostX + Math.round(hostWidth / 2));
  }
  // 从透明角落点到底下的宿主，再在脸部点开气泡。两次都实际发送系统鼠标事件。
  await application.evaluate(() => globalThis.__dragonGirlApp.companion.hideBubble());
  const probes = await application.evaluate(({ screen }) => {
    const rect = globalThis.__dragonGirlApp.companion.character;
    return [{ x: rect.x + 3, y: rect.y + 3 },
      { x: Math.round(rect.x + rect.width * .5), y: Math.round(rect.y + rect.height * .72) }].map(point => screen.dipToScreenPoint(point));
  });
  // 从宿主消息循环读取实际抵达客户区的点击数。
  const count = async () => {
    await send(host, 'input-count');
    return Number(await fs.readFile(path.join(host.directory, 'input-count'), 'utf8'));
  };
  const before = await count();
  try {
    for (const [index, point] of probes.entries()) {
      await send(host, `hover-input ${point.x} ${point.y}`);
      await until(() => application.evaluate((_, valid) => globalThis.__dragonGirlApp.companion.interactive.get('character') === valid, index === 1),
        '真实鼠标移入后没有切换角色命中');
      await send(host, `click-input ${ids.character}`);
      if (index === 0) await until(async () => (await count()) === before + 1, '透明角落拦截了宿主的实际点击');
      else await until(async () => (await companionState()).windows.bubble.visible, '真实点击脸部未打开气泡');
    }
    assert.equal(await count(), before + 1, '角色的不透明部分也把点击交给了宿主');
  } finally { await send(host, 'end-input'); }
}

// 管理页与桌宠属于同一个应用；它遮住角色时也必须排在整组前面，并保持可输入。
async function checkDashboardCover(host) {
  const dashboardId = await application.evaluate(async () => {
    const { dashboard, companion } = globalThis.__dragonGirlApp;
    companion.showBubble('管理页遮挡验收', 'speech');
    const { width, height } = dashboard.window.getBounds(), area = companion.display.workArea, rect = companion.character;
    const x = Math.max(area.x, Math.min(rect.x + (rect.width - width) / 2, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(rect.y + (rect.height - height) / 2, area.y + area.height - height));
    dashboard.window.setPosition(Math.round(x), Math.round(y));
    await dashboard.open();
    return dashboard.window.getMediaSourceId().split(':')[1];
  });
  await until(async () => {
    const { order } = systemState(host.child.pid);
    const sequence = [dashboardId, ids.bubble, ids.character, host.id].map(id => order.indexOf(id));
    return sequence.every((value, i) => value >= 0 && (!i || value > sequence[i - 1]))
      && await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.window.isFocused());
  }, '管理页未保持在桌宠前方或失去键盘焦点');
  await application.evaluate(() => globalThis.__dragonGirlApp.dashboard.window.hide());
}

// 非模态面板继续正常遮挡角色；模态框禁用宿主时收起，且聚焦最大化窗口应保留其大小。
async function checkWindowsPanels(host) {
  for (const command of ['owned-panel', 'modal-panel']) {
    await send(host, command);
    const panel = await fs.readFile(path.join(host.directory, 'panel-id'), 'utf8');
    await until(() => {
      const state = systemState(host.child.pid);
      return state.order.includes(panel) && String(state.host?.windows[0]?.id) === host.id
        && state.host.modalOpen === (command === 'modal-panel');
    }, command + ' 面板被错误选为宿主或未识别被禁用的主窗口');
    await until(async () => {
      const state = await companionState();
      return command === 'modal-panel' ? !state.windows.character.visible && !state.windows.bubble.visible
        : state.windows.character.visible && String(state.follow.frame?.id) === host.id;
    }, command + ' 的原生显隐不正确');
    await send(host, 'close-panel');
    await until(async () => (await companionState()).windows.character.visible, '关闭面板后角色没有自动回到主窗口');
  }
  // 同一进程的第二个独立聊天窗口必须仍然可选，关闭后重新跟回原窗口。
  await send(host, 'independent-window');
  const other = await fs.readFile(path.join(host.directory, 'panel-id'), 'utf8');
  await until(async () => String((await companionState()).follow.frame?.id) === other, '未跟随新打开的独立聊天窗口');
  await send(host, 'close-panel');
  await until(async () => String((await companionState()).follow.frame?.id) === host.id, '关闭独立聊天窗口后未恢复原宿主');
  await send(host, 'maximize');
  // 与管理页“切换到实例”使用相同的桥命令，Windows 可以拒绝抢焦点，但不应把最大化取消。
  spawnSync(bridge, ['--focus', String(host.child.pid)], { windowsHide: true, timeout: 10000 });
  await send(host, 'window-state');
  assert.equal(await fs.readFile(path.join(host.directory, 'window-state'), 'utf8'), 'Maximized');
  await send(host, 'restore');
}

// 中断本次测试应用的监控桥；在没有实时窗口信息的间隙，角色和气泡必须立即退出屏幕。
async function checkBridgeRecovery(host) {
  await application.evaluate(() => globalThis.__dragonGirlApp.companion.showBubble('连接中断测试', 'speech'));
  await until(async () => (await companionState()).windows.bubble.visible, '中断前没有显示气泡');
  const oldPid = await application.evaluate(() => {
    const bridge = globalThis.__dragonGirlApp.monitor.native;
    bridge.kill();
    return bridge.pid;
  });
  await until(() => application.evaluate(() => {
    const { companion, monitor } = globalThis.__dragonGirlApp;
    return !monitor.native && !companion.followTarget && !companion.windows.get('character').isVisible()
      && !companion.windows.get('bubble').isVisible() && !companion.interactive.get('character') && !companion.interactive.get('bubble');
  }), '窗口桥中断后仍在按旧快照显示角色或接收鼠标');
  await until(() => application.evaluate((_, { oldPid, hostId }) => {
    const { companion, monitor } = globalThis.__dragonGirlApp;
    return monitor.native?.pid !== oldPid && String(companion.followTarget?.id) === hostId
      && companion.windows.get('character').isVisible() && !companion.windows.get('bubble').isVisible();
  }, { oldPid, hostId: host.id }), '窗口桥自动重连后未按实时宿主恢复');
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
  ids = await application.evaluate((_, { pid, hostId, coverId, isMac }) => {
    const { monitor, dashboard, companion } = globalThis.__dragonGirlApp;
    dashboard.window.hide();
    // 保留真实原生桥和两个自建宿主的遮挡关系，避免用户窗口置前干扰 macOS 连续采样。
    const receive = monitor.receiveNative.bind(monitor);
    monitor.receiveNative = (state, bridge) => {
      const processes = state.processes.filter((row) => row.pid === pid);
      if (!isMac) return receive({ ...state, processes }, bridge);
      // 祈祷特效按需创建，每份快照也要纳入新出现的测试窗口。
      const overlays = [...companion.windows.values(), companion.prayerWave?.window, dashboard.window];
      // 宿主的保存面板也要保留在真实层级中，避免因测试过滤掉窗口而误判桌宠已正确避让。
      const fixtureIds = new Set([hostId, coverId, ...processes.flatMap((row) => row.windows.map((window) => String(window.id))),
        ...overlays.filter((win) => win && !win.isDestroyed())
        .map((win) => win.getMediaSourceId().split(':')[1])]);
      return receive({ ...state, processes,
        windowOrder: state.windowOrder?.filter((id) => fixtureIds.has(String(id))),
        normalWindows: state.normalWindows?.filter(({ id }) => fixtureIds.has(String(id))),
      }, bridge);
    };
    monitor.startNative();
    return Object.fromEntries([...companion.windows].map(([view, window]) => [view, window.getMediaSourceId().split(':')[1]]));
  }, { pid: host.child.pid, hostId: host.id, coverId: cover.id, isMac });
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.companion.windows.get('character').isVisible()), '角色没有跟随真实宿主显示');
  await application.evaluate(() => globalThis.__dragonGirlApp.companion.showBubble('窗口层级验收', 'speech'));
  await until(() => application.evaluate(() => globalThis.__dragonGirlApp.companion.windows.get('bubble').isVisible()), '气泡未显示');
  const original = (await companionState()).character;
  await raise(host, cover);
  // Windows 用真实输入激活宿主，覆盖普通窗口置前权限限制，不能只验收后台窗口之间的排序。
  if (!isMac) {
    await send(host, 'click');
    await until(() => systemState(host.child.pid).host?.frontmost, '标题栏点击没有实际激活测试宿主');
  }
  await expectStack(host, cover, false);
  // 连续真实拖动并在松手后继续采样，不能只等最终恢复，也不能靠抢占键盘焦点来通过。
  if (!isMac) {
    await fs.writeFile(path.join(host.directory, 'watch-windows'), Object.values(ids).join('\n'));
    const drags = [];
    for (let index = 0; index < 4; index++) {
      await fs.rm(path.join(host.directory, 'drag-result.json'), { force: true });
      await send(host, index % 2 ? 'drag-left' : 'drag-right');
      const result = await until(async () => JSON.parse(await fs.readFile(path.join(host.directory, 'drag-result.json'), 'utf8').catch(() => 'null')), '标题栏拖动采样没有结束');
      drags.push(result);
      await fs.writeFile(path.join(root, '.artifacts/follow-drag-report.json'), JSON.stringify({ drags }, null, 2));
      assert.equal(result.failed, false, `第 ${index + 1} 次拖动未成功执行：${JSON.stringify(result)}`);
      assert.equal(result.samples, 100, '连续拖动采样未完成');
      assert.ok(index % 2 ? result.movedX < -50 : result.movedX > 50, `测试没有真正移动宿主：${JSON.stringify(result)}`);
      assert.equal(result.coveredSamples, 0, `拖动或松手后角色被宿主盖住：${JSON.stringify(result)}`);
      assert.equal(result.focusLostSamples, 0, '跟随窗口在拖动时抢占了键盘焦点');
      await expectStack(host, cover, false);
    }
    await until(async () => JSON.stringify((await companionState()).character) === JSON.stringify(original), '往返拖动后角色没有跟随宿主回到原位置');
  }
  // 点击前台宿主会重新排列普通窗口；连续采样必须始终看见角色与气泡，不能容许先消失再补回。
  if (isMac) {
    // 在真实原生桥和桌宠窗口之间验收保存、取消及原位置恢复。
    await send(host, 'save-video');
    await until(async () => {
      const state = await companionState();
      return state.follow.frame === null && !state.windows.character.visible && !state.windows.bubble.visible;
    }, '保存视频期间桌宠或气泡仍然显示');
    await send(host, 'close');
    await until(async () => {
      const state = await companionState();
      return String(state.follow.frame?.id) === host.id && state.windows.character.visible;
    }, '取消保存后桌宠没有重新跟随聊天主窗口');
    assert.deepEqual((await companionState()).character, original, '取消保存改变了桌宠在主窗口上的位置');
    await application.evaluate(() => globalThis.__dragonGirlApp.companion.showBubble('窗口层级验收', 'speech'));
    await raise(host, cover);
    await expectStack(host, cover, false);
    try {
      await until(async () => {
        const state = await companionState();
        return state.windows.character.topmost && state.windows.bubble.topmost;
      }, '前台宿主未进入稳定浮动层');
    } catch (error) { throw new Error(`${error.message}\n${JSON.stringify(await companionState())}`); }
    await fs.writeFile(path.join(host.directory, 'watch.json'), JSON.stringify({ overlays: Object.values(ids) }));
    // 稳定前台点击期间不应发生补偿置前、层级切换或隐藏再显示，避免只靠采样间隙侥幸通过。
    await application.evaluate(() => {
      const companion = globalThis.__dragonGirlApp.companion;
      globalThis.__followClickCalls = {};
      globalThis.__followClickEvents = [];
      for (const [view, window] of companion.windows) for (const name of ['showInactive', 'hide', 'moveAbove', 'setAlwaysOnTop']) {
        const original = window[name].bind(window);
        window[name] = (...args) => {
          const key = `${view}.${name}`;
          globalThis.__followClickCalls[key] = (globalThis.__followClickCalls[key] || 0) + 1;
          globalThis.__followClickEvents.push({ key, args, at: Date.now(), normal: companion.followNormalWindows?.slice(0, 8) });
          return original(...args);
        };
      }
    });
    const clicks = [];
    for (let index = 0; index < 12; index++) {
      await fs.rm(path.join(host.directory, 'watch-result.json'), { force: true });
      await send(host, 'pulse');
      const result = await until(async () => JSON.parse(await fs.readFile(path.join(host.directory, 'watch-result.json'), 'utf8').catch(() => 'null')), '连续点击采样没有结束');
      clicks.push(result);
      if (result.coveredSamples) {
        const events = await application.evaluate(() => globalThis.__followClickEvents);
        await fs.writeFile(path.join(root, '.artifacts/follow-click-failure.json'), JSON.stringify({ clicks, events }, null, 2));
        result.events = events;
      }
      assert.equal(result.coveredSamples, 0, `第 ${index + 1} 次点击时角色或气泡被宿主盖住：${JSON.stringify(result)}`);
    }
    const calls = await application.evaluate(() => globalThis.__followClickCalls);
    assert.deepEqual(calls, {}, '前台点击仍在触发补偿置前或重新显隐');
    await fs.writeFile(path.join(root, '.artifacts/follow-click-report.json'), JSON.stringify({ clicks, calls }, null, 2));
  }

  // Windows 的运行器屏幕可能比宿主窄，验收移动速度时把角色放在可见的左边。
  const originalOffsets = !isMac && await application.evaluate(() => {
    const { monitor, dashboard, companion } = globalThis.__dragonGirlApp;
    const offsets = monitor.settings.followOffsets;
    monitor.settings.followOffsets = { ...offsets, [companion.home]: { x: 0, y: 0.5 } };
    dashboard.follow();
    return offsets;
  });
  const glideOrigin = (await companionState()).character;
  // 两端都统计连续移动期间角色窗口收到的不同坐标，避免只验收最终位置。
  await application.evaluate(() => {
    const window = globalThis.__dragonGirlApp.companion.windows.get('character');
    const setBounds = window.setBounds.bind(window);
    globalThis.__followMovePositions = new Set();
    window.setBounds = (bounds, animate) => {
      globalThis.__followMovePositions.add(bounds.x);
      setBounds(bounds, animate);
    };
  });
  await send(host, 'glide');
  await until(async () => (await fs.stat(path.join(host.directory, 'glide-complete')).catch(() => null))?.isFile(), '连续移动未完成');
  await until(async () => JSON.stringify((await companionState()).character) === JSON.stringify(glideOrigin), '往返移动后角色未对齐');
  const positions = await application.evaluate(() => globalThis.__followMovePositions.size);
  assert.ok(positions >= 14, `连续移动只更新了 ${positions} 个位置，角色跟随滞后`);
  if (originalOffsets) await application.evaluate((_, offsets) => {
    const { monitor, dashboard } = globalThis.__dragonGirlApp;
    monitor.settings.followOffsets = offsets;
    dashboard.follow();
  }, originalOffsets);

  // 宿主菜单展开后重新显示角色和气泡，快照仍应跟随主窗口，原生层级要留在菜单后方。
  await send(host, 'open-floating-menu');
  const menu = await fs.readFile(path.join(host.directory, 'floating-menu'), 'utf8');
  await application.evaluate(() => {
    const { companion } = globalThis.__dragonGirlApp;
    companion.hide();
    companion.show();
    companion.showBubble('菜单层级验收', 'speech');
  });
  await expectStack(host, cover, false);
  const snapshot = systemState(host.child.pid);
  const menuOrder = snapshot.order.filter((id) => [menu, ...Object.values(ids)].includes(id));
  await send(host, 'close-floating-menu');
  console.log(`${isMac ? 'macOS' : 'Windows'} 连续跟随更新 ${positions} 个位置，菜单与桌宠顺序 ${JSON.stringify(menuOrder)}`);
  assert.equal(String(snapshot.host?.windows[0]?.id), host.id, '菜单被误当成主窗口');
  assert.deepEqual(menuOrder, [menu, ids.bubble, ids.character], '角色或气泡盖住宿主的浮动菜单');
  const foreground = systemState(host.child.pid).host.frontmost;
  // 宿主没有移动或最小化，前台应用也不变，只置前另一个应用的窗口。
  await raise(cover, host);
  await expectStack(host, cover, true);
  assert.equal(systemState(host.child.pid).host.frontmost, foreground, '层级同步改变了键盘焦点');
  assert.deepEqual((await companionState()).character, original, '遮挡改变了角色跟随位置');
  await send(cover, 'partial');
  await expectStack(host, cover, true, true, null);
  await send(cover, 'full');
  await expectStack(host, cover, true);
  // 后台通知重新打开气泡时也不能将它提升到覆盖应用前面。
  await application.evaluate(() => {
    const { companion } = globalThis.__dragonGirlApp;
    companion.hideBubble();
    companion.showBubble('后台气泡不能置顶', 'notice');
  });
  await expectStack(host, cover, true);
  await raise(host, cover);
  await expectStack(host, cover, false);
  assert.deepEqual((await companionState()).character, original);
  // Windows 使用真正的置顶覆盖窗口验证层级组边界，并检查实际 Win32 样式而非只看 Electron 缓存。
  if (!isMac) {
    await send(cover, 'topmost');
    await until(() => systemState(host.child.pid).raised.includes(cover.id), '覆盖窗口未进入系统置顶组');
    await send(host, 'raise');
    await expectStack(host, cover, true, true, true);
    await send(cover, 'normal');
    await raise(host, cover);
    await expectStack(host, cover, false);
    await send(host, 'topmost');
    await expectStack(host, cover, false, true, true);
    await send(host, 'normal');
    await expectStack(host, cover, false);
  }
  await send(host, 'minimize');
  await until(async () => {
    const state = await companionState();
    return state.visible && !state.windows.character.visible && !state.windows.bubble.visible && !state.dragging;
  }, '最小化未同时收起角色和气泡');
  await send(host, 'restore');
  await until(async () => {
    const state = await companionState();
    return state.windows.character.visible && JSON.stringify(state.character) === JSON.stringify(original);
  }, '最小化恢复后角色没有回到原位置');
  await application.evaluate(() => globalThis.__dragonGirlApp.companion.hide());
  const sequence = (await companionState()).sequence;
  await raise(cover, host);
  await raise(host, cover);
  await until(async () => (await companionState()).sequence > sequence, '窗口层级变化没有触发原生快照');
  assert.equal((await companionState()).windows.character.visible, false, '窗口置前覆盖了用户主动隐藏的状态');
  // 模式切换使用真实管理层入口，独立桌面保持置顶，再切回跟随时恢复普通层级。
  await application.evaluate(async () => {
    const { monitor, dashboard, companion } = globalThis.__dragonGirlApp;
    monitor.settings.mode = 'desktop';
    await dashboard.updatePets();
    companion.show();
  });
  await send(host, 'minimize');
  await until(async () => systemState(host.child.pid).host?.windows.length === 0, '宿主未最小化');
  const desktop = await companionState();
  assert.equal(desktop.windows.character.visible, true);
  assert.equal(desktop.windows.character.topmost, true);
  assert.equal(desktop.windows.bubble.topmost, true);
  // 独立桌面也可以在 Codex 上播放波纹；把测试角色移到波纹实际经过的位置，检查其保持在特效上方。
  await send(host, 'restore');
  await raise(host, cover);
  await until(() => application.evaluate(() => {
    const { companion, dashboard } = globalThis.__dragonGirlApp;
    const frame = dashboard.prayerWaveTarget(companion)?.frame;
    if (!frame) return false;
    companion.character = { ...companion.character, x: frame.x + 70, y: frame.y + 60 };
    companion.applyCharacter();
    return true;
  }), '独立桌面没有找到恢复的测试宿主');
  await releasePrayerWave();
  const desktopWave = await until(() => application.evaluate(() => {
    const wave = globalThis.__dragonGirlApp.companion.prayerWave;
    return wave?.started && wave.window.getMediaSourceId().split(':')[1];
  }), '独立桌面的波纹没有启动');
  await until(() => {
    const { order } = systemState(host.child.pid);
    return order.indexOf(ids.character) >= 0 && order.indexOf(ids.character) < order.indexOf(desktopWave)
      && order.indexOf(desktopWave) < order.indexOf(host.id);
  }, '独立桌面的特效盖住角色或藏在宿主背后');
  await send(host, 'minimize');
  await until(() => application.evaluate(() => {
    const pet = globalThis.__dragonGirlApp.companion;
    return !pet.prayerWave && pet.windows.get('character').isVisible();
  }), '宿主最小化后独立桌面的波纹或角色状态不正确');
  await application.evaluate(async () => {
    const { monitor, dashboard } = globalThis.__dragonGirlApp;
    monitor.settings.mode = 'follow';
    await dashboard.updatePets();
  });
  await until(async () => !(await companionState()).windows.character.visible, '跟随最小化宿主时没有隐藏');
  await send(host, 'restore');
  await raise(host, cover);
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
  assert.ok(waveStack.order.indexOf(ids.character) >= 0 && waveStack.order.indexOf(ids.character) < waveStack.order.indexOf(wave.id),
    '透明特效窗口盖在角色前面');
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
  if (!isMac) {
    await checkWindowsSwitching(host, cover);
    await checkWindowsPanels(host);
  } else {
    await send(host, 'restore');
    await raise(host, cover);
    await expectStack(host, cover, false, false);
  }
  await checkBridgeRecovery(host);
  await checkDashboardCover(host);
  const report = { passed: true, platform: process.platform, checks: ['真实跨应用层级', '仅层级变化触发快照', '完全遮挡', '部分遮挡仍显示', '后台气泡层级', '恢复原位且不抢焦点', '最小化与恢复', '保留主动隐藏', '独立桌面仍置顶', '切回跟随恢复层级', ...(isMac ? ['连续置前 12 次、全程 8ms 采样无闪烁'] : ['真实标题栏往返拖动 4 次、拖动及松手后连续采样无遮挡', '拖动全程不抢焦点', '系统置顶窗口仍正常遮挡角色'])] };
  report.checks.push('连续移动及时跟随', '菜单展开时跟随主窗口且角色和气泡留在菜单之后');
  if (isMac) report.checks.push('保存视频期间角色与气泡收起，取消后回到聊天主窗口原位');
  else report.checks.push('气泡收起和打开时真实点击切换两窗，屏幕像素验证角色露出、半遮挡、完全遮挡与切回');
  report.checks.push('震荡波放出时收起气泡、渐变波纹扫过宿主远角、鼠标穿透、结束和最小化清理');
  report.checks.push('特效位于角色后方、窗口桥中断立即收起并在自动重连后恢复');
  report.checks.push('同进程管理页遮挡角色与气泡并保留焦点');
  if (!isMac) report.checks.push('Windows 大型非模态面板、阻塞对话框与最大化宿主聚焦', '真实点击透明角落交给宿主、脸部打开气泡');
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  await fs.writeFile(path.join(root, '.artifacts/follow-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  try { await application?.close(); }
  finally {
    for (const { child, directory } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        // 先正常关闭测试窗口，让正在拖动的线程释放鼠标；进程失去响应时才强制清理。
        const exited = new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
        await writeCommand(directory, `quit\n${++serial}`).catch(() => {});
        let timer;
        await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 2500); })]);
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
      }
    }
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
