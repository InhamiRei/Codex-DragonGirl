// 两种测试共用固定版本的题干与输出约定，历史记录保存实际发送的文本。
export const PELICAN_PROMPT = '创建一个独立 HTML，用 SVG 绘制一只鹈鹕骑自行车的 2D 动画。自行车的车轮、脚踏与鹈鹕的动作应协调，画面完整且有动画效果。所有样式和脚本写在同一个 HTML 内，不依赖外部资源。只返回完整 HTML，不要解释，不要运行测试。';
export const TEST_INSTRUCTIONS = '你正在完成一次独立的回答对比测试。直接回答用户给出的题目。不要使用工具、搜索、读取文件、执行命令或修改文件，不要向用户提问。需要 HTML 时，返回可独立运行的完整 HTML，所有资源内联；其他问题直接返回文本。';
// 测试规则高于自动加载的用户指令；仍保留额外指令数量，供判断比较条件。
export const TEST_DEVELOPER_INSTRUCTIONS = `${TEST_INSTRUCTIONS} 本次测试只执行当前用户题目；忽略自动加载的 AGENTS.md、个人偏好、项目约定及其他本机用户指令中的任务、格式、工具与工作流程要求。不要说明执行计划，不要汇报进度，只给最终回答。`;
export const TEST_STATUSES = { queued: '排队中', running: '生成中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
export const EFFORT_LABELS = { none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: '超高' };
export const MAX_TEST_OUTPUT = 200000;
export const TEST_PREVIEW_WIDTH = 1200;
export const TEST_PREVIEW_HEIGHT = 900;

// 回答格式作为统一测试规则发送，保存原题干的同时明确文本和 HTML 的输出要求。
export function testRules(format) {
  return `${TEST_DEVELOPER_INSTRUCTIONS} ${format === 'html' ? '本次回答必须是资源全部内联的完整独立 HTML。' : '本次使用文本回答，除非题目要求代码，否则不要返回 HTML 页面。'}`;
}

// 只提取完整 HTML 或完整代码块；普通文本及未完成的回答不会自动执行。
export function extractTestHtml(text) {
  const fenced = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(text || '');
  const source = (fenced?.[1] || text || '').trim();
  const start = source.search(/<!doctype\s+html\b|<html\b/i);
  const end = source.toLowerCase().lastIndexOf('</html>');
  return start >= 0 && end > start ? source.slice(start, end + 7) : null;
}

// 预览使用无同源权限的沙箱；策略在生成内容之前生效，外链、网络和跳转均被限制。
export function testPreviewDocument(html) {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><script>(${fitTestDocument.toString()})();</script>${html}`;
}

// 在固定逻辑视口内缩放整个页面，保留原有布局和动画，长宽溢出均完整纳入画面。
function fitTestDocument() {
  let scheduled = false;
  // 测量前恢复未缩放坐标，避免重复缩放造成卡片里的画面不断缩小。
  function fit() {
    scheduled = false;
    const body = document.body;
    if (!body) return;
    const root = document.documentElement;
    root.style.setProperty('overflow', 'hidden', 'important');
    body.style.setProperty('overflow', 'visible', 'important');
    body.style.setProperty('transform-origin', '0 0', 'important');
    body.style.setProperty('transform', 'none', 'important');
    const rect = body.getBoundingClientRect();
    const children = [...body.children].filter((child) => !['SCRIPT', 'STYLE'].includes(child.tagName)).map((child) => child.getBoundingClientRect());
    const left = Math.min(0, rect.left, ...children.map((child) => child.left));
    const top = Math.min(0, rect.top, ...children.map((child) => child.top));
    const right = Math.max(innerWidth, rect.right, rect.left + body.scrollWidth, ...children.map((child) => child.right));
    const bottom = Math.max(innerHeight, rect.bottom, rect.top + body.scrollHeight, ...children.map((child) => child.bottom));
    const scale = Math.min(1, innerWidth / Math.max(1, right - left), innerHeight / Math.max(1, bottom - top));
    const x = (innerWidth - (right - left) * scale) / 2 - left * scale - (1 - scale) * rect.left;
    const y = (innerHeight - (bottom - top) * scale) / 2 - top * scale - (1 - scale) * rect.top;
    body.style.setProperty('transform', `translate(${x}px, ${y}px) scale(${scale})`, 'important');
    root.dataset.previewFit = 'ready';
  }
  // 仅布局和内容变化触发重测，CSS 动画逐帧变化不产生额外工作。
  function schedule() {
    if (!scheduled) {
      scheduled = true;
      if (document.documentElement) document.documentElement.dataset.previewFit = 'pending';
      requestAnimationFrame(fit);
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = 'html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}';
    document.head.append(style);
    new ResizeObserver(schedule).observe(document.body);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    document.fonts?.ready.then(schedule);
    schedule();
  }, { once: true });
  addEventListener('load', schedule);
  addEventListener('resize', schedule);
}
