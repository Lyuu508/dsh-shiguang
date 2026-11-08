import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {writeFileSync,readFileSync,mkdirSync,existsSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Context} from '@deepseek-ai/cordis';
import {brandString} from '@deepseek-ai/dsh-brand';
import {LlmAdapter,type GenerateOptions,type StreamChunk,type ToolCallId} from '@deepseek-ai/dsh-llm';
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit';
import {WebSocketServer} from 'ws';
import {MemoryStore} from '../src/memory.js';
import {ChatDriver} from '../src/agent.js';
import {BilibiliClient} from '../src/bilibili.js';
import {ShiguangRuntime} from '../src/runtime.js';
import {checkMediaTools} from '../src/media.js';
import {MediaToolsManager} from '../src/media-tools.js';
import {panelAction} from '../src/panel-api.js';
import {parseMessage} from '../src/onebot.js';
import {BodyClock} from '../src/body-clock.js';
import {memoryAccess} from '../src/memory-access.js';
import {exportMemoryPage,importMemory} from '../src/memory-transfer.js';
import {Proactive} from '../src/proactive.js';
import {Autonomy} from '../src/autonomy.js';
import {fixture} from './helpers.js';
const pause=()=>new Promise(r=>setTimeout(r,5));
async function until(check:()=>boolean){const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw Error('fixture timeout');await pause();}}
class Script extends LlmAdapter{
 requests:GenerateOptions[]=[];
 constructor(readonly script:(i:number)=>StreamChunk[]=()=>text('我在。')){super();}
 async *stream(options:GenerateOptions){this.requests.push(options);yield* this.script(this.requests.length-1);}
}
function text(value:string):StreamChunk[]{return [{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}];}
function tool(name:string,args:object):StreamChunk[]{return [{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:brandString<ToolCallId>('v020-call'),name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}];}
async function harness(model:Script){const ctx=new Context();await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);ctx.llm.registerAdapter(['deepseek-official'],model);return ctx;}

test('问答使用实际发送回执后的 turn ID 关联，说话人、时分秒、导出导入及回收站保持一致',()=>{
 const f=fixture(),m=new MemoryStore(':memory:','a','UTC',f.settings.memory),copy=new MemoryStore(':memory:','a','UTC',f.settings.memory);
 try{const now=m.clock(),id=m.append('owner','qq','qq:private:1','user','在吗','incoming',now,'',{turnId:'incoming',speakerId:'1',speakerName:'小鱼'})!;m.recordReply('owner','qq','qq:private:1','我在。','incoming','2','拾光');
 const cards=m.conversationPage();assert.equal(cards.rows.length,1);assert.deepEqual(cards.rows[0]?.messages.map(r=>r.kind),['user','assistant']);assert.equal(cards.rows[0]?.messages[0]?.speakerName,'小鱼');assert.equal(cards.rows[0]?.messages[0]?.time,now);assert.match(m.search('owner','我在','today')[0]?.snippet||'',/小鱼：在吗.*拾光：我在/);
 const exported=exportMemoryPage(m,'*','all');assert.equal(importMemory(copy,'*','all',JSON.stringify({format:exported.format,version:1,memories:exported.rows}),'json').added,2);assert.equal(copy.conversationPage().rows[0]?.messages.length,2);assert.equal(copy.conversationPage().rows[0]?.messages[0]?.speakerId,'1');
 m.remove('owner',id);m.restore('owner',id);assert.equal(m.conversationPage().rows[0]?.messages[0]?.speakerName,'小鱼');
 }finally{m.close();copy.close();f.cleanup();}
});

test('相同寒暄的不同轮次和日期不会被导入去重或问答合并吞掉',()=>{
 const f=fixture();let now=Date.parse('2026-11-08T12:00Z');const m=new MemoryStore(':memory:','a','UTC',f.settings.memory,()=>now),copy=new MemoryStore(':memory:','a','UTC',f.settings.memory,()=>now);
 try{for(const turnId of ['first','second']){m.append('owner','qq','qq:private:1','user','在吗',undefined,now,'',{turnId,speakerId:'1'});m.recordReply('owner','qq','qq:private:1','我在',turnId);now+=1000;}
 const exported=exportMemoryPage(m,'*','all'),doc=JSON.stringify({format:exported.format,version:1,memories:exported.rows});assert.equal(importMemory(copy,'*','all',doc,'json').added,4);assert.equal(copy.conversationPage().rows.length,2);assert.equal(importMemory(copy,'*','all',doc,'json').skipped,4);now+=86400000;assert.equal(importMemory(copy,'*','today',doc,'json').added,4);assert.equal(copy.conversationPage({day:''}).rows.length,4);now+=60000;assert.equal(importMemory(copy,'*','today',doc,'json').skipped,4);assert.ok(copy.conversationPage({day:''}).rows.every(row=>row.messages.length===2));
 }finally{m.close();copy.close();f.cleanup();}
});

