import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import sharp from 'sharp';
import {WebSocketServer} from 'ws';
import {Context} from '@deepseek-ai/cordis';
import {LlmAdapter,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {LocalAttachmentStore} from '@deepseek-ai/dsh-attachment-local';
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit';
import {fixture} from './helpers.js';
import {ShiguangRuntime} from '../src/runtime.js';
import {EmojiBackfill} from '../src/emoji-backfill.js';
import {readEmojiMeaning,saveEmojiMeaning} from '../src/emoji-meaning.js';
import {readEmojiSource} from '../src/emoji-source.js';
import {QQConversation} from '../src/qq-conversation.js';
import {dailyUsage} from '../src/usage.js';
import {groupTaskRequested} from '../src/qq-group-tasks.js';
import type {QQMessage} from '../src/onebot.js';
const semantic={meaning:'假装委屈求抱抱',emotions:['委屈','撒娇'],situations:['希望得到安慰时'],avoid:[]};
class Model extends LlmAdapter {
 requests:GenerateOptions[]=[];hold?:Promise<void>;
 constructor(readonly script:(o:GenerateOptions,i:number)=>unknown=(o)=>o.system?.includes('整理已有 QQ 收藏')?{emoji:semantic}:'主人，我在。'){super();}
 async resolveModel(provider:string,id:string){return {provider,id,name:id,inputModalities:['text','image'] as const,reasoning:{efforts:[{id:'off' as any,name:'关闭'}]}};}
 async *stream(o:GenerateOptions):AsyncIterable<StreamChunk>{this.requests.push(o);if(this.hold)await this.hold;if(o.signal?.aborted)throw o.signal.reason;const answer=this.script(o,this.requests.length-1);if(Array.isArray(answer)){yield* answer as StreamChunk[];return;}const text=typeof answer==='string'?answer:JSON.stringify(answer);yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'usage',usage:{inputTokens:120,cacheReadTokens:50,cacheWriteTokens:0,outputTokens:30,totalTokens:200}};yield {type:'finish',reason:{kind:'stop'}};}
}
const wait=async(check:()=>boolean)=>{const until=Date.now()+7000;while(!check()){if(Date.now()>until)throw Error('fixture timeout');await new Promise(r=>setTimeout(r,10));}};
async function setup(model=new Model(),edit?:(f:ReturnType<typeof fixture>)=>void,fetcher?:typeof fetch){
 const f=fixture();Object.assign(f.settings.qq,{enabled:true,ownerQQ:'1',allowedGroups:['8'],allowedPrivate:['3'],groupMentionOnly:true});Object.assign(f.settings.qq.groupChat,{enabled:true,ownerReplyChance:100,replyChance:100,continueChance:100,minGapSeconds:0});Object.assign(f.settings.emoji,{backfillGapSeconds:0,backfillPerDay:20});edit?.(f);
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');f.settings.qq.wsUrl=`ws://127.0.0.1:${address.port}`;const file=join(f.dir,'config.json');writeFileSync(file,JSON.stringify(f.settings));writeFileSync(join(f.dir,'onebot.token'),'fixture-token');
 let socket:any,account='2',failSend=false,unsupported=false;const quotes:Record<string,any>={};const requests:any[]=[],sent:any[]=[],details:any[]=[{emoji_id:'old-a',resId:'old-a',url:'https://p.qpic.cn/old-a.png',md5:'a'.repeat(32),desc:''}],groups=[{group_id:8,group_name:'游戏群'},{group_id:9,group_name:'闲聊群'}];
 server.on('connection',s=>{socket=s;s.on('message',raw=>{const q=JSON.parse(raw.toString());requests.push(q);const data=q.action==='get_msg'?(quotes[q.params.message_id]||{}):q.action==='get_status'?{online:true}:q.action==='get_login_info'?{user_id:account,nickname:'伙伴'}:q.action==='fetch_custom_face_detail'?details:q.action==='get_group_list'?groups:q.action.startsWith('send_')?{message_id:700+sent.length}:{};if(q.action.startsWith('send_'))sent.push(q);s.send(JSON.stringify({status:unsupported&&q.action==='send_custom_face'||failSend&&q.action.startsWith('send_')?'failed':'ok',retcode:unsupported&&q.action==='send_custom_face'?1404:failSend&&q.action.startsWith('send_')?500:0,...(unsupported&&q.action==='send_custom_face'?{wording:'unknown action'}:{}),data,echo:q.echo}));});});
 const ctx=new Context();await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);new LocalAttachmentStore(ctx,{dshHome:join(f.dir,'attachments')});ctx.llm.registerAdapter(['deepseek-official'],model);const png=await sharp({create:{width:64,height:64,channels:3,background:'red'}}).png().toBuffer();let downloads=0;const runtime=new ShiguangRuntime(ctx,file,fetcher||(async()=>{downloads++;return new Response(png);}));await runtime.qq.ready();
 return {f,ctx,runtime,model,quotes,requests,sent,details,groups,get downloads(){return downloads;},switchAccount(){account='4';},fail(){failSend=true;},unsupported(){unsupported=true;},send(text:string,id:number,user=1,group:number|undefined=8,mention=false,quote?:string,media:any[]=[]){socket.send(JSON.stringify({post_type:'message',message_type:group?'group':'private',message_id:id,self_id:2,user_id:user,...(group?{group_id:group}:{}),sender:{nickname:user===1?'主人':'群友'},message:[{type:'text',data:{text}},...(mention?[{type:'at',data:{qq:2}}]:[]),...(quote?[{type:'reply',data:{id:quote}}]:[]),...media]}));},async close(){await runtime.stop();for(const s of server.clients)s.terminate();await new Promise<void>(r=>server.close(()=>r()));await ctx.fiber.dispose();f.cleanup();}};
}

