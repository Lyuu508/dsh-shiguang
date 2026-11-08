import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type { ShiguangRuntime } from './runtime.js';
import { dailyUsage,saveProviderBill } from './usage.js';
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
    case 'role-create':return runtime.createRole(text(args.name),text(args.persona),args.copy===true,text(args.revision));
    case 'role-switch':return runtime.switchRole(text(args.id),text(args.revision));
    case 'memory-concepts':return runtime.memory.concepts(text(args.scope,'owner'),text(args.query));
    case 'memory-concept-save':return runtime.enqueue(async()=>{runtime.memory.setConcept(text(args.scope,'owner'),text(args.term),Number(args.weight),args.pinned===true);return {ok:true};});
    case 'memory-remember':return runtime.enqueue(async()=>{runtime.memory.remember(text(args.id),args.pinned===true);return {ok:true};});
    case 'memory-sweep':return runtime.enqueue(async()=>runtime.memory.sweep());
    case 'load': return { ...runtime.view(), status: runtime.status() };
    case 'status': return runtime.status();
    case 'model-status':return runtime.modelStatus();
    case 'local-locate':return runtime.locateLocal();
    case 'qq-setup':return runtime.startQQSetup();
    case 'qq-setup-status':return {...runtime.qqSetup};
    case 'qq-auto-connect':await runtime.syncQQConnection();return {ok:true};
    case 'snowluma-credential':return runtime.snowluma.credential();
    case 'snowluma-open-backend':return runtime.snowluma.openBackend();
    case 'snowluma-status':return runtime.snowluma.view();
    case 'snowluma-start':return runtime.snowluma.start();
    case 'snowluma-qq':return runtime.snowluma.openQQ();
    case 'snowluma-console':return runtime.snowluma.consoleUrl();
    case 'voice-key':return runtime.enqueue(()=>runtime.saveVoiceSecret(text(args.secret)));
    case 'voice-status':return runtime.voice.status();
    case 'voice-test':return runtime.enqueue(async()=>{const result=await runtime.voice.synthesize(text(args.text),'owner',signal);return {audio:'data:audio/mpeg;base64,'+result.bytes.toString('base64'),chars:result.chars,billedChars:result.billedChars,reused:result.reused,status:runtime.voice.status()};});
    case 'bili-watch':return runtime.startWatch(text(args.video),text(args.question,'概括视频里的主要内容'),typeof args.part==='number'?args.part:1,args.depth==='deep'?'deep':'shallow');
    case 'watch-status':return {...runtime.watchJob};
    case 'watch-cancel':return runtime.cancelWatch();
    case 'bili-dm-poll':return runtime.biliSocial.requestPoll();
    case 'proactive-now':return runtime.proactive.consider();
    case 'proactive-cancel':runtime.proactive.cancel();return runtime.proactive.status();
    case 'auto-status':return runtime.autonomy.status();
    case 'wake-now':return runtime.autonomy.wake();
    case 'wake-cancel':runtime.autonomy.cancelCurrent();return runtime.autonomy.status();
    case 'memory-export':return exportMemoryPage(runtime.memory,text(args.scope,'owner'),args.range==='today'?'today':'all',typeof args.after==='number'?args.after:0,typeof args.snapshot==='number'?args.snapshot:undefined,text(args.day,runtime.memory.today()));
    case 'memory-import': {
      if(typeof args.document!=='string')throw new Error('请选择记忆文件');
      return runtime.enqueue(async()=>importMemory(runtime.memory,text(args.scope,'owner'),args.target==='today'?'today':'all',args.document as string,args.fileType==='text'?'text':args.fileType==='jsonl'?'jsonl':'json'));
    }
    case 'usage-recover':return runtime.recoverUsage(text(args.day,runtime.memory.today()));
    case 'usage-recover-status':return {...runtime.usageRecovery};
    case 'usage': return dailyUsage(runtime.memory,text(args.day,runtime.memory.today()),args.scope==='dsh'?'dsh':'plugin');
    case 'usage-bill-save':return saveProviderBill(runtime.memory,text(args.day),{label:text(args.label),totalTokens:Number(args.totalTokens),calls:args.calls===undefined?undefined:Number(args.calls),amount:text(args.amount)});
    case 'media-check': return runtime.mediaTools.check();
    case 'media-tools-status':return runtime.mediaTools.view();
    case 'media-tools-install':return runtime.mediaTools.start();
    case 'media-tools-pause':return runtime.mediaTools.pause();
    case 'update-status': return runtime.updates.view();
    case 'update-check': return runtime.updates.beginCheck();
    case 'update-cancel':return runtime.updates.cancel();
    case 'update-install': return runtime.updates.start(text(args.version));
    case 'save': return runtime.save(args.settings,text(args.revision),text(args.token));
    case 'qq-check':await runtime.syncQQConnection();return runtime.enqueue(async()=>{await runtime.qq.ready();return runtime.qq.check();});
    case 'owner-bili-start':return runtime.enqueue(()=>runtime.startLogin(signal,'owner'));
    case 'owner-bili-poll':return runtime.enqueue(()=>runtime.pollOwnerLogin(text(args.ticket)));
    case 'owner-bili-check':return runtime.enqueue(()=>runtime.ownerBili.account(signal));
    case 'owner-bili-logout':return runtime.enqueue(async()=>{runtime.logoutOwnerBili();return {ok:true};});
    case 'owner-interests-start':return runtime.startInterestScan(typeof args.count==='number'?args.count:30);
    case 'owner-interests-status':return {...runtime.interestJob};
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
    case 'memory-timeline':return (args.paired===false?runtime.memory.timeline.bind(runtime.memory):runtime.memory.conversationPage.bind(runtime.memory))({state:text(args.state,'active'),scope:text(args.scope,'*'),platform:text(args.platform,'all'),channel:text(args.channel,'all'),category:text(args.category,'all'),day:text(args.day,runtime.memory.today()),query:text(args.query),before:typeof args.before==='number'?args.before:0,beforeTime:typeof args.beforeTime==='number'?args.beforeTime:0});
    case 'memory-list': return runtime.memory.list(text(args.scope,'owner'),text(args.day,runtime.memory.today()),typeof args.before === 'number' ? args.before : 0);
    case 'memory-search': return { hits: runtime.memory.search(text(args.scope,'owner'),text(args.query),args.range === 'today' ? 'today' :args.range==='all'?'all': 'history',args.day ? text(args.day) : undefined) };
    case 'memory-detail': return runtime.memory.detail(text(args.scope,'owner'),text(args.id),typeof args.offset === 'number' ? args.offset : 0,true,undefined,true);
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