test('真实 v9 库迁移自动备份；只在同角色同会话一小时内推断旧问答，独立主动消息不误配',()=>{
 const f=fixture(),path=join(f.dir,'legacy.sqlite'),db=new DatabaseSync(path),now=Date.now();
 db.exec("CREATE TABLE memories(rowid INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,role TEXT NOT NULL,scope TEXT NOT NULL,day TEXT NOT NULL,time INTEGER NOT NULL,platform TEXT NOT NULL,thread TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,external_key TEXT UNIQUE); PRAGMA user_version=9;");
 const insert=db.prepare('INSERT INTO memories(id,role,scope,day,time,platform,thread,kind,body,external_key) VALUES(?,?,?,?,?,?,?,?,?,?)');
 insert.run('q','a','owner','2026-11-08',now,'qq','qq:private:1','user','在吗',null);insert.run('other-q','b','owner','2026-11-08',now,'qq','qq:private:1','user','另一角色',null);insert.run('a','a','owner','2026-11-08',now+1000,'qq','qq:private:1','assistant','我在',null);insert.run('p','a','owner','2026-11-08',now+2000,'qq','qq:private:1','assistant','主动分享','a:proactive:fixture');db.close();
 const m=new MemoryStore(path,'a','UTC',f.settings.memory);try{assert.ok(existsSync(path+'.v9-backup'));assert.equal(m.db.prepare('PRAGMA user_version').get()?.user_version,11);const pair=m.db.prepare('SELECT turn_id,pair_inferred FROM memories WHERE id=?').get('a');assert.equal(pair?.turn_id,'q');assert.equal(pair?.pair_inferred,1);assert.equal(m.db.prepare('SELECT turn_id FROM memories WHERE id=?').get('p')?.turn_id,'p');assert.equal(m.conversationPage({day:'2026-11-08'}).rows.find(r=>r.turnId==='q')?.messages.length,2);}finally{m.close();f.cleanup();}
});

test('真实 AgentLoop 跨 QQ / B站保留主人原话；群聊原话仅在明确追问时进入主人私聊',async()=>{
 const f=fixture(),model=new Script(),ctx=await harness(model),m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory),driver=new ChatDriver(ctx,f.settings,m,new BilibiliClient(f.settings,m));
 try{await driver.reply({owner:true,scope:'owner',thread:'qq:private:1',platform:'qq',text:'在吗，我今天带了蓝色雨伞。',turnId:'q',speakerId:'1',speakerName:'主人小鱼'});m.recordReply('owner','qq','qq:private:1','我在。','q','2','拾光');m.append('qq:group:8','qq','qq:group:8','user','群内独有的猎户星云讨论',undefined,m.clock(),'',{speakerId:'3',speakerName:'阿蓝'});
 await driver.reply({owner:true,scope:'owner',thread:'bilibili:dm:2:1',platform:'bilibili',text:'你好'});const ordinary=JSON.stringify(model.requests.at(-1)?.messages);assert.match(ordinary,/蓝色雨伞/);assert.match(ordinary,/主人小鱼/);assert.doesNotMatch(ordinary,/群内独有/);
 await driver.reply({owner:true,scope:'owner',thread:'bilibili:dm:2:1',platform:'bilibili',text:'群里刚说了什么？'});assert.match(JSON.stringify(model.requests.at(-1)?.messages),/群内独有的猎户星云讨论/);
 }finally{await driver.stop();await ctx.fiber.dispose();m.close();f.cleanup();}
});

for(const group of [false,true])test('仅主人可查跨会话：'+(group?'主人在群里也不获得私聊资料':'其他白名单私聊不能通过已知 ID 绕过权限'),async()=>{
 const f=fixture(),m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory),id=m.append('owner','qq','qq:private:1','user','私人资料蓝色雨伞',undefined,m.clock()-86400000)!;const model=new Script(i=>i===0?tool('shiguang_read_memory',{id}):text('没有权限读取。')),ctx=await harness(model),driver=new ChatDriver(ctx,f.settings,m,new BilibiliClient(f.settings,m)),scope=group?'qq:group:8':'qq:private:3';
 try{await driver.reply({owner:false,scope,thread:scope,platform:'qq',text:'之前主人 QQ 的私聊说了什么？'});assert.equal(model.requests.length,2);assert.doesNotMatch(JSON.stringify(model.requests),/私人资料蓝色雨伞/);assert.match(JSON.stringify(model.requests[1]?.messages),/不属于当前会话/);
 f.settings.memory.ownerOnlyCrossChat=false;const access=memoryAccess(f.settings,m,{owner:false,scope,thread:scope,text:'之前QQ私聊'});assert.equal(access.scopes.includes('owner'),!group);
 }finally{await driver.stop();await ctx.fiber.dispose();m.close();f.cleanup();}
});

