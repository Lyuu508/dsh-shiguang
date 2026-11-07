import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ShiguangRuntime } from './runtime.js';
import { registerPanelApi } from './panel-api.js';

export const name = 'shiguang';
export const inject = ['agents', 'tools', 'systemPrompt'];
export interface Config { configPath: string }
export const Config = Schema.object({ configPath: Schema.string().default('') });

export function apply(ctx: Context, config: Config): void {
  const runtime = new ShiguangRuntime(ctx,config.configPath);
  ctx.effect(() => () => runtime.stop());
  registerPanelApi(ctx,runtime);
  ctx.tools.register(defineTool({
    name: 'shiguang_chat', description: '以主人的身份与拾光角色对话，共用 QQ/B站记忆。普通聊天只加载今天的笔记，提到旧事再检索历史。',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      return runtime.enqueue(async () => {
        const reply = await runtime.driver.reply({ scope: 'owner', thread: 'dsh:owner', owner: true, platform: 'dsh', text: args.text });
        if (!reply) throw new Error('消息重复');
        runtime.memory.append('owner','dsh','dsh:owner','assistant',reply);
        return reply;
      });
    },
  }));
}
