import { TEST_PREVIEW_WIDTH, TEST_PREVIEW_HEIGHT } from '../shared/account-tests.js';

// 固定逻辑画布按容器大小等比缩放，卡片和缩略图共用同一套尺寸规则。
export class TestPreview {
  // 只有可见的预览才创建 iframe，滚出历史页后释放动画和脚本资源。
  constructor(stage, title) {
    this.stage = stage;
    this.title = title;
    this.sizeObserver = new ResizeObserver(() => this.mount());
    this.sizeObserver.observe(stage);
    this.visibilityObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.mount();
    }, { root: stage.closest('.content-scroll'), rootMargin: '100px' });
    this.visibilityObserver.observe(stage);
  }

  // 相同记录的推送不重建 iframe，已播放的动画不会反复重新开始。
  setSource(url) {
    if (this.url !== url) { this.url = url; this.frame?.remove(); this.frame = null; }
    this.mount();
  }

  // 沙箱不授予同源、弹窗和顶层导航权限，页面也没有主进程桥接接口。
  mount() {
    if (!this.visible || !this.url || this.stage.hidden || !this.stage.clientWidth || !this.stage.clientHeight) {
      this.frame?.remove();
      this.frame = null;
      return;
    }
    if (!this.frame) {
      this.frame = document.createElement('iframe');
      this.frame.className = 'test-preview';
      this.frame.setAttribute('sandbox', 'allow-scripts');
      this.frame.setAttribute('referrerpolicy', 'no-referrer');
      this.frame.setAttribute('scrolling', 'no');
      // 先固定逻辑尺寸再加载页面，切换视图时不会先出现浏览器默认的 300×150 视口。
      this.frame.width = String(TEST_PREVIEW_WIDTH);
      this.frame.height = String(TEST_PREVIEW_HEIGHT);
      this.frame.style.width = `${TEST_PREVIEW_WIDTH}px`;
      this.frame.style.height = `${TEST_PREVIEW_HEIGHT}px`;
      this.frame.title = this.title;
      this.frame.src = this.url;
      this.layout();
      this.stage.append(this.frame);
    }
    this.layout();
  }

  // 改变窗口尺寸只更新外层缩放，不改变生成页面的逻辑视口或内容高度。
  layout() {
    if (!this.frame) return;
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    const scale = Math.min(width / TEST_PREVIEW_WIDTH, height / TEST_PREVIEW_HEIGHT);
    const x = (width - TEST_PREVIEW_WIDTH * scale) / 2, y = (height - TEST_PREVIEW_HEIGHT * scale) / 2;
    this.frame.style.width = `${TEST_PREVIEW_WIDTH}px`;
    this.frame.style.height = `${TEST_PREVIEW_HEIGHT}px`;
    this.frame.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  // 离开记录或刷新历史列表时释放观察器，避免不可见页面继续执行。
  destroy() {
    this.sizeObserver.disconnect();
    this.visibilityObserver.disconnect();
    this.frame?.remove();
  }
}