test('模型尚不可用时也先保存提问原文和身份，重复消息不再次调用模型',async()=>{
 const f=fixture(),ctx=new Context(),m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory),driver=new ChatDriver(ctx,f.settings,m,new BilibiliClient(f.settings,m));
 try{const input={owner:true,scope:'owner',thread:'qq:private:1',platform:'qq' as const,text:'在吗',externalKey:'message1',speakerId:'1',speakerName:'小鱼'};await assert.rejects(driver.reply(input),/DeepSeek|模型/);assert.equal(m.timeline().rows[0]?.body,'在吗');assert.equal(m.timeline().rows[0]?.speakerName,'小鱼');assert.equal(await driver.reply(input),null);}finally{await driver.stop();await ctx.fiber.dispose();m.close();f.cleanup();}
});

test('QQ 回复关闭仍可检测真实 WebSocket 连接并归档主人和群消息，不调用模型或发送回复',async()=>{
 const f=fixture(),ctx=new Context(),ws=new WebSocketServer({host:'127.0.0.1',port:0});await once(ws,'listening');const address=ws.address();assert.ok(address&&typeof address==='object');Object.assign(f.settings.qq,{enabled:false,wsUrl:`ws://127.0.0.1:${address.port}`,ownerQQ:'1',allowedGroups:['8']});const file=join(f.dir,'config.json');writeFileSync(file,JSON.stringify(f.settings));writeFileSync(join(f.dir,'onebot.token'),'fixture-token');const actions:string[]=[];ws.on('connection',socket=>socket.on('message',raw=>{const r=JSON.parse(raw.toString());actions.push(r.action);socket.send(JSON.stringify({status:'ok',retcode:0,echo:r.echo,data:r.action==='get_status'?{online:true}:{user_id:2,nickname:'伙伴'}}));}));const r=new ShiguangRuntime(ctx,file);
 try{const result=await panelAction(r,'qq-check',{},new AbortController().signal) as {online:boolean};assert.equal(result.online,true);assert.equal(r.status().qq.repliesEnabled,false);assert.equal(r.status().qq.state,'connected');const socket=[...ws.clients][0]!;
 for(const group of [false,true])socket.send(JSON.stringify({post_type:'message',message_type:group?'group':'private',self_id:2,user_id:1,group_id:group?8:undefined,message_id:group?12:11,sender:{nickname:'主人小鱼'},message:[{type:'text',data:{text:group?'群聊原话':'在吗'}}]}));
 await until(()=>r.memory.overview().total===2);assert.ok(r.memory.timeline().rows.every(row=>row.kind==='user'&&row.speakerName==='主人小鱼'));assert.deepEqual(actions.sort(),['get_login_info','get_status']);
 }finally{await r.stop();for(const s of ws.clients)s.terminate();await new Promise<void>(resolve=>ws.close(()=>resolve()));await ctx.fiber.dispose();f.cleanup();}
});

for(const chance of [0,100])test('关键词实际运行：概率 '+chance+'%，白名单群匹配称呼、冷却不重复，其他群不能触发',async()=>{
 const f=fixture(),model=new Script(),ctx=await harness(model),ws=new WebSocketServer({host:'127.0.0.1',port:0});await once(ws,'listening');const address=ws.address();assert.ok(address&&typeof address==='object');Object.assign(f.settings.qq,{enabled:true,wsUrl:`ws://127.0.0.1:${address.port}`,ownerQQ:'1',allowedGroups:['8'],keywordWakeEnabled:true,keywordWakeChance:chance,keywordCooldownSeconds:60});const file=join(f.dir,'config.json');writeFileSync(file,JSON.stringify(f.settings));writeFileSync(join(f.dir,'onebot.token'),'fixture-token');let sends=0;ws.on('connection',socket=>socket.on('message',raw=>{const r=JSON.parse(raw.toString());if(r.action==='send_group_msg')sends++;socket.send(JSON.stringify({status:'ok',retcode:0,echo:r.echo,data:{message_id:999}}));}));const r=new ShiguangRuntime(ctx,file);
 try{await r.qq.ready();const socket=[...ws.clients][0]!,raw={post_type:'message',message_type:'group',self_id:2,user_id:3,group_id:8,message_id:1,sender:{card:'阿蓝'},message:[{type:'text',data:{text:'大肥鱼，在吗'}}]};assert.equal(parseMessage({...raw,group_id:9},f.settings.qq),null);assert.equal(parseMessage(raw,f.settings.qq)?.keyword,'大肥鱼');socket.send(JSON.stringify(raw));await until(()=>r.memory.overview().total>=(chance?2:1));assert.equal(sends,chance?1:0);socket.send(JSON.stringify({...raw,message_id:2}));await until(()=>r.memory.overview().total>=(chance?3:2));assert.equal(sends,chance?1:0);assert.equal(model.requests.length,chance?1:0);if(chance){assert.equal(r.memory.conversationPage().rows.find(row=>row.turnId.endsWith(':1'))?.messages.length,2);assert.equal(r.memory.timeline().rows.find(row=>row.kind==='user')?.speakerName,'阿蓝');}
 }finally{await r.stop();for(const s of ws.clients)s.terminate();await new Promise<void>(resolve=>ws.close(()=>resolve()));await ctx.fiber.dispose();f.cleanup();}
});

