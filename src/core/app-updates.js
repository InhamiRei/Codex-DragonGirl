import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileDigest } from './file-digest.js';

const repository = 'InhamiRei/Codex-DragonGirl';
const releases = `https://github.com/${repository}/releases`;
const latestApi = `https://api.github.com/repos/${repository}/releases/latest`;
const stableVersion = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
// 后台检查、打开窗口时刷新和网络失败重试采用各自的间隔，限流时延长等待。
const backgroundInterval = 6 * 60 * 60 * 1000;
const foregroundInterval = 15 * 60 * 1000;
const retryInterval = 5 * 60 * 1000;
const rateLimitInterval = 60 * 60 * 1000;
const downloadHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const cacheName = /^Codex-DragonGirl-(\d+\.\d+\.\d+)-(?:macOS-arm64\.dmg|Windows-x64(?:-Setup\.exe|\.zip))(?:\.[a-f\d-]{36}\.part)?$/;

// 正式版逐段比较，避免把 1.10 当成比 1.9 更早的版本。
function newerVersion(tag, current) {
  const latest = stableVersion.exec(tag), local = stableVersion.exec(current);
  if (!latest || !local) return false;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(latest[i]) - Number(local[i]);
    if (difference) return difference > 0;
  }
  return false;
}

// 只接受本仓库当前标签下、与运行架构精确匹配且具有 GitHub 摘要的正式附件。
export function selectUpdate(data, current, platform, arch) {
  const tag = data?.tag_name;
  if (typeof tag !== 'string' || data.draft || data.prerelease || !newerVersion(tag, current)) return null;
  const version = tag.replace(/^v/, '');
  const release = { version, page: `${releases}/tag/${tag}`, notes: String(data.body || '').slice(0, 24000),
    published: data.published_at || '', asset: null };
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const formats = platform === 'darwin' && arch === 'arm64' ? [['dmg', 'macOS-arm64.dmg']]
    : platform === 'win32' && arch === 'x64' ? [['setup', 'Windows-x64-Setup.exe'], ['zip', 'Windows-x64.zip']] : [];
  for (const [format, suffix] of formats) {
    const name = `Codex-DragonGirl-${version}-${suffix}`;
    const url = `${releases}/download/${tag}/${name}`;
    const file = assets.find((item) => item?.name === name && item.browser_download_url === url);
    if (file?.state !== 'uploaded' || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 2 ** 31
      || !/^sha256:[0-9a-f]{64}$/.test(file.digest || '')) continue;
    release.asset = { format, name, url, size: file.size, digest: file.digest.slice(7) };
    break;
  }
  return release;
}

// 打开系统安装包前重新核对整份文件，缓存被移动、截断或修改时不能继续安装。
async function matchesAsset(file, asset, signal) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size !== asset.size) return false;
    const { bytes, sha256 } = await fileDigest(file, signal);
    return bytes === asset.size && sha256 === asset.digest;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// 更新状态独立于统计快照；关闭管理窗口后下载继续，再次打开能够恢复到同一进度。
export class AppUpdates extends EventEmitter {
  // 系统打开与网络请求由主进程提供，离线测试可用相同入口检查真实状态转换。
  constructor({ current, platform = process.platform, arch = process.arch, installed = false, directory, fetch, markDownload, openFile, openPage }) {
    super();
    Object.assign(this, { current, platform, arch, directory, fetch, markDownload, openFile, openPage });
    this.lifetime = new AbortController();
    this.started = false;
    this.nextForegroundCheck = 0;
    this.state = { status: 'idle', current, installed, release: null, percent: 0, error: '' };
  }

  // 桌宠长期运行时也会发现新版本，自动检查只读取发布信息。
  start() {
    if (this.started || this.lifetime.signal.aborted) return;
    this.started = true;
    void this.check();
  }

  // 管理窗口打开时刷新过期的发布信息，短时间内反复打开会共用同一份结果。
  checkOnOpen() {
    if (this.started && Date.now() >= this.nextForegroundCheck) void this.check();
  }

  // 根据检查结果重设定时器，下载或安装占用通道时等当前操作结束。
  scheduleCheck(delay, foregroundDelay = delay) {
    if (!this.started || this.lifetime.signal.aborted) return;
    clearTimeout(this.timer);
    this.nextForegroundCheck = Date.now() + foregroundDelay;
    const timer = setTimeout(async () => {
      while (this.timer === timer && this.pending) await this.pending;
      if (this.timer === timer) void this.check();
    }, delay).unref();
    this.timer = timer;
  }

