import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {LlmAdapter,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit';
import {MemoryStore} from '../src/memory.js';
import {BilibiliClient,tagsAllowed,wbiQuery} from '../src/bilibili.js';
import {Autonomy,dueWake,parsePlan,publicTextAllowed} from '../src/autonomy.js';
import {dailyUsage} from '../src/usage.js';
import {fixture} from './helpers.js';

const good='BV1xx411c7mD',bad='BV1xx411c7mE',other='BV1xx411c7mF';
function platform(){
 const calls:{url:string;init?:RequestInit}[]=[];let failDynamic=false;
 const fetcher:typeof fetch=async(url,init)=>{
  const u=new URL(String(url));calls.push({url:String(url),init});let data:unknown;
  if(u.pathname.endsWith('/spi'))data={b_3:'fake-buvid'};
  else if(u.pathname.endsWith('/nav'))data={isLogin:true,wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/bfs/wbi/'+'b'.repeat(32)+'.png'}};
  else if(u.pathname.includes('search/type')){assert.match(u.search,/w_rid=[a-f0-9]{32}/);assert.match(String(new Headers(init?.headers).get('cookie')),/buvid3=/);data={result:[{bvid:bad,title:'黑名单不能交给模型'},{bvid:other},{bvid:good}]};}
  else if(u.pathname.includes('/tags')){const id=u.searchParams.get('bvid');data=(id===bad?['科技','广告']:id===other?['生活']:['科技']).map(tag_name=>({tag_name}));}
  else if(u.pathname.endsWith('/view')){assert.equal(u.searchParams.get('bvid'),good);data={aid:123,bvid:good,title:'科技新发现',desc:'介绍一个有用的小知识',owner:{name:'作者'}};}
  else if(u.pathname.endsWith('/reply/add'))data={rpid_str:'7001'};
  else if(u.pathname.includes('/create/dyn')){if(failDynamic)throw new TypeError('mock connection lost');const body=JSON.parse(String(init?.body));assert.equal(body.dyn_req.scene,1);assert.ok(body.dyn_req.content.contents[0].raw_text);data={dyn_id_str:'9001'};}
  else throw new Error('Unexpected mock URL '+u.pathname);
  return Response.json({code:0,data});
 };
 return {calls,fetcher,setFail:()=>{failDynamic=true;}};
}
function configure(f:ReturnType<typeof fixture>){
 Object.assign(f.settings.bilibili,{enabled:true,allowedTags:['科技'],blockedTags:['广告'],allowComments:true,allowDynamics:true});Object.assign(f.settings.autonomy,{enabled:true,chooseBrowsing:false,autoComment:true,autoDynamic:true});f.settings.provider='deepseek-official';f.settings.model='scripted';writeFileSync(join(f.dir,'bilibili.cookies.json'),JSON.stringify({SESSDATA:'fake-session',bili_jct:'fake-csrf'}));
}
class Planner extends LlmAdapter{
 requests:GenerateOptions[]=[];
 constructor(readonly plan:object){super();}
 async *stream(o:GenerateOptions):AsyncIterable<StreamChunk>{this.requests.push(o);const text=JSON.stringify(this.plan);yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'usage',usage:{inputTokens:300,outputTokens:80}};yield {type:'finish',reason:{kind:'stop'}};}
}
test('真实标签白黑名单优先级与 WBI 签名固定向量',()=>{
 assert.equal(tagsAllowed(['科技','广告'],['科技'],['广告']),false);assert.equal(tagsAllowed(['生活'],['科技'],[]),false);assert.equal(tagsAllowed(['AI'],['#ai#'],[]),true);
 const q=wbiQuery({foo:'114',bar:'514',zab:'1919810'},'7cd084941338484aae1ad9425b84077c','4932caff0ff746eab6f01bf08b70ac45',1702204169000);assert.match(q,/w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4$/);
 assert.equal(dueWake(['09:00','15:00'],Date.parse('2026-11-07T09:10:00Z'),'UTC'),'09:00');assert.equal(dueWake(['09:00'],Date.parse('2026-11-07T09:16:00Z'),'UTC'),undefined);
 assert.throws(()=>parsePlan(JSON.stringify({reason:'发评论',dynamic:null,comment:{bvid:bad,text:'你好'}}),new Set([good])),/范围/);assert.equal(publicTextAllowed('手机号 13800138000'),false);
});
test('搜索候选不进模型，真实标签筛选后只读取允许的视频；动态需要回执，未知结果占额度且不重发',async()=>{
 const f=fixture();configure(f);const m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory),p=platform(),bili=new BilibiliClient(f.settings,m,p.fetcher);
 try{
  const list=await bili.browse();assert.deepEqual(list.map(v=>v.bvid),[good]);assert.equal(p.calls.filter(c=>c.url.includes('/view')).length,1);assert.ok(p.calls.some(c=>c.url.includes('/tags?bvid='+bad)));
  assert.equal((await bili.dynamic('今天发现一个科技小知识')).id,'9001');assert.match(m.fastContext('owner','p').todayNotes,/已发布文字动态/);
  await assert.rejects(bili.dynamic('今天发现一个科技小知识'),/已提交/);
 }finally{m.close();f.cleanup();}
 const g=fixture();configure(g);const n=new MemoryStore(':memory:',g.settings.roleId,'UTC',g.settings.memory),z=platform();z.setFail();const api=new BilibiliClient(g.settings,n,z.fetcher);
 try{await assert.rejects(api.dynamic('未知结果测试'),/结果未知/);await assert.rejects(api.dynamic('未知结果测试'),/已提交/);assert.equal(z.calls.filter(c=>c.url.includes('/create/dyn')).length,1);assert.equal(n.db.prepare("SELECT status FROM actions WHERE kind='bili-dynamic'").get()?.status,'unknown');}finally{n.close();g.cleanup();}
 for(const data of [{dyn_id_str:'0'},{dyn_id_str:'123',need_captcha:true}]){
  const h=fixture();configure(h);const db=new MemoryStore(':memory:',h.settings.roleId,'UTC',h.settings.memory),client=new BilibiliClient(h.settings,db,async()=>Response.json({code:0,data}));
  try{await assert.rejects(client.dynamic('需要核实的回执'),/没有返回动态 ID|要求验证/);assert.equal(db.db.prepare("SELECT status FROM actions WHERE kind='bili-dynamic'").get()?.status,'unknown');}finally{db.close();h.cleanup();}
 }
});
test('自主醒来一次：真实 DSH 思考、允许视频评论和文字动态、共享记忆与用量；同一时段不重复',async()=>{
 const f=fixture();configure(f);const ctx=new Context(),m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory),p=platform(),bili=new BilibiliClient(f.settings,m,p.fetcher),planner=new Planner({reason:'分享公开见闻',dynamic:'今天从视频介绍发现一个科技知识。',comment:{bvid:good,text:'这个主题很有意思，谢谢介绍。'}});let auto:Autonomy|undefined;
 try{
  await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);ctx.llm.registerAdapter(['deepseek-official'],planner);m.append('owner','qq','p','note','私有灵感默认不提供');m.append('owner','bilibili','bilibili','experience','导入的未审核内容','import:fixture');
  auto=new Autonomy(ctx,f.settings,m,bili,async run=>run(),()=>{});await auto.run('09:00');await auto.run('09:00');assert.equal(planner.requests.length,1);assert.doesNotMatch(JSON.stringify(planner.requests[0]?.messages),/黑名单不能|私有灵感|未审核内容/);assert.equal(planner.requests[0]?.tools,undefined);
  assert.equal(p.calls.filter(c=>c.url.includes('/reply/add')).length,1);assert.equal(p.calls.filter(c=>c.url.includes('/create/dyn')).length,1);assert.match(m.fastContext('owner','p').todayNotes,/科技新发现/);assert.equal(auto.status().todayRuns,1);assert.equal(dailyUsage(m).categories.find(c=>c.category==='bilibili-auto')?.total,380);
  assert.ok(m.search('owner','分享公开见闻','today').some(hit=>hit.platform==='dsh'));
  f.settings.bilibili.commentsPerDay=1;f.settings.bilibili.dynamicsPerDay=1;bili.browse=async()=>[{aid:'123',bvid:good,title:'科技新发现',description:'介绍',owner:'作者',url:'https://www.bilibili.com/video/'+good,tags:['科技']}];await auto.run('15:00');assert.equal(auto.status().runs[0]?.status,'done');assert.equal(p.calls.filter(c=>c.init?.method==='POST').length,2);
  assert.doesNotMatch(JSON.stringify(planner.requests[1]?.messages),/分享公开见闻/);
 }finally{auto?.stop();await ctx.fiber.dispose();m.close();f.cleanup();}
});
test('公开草稿有私人信息时先阻止所有发布；模型越权目标同样不执行',async()=>{
 for(const plan of [{reason:'分享',dynamic:'手机号 13800138000',comment:{bvid:good,text:'谢谢'}},{reason:'分享',dynamic:null,comment:{bvid:bad,text:'越权'}}]){
  const f=fixture();configure(f);const ctx=new Context(),m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory),p=platform(),bili=new BilibiliClient(f.settings,m,p.fetcher);let auto:Autonomy|undefined;
  try{await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);ctx.llm.registerAdapter(['deepseek-official'],new Planner(plan));auto=new Autonomy(ctx,f.settings,m,bili,async run=>run(),()=>{});await assert.rejects(auto.run(),/阻止发布|范围/);assert.equal(p.calls.filter(c=>c.init?.method==='POST').length,0);assert.equal(auto.status().runs[0]?.status,'failed');}
  finally{auto?.stop();await ctx.fiber.dispose();m.close();f.cleanup();}
 }
});
test('夏令时重复时段和进程重启不重复醒来；手动执行计入每日上限',async()=>{
 const f=fixture();configure(f);f.settings.timezone='America/New_York';f.settings.autonomy.wakeTimes=['01:30'];f.settings.autonomy.maxRunsPerDay=1;let now=Date.parse('2026-11-01T05:35:00Z'),m=new MemoryStore(join(f.dir,'m.sqlite'),f.settings.roleId,f.settings.timezone,f.settings.memory,()=>now);const ctx=new Context();let auto:Autonomy|undefined;
 try{
  let browses=0;const create=()=>{const bili=new BilibiliClient(f.settings,m);bili.browse=async()=>{browses++;return [];};return new Autonomy(ctx,f.settings,m,bili,async run=>run(),()=>{});};
  auto=create();await auto.tick();assert.equal(browses,1);auto.stop();m.close();now=Date.parse('2026-11-01T06:35:00Z');m=new MemoryStore(join(f.dir,'m.sqlite'),f.settings.roleId,f.settings.timezone,f.settings.memory,()=>now);auto=create();await auto.tick();assert.equal(browses,1);await assert.rejects(auto.run(),/额度已用完/);assert.equal(dailyUsage(m).total.calls,0);
 }finally{auto?.stop();await ctx.fiber.dispose();m.close();f.cleanup();}
});
test('停止正在思考的自主任务，不排队等思考结束，不执行后续发布',async()=>{
 const f=fixture();configure(f);const ctx=new Context(),m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory),p=platform();let auto:Autonomy|undefined,started:()=>void=()=>{};const ready=new Promise<void>(r=>{started=r;});
 class Waiting extends LlmAdapter{async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{started();await new Promise((_,reject)=>{if(options.signal?.aborted)return reject(new Error('cancelled'));options.signal?.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});yield {type:'finish',reason:{kind:'stop'}};}}
 try{await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);ctx.llm.registerAdapter(['deepseek-official'],new Waiting());auto=new Autonomy(ctx,f.settings,m,new BilibiliClient(f.settings,m,p.fetcher),async run=>run(),()=>{});const task=auto.run();await ready;auto.cancelCurrent();await assert.rejects(task,/未完整返回|abort|cancelled/);assert.equal(p.calls.filter(c=>c.init?.method==='POST').length,0);assert.equal(auto.status().runs[0]?.status,'failed');}
 finally{auto?.stop();await ctx.fiber.dispose();m.close();f.cleanup();}
});
