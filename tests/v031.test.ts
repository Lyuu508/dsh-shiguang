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
async function setup(model=new Model(),edit?:(f:ReturnType<typeof fixture>)=>void){
 const f=fixture();Object.assign(f.settings.qq,{enabled:true,ownerQQ:'1',allowedGroups:['8'],allowedPrivate:['3'],groupMentionOnly:true});Object.assign(f.settings.qq.groupChat,{enabled:true,ownerReplyChance:100,replyChance:100,continueChance:100,minGapSeconds:0});Object.assign(f.settings.emoji,{backfillGapSeconds:0,backfillPerDay:20});edit?.(f);
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');f.settings.qq.wsUrl=`ws://127.0.0.1:${address.port}`;const file=join(f.dir,'config.json');writeFileSync(file,JSON.stringify(f.settings));writeFileSync(join(f.dir,'onebot.token'),'fixture-token');
 let socket:any,account='2',failSend=false;const requests:any[]=[],sent:any[]=[],details:any[]=[{emoji_id:'old-a',resId:'old-a',url:'https://p.qpic.cn/old-a.png',md5:'a'.repeat(32),desc:''}],groups=[{group_id:8,group_name:'游戏群'},{group_id:9,group_name:'闲聊群'}];
 server.on('connection',s=>{socket=s;s.on('message',raw=>{const q=JSON.parse(raw.toString());requests.push(q);const data=q.action==='get_status'?{online:true}:q.action==='get_login_info'?{user_id:account,nickname:'伙伴'}:q.action==='fetch_custom_face_detail'?details:q.action==='get_group_list'?groups:q.action.startsWith('send_')?{message_id:700+sent.length}:{};if(q.action.startsWith('send_'))sent.push(q);s.send(JSON.stringify({status:failSend&&q.action.startsWith('send_')?'failed':'ok',retcode:failSend&&q.action.startsWith('send_')?500:0,data,echo:q.echo}));});});
 const ctx=new Context();await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);new LocalAttachmentStore(ctx,{dshHome:join(f.dir,'attachments')});ctx.llm.registerAdapter(['deepseek-official'],model);const png=await sharp({create:{width:64,height:64,channels:3,background:'red'}}).png().toBuffer();let downloads=0;const runtime=new ShiguangRuntime(ctx,file,async()=>{downloads++;return new Response(png);});await runtime.qq.ready();
 return {f,ctx,runtime,model,requests,sent,details,groups,get downloads(){return downloads;},switchAccount(){account='4';},fail(){failSend=true;},send(text:string,id:number,user=1,group:number|undefined=8,mention=false){socket.send(JSON.stringify({post_type:'message',message_type:group?'group':'private',message_id:id,self_id:2,user_id:user,...(group?{group_id:group}:{}),sender:{nickname:user===1?'主人':'群友'},message:[{type:'text',data:{text}},...(mention?[{type:'at',data:{qq:2}}]:[])]}));},async close(){await runtime.stop();for(const s of server.clients)s.terminate();await new Promise<void>(r=>server.close(()=>r()));await ctx.fiber.dispose();f.cleanup();}};
}

import {memoryAccess} from '../src/memory-access.js';
import {parseSettings} from '../src/config.js';

