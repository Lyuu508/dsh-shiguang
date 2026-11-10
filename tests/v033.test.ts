import {biliReferenceContext} from '../src/bili-memory.js';
import {wantsEmoji} from '../src/emoji-sender.js';
import {MemoryStore} from '../src/memory.js';
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
import {relationship,ownerInteraction,wantedContact} from '../src/relationship.js';
import {Proactive} from '../src/proactive.js';
import {QQRecentMedia} from '../src/qq-recent-media.js';
import {groupEmojiRequested,groupPostRequested} from '../src/qq-group-tasks.js';
import {BiliVision,biliWatchIntent} from '../src/bili-vision.js';
import {BilibiliClient} from '../src/bilibili.js';
import {ChatDriver} from '../src/agent.js';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const picture=(emoji=false)=>[{type:'image',data:{file:'fixture.png',url:'https://gchat.qpic.cn/fixture.png',sub_type:emoji?1:0}}];
const completed=async(s:Awaited<ReturnType<typeof setup>>,count:number)=>wait(()=>s.sent.length>=count&&s.runtime.qqConversation.status().active===0&&s.runtime.qqConversation.status().pending===0);

test('明确群文字任务直接执行，带冒号原文0模型；群名不带群字也发到实际群',async()=>{
 const s=await setup(new Model(()=> '只能从当前窗口发'),f=>{f.settings.qq.allowedGroups.push('9');Object.assign(f.settings.emoji,{sendAllowGroups:true,autoSend:true,autoSendChance:100,sendMinGapSeconds:0});});
 try{s.groups[1]!.group_name='相亲相爱一家人';s.send('去相亲相爱一家人说：今晚八点一起玩',501,1,0);await completed(s,2);assert.equal(s.sent[0].action,'send_group_msg');assert.equal(s.sent[0].params.group_id,'9');assert.equal(s.sent[0].params.message[0].data.text,'今晚八点一起玩');assert.equal(s.sent[1].action,'send_private_msg');assert.equal(s.model.requests.length,0);
  s.send('去相亲相爱一家人里面发个表情包',502,1,0);await completed(s,4);assert.equal(s.sent[2].action,'send_custom_face');assert.equal(s.sent[2].params.group_id,'9');assert.ok(!('user_id' in s.sent[2].params));assert.equal(s.sent.filter(q=>q.action==='send_custom_face').length,1);assert.equal(s.runtime.qqGroups.status().last.groupId,'9');assert.ok(s.runtime.qqGroups.status().last.messageId);assert.equal(s.model.requests.length,0);
 }finally{await s.close();}
});
test('群里发个表情能识别为群任务；目标不明确后只回群名继续原任务，不落回私聊',async()=>{
 const s=await setup(new Model(()=>assert.fail('本机路由不应调用模型')),f=>{f.settings.qq.allowedGroups.push('9');Object.assign(f.settings.emoji,{sendAllowGroups:true,autoSend:true,autoSendChance:100,sendMinGapSeconds:0});});
 try{assert.equal(groupEmojiRequested('群里发个表情包'),true);assert.equal(groupPostRequested('去群里看一下聊天'),false);s.send('群里发个表情包',503,1,0);await completed(s,1);assert.equal(s.sent[0].action,'send_private_msg');assert.match(s.sent[0].params.message[0].data.text,/明确目标群/);assert.ok(s.runtime.qqGroups.status().pending);
  s.send('闲聊群',504,1,0);await completed(s,3);assert.equal(s.sent[1].action,'send_custom_face');assert.equal(s.sent[1].params.group_id,'9');assert.equal(s.sent[2].action,'send_private_msg');assert.equal(s.runtime.qqGroups.status().pending,null);assert.equal(s.model.requests.length,0);
  s.send('去群里发个表情包',505,1,0);await completed(s,4);s.send('取消',506,1,0);await completed(s,5);assert.equal(s.runtime.qqGroups.status().pending,null);assert.equal(s.sent.filter(q=>q.action==='send_custom_face').length,1);
 }finally{await s.close();}
});
test('后台选定群的任务走真实发送链路，未允许群和禁用开关不产生群发送',async()=>{
 const s=await setup(new Model(()=>assert.fail('指定原文无需模型')),f=>Object.assign(f.settings.emoji,{sendAllowGroups:true,sendMinGapSeconds:0}));const signal=AbortSignal.timeout(10000);
 try{const groups=await panelAction(s.runtime,'qq-groups',{},signal) as any[];assert.deepEqual(groups,[{id:'8',name:'游戏群'}]);const start=await panelAction(s.runtime,'qq-group-task',{groupId:'8',request:'说：大家晚上好'},signal) as any;assert.equal(start.status,'running');await wait(()=>s.runtime.groupJob.status!=='running');assert.equal(s.runtime.groupJob.status,'done');assert.equal(s.sent.length,1);assert.equal(s.sent[0].params.group_id,'8');assert.equal(s.sent[0].params.message[0].data.text,'大家晚上好');assert.ok(s.runtime.groupJob.messageId);assert.equal(s.model.requests.length,0);
  await assert.rejects(panelAction(s.runtime,'qq-group-task',{groupId:'9',request:'发个表情包'},signal),/已经允许/);s.runtime.settings.qq.groupChat.allowOwnerTasks=false;await panelAction(s.runtime,'qq-group-task',{groupId:'8',request:'发个表情包'},signal);await wait(()=>s.runtime.groupJob.status!=='running');assert.equal(s.runtime.groupJob.status,'error');assert.equal(s.sent.length,1);
 }finally{await s.close();}
});
test('未知群号不会误投唯一群，纯查询与否定指令不执行群发送',async()=>{
 const s=await setup();try{await assert.rejects(s.runtime.qqGroups.route('去999999群发个表情包','wrong',AbortSignal.timeout(3000)),/不在已加入且允许/);assert.equal(groupEmojiRequested('不要去群里发个表情包'),false);assert.equal(groupPostRequested('你记得去群里发过什么吗'),false);assert.equal(groupPostRequested('去游戏群看看聊天'),false);assert.equal(s.sent.length,0);assert.equal(s.model.requests.length,0);}finally{await s.close();}
});
test('先发普通图、再单独问这张图：原附件真正进入一次视觉调用，预览和用量可核对',async()=>{
 const s=await setup(new Model(()=>({summary:'小猫抱着红球',reply:'它抱得还挺紧，主人别抢它的小球呀。'})),f=>Object.assign(f.settings.media,{enabled:true,mode:'ask'}));
 try{s.send('',510,1,0,false,undefined,picture());await completed(s,1);assert.equal(s.model.requests.length,0);s.send('看看这张图',511,1,0);await completed(s,2);assert.equal(s.model.requests.length,1);assert.equal(s.model.requests[0].messages.flatMap(m=>m.content).filter(c=>c.type==='image').length,1);assert.equal(s.runtime.media.lastStatus.stage,'完成');assert.equal(s.runtime.media.lastStatus.imageCount,1);assert.ok(s.runtime.media.lastStatus.sourceBytes);const preview=await panelAction(s.runtime,'media-preview',{source:'qq'},AbortSignal.timeout(3000)) as any;assert.match(preview.images[0],/^data:image\/jpeg;base64,/);assert.equal(dailyUsage(s.runtime.memory).categories.find(c=>c.category==='qq-media')?.calls,1);assert.match(s.sent[1].params.message[0].data.text,/别抢/);
 }finally{await s.close();}
});
test('单独发表情在按需模式也理解后接反应，内部动作摘要不发成聊天说明',async()=>{
 const s=await setup(new Model(()=>({summary:'一个小人搓雪球后朝镜头扔出',reply:'哎呀，主人偷袭我！我也捏一个丢回去。'})),f=>Object.assign(f.settings.media,{enabled:true,mode:'ask',reactToEmoji:true}));
 try{s.send('',512,1,0,false,undefined,picture(true));await completed(s,1);assert.equal(s.model.requests.length,1);assert.equal(s.model.requests[0].messages.flatMap(m=>m.content).filter(c=>c.type==='image').length,1);assert.match(s.model.requests[0].system||'',/不默认解释表情含义/);assert.match(s.model.requests[0].system||'',/只有明确问什么意思/);const out=s.sent[0].params.message[0].data.text;assert.match(out,/偷袭/);assert.doesNotMatch(out,/一个小人搓雪球|含义|客观画面/);assert.ok(s.runtime.memory.fastContext('owner','qq:private:1').todayNotes.includes('搓雪球'));
 }finally{await s.close();}
});
test('群友自主接话的图片不再走纯文字分支，同次识图可以选择旁听，不发JSON或警告',async()=>{
 const s=await setup(new Model(()=>({summary:'猫抱着红球',reply:null})),f=>Object.assign(f.settings.media,{enabled:true,mode:'auto'}));
 try{s.send('这猫有点可爱',513,3,8,false,undefined,picture());await wait(()=>s.model.requests.length===1&&s.runtime.qqConversation.status().active===0);assert.equal(s.model.requests[0].messages.flatMap(m=>m.content).filter(c=>c.type==='image').length,1);assert.equal(s.sent.length,0);assert.equal(s.runtime.media.lastStatus.stage,'完成');assert.match(s.runtime.groupChat.status().last.message,/旁听/);assert.equal(s.runtime.memory.db.prepare("SELECT count(*) AS n FROM media_cache").get()?.n,1);}finally{await s.close();}
});
test('模型说看不到或全是空白时不缓存成识图成功，非空实际附件可预览，群内不发故障提示',async()=>{
 const s=await setup(new Model(()=>({summary:'看不到图片里的东西，全是空白一片',reply:'你能描述一下图片里有什么吗？'})),f=>Object.assign(f.settings.media,{enabled:true,mode:'auto'}));
 try{s.send('',514,1,0,false,undefined,picture(true));await completed(s,1);assert.equal(s.model.requests.length,1);assert.equal(s.runtime.memory.db.prepare('SELECT count(*) AS n FROM media_cache').get()?.n,0);assert.match(s.runtime.media.lastStatus.message,/没有确认读到有效图片/);assert.equal(s.runtime.media.lastStatus.imageFacts?.[0]?.nearlyBlank,false);assert.ok(s.runtime.media.imagePreviews.length);assert.doesNotMatch(s.sent[0].params.message[0].data.text,/描述一下|换一张/);
  s.send('看看这张图',515,1,8,true,undefined,picture(true));await wait(()=>s.model.requests.length===2&&s.runtime.qqConversation.status().active===0);assert.equal(s.sent.length,1);assert.equal(s.runtime.memory.db.prepare('SELECT count(*) AS n FROM media_cache').get()?.n,0);
 }finally{await s.close();}
});
test('最近图片引用按角色、QQ账号、会话、发言人和30分钟隔离，跨会话不取图',()=>{
 const f=fixture();let now=Date.now();const m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory,()=>now),store=new QQRecentMedia(m),base:QQMessage={id:'media',selfId:'2',userId:'1',thread:'qq:group:8',scope:'qq:group:8',groupId:'8',owner:false,text:'',media:[{type:'image',url:'https://gchat.qpic.cn/a.png'}]};
 try{store.remember(base);const ask={...base,text:'看看这张图',media:[]};assert.ok(store.followup(ask));for(const patch of [{selfId:'4'},{userId:'3'},{scope:'owner'},{thread:'qq:group:9'},{replyId:'9'}])assert.equal(store.followup({...ask,...patch}),undefined);assert.equal(store.followup({...ask,text:'去看看群里聊天'}),undefined);now+=31*60000;assert.equal(store.followup(ask),undefined);}finally{m.close();f.cleanup();}
});
test('关键词只用配置的一个回应概率，不再乘普通概率；冷却和0%可解释',async()=>{
 const s=await setup(new Model(()=> '主人，我在呢。'),f=>{f.settings.qq.groupChat.enabled=false;Object.assign(f.settings.qq,{keywordWakeEnabled:true,wakeWords:['鱼'],keywordWakeChance:80,keywordCooldownSeconds:60});Object.assign(f.settings.qq.chat,{enabled:true,ownerReplyChance:0,replyChance:0,delayMinSeconds:0,delayMaxSeconds:0,mergeWindowSeconds:0});});(s.runtime.qqConversation as any).random=()=>.5;
 try{s.send('鱼，你在吗',516,1,8);await completed(s,1);assert.equal(s.model.requests.length,1);assert.equal(s.runtime.qqConversation.status().decisions[0]?.chance,80);assert.equal(s.runtime.qqConversation.status().decisions[0]?.roll,50);s.send('鱼，听到没有',517,1,8);await wait(()=>s.runtime.qqConversation.status().decisions[0]?.id.endsWith(':517')||false);assert.equal(s.runtime.qqConversation.status().decisions[0]?.selected,false);assert.match(s.runtime.qqConversation.status().decisions[0]?.reason||'',/冷却/);s.runtime.settings.qq.keywordCooldownSeconds=0;s.runtime.settings.qq.keywordWakeChance=0;s.send('鱼，你看看',518,1,8);await wait(()=>s.runtime.qqConversation.status().decisions[0]?.id.endsWith(':518')||false);assert.equal(s.runtime.qqConversation.status().decisions[0]?.chance,0);assert.equal(s.runtime.qqConversation.status().decisions[0]?.selected,false);assert.equal(s.model.requests.length,1);
 }finally{await s.close();}
});
test('好感和五种愿望30起步，真实主人回复只按一轮记一次，重启保留且按角色和主人隔离',()=>{
 const f=fixture(),path=join(f.dir,'relationship.sqlite');f.settings.qq.ownerQQ='1';let m=new MemoryStore(path,f.settings.roleId,'UTC',f.settings.memory);
 try{assert.equal(relationship(m,f.settings).affection,30);assert.deepEqual(Object.values(relationship(m,f.settings).motives),[30,30,30,30,30]);ownerInteraction(m,f.settings,'turn-a','今天上班有点烦恼');ownerInteraction(m,f.settings,'turn-a','今天上班有点烦恼');assert.equal(relationship(m,f.settings).affection,31);assert.equal(relationship(m,f.settings).motives.care,31);wantedContact(m,f.settings,'desire-a','play','想邀请主人一起猜个谜');assert.equal(relationship(m,f.settings).motives.play,32);m.close();m=new MemoryStore(path,f.settings.roleId,'UTC',f.settings.memory);assert.equal(relationship(m,f.settings).affection,31);assert.equal(relationship(m,f.settings).motives.play,32);f.settings.qq.ownerQQ='3';assert.equal(relationship(m,f.settings).affection,30);const other=new MemoryStore(path,'other-role','UTC',f.settings.memory);try{f.settings.qq.ownerQQ='1';assert.equal(relationship(other,f.settings).affection,30);}finally{other.close();}}finally{m.close();f.cleanup();}
});
test('主动联系由模型同次自行选择动机和原因，只增加对应愿望，不使用旧手动权重',async()=>{
 const s=await setup(new Model(()=>({send:true,motive:'play',text:'主人，要不要猜个谜？',reason:'刚想到一个字谜，想和主人一起玩'})));let p:Proactive|undefined;
 try{Object.assign(s.runtime.settings.proactive,{enabled:true,company:999999,play:0});p=new Proactive(s.ctx,s.runtime.settings,s.runtime.memory,s.runtime.qq,async run=>run(),()=>{},()=>0);await p.run();assert.equal(s.model.requests.length,1);assert.match(s.model.requests[0].system||'',/自己选择为什么想联系/);assert.doesNotMatch(s.model.requests[0].system||'',/按权重抽中的动机/);assert.equal(p.status().relationship.motives.play,32);assert.equal(p.status().relationship.motives.company,30);assert.equal(p.status().relationship.affection,30);assert.match(p.status().relationship.lastReason,/字谜/);assert.equal(s.sent[0].params.user_id,'1');assert.equal(dailyUsage(s.runtime.memory).categories.find(c=>c.category==='qq-proactive')?.calls,1);}finally{p?.stop();await s.close();}
});
test('分气泡真实发送后好感只增长一次，纯群友交流不改主人好感',async()=>{
 const s=await setup(new Model(()=> '主人，听你说。\n\n今天哪里累呀？'),f=>Object.assign(f.settings.qq.chat,{splitEnabled:true,maxParts:2,partGapMinSeconds:0,partGapMaxSeconds:0}));
 try{s.send('今天有点难过',519,1,0);await completed(s,2);assert.equal(relationship(s.runtime.memory,s.runtime.settings).affection,31);assert.equal(relationship(s.runtime.memory,s.runtime.settings).motives.care,31);s.send('大家好',520,3,8,true);await completed(s,4);assert.equal(relationship(s.runtime.memory,s.runtime.settings).affection,31);}finally{await s.close();}
});
test('主人明确看BV视频直接执行真实下载和内置解码，再按结果分享；关闭时给明确入口不假称观看',async()=>{
 const s=await setup(new Model((_o,index)=>index===0?{summary:'红色演示画面',reply:'视频里是红色的演示背景。'}:'主人，刚看了红色演示片段。'),f=>{f.settings.bilibili.enabled=true;Object.assign(f.settings.biliVision,{enabled:true,frames:2});});let vision:BiliVision|undefined,driver:ChatDriver|undefined;
 try{const file=join(s.f.dir,'video.mp4');execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=160x120:r=5:d=2','-threads','1','-pix_fmt','yuv420p','-y',file]);const bytes=readFileSync(file);let downloads=0;writeFileSync(join(s.f.dir,'bilibili.cookies.json'),JSON.stringify({SESSDATA:'fake-session',bili_jct:'fake-csrf'}));const fetcher:typeof fetch=async(url)=>{const u=new URL(String(url)),json=(data:any)=>Response.json({code:0,data});if(u.hostname.endsWith('bilivideo.com')){downloads++;return new Response(bytes);}if(u.pathname.endsWith('/view'))return json({aid:123,bvid:'BV1xx411c7mD',title:'演示视频',owner:{name:'演示作者'},cid:999,duration:2,pages:[{cid:999,duration:2}]});if(u.pathname.endsWith('/nav'))return json({isLogin:true,mid:2,wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/bfs/wbi/'+'b'.repeat(32)+'.png'}});if(u.pathname.endsWith('/playurl'))return json({timelength:2000,dash:{duration:2,video:[{id:16,codecid:7,bandwidth:100000,baseUrl:'https://upos-test.bilivideo.com/v.mp4'}]}});if(u.pathname.endsWith('/v2'))return json({subtitle:{subtitles:[]}});throw Error('unexpected '+u.pathname);};const bili=new BilibiliClient(s.runtime.settings,s.runtime.memory,fetcher);vision=new BiliVision(s.ctx,s.runtime.settings,s.runtime.memory,bili,fetcher);driver=new ChatDriver(s.ctx,s.runtime.settings,s.runtime.memory,bili,vision);
  const input={scope:'owner',thread:'qq:private:1',owner:true,platform:'qq' as const,speakerId:'1',text:'看看 https://www.bilibili.com/video/BV1xx411c7mD/ 里面有什么'};assert.ok(biliWatchIntent(input.text));assert.equal(biliWatchIntent('不要看BV1xx411c7mD'),undefined);assert.match(await driver.reply(input)||'',/红色/);assert.equal(downloads,1);assert.equal(vision.lastStatus.stage,'完成');assert.equal(vision.lastStatus.images,1);assert.ok(vision.lastStatus.frames);assert.ok(vision.imagePreviews.length);assert.equal(s.model.requests.length,2);assert.equal(s.model.requests[0].messages.flatMap(m=>m.content).filter(c=>c.type==='image').length,1);s.runtime.settings.biliVision.enabled=false;assert.match(await driver.reply({...input,text:'看一下BV1xx411c7mD里面的内容'})||'',/视频内容识别还没开启/);assert.equal(s.model.requests.length,2);assert.equal(downloads,1);
 }finally{await driver?.stop();vision?.stop();await s.close();}
});

