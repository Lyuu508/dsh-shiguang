import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import * as plugin from '../src/plugin.js';
import { MemoryStore } from '../src/memory.js';
import { fixture } from './helpers.js';

class Adapter extends LlmAdapter {
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '你好，今天也记得练吉他。' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '你好，今天也记得练吉他。' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
test('独立插件加载→OneBot 收消息→真实 DSH 循环→QQ 回执→记忆落盘→卸载', { timeout: 10000 }, async () => {
  const f = fixture(), ctx = new Context();
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address === 'object');
  f.settings.provider = 'deepseek-official'; f.settings.model = 'scripted';
  f.settings.qq.enabled = true; f.settings.qq.ownerQQ = '1'; f.settings.qq.tokenEnv = 'SHIGUANG_PLUGIN_TEST_TOKEN';
  f.settings.qq.wsUrl = `ws://127.0.0.1:${address.port}`;
  process.env.SHIGUANG_PLUGIN_TEST_TOKEN = 'test-token';
  const file = join(f.dir, 'config.json'); writeFileSync(file, JSON.stringify(f.settings));
  let resolveSent: (text: string) => void;
  const sent = new Promise<string>(resolve => { resolveSent = resolve; });
  server.on('connection', socket => {
    socket.on('message', data => {
      const value = JSON.parse(data.toString());
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 22 }, echo: value.echo }));
      resolveSent(value.params.message[0].data.text);
    });
    socket.send(JSON.stringify({ post_type: 'message', message_type: 'private', message_id: 11, self_id: 2, user_id: 1, message: [{ type: 'text', data: { text: '你好' } }] }));
  });
  try {
    await mountAgentLoopTestDependencies(ctx); await mountAgentLoopTestHarness(ctx);
    ctx.llm.registerAdapter(['deepseek-official'], new Adapter());
    const mounted = await ctx.plugin(plugin, { configPath: file });
    assert.equal(await sent, '你好，今天也记得练吉他。');
    await mounted.dispose();
    const memory = new MemoryStore(join(f.dir, 'memory.sqlite'), f.settings.roleId, f.settings.timezone, f.settings.memory);
    try {
      assert.match(memory.fastContext('owner', 'qq:private:1').recent, /今天也记得练吉他/);
    } finally { memory.close(); }
    assert.equal(ctx.agents.list().length, 0);
  } finally { await ctx.fiber.dispose(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(r => server.close(() => r())); delete process.env.SHIGUANG_PLUGIN_TEST_TOKEN; f.cleanup(); }
});
