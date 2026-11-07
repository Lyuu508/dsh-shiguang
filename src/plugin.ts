import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { join } from 'node:path';
import { loadSettings } from './config.js';
import { MemoryStore } from './memory.js';
import { BilibiliClient } from './bilibili.js';
import { OneBotClient } from './onebot.js';
import { ChatDriver } from './agent.js';

export const name = 'shiguang';
export const inject = ['agents', 'tools', 'systemPrompt'];
export interface Config { configPath: string }
export const Config = Schema.object({ configPath: Schema.string().default('') });

export function apply(ctx: Context, config: Config): void {
  const settings = loadSettings(config.configPath);
  const memory = new MemoryStore(join(settings.dataDir, 'memory.sqlite'), settings.roleId, settings.timezone, settings.memory);
  const bili = new BilibiliClient(settings, memory);
  const driver = new ChatDriver(ctx, settings, memory, bili);
  const log = (text: string) => console.info(`[Shiguang] ${text}`);
  let stopped = false, queued = 0;
  let tail = Promise.resolve();
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    if (stopped) return Promise.reject(new Error('Shiguang 正在停止'));
    if (queued >= settings.maxQueue) return Promise.reject(new Error('Shiguang 待处理消息已满，请稍后再试'));
    queued++;
    const task = tail.then(() => { if (stopped) throw new Error('Shiguang 正在停止'); return run(); });
    tail = task.then(() => {}, error => log(error instanceof Error ? error.message : '任务失败，请检查日志')).finally(() => { queued--; });
    return task;
  };
  const qq = new OneBotClient(settings.qq, message => {
    void enqueue(async () => {
      const reply = await driver.reply({ scope: message.scope, thread: message.thread, owner: message.owner, platform: 'qq', text: message.text, externalKey: message.id });
      if (!reply) return;
      await qq.send(message, reply);
      memory.append(message.scope, 'qq', message.thread, 'assistant', reply);
    }).catch(() => { /* The queue logs the failure once; no automatic retry of external writes. */ });
  }, log);
  ctx.effect(() => {
    if (settings.qq.enabled) qq.start();
    log(`已加载角色 ${settings.roleId}；QQ ${settings.qq.enabled ? '开启' : '关闭'}；B站 ${settings.bilibili.enabled ? '开启' : '关闭'}；当天时区 ${settings.timezone}`);
    return async () => {
      stopped = true;
      try { await driver.stop(); await tail; }
      finally { qq.stop(); memory.close(); }
    };
  });
  ctx.tools.register(defineTool({
    name: 'shiguang_chat', description: '以主人的身份与 Shiguang 角色对话，共用 QQ/B站记忆。普通聊天只加载今天的笔记，提到旧事再检索历史。',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      return enqueue(async () => {
        const reply = await driver.reply({ scope: 'owner', thread: 'dsh:owner', owner: true, platform: 'dsh', text: args.text });
        if (!reply) throw new Error('消息重复');
        memory.append('owner', 'dsh', 'dsh:owner', 'assistant', reply);
        return reply;
      });
    },
  }));
}