  // 阶段变化时推送完整快照；连续下载进度单独传一个整数。
  update(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.state);
  }

  // 串行化检查、下载和安装，连续点击或多个异步入口复用同一次操作。
  run(task, retryStatus) {
    if (this.pending || this.lifetime.signal.aborted) return this.pending;
    this.pending = Promise.resolve().then(task).catch((error) => {
      const networkError = /^(?:fetch failed|failed to fetch|net::|networkerror|the operation (?:was aborted|timed out))/i.test(error.message);
      if (!this.lifetime.signal.aborted) this.update({ status: retryStatus, error: networkError
        ? '连接 GitHub 失败，请检查网络后重试。' : error.message });
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  // 从固定公开仓库读取最新正式版，网络故障时保留上次发现的版本和发布页。
  check() {
    const previous = this.state;
    const downloaded = previous.status === 'ready' || previous.status === 'opened';
    return this.run(async () => {
      // 网络错误和无效响应保留这次重试，检查成功后再恢复常规频率。
      this.scheduleCheck(retryInterval);
      this.update({ status: 'checking', error: '' });
      const response = await this.fetch(latestApi, { redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)]) });
      if (response.status === 403 || response.status === 429) {
        this.scheduleCheck(rateLimitInterval);
        throw new Error('GitHub 暂时限制了检查频率，请稍后重试。');
      }
      if (!response.ok) throw new Error(`获取版本失败（HTTP ${response.status}），请稍后重试。`);
      const data = await response.json();
      if (typeof data?.tag_name !== 'string' || !stableVersion.test(data.tag_name) || data.draft || data.prerelease)
        throw new Error('最新正式版的发布信息不完整，请稍后重试。');
      const release = selectUpdate(data, this.current, this.platform, this.arch);
      // 通过版本和摘要识别同一个已下载附件，新版本或重新上传的文件必须重新下载。
      const sameFile = downloaded && release?.asset && release.asset.url === previous.release?.asset?.url
        && release.asset.digest === previous.release.asset.digest && release.asset.size === previous.release.asset.size;
      await this.cleanCache(release?.asset?.name);
      this.scheduleCheck(backgroundInterval, foregroundInterval);
      this.update({ release, status: sameFile ? previous.status : release ? 'available' : 'current', percent: sameFile ? 100 : 0 });
    }, downloaded ? previous.status : previous.release ? 'available' : 'error');
  }

  // 回收中断的临时文件和过时安装包，当前版本的 DMG 可能仍被挂载，保留到下一次升级。
  async cleanCache(keep) {
    const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const match = cacheName.exec(entry.name);
      if (!match || !entry.isFile() || entry.name === keep) continue;
      if (match[1] === this.current && entry.name.endsWith('.dmg')) continue;
      await fs.rm(path.join(this.directory, entry.name), { force: true }).catch(() => {});
    }
  }

  // 附件仅从本仓库的正式地址发起，请求不带登录信息，重定向仅允许 GitHub 分发域名。
  async fetchAsset(asset, signal) {
    let url = new URL(asset.url);
    for (let count = 0; count < 6; count++) {
      if (url.protocol !== 'https:' || url.port || url.username || url.password || !downloadHosts.has(url.hostname))
        throw new Error('安装包跳转地址无效，请打开发布页查看。');
      const response = await this.fetch(url.href, { redirect: 'manual', credentials: 'omit', signal });
      if (response.ok && response.body) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (response.status < 300 || response.status >= 400 || !location)
        throw new Error(`下载失败（HTTP ${response.status}），请重试。`);
      url = new URL(location, url);
    }
    throw new Error('安装包跳转次数过多，请打开发布页查看。');
  }

  // 流式写临时文件，只有长度与 SHA-256 同时匹配才原子替换为可打开的安装包。
  download() {
    const asset = this.state.release?.asset;
    if (!asset || this.state.status !== 'available') return this.pending;
    return this.run(async () => {
      this.update({ status: 'downloading', percent: 0, error: '' });
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, asset.name);
      if (!await matchesAsset(file, asset, this.lifetime.signal)) {
        const temporary = `${file}.${randomUUID()}.part`;
        // 持续传输的慢连接可以下载完整安装包，仅在连续两分钟没有数据时中止。
        const stalled = new AbortController();
        const idleTimer = setTimeout(() => stalled.abort(), 120000).unref();
        const signal = AbortSignal.any([this.lifetime.signal, stalled.signal]);
        try {
          const response = await this.fetchAsset(asset, signal);
          const hash = createHash('sha256');
          let received = 0, lastReport = 0;
          // 进度适度合并，避免逐数据块触发管理窗口重绘。
          const meter = new Transform({ transform: (chunk, _encoding, done) => {
            idleTimer.refresh();
            received += chunk.length;
            if (received > asset.size) return done(new Error('安装包长度与发布记录不符，请重新下载。'));
            hash.update(chunk);
            const percent = Math.floor(received / asset.size * 100);
            const now = Date.now();
            if (percent !== this.state.percent && now - lastReport >= 180) {
              this.state.percent = percent;
              this.emit('change', percent);
              lastReport = now;
            }
            done(null, chunk);
          } });
          await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
          if (received !== asset.size || hash.digest('hex') !== asset.digest)
            throw new Error('安装包校验失败，请重新下载。');
          await this.markDownload?.(temporary, asset.url);
          await fs.rename(temporary, file);
        } catch (error) {
          // 正常提交后临时路径已消失；清理失败也要保留真正的下载或校验错误。
          await fs.rm(temporary, { force: true }).catch(() => {});
          throw error;
        } finally {
          clearTimeout(idleTimer);
        }
      }
      this.update({ status: 'ready', percent: 100 });
    }, 'available');
  }

  // 系统只接收当前已经核验的固定缓存文件；窗口不能传入路径、命令或下载地址。
  apply() {
    const asset = this.state.release?.asset;
    if (!asset || (this.state.status !== 'ready' && !(this.state.status === 'opened' && asset.format !== 'setup'))) return this.pending;
    return this.run(async () => {
      this.update({ status: 'opening', error: '' });
      const file = path.join(this.directory, asset.name);
      if (!await matchesAsset(file, asset, this.lifetime.signal)) {
        this.update({ status: 'available', percent: 0, error: '安装包已移动或内容有变化，请重新下载。' });
        return;
      }
      if (this.lifetime.signal.aborted) return;
      await this.openFile(file, asset.format);
      this.update({ status: 'opened' });
    }, 'ready');
  }

  // 发布说明始终指向项目本身，检查失败时仍能访问最新正式版页面。
  visitRelease() { return this.openPage(this.state.release?.page || `${releases}/latest`); }

  // 退出时终止网络请求，并等待临时文件清理完毕。
  async stop() {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.lifetime.abort();
    await this.pending;
  }
}
