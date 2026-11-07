import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type { ShiguangRuntime } from './runtime.js';
import { dailyUsage } from './usage.js';
import { checkMediaTools } from './media.js';
import {exportMemoryPage,importMemory} from './memory-transfer.js';

function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求参数应为对象');
  return value as Record<string,unknown>;
}
function text(value: unknown, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 4096) throw new Error('文本参数无效');
  return value;
}
export async function panelAction(runtime: ShiguangRuntime, action: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const args = object(payload ?? {});
  switch (action) {
    case 'load': return { ...runtime.view(), status: runtime.status() };
    case 'status': return runtime.status();
    case 'napcat-status':return runtime.napcat.view();
    case 'napcat-start':return runtime.napcat.start();
    case 'napcat-token':return runtime.napcat.saveWebuiToken(text(args.token));
    case 'napcat-console':return runtime.napcat.consoleUrl();
    case 'napcat-login':return runtime.napcat.loginStatus(signal);
    case 'napcat-refresh':return runtime.napcat.refreshQR(signal);
    case 'auto-status':return runtime.autonomy.status();
    case 'wake-now':return runtime.enqueue(()=>runtime.autonomy.run());
    case 'wake-cancel':runtime.autonomy.cancelCurrent();return runtime.autonomy.status();
    case 'memory-export':return exportMemoryPage(runtime.memory,text(args.scope,'owner'),args.range==='today'?'today':'all',typeof args.after==='number'?args.after:0,typeof args.snapshot==='number'?args.snapshot:undefined,text(args.day,runtime.memory.today()));
    case 'memory-import': {
      if(typeof args.document!=='string')throw new Error('请选择记忆文件');
      return runtime.enqueue(async()=>importMemory(runtime.memory,text(args.scope,'owner'),args.target==='today'?'today':'all',args.document as string,args.fileType==='text'?'text':'json'));
    }
    case 'usage': return dailyUsage(runtime.memory,text(args.day,runtime.memory.today()));
    case 'media-check': return checkMediaTools(runtime.settings.media);
    case 'update-status': return runtime.updates.view();
    case 'update-check': return runtime.updates.check();
    case 'update-install': return runtime.updates.start(text(args.version));
    case 'save': return runtime.save(args.settings,text(args.revision),text(args.token));
    case 'qq-check': return runtime.enqueue(() => runtime.qq.check());
    case 'bili-check': return runtime.enqueue(() => runtime.bili.account(signal));
    case 'bili-start': return runtime.enqueue(() => runtime.startLogin(signal));
    case 'bili-poll': return runtime.enqueue(() => runtime.pollLogin(text(args.ticket)));
    case 'bili-logout': return runtime.enqueue(async () => { runtime.logoutBili(); return { success: true }; });
    case 'models': {
      const llm = runtime.ctx.get('llm');
      if (!llm) return { providers: [], models: [] };
      const provider = text(args.provider);
      return { providers: llm.listProviders().map(p => ({ id: p.id, name: p.name || p.id })), models: provider ? (await llm.listModels(provider)).map(m => ({ id: m.id, name: m.name || m.id, inputModalities: m.inputModalities })) : [] };
    }
    case 'memory-list': return runtime.memory.list(text(args.scope,'owner'),text(args.day,runtime.memory.today()),typeof args.before === 'number' ? args.before : 0);
    case 'memory-search': return { hits: runtime.memory.search(text(args.scope,'owner'),text(args.query),args.range === 'today' ? 'today' :args.range==='all'?'all': 'history',args.day ? text(args.day) : undefined) };
    case 'memory-detail': return runtime.memory.detail(text(args.scope,'owner'),text(args.id),typeof args.offset === 'number' ? args.offset : 0);
    case 'memory-remove': return runtime.enqueue(async () => { runtime.memory.remove(text(args.scope,'owner'),text(args.id)); return { success: true }; });
    case 'memory-restore': return runtime.enqueue(async () => { runtime.memory.restore(text(args.scope,'owner'),text(args.id)); return { success: true }; });
    default: throw new Error('未知的拾光面板操作');
  }
}
export function registerPanelApi(ctx: Context, runtime: ShiguangRuntime): void {
  // The exact route inherits DSH authentication, CSRF/Host checks, owner-only
  // access and Desktop transport. It opens no additional network port.
  ctx.inject(['connection'], scoped => {
    scoped.effect(() => scoped.connection.fetch.register({
      path: '/api/shiguang', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        let rpcId = '';
        try {
          if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return new Response('需要 JSON 请求',{status:415});
          const body = await request.text();
          if (body.length > 3*1024*1024) return new Response('请求内容过长',{status:413});
          const envelope = object(JSON.parse(body)); rpcId = text(envelope.rpcId);
          if (envelope.type !== 'client-request' || envelope.method !== 'shiguang' || !rpcId || rpcId.length > 128) return new Response('无效的 RPC 请求',{status:400});
          const command = object(envelope.payload);
          const value = await panelAction(runtime,text(command.action),command.args,request.signal);
          return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } },{headers:{'Cache-Control':'no-store'}});
        } catch (error) {
          return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'shiguang/action-failed', message: error instanceof SyntaxError ? '请求 JSON 格式无效' : error instanceof Error ? error.message : '操作未完成，请重试', details: {} } } },{headers:{'Cache-Control':'no-store'}});
        }
      },
    }),'shiguang: settings API');
  });
}
