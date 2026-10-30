import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';

const execute = promisify(execFile);
const LABEL = 'com.inhamirei.dragongirl.startup';

// 所有控制文件原子替换，助手读取时不会看到半份配置。
export async function writeStartupJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

// 缺少控制文件与损坏控制文件分别处理，配置损坏时保留诊断信息。
export async function readStartupJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

// XML 中仅保存参数数组和固定服务标识，路径不作为脚本执行。
export function startupPlist(helper, config, mode) {
  const escape = (value) => String(value).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${escape(helper)}</string><string>--config</string><string>${escape(config)}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><${mode === 'codex' ? 'true' : 'false'}/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Background</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>\n`;
}

// 原生助手按内容寻址安装，Windows 更新时无需覆盖正在执行的文件。
export class StartupRegistration {
  // 测试可替换命令执行器与系统目录，不注册真实登录项。
  constructor({ root, directory, executable, platform = process.platform, home = os.homedir(), uid = process.getuid?.(), run, launch }) {
    Object.assign(this, { root, executable, platform, uid });
    this.directory = path.join(directory, 'startup');
    this.configFile = path.join(this.directory, 'config.json');
    this.plist = path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`);
    this.run = run || ((command, args) => execute(command, args, { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }));
    this.launch = launch || ((command, args) => new Promise((resolve, reject) => {
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, env: environment });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    }));
  }

  // 只读取本产品自己的配置，不使用配置内的任意程序作为管理命令。
  async current() { return readStartupJson(this.configFile); }

  // 开启自启前确认应用已放到固定位置，避免安装映像卸载后产生失效项。
  validateLocation(mode) {
    if (mode !== 'manual' && this.platform === 'darwin'
      && (/^\/Volumes\//.test(this.executable) || this.executable.includes('/AppTranslocation/')))
      throw new Error('请先把龙娘移入 Applications 并从那里打开，再开启自动启动。');
  }

  // 内容相同的助手复用同一个文件，应用更新后旧助手读到新修订会自行结束。
  async installHelper() {
    const name = this.platform === 'win32' ? 'dragongirl-startup.exe' : 'dragongirl-startup';
    const bytes = await fs.readFile(path.join(this.root, 'native/bin', name));
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const helper = path.join(this.directory, `assistant-${digest}${this.platform === 'win32' ? '.exe' : ''}`);
    await fs.mkdir(this.directory, { recursive: true });
    try { await fs.writeFile(helper, bytes, { flag: 'wx', mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await fs.readFile(helper)).equals(bytes)) throw new Error('启动助手校验失败，请重新安装龙娘。');
    }
    if (this.platform === 'darwin') await fs.chmod(helper, 0o700);
    return helper;
  }

  // 查询当前用户的服务，找不到服务才视为未加载，其他错误保留给调用方。
  async loaded() {
    try { await this.run('/bin/launchctl', ['print', `gui/${this.uid}/${LABEL}`]); return true; }
    catch (error) {
      if (/could not find|could not be found|not found/i.test(error.stderr || '') || [3, 113].includes(error.code)) return false;
      throw error;
    }
  }

  // 注册和移除仅影响本产品的登录项；助手不接管或改写 Codex 的启动配置。
  async register(config) {
    if (this.platform === 'darwin') {
      if (await this.loaded()) await this.run('/bin/launchctl', ['bootout', `gui/${this.uid}/${LABEL}`]);
      if (config.mode === 'manual') { await fs.rm(this.plist, { force: true }); return; }
      await fs.mkdir(path.dirname(this.plist), { recursive: true });
      await fs.writeFile(this.plist, startupPlist(config.helper, this.configFile, config.mode), { mode: 0o600 });
      await this.run('/bin/launchctl', ['enable', `gui/${this.uid}/${LABEL}`]);
      await this.run('/bin/launchctl', ['bootstrap', `gui/${this.uid}`, this.plist]);
      if (!(await this.loaded())) throw new Error('系统没有加载启动助手，请检查登录项设置。');
    } else if (this.platform === 'win32') {
      await this.run(config.helper, [config.mode === 'manual' ? '--disable' : '--enable']);
      if (config.mode !== 'manual') await this.launch(config.helper, []);
    } else throw new Error('自动启动目前支持 macOS 和 Windows。');
  }

  // 仅在用户保存启动方式或应用路径发生变化时重建注册，避免覆盖系统中的禁用选择。
  async configure(mode, { force = false } = {}) {
    if (!['manual', 'login', 'codex'].includes(mode)) throw new Error('无效的启动方式');
    this.validateLocation(mode);
    let previous, recovered = false;
    try { previous = await this.current(); }
    catch (error) {
      if (mode !== 'manual') throw new Error('启动配置无法读取，请先选择手动启动并保存，再重新开启联动。');
      // 损坏配置保留备份，但不能阻止用户关闭已经注册的本产品登录项。
      await fs.copyFile(this.configFile, `${this.configFile}.recovered-${Date.now()}`);
      recovered = true;
    }
    if (!previous && mode === 'manual' && !recovered && !force) return null;
    const helper = await this.installHelper();
    if (!force && previous?.mode === mode && previous.executable === this.executable && previous.helper === helper) return previous;
    const next = { version: 1, revision: randomUUID(), mode, executable: this.executable, arguments: [], helper };
    try {
      await writeStartupJson(this.configFile, next);
      await this.register(next);
      return next;
    } catch (error) {
      // 注册失败时恢复先前可用配置；无法回滚的情况明确显示，不能伪装成保存成功。
      try {
        const restored = previous || { ...next, mode: 'manual' };
        await writeStartupJson(this.configFile, restored);
        await this.register({ ...restored, helper });
      } catch (rollback) { throw new Error(`自动启动设置失败：${error.message}；恢复失败：${rollback.message}`); }
      throw new Error(`自动启动设置未生效：${error.message}`);
    }
  }
}