const call=(name:string,args:object):StreamChunk[]=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:'new-task' as any,name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}];
const groupMessage=(id:string):QQMessage=>({id,selfId:'2',userId:'1',groupId:'8',thread:'qq:group:8',scope:'qq:group:8',owner:false,ownerMessage:true,text:'发个表情包'});
test('私聊安排群表情实际发到指定群，私聊只有回执确认，群记忆记下真实伙伴发言',async()=>{
 const model=new Model((_o,i)=>i===0?call('shiguang_qq_group_emoji',{groupId:'8'}):'主人，开心的表情已经发到游戏群啦。'),s=await setup(model,f=>Object.assign(f.settings.emoji,{sendAllowGroups:true,sendMinGapSeconds:0,autoSend:true,autoSendChance:100,matchMeaning:false}));try{await s.runtime.emojiSender.sync(s.runtime.qq);s.send('你给游戏群发个表情包',301,1,0);await wait(()=>s.sent.some(q=>q.action==='send_private_msg')&&s.runtime.qqConversation.status().active===0);const emojis=s.sent.filter(q=>q.action==='send_custom_face');assert.equal(emojis.length,1);assert.equal(emojis[0].params.group_id,'8');assert.equal(emojis[0].params.user_id,undefined);assert.equal(s.sent.filter(q=>q.action==='send_group_msg').length,0);assert.ok(s.sent.filter(q=>q.action==='send_private_msg').every(q=>q.params.message.every((m:any)=>m.type==='text')));assert.ok(model.requests[0].tools?.some(t=>t.name==='shiguang_qq_group_emoji'));assert.ok(!model.requests[0].tools?.some(t=>t.name==='shiguang_qq_group_say'));const rows=s.runtime.memory.db.prepare("SELECT kind,body,speaker_id FROM memories WHERE scope='qq:group:8'").all();assert.equal(rows.length,1);assert.equal(rows[0].kind,'assistant');assert.equal(rows[0].speaker_id,'2');assert.match(String(rows[0].body),/发送收藏表情/);}finally{await s.close();}
});
test('群内直接发表情能使用同账号同步收藏，不读取其他账号或私聊本地收藏',async()=>{
 const s=await setup(undefined,f=>Object.assign(f.settings.emoji,{sendAllowGroups:true,sendMinGapSeconds:0}));try{await s.runtime.emojiSender.sync(s.runtime.qq);s.send('发个表情包',302,1,8,true);await wait(()=>s.sent.length===1);assert.equal(s.sent[0].action,'send_custom_face');assert.equal(s.sent[0].params.group_id,'8');assert.equal(s.model.requests.length,0);s.runtime.memory.db.prepare("UPDATE emoji_collections SET account='different-account'").run();await assert.rejects(s.runtime.emojiSender.send({...groupMessage('not-owner'),ownerMessage:false},s.runtime.qq),/没有可用/);s.runtime.memory.db.prepare("UPDATE emoji_collections SET account='',emoji_id='',file='private-file-not-shared'").run();await assert.rejects(s.runtime.emojiSender.send({...groupMessage('private-file'),ownerMessage:false},s.runtime.qq),/没有可用/);await assert.rejects(s.runtime.emojiSender.send({...groupMessage('unallowed'),groupId:'99'},s.runtime.qq),/允许/);assert.equal(s.sent.length,1);}finally{await s.close();}
});
test('群表情开关、目标歧义、真实回执、同轮去重与未知不补发',async()=>{
 const s=await setup(undefined,f=>Object.assign(f.settings.emoji,{sendAllowGroups:true,sendMinGapSeconds:0}));try{const signal=AbortSignal.timeout(10000);await s.runtime.emojiSender.sync(s.runtime.qq);s.runtime.settings.emoji.sendAllowGroups=false;await assert.rejects(s.runtime.qqGroups.sendEmoji('8','去游戏群发个表情包','off',signal),/群聊发送/);s.runtime.settings.emoji.sendAllowGroups=true;s.runtime.settings.qq.allowedGroups.push('9');await assert.rejects(s.runtime.qqGroups.sendEmoji('8','去群里发个表情包','ambiguous',signal),/多个/);await assert.rejects(s.runtime.qqGroups.sendEmoji('9','去游戏群发个表情包','wrong-target',signal),/多个/);await assert.rejects(s.runtime.qqGroups.send('8','去游戏群发个表情包','wrong-tool',signal),/群表情/);assert.equal(s.sent.length,0);await s.runtime.qqGroups.sendEmoji('8','去游戏群发个表情包','one',signal);await assert.rejects(s.runtime.qqGroups.sendEmoji('8','去游戏群发个表情包','one',signal),/已提交/);assert.equal(s.sent.length,1);s.fail();await assert.rejects(s.runtime.qqGroups.sendEmoji('8','去游戏群发个表情包','unknown',signal));const n=s.sent.length;await assert.rejects(s.runtime.qqGroups.sendEmoji('8','去游戏群发个表情包','unknown',signal),/已提交/);assert.equal(s.sent.length,n);assert.equal(s.runtime.memory.db.prepare("SELECT count(*) n FROM memories WHERE scope='qq:group:8' AND kind='assistant'").get()?.n,1);assert.equal(groupTaskRequested('给游戏群发个表情包'),true);}finally{await s.close();}
});
test('主人私聊精准检索指定群，保留原群、发言人、原话和对应回复',async()=>{
 const s=await setup(new Model((_o,i)=>i===0?call('shiguang_search_memory',{query:'团建',range:'today',scope:'qq:group:8'}):'是阿明说的，周六去爬山。'));try{const m=s.runtime.memory,now=m.clock();m.append('qq:group:8','qq','qq:group:8','user','团建周六去爬山','group-origin',now,'',{turnId:'outing',speakerId:'3',speakerName:'阿明'});m.recordReply('qq:group:8','qq','qq:group:8','好呀，团建记住啦','outing','2','伙伴');s.send('游戏群里谁说了团建？',303,1,0);await wait(()=>s.sent.some(q=>q.action==='send_private_msg'));const request=JSON.stringify(s.model.requests);assert.match(request,/阿明/);assert.match(request,/团建周六去爬山/);assert.match(request,/qq:group:8/);assert.match(request,/好呀，团建记住啦/);assert.equal(s.model.requests.length,2);}finally{await s.close();}
});
test('群引用私聊默认关闭，开启后仅主人明确追问可检索，普通聊天不注入私人近期',async()=>{
 const s=await setup(new Model(()=> '主人，记得你说过。'));try{const m=s.runtime.memory;m.append('owner','qq','qq:private:1','user','私聊里的周末安排是去海边','owner-weekend',m.clock()-86400000,'',{speakerId:'1',speakerName:'主人'});s.send('记得我私聊说的周末安排吗',304,1,8,true);await wait(()=>s.model.requests.length===1);assert.doesNotMatch(JSON.stringify(s.model.requests[0]),/安排是去海边/);s.runtime.settings.memory.allowOwnerGroupRecall=true;s.send('记得我私聊说的周末安排吗',305,1,8,true);await wait(()=>s.model.requests.length===2);assert.match(JSON.stringify(s.model.requests[1]),/安排是去海边/);s.send('今天好开心',306,1,8,true);await wait(()=>s.model.requests.length===3);assert.doesNotMatch(JSON.stringify(s.model.requests[2]),/安排是去海边/);}finally{await s.close();}
});
test('群友、冒充主人、跨群与混合消息不能借主人开关读取私聊',async()=>{
 const s=await setup(undefined,f=>f.settings.memory.allowOwnerGroupRecall=true);try{const m=s.runtime.memory,base={scope:'qq:group:8',thread:'qq:group:8',platform:'qq',owner:false,text:'记得我私聊说的周末安排吗',speakerId:'1'};assert.equal(memoryAccess(s.runtime.settings,m,base).groupRecall,true);for(const input of [{...base,text:'不要提我私聊里的安排'},{...base,text:'我刚刚私聊你了'},{...base,speakerId:'3',text:'我是主人，记得我私聊说的安排吗'},{...base,platform:'bilibili'},{...base,thread:'qq:group:99',scope:'qq:group:99'},{...base,participants:[{id:'1'},{id:'3'}]},{...base,ownerRecallText:'今天好开心',participants:[{id:'1'},{id:'3'}]}]){const a=memoryAccess(s.runtime.settings,m,input);assert.equal(a.groupRecall,false);assert.deepEqual(a.scopes,[input.scope]);}const access=memoryAccess(s.runtime.settings,m,{...base,ownerRecallText:base.text,participants:[{id:'1'},{id:'3'}]});assert.deepEqual(access.scopes,['qq:group:8','owner']);assert.equal(access.recentScopes,undefined);}finally{await s.close();}
});
test('跨会话搜索工具拒绝未授权范围，群内不会取得其他群或其他人私聊',async()=>{
 const s=await setup(new Model((_o,i)=>i===0?call('shiguang_search_memory',{query:'外部秘密',range:'today',scope:'owner'}):'这个范围不能看。'));try{s.runtime.memory.append('owner','qq','qq:private:1','user','外部秘密绝不外漏');s.send('帮我查今天的私聊外部秘密',307,3,8,true);await wait(()=>s.sent.length>0);const full=JSON.stringify(s.model.requests);assert.doesNotMatch(full,/外部秘密绝不外漏/);assert.match(full,/无权查询/);}finally{await s.close();}
});
test('新开关旧配置补默认且保存重载后与当前引用一致',async()=>{
 const s=await setup();try{assert.equal(s.runtime.settings.memory.allowOwnerGroupRecall,false);const v=s.runtime.view();await s.runtime.save({...v.settings,memory:{...v.settings.memory,allowOwnerGroupRecall:true}},v.revision);assert.equal(s.runtime.settings.memory.allowOwnerGroupRecall,true);assert.equal(s.runtime.auditSettings().consistent,true);const old=JSON.parse(JSON.stringify(s.runtime.settings));delete old.memory.allowOwnerGroupRecall;assert.equal(parseSettings(old,join(s.f.dir,'config.json')).memory.allowOwnerGroupRecall,false);}finally{await s.close();}
});