test('只在桥接明确不支持原生收藏接口时用同账号原图兼容发送，目标仍为群',async()=>{
 const s=await setup(new Model(()=>assert.fail('不应调用模型')),f=>Object.assign(f.settings.emoji,{sendAllowGroups:true,sendMinGapSeconds:0}));
 try{s.unsupported();s.send('去游戏群发个表情包',521,1,0);await completed(s,3);assert.equal(s.sent[0].action,'send_custom_face');assert.equal(s.sent[1].action,'send_group_msg');assert.equal(s.sent[1].params.group_id,'8');assert.ok(!('user_id' in s.sent[1].params));assert.equal(s.sent[1].params.message[0].type,'image');assert.equal(s.sent[1].params.message[0].data.sub_type,1);assert.equal(s.sent[1].params.message[0].data.file,'https://p.qpic.cn/old-a.png');assert.equal(s.sent[2].action,'send_private_msg');assert.equal(s.model.requests.length,0);assert.ok(s.runtime.qqGroups.status().last.messageId);}finally{await s.close();}
});
test('问我发的表情是什么意思是识图追问，不会误触发给当前窗口发收藏',async()=>{
 const s=await setup(new Model(()=>({summary:'小人丢雪球表达玩闹',reply:'主人，这是朝我丢雪球玩呢。'})),f=>Object.assign(f.settings.media,{enabled:true,mode:'ask',reactToEmoji:false}));
 try{assert.equal(wantsEmoji('我发的这个表情包是什么意思'),false);assert.equal(wantsEmoji('你看到我给你发的表情包了吗'),false);assert.equal(wantsEmoji('你给我发一个表情包看看'),true);s.send('',522,1,0,false,undefined,picture(true));await completed(s,1);s.send('我发的这个表情包是什么意思',523,1,0);await completed(s,2);assert.equal(s.model.requests.length,1);assert.equal(s.sent.filter(q=>q.action==='send_custom_face').length,0);assert.equal(s.model.requests[0].messages.flatMap(m=>m.content).filter(c=>c.type==='image').length,1);}finally{await s.close();}
});
test('QQ能按原发言人索引定位旧版B站@原话、视频和已回复内容，其他人及群里不自动取私聊范围',async()=>{
 const s=await setup(new Model(()=> '主人，你昨天让我看的是那个视频，咱们接着在这里聊。'),f=>{f.settings.biliSocial.ownerUids=['11'];});
 try{const m=s.runtime.memory,at=m.clock()-86400000,thread='bilibili:comment:123:456',key='bili-mention:2:old';m.append(thread,'bilibili',thread,'user','@伙伴 看一下这个视频，试试里面的说话方式',key,at,'',{turnId:key,speakerId:'11',speakerName:'主人B站昵称'});m.append(thread,'bilibili',thread,'assistant','看到了里面的接话方式，先顺着情绪接梗。',key+':reply',at+1000,'',{turnId:key,speakerId:'2',speakerName:'伙伴'});
  const ask='能按照我刚刚艾特你的视频对我吗';assert.match(biliReferenceContext(m,s.runtime.settings,{owner:true,thread:'qq:private:1',text:ask}),/av123/);assert.equal(biliReferenceContext(m,s.runtime.settings,{owner:false,thread:'qq:private:3',text:ask}), '');assert.equal(biliReferenceContext(m,s.runtime.settings,{owner:true,public:true,thread:'bilibili:comment:321:654',text:ask}), '');assert.equal(biliReferenceContext(m,s.runtime.settings,{owner:true,thread:'qq:group:8',text:ask}), '');
  s.send(ask,524,1,0);await completed(s,1);const prompt=JSON.stringify(s.model.requests[0]);assert.match(prompt,/主人B站昵称/);assert.match(prompt,/av123/);assert.match(prompt,/先顺着情绪接梗/);assert.match(prompt,/不能只用/);assert.equal(s.model.requests.length,1);
  s.send(ask,525,3,0);await completed(s,2);const other=JSON.stringify(s.model.requests[1]);assert.doesNotMatch(other,/主人B站昵称|av123|先顺着情绪接梗/);
 }finally{await s.close();}
});
test('看指定视频后还有评论要求时保留发布工具，只看一次且用真实回执确认',async()=>{
 const calls:StreamChunk[]=[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:'comment-after-watch' as any,name:'shiguang_bili_comment',arguments:JSON.stringify({video:'BV1xx411c7mD',text:'这个小细节太好笑了'})}},{type:'finish',reason:{kind:'tool-calls'}}];
 const s=await setup(new Model((_o,i)=>i===0?calls:'主人，看过也留言啦。'),f=>{f.settings.bilibili.enabled=true;f.settings.bilibili.allowComments=true;f.settings.biliVision.enabled=true;});let driver:ChatDriver|undefined,watches=0,posts=0;
 try{const bili=new BilibiliClient(s.runtime.settings,s.runtime.memory);bili.comment=async()=>{posts++;return {rpid:'7788',url:'https://www.bilibili.com/video/BV1xx411c7mD/#reply7788'};};const vision={watch:async()=>{watches++;return '实际画面摘要：一个小人把雪球丢出镜头。';}} as unknown as BiliVision;driver=new ChatDriver(s.ctx,s.runtime.settings,s.runtime.memory,bili,vision);await driver.reply({scope:'owner',thread:'qq:private:1',owner:true,platform:'qq',speakerId:'1',text:'看一下BV1xx411c7mD的视频内容然后留个评论'});assert.equal(watches,1);assert.equal(posts,1);assert.equal(s.model.requests.length,2);assert.ok(s.model.requests[0].tools?.some(t=>t.name==='shiguang_bili_comment'));assert.ok(!s.model.requests[0].tools?.some(t=>t.name==='shiguang_bili_watch'));assert.match(JSON.stringify(s.model.requests[0]),/把雪球丢出镜头/);assert.match(JSON.stringify(s.model.requests[1]),/7788/);assert.equal(biliWatchIntent('查看 av123'),undefined);}finally{await driver?.stop();await s.close();}
});
test('新旧设置保存重载后概率和媒体开关真正生效，旧手动动机字段不再决定状态',async()=>{
 const s=await setup(new Model(()=> '主人，在呢。'));try{const view=s.runtime.view(),next=structuredClone(view.settings);Object.assign(next.qq.chat,{enabled:true,ownerReplyChance:0,replyChance:0,delayMinSeconds:0,delayMaxSeconds:0,mergeWindowSeconds:0});Object.assign(next.qq.groupChat,{enabled:true,ownerReplyChance:91,mentionReplyChance:100});Object.assign(next.media,{enabled:true,reactToEmoji:false,mode:'ask'});Object.assign(next.proactive,{company:999999,share:0});await s.runtime.save(next,view.revision);await s.runtime.qq.ready();assert.equal(s.runtime.auditSettings().consistent,true);const disk=JSON.parse(readFileSync(join(s.f.dir,'config.json'),'utf8'));assert.equal(disk.qq.groupChat.ownerReplyChance,91);assert.equal(disk.media.reactToEmoji,false);assert.ok(!Object.hasOwn(disk.proactive,'company'));assert.equal(relationship(s.runtime.memory,s.runtime.settings).motives.company,30);
  s.send('主人私聊概率0本轮不回',526,1,0);await wait(()=>s.runtime.qqConversation.status().decisions[0]?.id.endsWith(':526')||false);assert.equal(s.model.requests.length,0);assert.equal(s.runtime.qqConversation.status().decisions[0]?.chance,0);s.send('明确@独立100',527,1,8,true);await completed(s,1);assert.equal(s.runtime.qqConversation.status().decisions[0]?.chance,100);assert.equal(s.runtime.qqConversation.status().decisions[0]?.selected,true);assert.equal(s.model.requests.length,1);
 }finally{await s.close();}
});