test('睡眠关键词使用自己的开关，不把普通文字 @ 当作真正 @，关键词概率不重复抽取',()=>{
 const f=fixture(),m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory,()=>Date.parse('2026-11-08T23:30Z'));Object.assign(f.settings.clock,{enabled:true,wakeOnKeyword:false,wakeChance:0});const c=new BodyClock(f.settings,m,()=>.99),message={id:'q',selfId:'2',userId:'1',thread:'qq:group:8',scope:'qq:group:8',owner:false,text:'小肥鱼',keyword:'小肥鱼',keywordAwakened:true};
 try{assert.equal(c.receive(message),false);f.settings.clock.wakeOnKeyword=true;assert.equal(c.receive(message),true);assert.equal(c.canAct(),true);}finally{c.stop();m.close();f.cleanup();}
});

test('真实可执行工具首次启动超过旧五秒仍可通过，两个程序独立并行检测',{skip:process.platform==='win32'},async()=>{
 const f=fixture(),program=join(f.dir,'cold-video-tool');writeFileSync(program,'#!'+process.execPath+'\nsetTimeout(()=>process.stdout.write("fixture tool version"),5500);\n');chmodSync(program,0o700);
 try{const start=Date.now(),result=await checkMediaTools({...f.settings.media,ffmpegPath:program,ffprobePath:program});assert.equal(result.ready,true);assert.ok(Date.now()-start<12000);}finally{f.cleanup();}
});

for(const recovers of [false,true])test('下载完成后冷启动检测'+(recovers?'重试成功':'未通过但保留安装；稍后定位恢复且不再下载'),async()=>{
 const f=fixture(),bytes=Buffer.from('fixture-video-tools'),asset={tag_name:'latest',assets:[{name:'ffmpeg-master-latest-win64-lgpl.zip',size:bytes.length,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex'),browser_download_url:'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip'}]};let downloads=0,checks=0,ready=false;const manager=new MediaToolsManager(f.dir,()=>f.settings,paths=>Object.assign(f.settings.media,paths),async url=>String(url).includes('api.github.com')?Response.json(asset):(()=>{throw Error('fetch failed');})(),{platform:'win32',arch:'x64',async download(_a,target){downloads++;writeFileSync(target,bytes);},async extract(_a,dir){writeFileSync(join(dir,'ffmpeg.exe'),'');writeFileSync(join(dir,'ffprobe.exe'),'');},async check(c){if(!existsSync(c.ffmpegPath))return {ready:false,message:'missing'};checks++;return {ready:ready||recovers&&checks>1,message:'工具启动检测超时'};}});
 try{manager.start();await manager.whenIdle();assert.equal(manager.view().ready,recovers);assert.ok(existsSync(join(f.dir,'media-tools','installed.json')));assert.equal(downloads,1);if(!recovers){assert.equal(manager.view().phase,'needs-check');assert.match(manager.view().message,/无需重新下载/);ready=true;assert.equal((await manager.check()).ready,true);manager.start();await manager.whenIdle();assert.equal(downloads,1);}}
 finally{manager.stop();f.cleanup();}
});

test('调度状态明确给出未行动原因与自主互动权限，无需猜测后台是否在工作',async()=>{
 const f=fixture(),ctx=new Context(),m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory),qq={status:()=>({state:'disconnected'})} as any,p=new Proactive(ctx,f.settings,m,qq,async r=>r(),()=>{}),b=new BilibiliClient(f.settings,m),a=new Autonomy(ctx,f.settings,m,b,async r=>r(),()=>{});
 try{assert.match(p.status().reason,/尚未开启/);assert.ok(p.status().blockedReasons.some(s=>s.includes('桥接')));assert.match(a.status().reason,/尚未开启/);assert.equal(a.status().permissions.comment,false);f.settings.autonomy.autoComment=true;assert.equal(a.status().permissions.comment,false);f.settings.bilibili.allowComments=true;assert.equal(a.status().permissions.comment,true);f.settings.proactive.enabled=true;f.settings.proactive.activity='silent';assert.match(p.status().reason,/沉默/);}finally{p.stop();a.stop();await ctx.fiber.dispose();m.close();f.cleanup();}
});
