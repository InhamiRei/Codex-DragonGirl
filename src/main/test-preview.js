import { extractTestHtml, testPreviewDocument } from '../shared/account-tests.js';

// 预览仅提供指定已完成测试的 HTML，禁止借用协议读取其他文件或未完成回答。
export async function accountTestPreview(address, tests) {
  const url = new URL(address);
  const parts = /^\/([a-f0-9-]{36})\/([a-f0-9]{20})$/.exec(url.pathname);
  if (url.protocol !== 'dragon-preview:' || url.hostname !== 'test' || !parts || url.search || url.hash)
    return new Response('预览不存在', { status: 404 });
  try {
    const run = await tests.read(parts[1]);
    const result = run.results.find((item) => item.instanceId === parts[2]);
    const html = result?.status === 'completed' && extractTestHtml(result.text);
    if (!html) return new Response('没有完整 HTML 可供预览', { status: 409 });
    return new Response(testPreviewDocument(html), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors dragon://app",
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch { return new Response('预览不存在', { status: 404 }); }
}
