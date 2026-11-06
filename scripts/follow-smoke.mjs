import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  const foreground = systemState(host.child.pid).host.frontmost;
  // 宿主没有移动或最小化，前台应用也不变，只置前另一个应用的窗口。
  await raise(cover, host);
  await expectStack(host, cover, true);
  assert.equal(systemState(host.child.pid).host.frontmost, foreground, '层级同步改变了键盘焦点');
  assert.deepEqual((await companionState()).character, original, '遮挡改变了角色跟随位置');
  await send(cover, 'partial');
  await expectStack(host, cover, true);
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
  await application.evaluate(async () => {
    const { monitor, dashboard } = globalThis.__dragonGirlApp;
    monitor.settings.mode = 'follow';
    await dashboard.updatePets();
  });
  await until(async () => !(await companionState()).windows.character.visible, '跟随最小化宿主时没有隐藏');
  await send(host, 'restore');
  await raise(host, cover);
  await expectStack(host, cover, false, false);
  const report = { passed: true, platform: process.platform, checks: ['真实跨应用层级', '仅层级变化触发快照', '完全遮挡', '部分遮挡仍显示', '后台气泡层级', '恢复原位且不抢焦点', '最小化与恢复', '保留主动隐藏', '独立桌面仍置顶', '切回跟随恢复层级', ...(isMac ? ['连续置前 12 次、全程 8ms 采样无闪烁'] : ['真实标题栏往返拖动 4 次、拖动及松手后连续采样无遮挡', '拖动全程不抢焦点', '系统置顶窗口仍正常遮挡角色'])] };
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
