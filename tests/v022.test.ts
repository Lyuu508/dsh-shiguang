import test from 'node:test';
import assert from 'node:assert/strict';
import {once,EventEmitter} from 'node:events';
import {writeFileSync,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {LlmAdapter,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit';
import {WebSocketServer,type WebSocket} from 'ws';
import type {ChildProcess} from 'node:child_process';
import {QQConversation} from '../src/qq-conversation.js';
import {OneBotClient,parseMessage} from '../src/onebot.js';
import {ShiguangRuntime} from '../src/runtime.js';
import {MemoryStore} from '../src/memory.js';
import {BilibiliClient,weightedTag} from '../src/bilibili.js';
import {BiliBrowser,biliBrowseIntent} from '../src/bili-browser.js';
import type {BiliVision} from '../src/bili-vision.js';
import {saveSlang,listSlang,deleteSlang,recallSlang,parseSlangLesson} from '../src/slang.js';
import {ChatDriver} from '../src/agent.js';
import {fixture} from './helpers.js';
import {SnowLumaManager} from '../src/snowluma.js';
const wait=async(check:()=>boolean,ms=5000)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw Error('fixture timeout');await new Promise(r=>setTimeout(r,5));}};
const video={aid:'123',bvid:'BV1xx411c7mD',title:'水獭的小石头',owner:'作者',description:'水獭用石头敲贝壳',url:'https://www.bilibili.com/video/BV1xx411c7mD',tags:['动物']};
class Model extends LlmAdapter{
 requests:GenerateOptions[]=[];
 async *stream(o:GenerateOptions):AsyncIterable<StreamChunk>{this.requests.push(o);const text='看到了水獭拿石头敲贝壳，抱着小石头的样子很有趣。'+video.url;yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'usage',usage:{inputTokens:100,outputTokens:30,totalTokens:130}};yield {type:'finish',reason:{kind:'stop'}};}
}
async function platform(){
 const ws=new WebSocketServer({host:'127.0.0.1',port:0});await once(ws,'listening');const a=ws.address();assert.ok(a&&typeof a==='object');let connections=0;const sent:string[]=[];let socket:WebSocket;
 ws.on('connection',s=>{connections++;socket=s;s.on('message',raw=>{const r=JSON.parse(raw.toString());if(r.action.startsWith('send_'))sent.push(r.params.message[0].data.text);s.send(JSON.stringify({status:'ok',retcode:0,echo:r.echo,data:r.action==='get_status'?{online:true}:r.action==='get_login_info'?{user_id:2,nickname:'伙伴'}:{message_id:100+sent.length}}));});});
 return {ws,url:`ws://127.0.0.1:${a.port}/`,sent,connections:()=>connections,socket:()=>socket!,async close(){for(const s of ws.clients)s.terminate();await new Promise<void>(r=>ws.close(()=>r()));}};
}
async function setup(){const f=fixture(),ctx=new Context(),p=await platform();Object.assign(f.settings.qq,{enabled:true,ownerQQ:'1',allowedGroups:['8'],actionTimeoutMs:1000,reconnectMs:500,wsUrl:p.url});writeFileSync(join(f.dir,'config.json'),JSON.stringify(f.settings));writeFileSync(join(f.dir,'onebot.token'),'fixture-token');await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);const model=new Model();ctx.llm.registerAdapter(['deepseek-official'],model);const r=new ShiguangRuntime(ctx,join(f.dir,'config.json'));await r.qq.ready();return {f,ctx,p,r,model,async close(){await r.stop();await p.close();await ctx.fiber.dispose();f.cleanup();}};}
function send(socket:WebSocket,text:string,id=1,user=1,group=false){socket.send(JSON.stringify({post_type:'message',message_type:group?'group':'private',message_id:id,self_id:2,user_id:user,...(group?{group_id:8}:{}),sender:{nickname:'主人'},message:[{type:'text',data:{text}},...(group?[{type:'at',data:{qq:2}}]:[])]}));}