test('群原文中的否定、群号和表情词只作为文字，不改成收藏或误选正文里提到的群',async()=>{
 const s=await setup(new Model(()=>assert.fail('明确原文无需模型')),f=>{f.settings.qq.allowedGroups.push('9');f.settings.emoji.sendAllowGroups=true;});
 try{s.send('去游戏群说：不要在群里发个表情包，提醒群号9的朋友',528,1,0);await completed(s,2);assert.equal(s.sent[0].action,'send_group_msg');assert.equal(s.sent[0].params.group_id,'8');assert.equal(s.sent[0].params.message[0].data.text,'不要在群里发个表情包，提醒群号9的朋友');assert.equal(s.sent.filter(q=>q.action==='send_custom_face').length,0);assert.equal(s.model.requests.length,0);}finally{await s.close();}
});
test('表情情绪词碰巧等于某个群名时不能据此选择目的群，需明确确认',async()=>{
 const s=await setup(new Model(()=>assert.fail('待确认任务不应让模型选群')),f=>{f.settings.qq.allowedGroups.push('9');Object.assign(f.settings.emoji,{sendAllowGroups:true,sendMinGapSeconds:0});});
 try{s.groups[0]!.group_name='开心';s.details[0].desc='开心摇摆';s.send('去群里发个开心的表情包',529,1,0);await completed(s,1);assert.equal(s.sent[0].action,'send_private_msg');assert.match(s.sent[0].params.message[0].data.text,/明确目标群/);s.send('闲聊群',530,1,0);await completed(s,3);assert.equal(s.sent[1].action,'send_custom_face');assert.equal(s.sent[1].params.group_id,'9');assert.equal(s.model.requests.length,0);}finally{await s.close();}
});

