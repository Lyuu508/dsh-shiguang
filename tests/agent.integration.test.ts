import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm';
import { brandString } from '@deepseek-ai/dsh-brand';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { MemoryStore } from '../src/memory.js';
import { BilibiliClient } from '../src/bilibili.js';
import { ChatDriver } from '../src/agent.js';
import { fixture } from './helpers.js';

class ScriptedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  constructor(readonly script: (options: GenerateOptions, index: number) => StreamChunk[]) { super(); }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    for (const chunk of this.script(options, this.requests.length - 1)) yield chunk;
  }
}
function textChunks(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }];
}
test('真实 DSH AgentLoop：当天上下文进入请求、旧档案不进入、会话完成即释放', async () => {
  const f = fixture(), ctx = new Context();
  const memory = new MemoryStore(':memory:', f.settings.roleId, f.settings.timezone, f.settings.memory);
  const adapter = new ScriptedAdapter(() => textChunks('今天一起练吉他吧。'));
  f.settings.provider = 'shiguang-test'; f.settings.model = 'scripted';
  let driver: ChatDriver | undefined;
  try {
    await mountAgentLoopTestDependencies(ctx); await mountAgentLoopTestHarness(ctx);
    ctx.llm.registerAdapter(['shiguang-test'], adapter);
    ctx.systemPrompt.section({ name: 'private-project-instructions', order: 50, text: '主会话的私人项目指令不应传到QQ' });
    ctx.systemPrompt.context({ name: 'private-project-context', order: 60, text: '主会话的私人项目资料不应传到QQ' });
    memory.append('owner', 'qq', 'p', 'note', '今天准备练吉他');
    memory.append('owner', 'qq', 'p', 'note', '昨天的秘密不应常驻', undefined, Date.now() - 86400000);
    driver = new ChatDriver(ctx, f.settings, memory, new BilibiliClient(f.settings, memory));
    assert.equal(await driver.reply({ scope: 'owner', thread: 'p', owner: true, platform: 'qq', text: '你好' }), '今天一起练吉他吧。');
    assert.equal(adapter.requests.length, 1);
    const request = JSON.stringify(adapter.requests[0]?.messages);
    assert.match(request, /今天准备练吉他/);
    assert.doesNotMatch(request, /昨天的秘密/);
    assert.doesNotMatch(request, /私人项目/);
    assert.deepEqual(adapter.requests[0]?.tools?.map(t => t.name).sort(), ['shiguang_note_today', 'shiguang_read_memory', 'shiguang_search_memory']);
    assert.equal(ctx.agents.list().length, 0);
    await driver.reply({ scope: 'qq:group:5', thread: 'g', owner: false, platform: 'qq', text: '你好' });
    assert.doesNotMatch(JSON.stringify(adapter.requests[1]?.messages), /今天准备练吉他/);
    assert.equal(ctx.agents.list().length, 0);
  } finally { await driver?.stop(); await ctx.fiber.dispose(); memory.close(); f.cleanup(); }
});
function toolChunks(name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>('shiguang-test-call'), name, arguments: JSON.stringify(args) } }, { type: 'finish', reason: { kind: 'tool-calls' } }];
}
for (const recall of [false, true]) test(`真实 DSH 工具执行：${recall ? '追问旧事才返回索引片段' : '日常聊天尝试查历史会被拒绝'}`, async () => {
  const f = fixture(), ctx = new Context();
  f.settings.provider = 'shiguang-test'; f.settings.model = 'scripted';
  f.settings.bilibili.enabled = true; f.settings.bilibili.allowComments = true;
  const memory = new MemoryStore(':memory:', f.settings.roleId, f.settings.timezone, f.settings.memory);
  const adapter = new ScriptedAdapter((_options, index) => index === 0 ? toolChunks('shiguang_search_memory', { query: '吉他', range: 'history' }) : textChunks('收到。'));
  let driver: ChatDriver | undefined;
  try {
    await mountAgentLoopTestDependencies(ctx); await mountAgentLoopTestHarness(ctx);
    ctx.llm.registerAdapter(['shiguang-test'], adapter);
    memory.append('owner', 'qq', 'p', 'note', '旧记忆：选了雅马哈吉他', undefined, Date.now() - 86400000);
    driver = new ChatDriver(ctx, f.settings, memory, new BilibiliClient(f.settings, memory));
    assert.equal(await driver.reply({ scope: 'owner', thread: 'p', owner: true, platform: 'qq', text: recall ? '上次选的吉他是什么' : '你好' }), '收到。');
    assert.equal(adapter.requests.length, 2);
    const rendered = JSON.stringify(adapter.requests[1]?.messages);
    if (recall) assert.match(rendered, /雅马哈吉他/);
    else { assert.match(rendered, /日常聊天/); assert.doesNotMatch(rendered, /雅马哈吉他/); }
    assert.ok(adapter.requests[0]?.tools?.some(t => t.name === 'shiguang_bili_comment'));
    assert.equal(ctx.agents.list().length, 0);
  } finally { await driver?.stop(); await ctx.fiber.dispose(); memory.close(); f.cleanup(); }
});
