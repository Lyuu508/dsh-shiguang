import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { frameSheet, pickFrames, mediaURL, wantsMedia, MediaReader, parseVisionAnswer } from '../src/media.js';
import { MemoryStore } from '../src/memory.js';
import { dailyUsage } from '../src/usage.js';
import type { OneBotClient, QQMessage } from '../src/onebot.js';
import { fixture } from './helpers.js';
import { ShiguangRuntime } from '../src/runtime.js';

export function clip(dir:string):Buffer {
 const file=join(dir,'sample.mp4');
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-filter_complex_threads','1',...['red','white','blue'].flatMap(color=>['-f','lavfi','-i',`color=c=${color}:s=320x180:r=10:d=0.6`]),'-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0','-threads','1','-pix_fmt','yuv420p','-y',file]);
 return readFileSync(file);
}
test('内置引擎抽取真实视频和 GIF，拼图不超过预算，近似画面本机去重',async()=>{
 const f=fixture();try{
  clip(f.dir);const signal=AbortSignal.timeout(20000),sheet=await frameSheet(join(f.dir,'sample.mp4'),f.dir,f.settings.media,signal);
  assert.equal(sheet.times.length,3);assert.ok(sheet.width<=512&&sheet.height<=512);assert.ok(sheet.bytes.length<200000);
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-threads','1','-filter_threads','1','-i',join(f.dir,'sample.mp4'),'-y',join(f.dir,'sample.gif')]);
  const gif=await frameSheet(join(f.dir,'sample.gif'),f.dir,f.settings.media,signal);assert.ok(gif.times.length>=2&&gif.times.length<=3);
  assert.deepEqual(pickFrames(Buffer.alloc(256*3*8,50),3),[0]);
  await assert.rejects(frameSheet(join(f.dir,'sample.mp4'),f.dir,{...f.settings.media,maxDurationSeconds:1},signal),/超过/);
 }finally{f.cleanup();}
});
test('只接受 QQ CDN，拒绝任意地址、认证 URL 和伪装域名；按需触发不调用模型',()=>{
 assert.equal(mediaURL('https://multimedia.nt.qq.com/a?token=sample').hostname,'multimedia.nt.qq.com');
 for(const url of ['http://127.0.0.1/a','http://169.254.169.254/','file:///etc/passwd','https://gchat.qpic.cn.attacker.test/a','https://user:pass@gchat.qpic.cn/a','https://gchat.qpic.cn:8080/a'])assert.throws(()=>mediaURL(url));
 assert.equal(wantsMedia('你好','ask'),false);assert.equal(wantsMedia('看看这个','ask'),true);assert.equal(wantsMedia('你好','auto'),true);
 assert.throws(()=>parseVisionAnswer('{"summary":"未完整返回'),/没有读到/);
});
class Vision extends LlmAdapter {
 requests:GenerateOptions[]=[];
 async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text','image'] as const,reasoning:{efforts:[{id:'off' as any,name:'关闭'}]}};}
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
  this.requests.push(options);const text=JSON.stringify({summary:'红色、白色和蓝色画面依次切换。',reply:'主要是三种颜色在切换。'});
  yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};
  yield {type:'usage',usage:{inputTokens:240,cacheReadTokens:60,outputTokens:70}};yield {type:'finish',reason:{kind:'stop'}};
 }
}
const message:QQMessage={id:'media-test-1',selfId:'2',userId:'1',thread:'qq:private:1',scope:'owner',owner:true,text:'看看主要画面'};
const reference={type:'video' as const,file:'qq-file-id',url:'https://multimedia.nt.qq.com/sample.mp4'};
const qq={mediaInfo:async()=>({})} as unknown as OneBotClient;
test('真实 DSH LLM 与附件服务：一次视觉调用、缓存只传文字、跨会话不复用、每日额度生效',async()=>{
 const f=fixture(),ctx=new Context(),memory=new MemoryStore(':memory:',f.settings.roleId,f.settings.timezone,f.settings.memory),adapter=new Vision();let reader:MediaReader|undefined,fetches=0,prepared=0;
 try{
  const bytes=clip(f.dir);f.settings.media.enabled=true;f.settings.media.provider='deepseek-official';f.settings.media.model='image-model';f.settings.media.dailyLimit=3;
  await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);new LocalAttachmentStore(ctx,{dshHome:join(f.dir,'harness')});ctx.llm.registerAdapter(['deepseek-official'],adapter);
  reader=new MediaReader(ctx,f.settings,memory,async()=>{fetches++;return new Response(bytes);},async()=>{prepared++;});
  assert.equal(await reader.reply(message,qq,[reference]),'主要是三种颜色在切换。');assert.equal(adapter.requests.length,1);
  const first=adapter.requests[0]!;assert.equal(first.messages.flatMap(m=>m.content).filter(b=>b.type==='image').length,1);assert.equal(first.maxTokens,320);assert.equal(first.tools,undefined);
  assert.equal(await reader.reply({...message,id:'2',text:'看看还有什么'},qq,[reference]),'主要是三种颜色在切换。');assert.equal(adapter.requests.length,2);assert.equal(prepared,0);assert.equal(adapter.requests[1]!.messages.flatMap(m=>m.content).filter(b=>b.type==='image').length,0);
  assert.equal(memory.db.prepare("SELECT count(*) AS n FROM memories WHERE kind='experience'").get()?.n,1);
  await reader.reply({...message,id:'3',scope:'qq:group:5',thread:'qq:group:5',owner:false},qq,[reference]);assert.equal(adapter.requests[2]!.messages.flatMap(m=>m.content).filter(b=>b.type==='image').length,1);
  assert.match(await reader.reply({...message,id:'4'},qq,[reference]),/额度已用完/);assert.equal(fetches,3);
  const usage=dailyUsage(memory);assert.equal(usage.total.calls,3);assert.equal(usage.total.total,1110);assert.equal(usage.categories[0]?.category,'qq-media');assert.equal(usage.total.missing,0);
  assert.deepEqual(readdirSync(join(f.dir,'media-tmp')),[]);
 }finally{reader?.stop();await ctx.fiber.dispose();memory.close();f.cleanup();}
});
test('关闭、未触发、纯文本模型和超限下载都不产生模型调用',async()=>{
 const f=fixture(),ctx=new Context(),memory=new MemoryStore(':memory:',f.settings.roleId,f.settings.timezone,f.settings.memory);let reader:MediaReader|undefined;
 try{
  reader=new MediaReader(ctx,f.settings,memory);assert.match(await reader.reply(message,qq,[reference]),/还没打开看视频/);
  f.settings.media.enabled=true;assert.equal(await reader.reply({...message,text:'你好'},qq,[reference]),'嗯，收到了。');
  await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);new LocalAttachmentStore(ctx,{dshHome:join(f.dir,'harness')});
  f.settings.media.provider='deepseek-account';f.settings.media.model='text';class Text extends Vision{async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as any};}}const text=new Text();ctx.llm.registerAdapter(['deepseek-account'],text);
  await assert.rejects(reader.reply(message,qq,[reference]),/Flash 连接未声明支持图片/);assert.equal(text.requests.length,0);
  const vision=new Vision();ctx.llm.registerAdapter(['deepseek-official'],vision);f.settings.media.provider='deepseek-official';f.settings.media.maxFileMB=1;
  reader=new MediaReader(ctx,f.settings,memory,async()=>new Response(Buffer.alloc(1024*1024+1)));await assert.rejects(reader.reply(message,qq,[reference]),/超过/);assert.equal(vision.requests.length,0);assert.equal(dailyUsage(memory).total.calls,0);
  const fetched:string[]=[];reader=new MediaReader(ctx,f.settings,memory,async(url)=>{fetched.push(String(url));return new Response('',{status:302,headers:{location:'http://127.0.0.1/private'}});});
  await assert.rejects(reader.reply(message,qq,[reference]),/下载地址暂时没识别/);assert.equal(fetched.length,1);
 }finally{reader?.stop();await ctx.fiber.dispose();memory.close();f.cleanup();}
});
test('真实 OneBot 媒体链路：收到视频→视觉回答→引用命中摘要→重复事件去重→关闭后不调用模型', {timeout:20000},async()=>{
 const f=fixture(),ctx=new Context(),server=new WebSocketServer({port:0,host:'127.0.0.1'}),adapter=new Vision();let runtime:ShiguangRuntime|undefined;
 await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const received:string[]=[];let socket:import('ws').WebSocket|undefined;
 const event=(id:number,segments:object[])=>({post_type:'message',message_type:'private',message_id:id,self_id:2,user_id:1,message:segments});
 const segments=[{type:'video',data:{file:reference.file,url:reference.url}},{type:'text',data:{text:'看看主要画面'}}];
 async function waitFor(n:number){const until=Date.now()+10000;while(received.length<n){if(Date.now()>until)throw new Error('No QQ receipt');await new Promise(r=>setTimeout(r,25));}}
 try{
  const bytes=clip(f.dir);await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);new LocalAttachmentStore(ctx,{dshHome:join(f.dir,'harness')});ctx.llm.registerAdapter(['deepseek-official'],adapter);
  Object.assign(f.settings.media,{enabled:true,provider:'deepseek-official',model:'image'});Object.assign(f.settings.qq,{enabled:true,ownerQQ:'1',wsUrl:`ws://127.0.0.1:${address.port}`});
  writeFileSync(join(f.dir,'onebot.token'),'local-fake-test-token');const file=join(f.dir,'config.json');writeFileSync(file,JSON.stringify(f.settings));
  server.on('connection',s=>{socket=s;s.on('message',data=>{const v=JSON.parse(data.toString());const result=v.action==='get_msg'?{message_type:'private',user_id:1,message:segments}:v.action==='get_file'?{url:reference.url}:{message_id:100};s.send(JSON.stringify({status:'ok',retcode:0,echo:v.echo,data:result}));if(v.action==='send_private_msg')received.push(v.params.message[0].data.text);});s.send(JSON.stringify(event(1,segments)));});
  runtime=new ShiguangRuntime(ctx,file,async()=>new Response(bytes));await waitFor(1);assert.equal(received[0]!,'主要是三种颜色在切换。');assert.equal(adapter.requests.length,1);
  socket!.send(JSON.stringify(event(1,segments)));socket!.send(JSON.stringify(event(2,[{type:'reply',data:{id:1}},{type:'text',data:{text:'看看这是什么颜色'}}])));await waitFor(2);assert.equal(received[1]!,'主要是三种颜色在切换。');assert.equal(adapter.requests.length,2);
  assert.equal(runtime.memory.db.prepare("SELECT count(*) AS n FROM memories WHERE kind='user'").get()?.n,2);
  const value=runtime.view();value.settings.media.enabled=false;await runtime.save(value.settings,value.revision);await new Promise(r=>setTimeout(r,80));socket!.send(JSON.stringify(event(3,segments)));await waitFor(3);assert.match(received[2]!,/还没打开看视频/);assert.equal(adapter.requests.length,2);
  assert.equal(dailyUsage(runtime.memory).total.calls,2);
 }finally{await runtime?.stop();await ctx.fiber.dispose();for(const s of server.clients)s.terminate();await new Promise<void>(r=>server.close(()=>r()));f.cleanup();}
});
test('本机文件不能越过缓存目录，视觉输出中断仍记 usage 且不自动重试',async()=>{
 const f=fixture(),ctx=new Context(),memory=new MemoryStore(':memory:',f.settings.roleId,f.settings.timezone,f.settings.memory);let reader:MediaReader|undefined;
 class Limited extends Vision{async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{this.requests.push(options);yield {type:'usage',usage:{inputTokens:100,outputTokens:20}};yield {type:'finish',reason:{kind:'max-tokens'}};}}
 try{
  const bytes=clip(f.dir);Object.assign(f.settings.media,{enabled:true,provider:'deepseek-official',model:'image',localMediaDir:join(f.dir,'allowed')});mkdirSync(f.settings.media.localMediaDir);
  await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);new LocalAttachmentStore(ctx,{dshHome:join(f.dir,'harness')});const adapter=new Limited();ctx.llm.registerAdapter(['deepseek-official'],adapter);
  const local={mediaInfo:async()=>({file:join(f.dir,'sample.mp4')})} as unknown as OneBotClient;
  reader=new MediaReader(ctx,f.settings,memory,async()=>new Response(bytes));await assert.rejects(reader.reply(message,local,[{type:'video',file:'id'}]),/允许的缓存目录/);assert.equal(adapter.requests.length,0);
  await assert.rejects(reader.reply(message,qq,[reference]),/未完整返回/);assert.equal(adapter.requests.length,1);assert.equal(dailyUsage(memory).total.total,120);assert.equal(dailyUsage(memory).total.calls,1);assert.equal(memory.db.prepare('SELECT count(*) AS n FROM media_cache').get()?.n,0);
 }finally{reader?.stop();await ctx.fiber.dispose();memory.close();f.cleanup();}
});