import {panelAction} from '../src/panel-api.js';
import {OneBotClient} from '../src/onebot.js';
const picture=[{type:'image',data:{file:'fixture.png',url:'https://gchat.qpic.cn/fixture.png',sub_type:1}}];
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {release,promise};};

test('自动收藏关闭时，长任务后60个未触发表情只归档，不产生60项无效待办',async()=>{
 const s=await setup(new Model(()=>assert.fail('不应调用模型')),f=>{f.settings.maxQueue=100;f.settings.qq.groupChat.enabled=false;Object.assign(f.settings.qq.chat,{enabled:true,ownerReplyChance:0});f.settings.emoji.enabled=false;}),held=gate(),started=gate();
 try{const first=s.runtime.enqueue(async()=>{started.release();await held.promise;},{label:'模拟长任务'});await started.promise;for(let i=0;i<60;i++)s.send('',600+i,1,0,false,undefined,picture);await wait(()=>Number(s.runtime.memory.db.prepare("SELECT count(*) AS n FROM memories WHERE kind='user'").get()?.n)===60);assert.equal(s.runtime.status().queued,1);assert.equal(s.runtime.status().taskQueue.waiting,0);assert.equal(s.downloads,0);assert.equal(s.model.requests.length,0);held.release();await first;await s.runtime.enqueue(async()=>{});assert.equal(s.runtime.memory.db.prepare("SELECT count(*) AS n FROM memories WHERE kind='user'").get()?.n,60);}finally{held.release();await s.close();}
});
test('启用自动收藏时突发表情最多合并成一项后台挑选，释放后只调用一次模型',async()=>{
 const s=await setup(new Model(()=>({collect:false,reason:'这次先不收藏'})),f=>{f.settings.qq.groupChat.enabled=false;Object.assign(f.settings.qq.chat,{enabled:true,ownerReplyChance:0});Object.assign(f.settings.emoji,{enabled:true,dailyLimit:3,decisionsPerDay:8});}),held=gate(),started=gate();
 try{const first=s.runtime.enqueue(async()=>{started.release();await held.promise;});await started.promise;for(let i=0;i<50;i++)s.send('',700+i,1,0,false,undefined,picture);await wait(()=>Number(s.runtime.memory.db.prepare("SELECT count(*) AS n FROM memories WHERE kind='user'").get()?.n)===50);assert.equal(s.runtime.status().taskQueue.waiting,1);assert.equal(s.runtime.status().taskQueue.counts.background,1);assert.equal(s.model.requests.length,0);held.release();await first;await wait(()=>s.runtime.status().queued===0);assert.equal(s.model.requests.length,1);assert.equal(s.downloads,1);assert.equal(s.sent.length,0);}finally{held.release();await s.close();}
});
test('队列满时设置仍能提交，先停止旧工作并撤销旧待办，原始记忆和新配置保留',async()=>{
 const s=await setup(new Model(()=>assert.fail('不应调用模型')),f=>f.settings.maxQueue=2),started=gate();let oldRuns=0;
 try{s.runtime.memory.append('owner','qq','qq:private:1','user','队列满之前的原话','queue-raw');const active=s.runtime.enqueue(async signal=>{started.release();await new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});const cancelled=assert.rejects(active,/旧任务|更新/);await started.promise;const waiting=s.runtime.enqueue(async()=>{oldRuns++;});const discarded=assert.rejects(waiting,/配置|取消/);assert.equal(s.runtime.status().queued,2);
  const v=s.runtime.view(),saved=await s.runtime.save({...v.settings,displayName:'队列已恢复'},v.revision);await Promise.all([cancelled,discarded]);assert.equal(saved.settings.displayName,'队列已恢复');assert.equal(s.runtime.auditSettings().consistent,true);assert.equal(oldRuns,0);assert.ok(s.runtime.memory.db.prepare("SELECT id FROM memories WHERE body='队列满之前的原话'").get());await s.runtime.enqueue(async()=>{});assert.equal(s.runtime.status().queued,0);
 }finally{await s.close();}
});
test('无效设置不会提前停止当前工作；取消等待中的后台发送请求不会在稍后暗中发送',async()=>{
 const s=await setup(),held=gate(),started=gate();try{const active=s.runtime.enqueue(async()=>{started.release();await held.promise;});await started.promise;const v=s.runtime.view();await assert.rejects(s.runtime.save({...v.settings,maxReplyChars:-1},v.revision));assert.equal(s.runtime.status().taskQueue.active?.cancelling,false);
  const abort=new AbortController(),send=panelAction(s.runtime,'emoji-test',{},abort.signal),cancelled=assert.rejects(send,/取消/);await wait(()=>s.runtime.status().taskQueue.counts.panel===1);abort.abort(Error('取消后台测试发送'));await cancelled;assert.equal(s.runtime.status().taskQueue.waiting,0);held.release();await active;await s.runtime.enqueue(async()=>{});assert.equal(s.sent.length,0);assert.equal(s.requests.filter(q=>q.action==='fetch_custom_face_detail').length,0);
 }finally{held.release();await s.close();}
});
test('停止按钮不经过已满队列，清理后仍可接受新QQ消息并取得一次回复回执',async()=>{
 const s=await setup(new Model(()=> '主人，已经恢复啦。'),f=>f.settings.maxQueue=2),started=gate();let stale=0;
 try{const active=s.runtime.enqueue(async signal=>{started.release();await new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});const stopped=assert.rejects(active,/停止/);await started.promise;const waiting=s.runtime.enqueue(async()=>{stale++;});const cleared=assert.rejects(waiting,/取消/);
  const result=await panelAction(s.runtime,'tasks-cancel',{},AbortSignal.timeout(1000)) as any;assert.equal(result.cleared,1);await Promise.all([stopped,cleared]);await wait(()=>s.runtime.status().queued===0);assert.equal(stale,0);s.send('现在能说话了吗',800,1,0);await wait(()=>s.sent.length===1);assert.equal(s.model.requests.length,1);assert.equal(s.sent[0].action,'send_private_msg');assert.equal(s.sent[0].params.user_id,'1');
 }finally{await s.close();}
});
test('暂停单轮后台操作后允许下一轮，不把永久停止状态带到新任务',async()=>{
 const s=await setup();try{for(const service of [s.runtime.biliSocial,s.runtime.biliMentions,s.runtime.biliReplies]){service.cancelCurrent();assert.equal((service as any).stopped,false);assert.equal((service as any).abort.signal.aborted,false);}s.runtime.visionCheck.cancelCurrent();assert.equal((s.runtime.visionCheck as any).abort.signal.aborted,false);const status=await panelAction(s.runtime,'tasks-status',{},AbortSignal.timeout(1000)) as any;assert.equal(status.waiting,0);assert.equal(status.active,null);}finally{await s.close();}
});
test('群发言拟文遵守回复超时，合作式模型取消后释放队列且不发布',async()=>{
 const model=new Model();model.stream=async function*(o:GenerateOptions){this.requests.push(o);await new Promise<void>((_r,reject)=>{if(o.signal?.aborted)reject(o.signal.reason);else o.signal?.addEventListener('abort',()=>reject(o.signal?.reason),{once:true});});};
 const s=await setup(model);try{s.runtime.settings.replyTimeoutMs=250;await assert.rejects(s.runtime.enqueue(signal=>s.runtime.qqGroups.route('去游戏群打个招呼','draft-timeout',signal)),/未完整|超时|aborted|取消/i);await wait(()=>s.runtime.status().queued===0);assert.equal(s.sent.filter(q=>q.action==='send_group_msg').length,0);assert.equal(model.requests.length,1);}finally{await s.close();}
});
test('已发送QQ请求取消后回执未知，只尝试一次，迟到回执不触发补发且后续查询正常',async()=>{
 const f=fixture(),server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');f.settings.qq.wsUrl=`ws://127.0.0.1:${address.port}`;f.settings.qq.actionTimeoutMs=60000;let late:any,socket:any,sends=0;
 server.on('connection',s=>{socket=s;s.on('message',raw=>{const q=JSON.parse(raw.toString());if(q.action==='send_custom_face'){sends++;late=q;return;}s.send(JSON.stringify({status:'ok',retcode:0,data:{online:true},echo:q.echo}));});});
 const client=new OneBotClient(f.settings.qq,()=>{},()=>{},()=> 'fixture-token');try{client.start();await client.ready();const abort=new AbortController(),pending=client.action('send_custom_face',{group_id:'8',emoji_id:'fixture'},abort.signal),cancelled=assert.rejects(pending,/待核实/);await wait(()=>!!late);abort.abort();await cancelled;socket.send(JSON.stringify({status:'ok',retcode:0,data:{message_id:123},echo:late.echo}));assert.equal((await client.action('get_status',{})).online,true);assert.equal(sends,1);assert.equal((client as any).pending.size,0);}finally{client.stop();for(const s of server.clients)s.terminate();await new Promise<void>(r=>server.close(()=>r()));f.cleanup();}
});
