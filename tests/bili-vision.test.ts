import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {Context} from '@deepseek-ai/cordis';
import {LlmAdapter,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {LocalAttachmentStore} from '@deepseek-ai/dsh-attachment-local';
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit';
import {BiliVision,biliContentURL,sampleSubtitles} from '../src/bili-vision.js';
import {BilibiliClient} from '../src/bilibili.js';
import {MemoryStore} from '../src/memory.js';
import {dailyUsage} from '../src/usage.js';
import {fixture} from './helpers.js';

class Vision extends LlmAdapter {
 requests:GenerateOptions[]=[];
 async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text','image'] as any};}
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{this.requests.push(options);const text=JSON.stringify({summary:'红色画面，字幕介绍吉他的持琴姿势。',reply:'画面是红色演示背景，字幕主要讲持琴姿势。'});yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'usage',usage:{inputTokens:300,outputTokens:80}};yield {type:'finish',reason:{kind:'stop'}};}
}
const video={aid:123,bvid:'BV1xx411c7mD',title:'吉他演示',desc:'基础姿势',owner:{name:'测试作者'},cid:999,duration:2,pages:[{cid:999,duration:2}]};
test('B 站内容使用真实 FFmpeg 与 DSH 视觉：一张关键帧图及字幕、摘要复用、独立用量和临时文件清理',async()=>{
 const f=fixture(),ctx=new Context(),memory=new MemoryStore(':memory:',f.settings.roleId,f.settings.timezone,f.settings.memory),model=new Vision();let reader:BiliVision|undefined,videoDownloads=0,preview=false,blocked=false;
 try{
  const file=join(f.dir,'source.mp4');execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=320x180:r=5:d=2','-threads','1','-pix_fmt','yuv420p','-y',file]);const bytes=readFileSync(file);
  f.settings.bilibili.enabled=true;Object.assign(f.settings.biliVision,{enabled:true,provider:'bili-vision-test',model:'image',dailyLimit:2});
  writeFileSync(join(f.dir,'bilibili.cookies.json'),JSON.stringify({SESSDATA:'test-session',bili_jct:'test-csrf'}));
  const fetcher:typeof fetch=async(url,init)=>{
   const u=new URL(String(url));
   if(u.hostname.endsWith('bilivideo.com')){videoDownloads++;assert.equal(new Headers(init?.headers).has('Cookie'),false);return new Response(bytes);}
   if(u.hostname==='aisubtitle.hdslb.com')return Response.json({body:[{from:0,to:1,content:'吉他持琴姿势'},{from:1,to:2,content:'注意放松手腕'}]});
   const json=(data:unknown)=>Response.json({code:0,data});
   if(u.pathname.endsWith('/view'))return json(video);
   if(u.pathname.endsWith('/nav'))return json({isLogin:true,wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/bfs/wbi/'+'b'.repeat(32)+'.png'}});
   if(u.pathname.endsWith('/playurl'))return json({timelength:2000,is_preview:preview,dash:{duration:2,video:[{id:64,codecid:7,bandwidth:1000000,baseUrl:'https://upos-test.bilivideo.com/high.mp4'},{id:16,codecid:7,bandwidth:100000,baseUrl:blocked?'http://127.0.0.1/private':'https://upos-test.bilivideo.com/low.mp4'}]}});
   if(u.pathname.endsWith('/v2'))return json({subtitle:{subtitles:[{lan:'zh-CN',subtitle_url:'//aisubtitle.hdslb.com/sample.json'}]}});
   throw Error('Unexpected request '+u.pathname);
  };
  await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);new LocalAttachmentStore(ctx,{dshHome:join(f.dir,'attachments')});ctx.llm.registerAdapter(['bili-vision-test'],model);
  reader=new BiliVision(ctx,f.settings,memory,new BilibiliClient(f.settings,memory,fetcher),fetcher);
  const result=await reader.watch(video.bvid,'视频里在做什么？');assert.match(result,/持琴/);assert.match(result,/节选的平台字幕/);assert.equal(model.requests.length,1);assert.equal(videoDownloads,1);
  const request=model.requests[0]!;assert.equal(request.messages.flatMap(m=>m.content).filter(b=>b.type==='image').length,1);assert.equal(request.maxTokens,480);assert.equal(request.tools,undefined);assert.match(JSON.stringify(request.messages),/注意放松手腕/);assert.doesNotMatch(JSON.stringify(request),/test-session|test-csrf/);
  assert.match(await reader.watch(video.bvid,'还有什么？'),/复用/);assert.equal(videoDownloads,1);assert.equal(model.requests.length,1);
  const usage=dailyUsage(memory);assert.equal(usage.total.total,380);assert.equal(usage.categories[0]?.category,'bilibili-video');assert.match(memory.fastContext('owner','bilibili').todayNotes,/识别视频/);assert.deepEqual(readdirSync(join(f.dir,'bili-video-tmp')),[]);
  memory.db.exec('DELETE FROM media_cache');preview=true;await assert.rejects(reader.watch(video.bvid),/播放权限/);assert.equal(model.requests.length,1);
  preview=false;blocked=true;await assert.rejects(reader.watch(video.bvid),/视频流/);assert.equal(model.requests.length,1);
  f.settings.biliVision.maxDurationSeconds=1;await assert.rejects(reader.watch(video.bvid),/超过/);
 }finally{reader?.stop();await ctx.fiber.dispose();memory.close();f.cleanup();}
});
test('B 站媒体地址不能跳到任意主机，字幕按时间取有限片段，关闭功能不请求平台',async()=>{
 assert.equal(biliContentURL('https://upos-sz.bilivideo.com/a.mp4').hostname,'upos-sz.bilivideo.com');
 for(const u of ['http://127.0.0.1/a','https://bilivideo.com.attacker.test/a','https://user@upos.bilivideo.com/a','https://upos.bilivideo.com:22/a'])assert.throws(()=>biliContentURL(u));
 const lines=Array.from({length:100},(_,i)=>({from:i,content:'内容'+i}));const sampled=sampleSubtitles({body:lines},1000);assert.match(sampled,/内容0/);assert.match(sampled,/内容99/);assert.ok(sampled.length<=1000);
 const f=fixture(),ctx=new Context(),memory=new MemoryStore(':memory:',f.settings.roleId,f.settings.timezone,f.settings.memory);let calls=0;
 const reader=new BiliVision(ctx,f.settings,memory,new BilibiliClient(f.settings,memory,async()=>{calls++;throw Error('must not request')}));
 try{await assert.rejects(reader.watch(video.bvid),/开启/);assert.equal(calls,0);}finally{reader.stop();await ctx.fiber.dispose();memory.close();f.cleanup();}
});