test('主人 95% 独立于普通 85%，群内主人身份提高概率但不授予私聊权限',()=>{
 const f=fixture();Object.assign(f.settings.qq,{ownerQQ:'1',allowedGroups:['8']});Object.assign(f.settings.qq.chat,{enabled:true,ownerReplyChance:95,replyChance:85});let random=.94;const q=new QQConversation(f.settings.qq.chat,async()=>{},()=>{},Date.now,()=>random);
 try{const base={post_type:'message',message_type:'group',message_id:1,self_id:2,user_id:1,group_id:8,message:[{type:'at',data:{qq:2}},{type:'text',data:{text:'在吗'}}]};const owner=parseMessage(base,f.settings.qq)!;assert.equal(owner.owner,false);assert.equal(owner.ownerMessage,true);assert.equal(owner.scope,'qq:group:8');assert.equal(q.offer(owner,true),true);random=.95;assert.equal(q.offer({...owner,id:'2'},true),false);random=.86;assert.equal(q.offer({...owner,id:'3',ownerMessage:false},true),false);random=.84;assert.equal(q.offer({...owner,id:'4',ownerMessage:false},true),true);}finally{q.stop();f.cleanup();}
});
test('保存角色称呼和普通设置保留真实 WebSocket，随后仍接收并只回复一次',async()=>{
 const s=await setup();try{const client=s.r.qq,v=s.r.view();await s.r.save({...v.settings,displayName:'小鱼'},v.revision);assert.equal(s.r.qq,client);assert.equal(s.p.connections(),1);assert.equal(client.status().state,'connected');send(s.p.socket(),'今天见到水獭');await wait(()=>s.r.memory.timeline().rows.some(r=>r.kind==='assistant'));assert.equal(s.p.sent.length,1);assert.equal(s.model.requests.length,1);assert.ok(client.status().lastMessageAt>0);}finally{await s.close();}
});
test('桥接关闭后自动重连，旧套接字事件不覆盖新连接，断线时等待恢复再发送',async()=>{
 const s=await setup();try{const client=s.r.qq;s.p.socket().close(1012,'fixture restart');await wait(()=>client.status().state==='disconnected');assert.equal(client.status().closeCode,1012);assert.ok(client.status().nextRetryAt>0);await client.ready();assert.equal(s.p.connections(),2);client.reconnect();await client.ready();assert.equal(client.status().state,'connected');await client.send({id:'t',selfId:'2',userId:'1',scope:'owner',thread:'p',owner:true,text:''},'回来啦');assert.deepEqual(s.p.sent,['回来啦']);}finally{await s.close();}
});
test('心跳超过 65 秒没有回包会关闭假连接并安排恢复，不永久显示已连接',async t=>{
 const f=fixture(),ws=new WebSocketServer({host:'127.0.0.1',port:0,autoPong:false});await once(ws,'listening');const a=ws.address();assert.ok(a&&typeof a==='object');f.settings.qq.wsUrl=`ws://127.0.0.1:${a.port}`;const q=new OneBotClient(f.settings.qq,()=>{},()=>{},()=> 'fixture');
 t.mock.timers.enable({apis:['Date','setInterval'],now:1000});try{await q.ready();t.mock.timers.tick(90000);await wait(()=>q.status().state==='disconnected');assert.match(q.status().error,/心跳/);assert.ok(q.status().nextRetryAt>0);}finally{q.stop();t.mock.timers.reset();for(const s of ws.clients)s.terminate();await new Promise<void>(r=>ws.close(()=>r()));f.cleanup();}
});
test('SnowLuma 自动同步只更新连接参数，模型队列忙时也能恢复，不丢失对话控制器',async()=>{
 const s=await setup(),next=await platform();let release!:()=>void;try{const dir=join(s.f.dir,'snow');mkdirSync(join(dir,'config'),{recursive:true});writeFileSync(join(dir,'config','onebot.json'),JSON.stringify({networks:{wsServers:[{name:'fixture',enabled:true,role:'Universal',host:'127.0.0.1',port:Number(new URL(next.url).port),path:'/',accessToken:'changed-fixture-token'}]}}));s.r.settings.snowluma.directory=dir;const conversation=s.r.qqConversation,client=s.r.qq;const hold=s.r.enqueue(()=>new Promise<void>(r=>release=r));await wait(()=>!!release);await s.r.syncQQConnection();assert.equal(s.r.qqConversation,conversation);assert.equal(s.r.qq,client);await client.ready();assert.equal(next.connections(),1);assert.equal(s.r.settings.qq.wsUrl,next.url);assert.equal(readFileSync(join(s.f.dir,'onebot.token'),'utf8'),'changed-fixture-token');release();await hold;}finally{release?.();await s.close();await next.close();}
});
test('只启动 QQ 桥接复用外部 SnowLuma，不打开 QQ 或网页；完整启动复用已运行 QQ',async()=>{
 const f=fixture(),ctx=new Context();let launches=0,opens=0,browsers=0;const dir=join(f.dir,'snow');mkdirSync(dir);writeFileSync(join(dir,'index.mjs'),'');const qqPath=join(f.dir,'QQ.exe');writeFileSync(qqPath,'');Object.assign(f.settings.snowluma,{directory:dir,qqPath});writeFileSync(join(f.dir,'config.json'),JSON.stringify(f.settings));const child=Object.assign(new EventEmitter(),{killed:false,kill(){this.killed=true;}}) as ChildProcess;const r=new ShiguangRuntime(ctx,join(f.dir,'config.json'),fetch,{snowHost:{platform:'win32',launch(){launches++;return child;},openQQ(){opens++;},qqRunning:()=>true,openBrowser(){browsers++;}},localFetch:async()=>Response.json({status:'failed'},{status:401}),locator:{roots:[],onPath:async()=>[]}});
 try{r.startQQSetup('bridge');await wait(()=>!r.qqSetup.busy);assert.equal(r.qqSetup.phase,'done');assert.deepEqual([launches,opens,browsers],[0,0,0]);r.startQQSetup('full');await wait(()=>!r.qqSetup.busy);assert.equal(r.qqSetup.phase,'done');assert.deepEqual([launches,opens,browsers],[0,0,0]);}finally{await r.stop();await ctx.fiber.dispose();f.cleanup();}
});
test('主人 QQ 要求去刷视频：真实触发浏览和内容读取，结束后回 QQ 分享，群聊不启动该路线',async()=>{
 const s=await setup();let browses=0,watches=0;try{Object.assign(s.r.settings.bilibili,{enabled:true,allowedTags:['动物']});s.r.settings.biliVision.enabled=true;s.r.bili.hasLogin=()=>true;s.r.bili.browse=async()=>{browses++;return [video];};s.r.biliVision.watch=async()=>{watches++;s.p.socket().close(1012,'watch fixture');await new Promise(r=>setTimeout(r,30));return '抽样画面：水獭抱着石头敲贝壳。';};send(s.p.socket(),'去刷一下B站，回来给我分享有趣的东西');await wait(()=>s.r.memory.timeline().rows.some(r=>r.kind==='assistant'),8000);assert.equal(browses,1);assert.equal(watches,1);assert.equal(s.p.sent.length,1);assert.match(s.p.sent[0]!,/水獭/);assert.ok(s.p.connections()>1);assert.match(JSON.stringify(s.model.requests[0]?.messages),/水獭抱着石头/);assert.ok(!s.model.requests[0]?.tools?.some(t=>t.name==='shiguang_bili_browse'));assert.ok(s.r.memory.timeline({platform:'bilibili',category:'watch'}).rows.length>0);send(s.p.socket(),'去刷一下B站',2,1,true);await wait(()=>s.model.requests.length===2);assert.equal(browses,1);}finally{await s.close();}
});
test('未授权识别不冒充观看，失败逐项可见；深看明确传给识别器，未自动执行互动',async()=>{
 const f=fixture(),m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory);Object.assign(f.settings.bilibili,{enabled:true,allowedTags:['动物']});const bili=new BilibiliClient(f.settings,m);bili.hasLogin=()=>true;let reads=0;const vision={watch:async(_id:string,_q:string,_p:number,_s:AbortSignal,depth:string)=>{reads++;assert.equal(depth,'deep');throw new Error('今日识别额度已用完');}} as unknown as BiliVision;bili.browse=async()=>[video];const b=new BiliBrowser(f.settings,m,bili,vision);
 try{await assert.rejects(b.run(),/尚未开启/);assert.equal(reads,0);f.settings.biliVision.enabled=true;const result=await b.run(undefined,'deep');assert.equal(reads,1);assert.match(result,/实际读取成功 0/);assert.match(b.status().videos[0]!.status,/额度/);assert.equal(m.actionQuota('bili-comment').today,0);assert.equal(m.actionQuota('bili-like').today,0);}finally{b.stop();m.close();f.cleanup();}
});
test('浏览指令识别区分否定、追问和指定视频；权重 10 的主题约为权重 1 的十倍',()=>{
 for(const text of ['去刷一下 B 站','帮我看看b站','你去B站看视频回来分享'])assert.equal(biliBrowseIntent(text),'shallow');assert.equal(biliBrowseIntent('去深度看看B站视频'),'deep');for(const text of ['不要去刷B站','为什么没有去刷B站','昨天刷B站看到什么','看看 B站 BV1xx411c7mD'])assert.equal(biliBrowseIntent(text),undefined);const counts={科技:0,动物:0};for(let i=0;i<1100;i++)counts[weightedTag(['科技','动物'],{科技:1,动物:10},()=>i/1100) as keyof typeof counts]++;assert.equal(counts.动物,1000);assert.equal(counts.科技,100);
});
test('梗词条按索引命中、跨平台共享主人范围、跨角色隔离，一个月后仍在；可修改删除',()=>{
 const f=fixture(),path=join(f.dir,'m.sqlite');let now=Date.now(),m=new MemoryStore(path,'role-a','UTC',f.settings.memory,()=>now);try{const lesson=parseSlangLesson('学个梗：摸鱼｜忙里偷闲｜被你发现啦')!;assert.equal(lesson.term,'摸鱼');saveSlang(m,'owner',lesson);saveSlang(m,'owner',{term:'绝绝子',meaning:'夸奖',response:'好厉害'});assert.match(recallSlang(m,'owner','你今天是不是在摸鱼',4,600),/忙里偷闲/);assert.doesNotMatch(recallSlang(m,'qq:group:8','摸鱼',4,600),/忙里偷闲/);assert.equal(recallSlang(m,'owner','你好',4,600),'[]');now+=40*86400000;m.sweep();assert.match(recallSlang(m,'owner','摸鱼',4,600),/被你发现/);saveSlang(m,'owner',{...lesson,meaning:'放松一下'});assert.equal(listSlang(m,'摸鱼')[0]?.meaning,'放松一下');m.close();m=new MemoryStore(path,'role-b','UTC',f.settings.memory);assert.deepEqual(listSlang(m),[]);m.close();m=new MemoryStore(path,'role-a','UTC',f.settings.memory);assert.equal(listSlang(m).length,2);deleteSlang(m,'摸鱼');assert.equal(recallSlang(m,'owner','摸鱼',4,600),'[]');}finally{m.close();f.cleanup();}
});
test('真实 DSH AgentLoop 学梗后普通提问直接取出词义，非主人和关闭开关时不可教学或取出',async()=>{
 const f=fixture(),ctx=new Context(),m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory),model=new Model();await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);ctx.llm.registerAdapter(['deepseek-official'],model);const driver=new ChatDriver(ctx,f.settings,m,new BilibiliClient(f.settings,m));
 try{await driver.reply({owner:true,scope:'owner',thread:'p',platform:'qq',text:'学个梗：摸鱼｜忙里偷闲｜被你发现啦'});assert.equal(listSlang(m).length,1);await driver.reply({owner:true,scope:'owner',thread:'bilibili:dm:1',platform:'bilibili',text:'摸鱼是怎么接的'});assert.match(JSON.stringify(model.requests.at(-1)?.messages),/忙里偷闲/);assert.ok(!model.requests.at(-1)?.tools?.some(t=>t.name==='shiguang_learn_slang'));await driver.reply({owner:false,scope:'qq:group:8',thread:'qq:group:8',platform:'qq',text:'学个梗：测试｜不可信'});assert.equal(listSlang(m).length,1);assert.doesNotMatch(JSON.stringify(model.requests.at(-1)?.messages),/忙里偷闲/);f.settings.slang.enabled=false;await driver.reply({owner:true,scope:'owner',thread:'other',platform:'dsh',text:'学个梗：新词｜不能保存'});assert.equal(listSlang(m).length,1);assert.ok(!model.requests.at(-1)?.tools?.some(t=>t.name==='shiguang_learn_slang'));}finally{await driver.stop();await ctx.fiber.dispose();m.close();f.cleanup();}
});
test('v11 数据升级备份后保留原话与完整 Token 回执，新增词库是角色范围的持久表',()=>{
 const f=fixture(),path=join(f.dir,'old.sqlite');let m=new MemoryStore(path,'a','UTC',f.settings.memory);const id=m.append('owner','qq','p','user','旧原话');m.db.exec('DROP TABLE slang_entries; DROP TABLE slang_tokens; PRAGMA user_version=11');m.close();m=new MemoryStore(path,'a','UTC',f.settings.memory);try{assert.ok(existsSync(path+'.v11-backup'));assert.equal(m.db.prepare('PRAGMA user_version').get()?.user_version,14);assert.equal(m.db.prepare('SELECT body FROM memories WHERE id=?').get(id!)?.body,'旧原话');assert.ok(m.db.prepare('PRAGMA table_info(llm_usage)').all().some(c=>c.name==='full_total'));saveSlang(m,'owner',{term:'摸鱼',meaning:'休息',response:''});assert.equal(listSlang(m).length,1);}finally{m.close();f.cleanup();}
});

test('随插件启动桥接的探测尚未返回时停止，不在停止后重新拉起 QQ 或桥接',async()=>{
 const f=fixture();let finish!:(r:Response)=>void,launches=0;const manager=new SnowLumaManager(f.dir,()=>f.settings,{platform:'win32',launch(){launches++;throw Error('must not launch');},openQQ(){assert.fail('must not open QQ');}},()=>new Promise<Response>(r=>finish=r));
 try{const job=manager.startBridge();await manager.stop();finish(new Response('{}',{status:503}));await assert.rejects(job,/停止/);assert.equal(launches,0);}finally{await manager.stop();f.cleanup();}
});
