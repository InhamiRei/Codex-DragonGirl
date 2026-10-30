import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const home = process.env.CODEX_HOME;
const mode = fs.existsSync(path.join(home, 'mode')) ? fs.readFileSync(path.join(home, 'mode'), 'utf8').trim() : 'normal';
const calls = [];
fs.writeFileSync(path.join(home, 'pid'), String(process.pid));

// 假服务保存协议请求供断言使用，所有数据都位于测试专用目录。
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }

// 模拟真实的双向通知、分页、工具请求、限流与可中断长任务，不访问外部模型。
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method || message.id === undefined) return;
  calls.push(message);
  fs.writeFileSync(path.join(home, 'calls.json'), JSON.stringify(calls));
  const reply = (result) => send({ id: message.id, result });
  const notify = (method, params) => send({ method, params: { threadId: 'thread-test', ...params } });
  if (message.method === 'initialize') { reply({}); return; }
  if (message.method === 'account/read') { reply({ account: { type: 'chatgpt', planType: 'plus' } }); return; }
  if (message.method === 'config/read') { reply({ config: { mcp_servers: { fixture: { command: 'must-not-run' } } } }); return; }
  if (message.method === 'model/list') {
    const item = { model: 'fixture-model', displayName: '测试模型', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] };
    reply(message.params.cursor ? { data: [{ ...item, model: 'second-model', isDefault: false }], nextCursor: null } : { data: [item, { ...item, model: 'gpt-6-astra', displayName: 'GPT-6 Astra', isDefault: false }], nextCursor: 'next' });
    return;
  }
  if (message.method === 'thread/start') { reply({ thread: { id: 'thread-test', ephemeral: true }, model: message.params.model, instructionSources: mode === 'global' ? ['/fake/AGENTS.md'] : [] }); return; }
  if (message.method === 'turn/interrupt') {
    reply({});
    notify('turn/completed', { turn: { id: 'turn-test', status: 'interrupted', items: [] } });
    return;
  }
  if (message.method !== 'turn/start') { reply({}); return; }
  reply({ turn: { id: 'turn-test', status: 'inProgress' } });
  notify('turn/started', { turn: { id: 'turn-test' } });
  if (mode === 'tool') {
    notify('item/started', { item: { id: 'tool', type: 'commandExecution', command: 'must-not-run' } });
    return;
  }
  notify('item/started', { item: { id: 'answer', type: 'agentMessage', text: '', phase: 'final_answer' } });
  if (mode === 'slow') {
    notify('item/agentMessage/delta', { itemId: 'answer', delta: '正在生成的部分回答' });
    return;
  }
  if (mode === 'rate' || mode === 'html-rate') {
    notify('item/agentMessage/delta', { itemId: 'answer', delta: mode === 'rate' ? '保留部分内容' : '<!doctype html><html>生成中的源码' });
    notify('turn/completed', { turn: { id: 'turn-test', status: 'failed', error: { message: '429 hidden-sensitive-content' }, items: [] } });
    return;
  }
  const prompt = message.params.input[0].text;
  const text = /HTML|鹈鹕/.test(prompt)
    ? '<!doctype html><html><head><style>body{margin:32px;min-height:100vh;background:#f5f1e8;font-family:sans-serif}main{width:1500px;height:1300px;background:#d2eee6}header,footer{height:100px;padding:24px;box-sizing:border-box}svg{display:block;width:1500px;height:1100px}circle{animation:ride 1s infinite alternate}@keyframes ride{to{transform:translateX(40px)}}</style></head><body><main data-fit-marker><header>鹈鹕动画 · 完整页面</header><svg viewBox="0 0 1500 1100"><rect width="1500" height="1100" fill="#d2eee6"/><circle cx="750" cy="550" r="200" fill="#7561ad"/><text x="560" y="850" font-size="60">骑车的鹈鹕</text></svg><footer data-fit-bottom>完整页脚</footer></main>\n' + '<!-- 测试源码滚动区域，不应改变外部卡片高度。 -->\n'.repeat(100) + '<script>document.body.dataset.animated="yes"</script></body></html>'
    : '中文回答：' + prompt;
  if (mode === 'step') {
    notify('item/agentMessage/delta', { itemId: 'answer', delta: text.slice(0, -7) });
    const poll = setInterval(() => {
      if (!fs.existsSync(path.join(home, 'release'))) return;
      clearInterval(poll);
      notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text, phase: 'final_answer' } });
      notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } });
      notify('turn/completed', { turn: { id: 'turn-test', status: 'completed', items: [] } });
    }, 25);
    return;
  }
  const notification = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-test', itemId: 'answer', delta: text } }) + '\n');
  const chinese = notification.indexOf(Buffer.from('中'));
  const boundary = chinese > 0 ? chinese + 1 : Math.floor(notification.length / 2);
  process.stdout.write(notification.subarray(0, boundary));
  setTimeout(() => {
    process.stdout.write(notification.subarray(boundary));
    notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text, phase: 'final_answer' } });
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } });
    notify('turn/completed', { turn: { id: 'turn-test', status: 'completed', items: [] } });
  }, 30);
});
