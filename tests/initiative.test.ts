import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {LlmAdapter,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit';
import {writeFileSync} from 'node:fs';import {join} from 'node:path';
import {MemoryStore} from '../src/memory.js';import {BilibiliClient,losslessJSON} from '../src/bilibili.js';
import {Proactive,chooseMotive} from '../src/proactive.js';import {BiliSocial} from '../src/bili-social.js';
import {quietAt,stateValue,setState} from '../src/initiative.js';import {Autonomy} from '../src/autonomy.js';
import {BodyClock} from '../src/body-clock.js';
import {ChatDriver} from '../src/agent.js';import type {OneBotClient} from '../src/onebot.js';import type {BiliVision} from '../src/bili-vision.js';
import {dailyUsage} from '../src/usage.js';import {fixture} from './helpers.js';
class Planner extends LlmAdapter{
 requests:GenerateOptions[]=[];constructor(readonly script:(i:number)=>unknown){super();}
 async *stream(o:GenerateOptions):AsyncIterable<StreamChunk>{this.requests.push(o);const text=typeof this.script(this.requests.length-1)==='string'?String(this.script(this.requests.length-1)):JSON.stringify(this.script(this.requests.length-1));yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'usage',usage:{inputTokens:100,outputTokens:30}};yield {type:'finish',reason:{kind:'stop'}};}
}
async function harness(f:ReturnType<typeof fixture>,planner:Planner){const ctx=new Context();f.settings.provider='initiative-test';f.settings.model='script';f.settings.timezone='UTC';await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);ctx.llm.registerAdapter(['initiative-test'],planner);return ctx;}
function login(f:ReturnType<typeof fixture>){f.settings.bilibili.enabled=true;writeFileSync(join(f.dir,'bilibili.cookies.json'),JSON.stringify({SESSDATA:'fake-session',bili_jct:'fake-csrf'}));}
const keys={img_url:'https://i0.hdslb.com/bfs/wbi/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/bfs/wbi/'+'b'.repeat(32)+'.png'};
const good='BV1xx411c7mD',other='BV1xx411c7mE';
test('跨午夜免打扰按时区计算；动机权重为 0 不会被抽中',()=>{
 const f=fixture();try{Object.assign(f.settings.proactive,{company:0,care:0,share:100,play:0,chat:0});for(const n of [0,.25,.99999])assert.equal(chooseMotive(f.settings.proactive,()=>n),'share');assert.equal(quietAt(Date.parse('2026-11-07T16:00Z'),'Asia/Shanghai','23:00','08:00'),true);assert.equal(quietAt(Date.parse('2026-11-07T04:00Z'),'Asia/Shanghai','23:00','08:00'),false);assert.equal(quietAt(Date.now(),'UTC','00:00','00:00'),false);}finally{f.cleanup();}
});
for(const send of [true,false])test(`QQ 主动联系：${send?'只发主人，未回复不重复，沉默不调用模型':'模型可选择安静，计思考用量但不占发送额度'}`,async()=>{
 const f=fixture(),model=new Planner(()=>({send,text:send?'今天想陪你聊聊。':null,reason:'尊重主人的节奏'})),ctx=await harness(f,model);let now=Date.parse('2026-11-07T12:00Z');const memory=new MemoryStore(join(f.dir,'memory.sqlite'),f.settings.roleId,'UTC',f.settings.memory,()=>now),targets:string[]=[];
 Object.assign(f.settings.qq,{enabled:true,ownerQQ:'10001'});Object.assign(f.settings.proactive,{enabled:true,contextChars:200});
 const qq={status:()=>({state:'connected'}),check:async()=>({online:true,userId:'10002'}),send:async(m:any)=>{targets.push(m.userId);}} as unknown as OneBotClient;
 let p=new Proactive(ctx,f.settings,memory,qq,async run=>run(),()=>{},()=>0);
 try{memory.append('owner','qq','p','note','今天想分享吉他');memory.append('owner','qq','p','note','昨天秘密不带入',undefined,now-86400000);
 await p.run();assert.equal(model.requests.length,1);assert.doesNotMatch(JSON.stringify(model.requests[0]?.messages),/昨天秘密/);assert.equal(dailyUsage(memory).categories[0]?.category,'qq-proactive');assert.equal(p.status().sentToday,send?1:0);assert.deepEqual(targets,send?['10001']:[]);
 now+=5*3600000;p.stop();p=new Proactive(ctx,f.settings,memory,qq,async run=>run(),()=>{},()=>0);
 if(send){await p.run();assert.equal(model.requests.length,1);setState(memory,'qq:last-owner',now);now+=11*60000;await p.run();assert.equal(targets.length,2);}
 f.settings.proactive.activity='silent';const count=model.requests.length;await p.run();assert.equal(model.requests.length,count);
 }finally{p.stop();await ctx.fiber.dispose();memory.close();f.cleanup();}
});
test('QQ 未知发送结果占额度且重启后未回复不再发送；限额与免打扰无模型请求',async()=>{
 const f=fixture(),model=new Planner(()=>({send:true,text:'想分享今天的小事',reason:'分享'})),ctx=await harness(f,model);let now=Date.parse('2026-11-07T12:00Z');const m=new MemoryStore(join(f.dir,'m.sqlite'),f.settings.roleId,'UTC',f.settings.memory,()=>now);let sends=0;
 Object.assign(f.settings.qq,{enabled:true,ownerQQ:'10001'});f.settings.proactive.enabled=true;
 const qq={status:()=>({state:'connected'}),check:async()=>({online:true,userId:'10002'}),send:async()=>{sends++;throw Error('unknown send');}} as unknown as OneBotClient;
 f.settings.clock.enabled=true;let p=new Proactive(ctx,f.settings,m,qq,async r=>r(),()=>{},Math.random,()=>new BodyClock(f.settings,m).canAct());
 try{await assert.rejects(p.run(),/unknown/);assert.equal(m.actionQuota('qq-proactive').today,1);assert.equal(m.db.prepare("SELECT status FROM actions WHERE kind='qq-proactive'").get()?.status,'unknown');p.stop();now+=3600000;p=new Proactive(ctx,f.settings,m,qq,async r=>r(),()=>{},Math.random,()=>new BodyClock(f.settings,m).canAct());await p.run();assert.equal(sends,1);f.settings.proactive.waitForReply=false;f.settings.proactive.maxPerDay=1;await p.run();assert.equal(model.requests.length,1);f.settings.proactive.maxPerDay=4;now=Date.parse('2026-11-07T23:30Z');await p.run();assert.equal(model.requests.length,1);}finally{p.stop();await ctx.fiber.dispose();m.close();f.cleanup();}
});
test('B 站自由醒来由意愿选取视频和深度；跳过的候选不识别不发布，下次间隔持久化',async()=>{
 const f=fixture(),model=new Planner(i=>i===0?{choices:[{bvid:good,depth:'deep'}],reason:'想细看这个知识',nextWakeMinutes:90}:{reason:'先记下来',dynamic:null,comment:null,recommend:null}),ctx=await harness(f,model),now=Date.parse('2026-11-07T12:00Z'),m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory,()=>now);login(f);
 Object.assign(f.settings.autonomy,{enabled:true,scheduleMode:'free',allowDeep:true});f.settings.bilibili.allowedTags=['科技'];Object.assign(f.settings.biliVision,{enabled:true,autoBrowse:true});const bili=new BilibiliClient(f.settings,m);bili.browse=async()=>[good,other].map(bvid=>({aid:'1',bvid,title:bvid,description:'真实介绍',tags:['科技'],owner:'作者',url:'https://www.bilibili.com/video/'+bvid}));const watched:string[]=[];
 const vision={watch:async(bvid:string,_q:any,_p:any,_s:any,depth:string)=>{watched.push(bvid+':'+depth);return '实际识别到的抽样画面与字幕';}} as unknown as BiliVision;const a=new Autonomy(ctx,f.settings,m,bili,async r=>r(),()=>{},vision);
 try{await a.run();assert.deepEqual(watched,[good+':deep']);assert.equal(model.requests.length,2);assert.doesNotMatch(JSON.stringify(model.requests[1]?.messages),new RegExp(other));assert.equal(stateValue(m,'bili:next',0),now+90*60000);assert.match(String(a.status().runs[0]?.summary),/1 个分段细看/);await a.tick();assert.equal(a.status().todayRuns,1);}finally{a.stop();await ctx.fiber.dispose();m.close();f.cleanup();}
});
test('B 站可决定本轮全部跳过，不再调用发布思考；禁止深看时模型不能越权',async()=>{
 for(const deep of [false,true]){const f=fixture(),model=new Planner(()=>({choices:deep?[{bvid:good,depth:'deep'}]:[],reason:'想休息',nextWakeMinutes:60})),ctx=await harness(f,model),m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory);login(f);f.settings.autonomy.enabled=true;f.settings.bilibili.allowedTags=['科技'];const b=new BilibiliClient(f.settings,m);b.browse=async()=>[{aid:'1',bvid:good,title:'主题',description:'简介',tags:['科技'],owner:'作者',url:'url'}];const a=new Autonomy(ctx,f.settings,m,b,async r=>r(),()=>{});
 try{if(deep)await assert.rejects(a.run(),/未获授权/);else{await a.run();assert.match(String(a.status().runs[0]?.summary),/跳过/);}assert.equal(model.requests.length,1);}finally{a.stop();await ctx.fiber.dispose();m.close();f.cleanup();}}
});
test('B 站私信保留 64 位消息序号，只读取白名单主人新文字；撤回、其他人、系统消息不回复',async()=>{
 const f=fixture();login(f);Object.assign(f.settings.biliSocial,{dmEnabled:true,ownerUids:['10001']});const m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory);let calls=0;
 const b=new BilibiliClient(f.settings,m,async()=>{calls++;return new Response('{"code":0,"data":{"max_seqno":9007199254740995,"has_more":0,"messages":['+[
 '{"msg_seqno":9007199254740993,"sender_uid":10001,"receiver_type":1,"msg_type":1,"msg_status":0,"content":"{\\"content\\":\\"新消息\\"}"}',
 '{"msg_seqno":9007199254740994,"sender_uid":10001,"receiver_type":1,"msg_type":1,"msg_status":1,"content":"{\\"content\\":\\"已撤回\\"}"}',
 '{"msg_seqno":9007199254740995,"sender_uid":10003,"receiver_type":1,"msg_type":1,"msg_status":0,"content":"{\\"content\\":\\"别人\\"}"}'].join(',')+']}}');});
 try{assert.deepEqual(losslessJSON('{"n":9007199254740993,"text":"1234567890123456789","negative":-9007199254740993}'),{n:'9007199254740993',text:'1234567890123456789',negative:'-9007199254740993'});await assert.rejects(b.directMessages('10003'),/白名单/);assert.equal(calls,0);assert.deepEqual(await b.directMessages('10001'),{seq:'9007199254740995',messages:[]});assert.deepEqual((await b.directMessages('10001','9007199254740992')).messages,[{seq:'9007199254740993',text:'新消息'}]);}finally{m.close();f.cleanup();}
});
test('B 站私信使用 WBI、CSRF 与真实消息回执，@ 主人提交昵称 UID 映射；结果未知不重发',async()=>{
 const f=fixture();login(f);Object.assign(f.settings.biliSocial,{dmEnabled:true,ownerUids:['10001'],minReplySeconds:0});f.settings.bilibili.allowComments=true;f.settings.autonomy.recommendOwner=true;const m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory);let posts=0,fail=false;
 const b=new BilibiliClient(f.settings,m,async(url,init)=>{const u=new URL(String(url));const json=(data:unknown)=>Response.json({code:0,data});if(u.pathname.endsWith('/nav'))return json({isLogin:true,mid:10002,uname:'伙伴',wbi_img:keys});if(u.pathname.endsWith('/info'))return json({name:'主人昵称'});if(u.pathname.endsWith('/view'))return json({aid:1,bvid:good,title:'有趣的视频',owner:{name:'作者'}});if(init?.method==='POST'){posts++;const form=new URLSearchParams(String(init.body));if(u.pathname.endsWith('/send_msg')){assert.match(u.search,/w_rid=[a-f0-9]{32}/);assert.equal(form.get('msg[receiver_id]'),'10001');assert.equal(form.get('csrf_token'),'fake-csrf');if(fail)throw Error('connection lost');return new Response('{"code":0,"data":{"msg_key":9007199254740993}}');}assert.deepEqual(JSON.parse(form.get('at_name_to_mid')!),{'主人昵称':'10001'});assert.match(form.get('message')!,/@主人昵称/);return json({rpid_str:'12345'});}throw Error('unexpected '+u.pathname);});
 try{assert.equal(await b.sendDirect('10001','你好','1'),'9007199254740993');await assert.rejects(b.sendDirect('10001','你好','1'),/已提交/);await b.recommend(good,'这个细节想分享给你');assert.equal(posts,2);fail=true;await assert.rejects(b.sendDirect('10001','新私信','2'),/结果未知/);await assert.rejects(b.sendDirect('10001','新私信','2'),/已提交/);assert.equal(posts,3);}finally{m.close();f.cleanup();}
});
test('真实 AgentLoop 回复 B 站主人私信：首次不补旧消息，共享当天记忆，重启游标不重复生成或发送',async()=>{
 const f=fixture(),model=new Planner(()=> '记得，你今天练了吉他。'),ctx=await harness(f,model),path=join(f.dir,'m.sqlite');login(f);Object.assign(f.settings.biliSocial,{dmEnabled:true,ownerUids:['10001'],minReplySeconds:0});let m=new MemoryStore(path,f.settings.roleId,'UTC',f.settings.memory),phase=0,sends=0,driver:ChatDriver|undefined,social:BiliSocial|undefined;
 const fetcher:typeof fetch=async(url,init)=>{const u=new URL(String(url)),json=(data:unknown)=>Response.json({code:0,data});if(u.pathname.endsWith('/nav'))return json({isLogin:true,mid:10002,uname:'伙伴',wbi_img:keys});if(u.pathname.endsWith('/fetch_session_msgs')){const after=u.searchParams.get('begin_seqno');return json({max_seqno:phase?'12':'10',has_more:0,messages:phase&&after!=='12'?[{sender_uid:10001,receiver_type:1,msg_type:1,msg_status:0,msg_seqno:12,content:JSON.stringify({content:'今天练了什么？'})}]:[]});}if(u.pathname.endsWith('/send_msg')){sends++;return json({msg_key:'2222'});}throw Error('unexpected '+u.pathname);};
 const create=()=>{const b=new BilibiliClient(f.settings,m,fetcher);driver=new ChatDriver(ctx,f.settings,m,b);return new BiliSocial(f.settings,m,b,driver,async r=>r(),()=>{});};
 try{m.append('owner','qq','p','note','今天练了吉他');social=create();await social.poll();assert.equal(model.requests.length,0);phase=1;await social.poll();assert.equal(sends,1);assert.match(JSON.stringify(model.requests[0]?.messages),/今天练了吉他/);assert.equal(dailyUsage(m).categories[0]?.category,'bilibili-dm');social.stop();await driver?.stop();m.close();m=new MemoryStore(path,f.settings.roleId,'UTC',f.settings.memory);social=create();await social.poll();assert.equal(model.requests.length,1);assert.equal(sends,1);assert.equal(social.status().processed,1);}finally{social?.stop();await driver?.stop();await ctx.fiber.dispose();m.close();f.cleanup();}
});
