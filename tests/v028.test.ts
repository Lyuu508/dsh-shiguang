import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import sharp from 'sharp';
import {Context} from '@deepseek-ai/cordis';
import {LlmAdapter,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {LocalAttachmentStore} from '@deepseek-ai/dsh-attachment-local';
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit';
import {fixture} from './helpers.js';
import {frameSheet,frameSheetRange,MediaReader} from '../src/media.js';
import {checkEmbeddedEngine} from '../src/embedded-media.js';
import {MediaToolsManager,cleanupOwnedMediaTools} from '../src/media-tools.js';
import {clockContext} from '../src/time-awareness.js';
import {BodyClock} from '../src/body-clock.js';
import {setState} from '../src/initiative-state.js';
import {think} from '../src/initiative.js';
import {MemoryStore} from '../src/memory.js';
import {ChatDriver} from '../src/agent.js';
import {BilibiliClient} from '../src/bilibili.js';
import type {OneBotClient} from '../src/onebot.js';
const qq={mediaInfo:async()=>({})} as unknown as OneBotClient;
function gif(dir:string){const file=join(dir,'colors.gif');execFileSync('ffmpeg',['-v','error','-filter_complex_threads','1',...['red','white','green','blue'].flatMap(c=>['-f','lavfi','-i',`color=c=${c}:s=64x64:r=10:d=0.3`]),'-filter_complex','[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0','-threads','1','-loop','0','-y',file]);return file;}
async function ends(sheet:Awaited<ReturnType<typeof frameSheet>>){
 const cols=sheet.times.length===1?1:sheet.times.length>4?3:2,cell=sheet.width/cols,last=sheet.times.length-1;
 const pixel=async(x:number,y:number)=>[...await sharp(sheet.bytes).extract({left:Math.floor(x),top:Math.floor(y),width:1,height:1}).removeAlpha().raw().toBuffer()];
 const a=await pixel(cell/2,cell/2),b=await pixel((last%cols+.5)*cell,(Math.floor(last/cols)+.5)*cell);assert.ok(a[0]!>180&&a[2]!<90,'first frame is red');assert.ok(b[2]!>160&&b[0]!<90,'ending is blue, not the poster frame');
}
for(const format of ['gif','webp','apng'])test(`内置 ${format} 动画读取真实变化和末尾，无外部 FFmpeg 程序`,async()=>{
 const f=fixture();try{const source=gif(f.dir),file=join(f.dir,'input.'+format);if(format==='gif')writeFileSync(file,readFileSync(source));else if(format==='webp')await sharp(source,{animated:true}).webp({lossless:true}).toFile(file);else execFileSync('ffmpeg',['-v','error','-i',source,'-vf','format=rgba','-plays','0','-frames:v','12','-f','apng','-y',file]);
  const c={...f.settings.media,ffmpegPath:'missing-exe',ffprobePath:'missing-probe'},sheet=await frameSheet(file,f.dir,c,AbortSignal.timeout(15000));assert.ok(sheet.times.length>=4&&sheet.times.length<=8);assert.ok(sheet.times.some(t=>t>=.9));assert.ok(Math.abs(sheet.duration-1.2)<.1);await ends(sheet);
 }finally{f.cleanup();}
});
for(const [extension,codec] of [['mp4','libx264'],['mp4','mpeg4'],['flv','flv1']] as const)test(`内置视频 ${extension}/${codec} 浅看和分段，不调用用户配置的 exe`,async()=>{
 const f=fixture();try{const source=gif(f.dir),file=join(f.dir,'video.'+extension);execFileSync('ffmpeg',['-v','error','-i',source,'-an','-threads','1','-c:v',codec,'-pix_fmt','yuv420p',...(codec==='mpeg4'?['-movflags','frag_keyframe+empty_moov']:[]),'-y',file]);const c={...f.settings.media,ffmpegPath:'must-not-execute',ffprobePath:'must-not-execute',frames:4};
  const full=await frameSheet(file,f.dir,c,AbortSignal.timeout(15000));await ends(full);const part=await frameSheetRange(file,f.dir,c,AbortSignal.timeout(15000),.6,.6);assert.ok(Math.abs(part.duration-.6)<.01);assert.ok(part.times.every(t=>t>=0&&t<.6));
 }finally{f.cleanup();}
});
test('内置引擎真实启动，任务取消退出且不残留外部进程',async()=>{
 const result=await checkEmbeddedEngine();assert.equal(result.ready,true);assert.match(result.message,/内置/);const f=fixture();try{const file=gif(f.dir),abort=new AbortController();const job=frameSheet(file,f.dir,f.settings.media,abort.signal);setTimeout(()=>abort.abort(),10);await assert.rejects(job,/取消或超时/);await assert.rejects(frameSheet(file,f.dir,f.settings.media,AbortSignal.abort()),/abort|取消|operation/i);}finally{f.cleanup();}
});
function owned(dir:string){const root=join(dir,'media-tools'),digest='a'.repeat(64),bin=join(root,digest,'bin');mkdirSync(bin,{recursive:true});for(const name of ['ffmpeg.exe','ffprobe.exe'])writeFileSync(join(bin,name),'owned-old-tool');writeFileSync(join(root,'installed.json'),JSON.stringify({version:'latest',digest,ffmpeg:digest+'/bin/ffmpeg.exe',ffprobe:digest+'/bin/ffprobe.exe'}));writeFileSync(join(root,'ffmpeg.zip'),'archive');mkdirSync(join(root,'parts'));writeFileSync(join(root,'keep-user.txt'),'user-owned');return {root,digest,bin};}
test('升级先验证内置引擎再清理有记录的旧安装，保留系统和用户文件',async()=>{
 const f=fixture(),o=owned(f.dir),outside=join(f.dir,'system-ffmpeg.exe');writeFileSync(outside,'system');let ready=false;const manager=new MediaToolsManager(f.dir,()=>f.settings,()=>assert.fail('must not write paths'),async()=>assert.fail('must not download'),{check:async()=>({ready,message:ready?'内置引擎可用':'fixture-engine-unavailable'})});
 try{manager.migrate();await manager.whenIdle();assert.equal(existsSync(o.bin),true);ready=true;const result=await manager.check();assert.equal(result.ready,true);assert.equal(existsSync(o.bin),false);assert.equal(existsSync(join(o.root,'installed.json')),false);assert.equal(existsSync(join(o.root,'ffmpeg.zip')),false);assert.equal(existsSync(outside),true);assert.equal(readFileSync(join(o.root,'keep-user.txt'),'utf8'),'user-owned');}finally{manager.stop();f.cleanup();}
});
for(const mode of ['missing','traversal','symlink'])test('旧工具清理拒绝无法证明归属的路径：'+mode,()=>{
 const f=fixture(),o=owned(f.dir);try{const manifest=join(o.root,'installed.json'),m=JSON.parse(readFileSync(manifest,'utf8'));if(mode==='missing')writeFileSync(manifest,'{}');if(mode==='traversal'){m.ffmpeg=o.digest+'/../outside.exe';writeFileSync(manifest,JSON.stringify(m));}if(mode==='symlink'){const outside=join(f.dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'do-not-delete.txt'),'keep');for(const name of ['ffmpeg.exe','ffprobe.exe'])writeFileSync(join(outside,name),'keep');rmSync(o.bin,{recursive:true});symlinkSync(outside,o.bin,'junction');}
  assert.equal(cleanupOwnedMediaTools(f.dir).removed,false);assert.equal(existsSync(o.bin),true);assert.equal(readFileSync(join(o.root,'keep-user.txt'),'utf8'),'user-owned');
 }finally{f.cleanup();}
});
test('时间按角色时区刷新：跨零点、07:30 已起床与夜间临时叫醒，不推断主人睡眠',()=>{
 const f=fixture();f.settings.timezone='Asia/Shanghai';f.settings.clock.enabled=true;f.settings.clock.wakeAt='07:30';f.settings.clock.sleepAt='02:00';let now=Date.parse('2026-11-08T15:59:59Z');const memory=new MemoryStore(':memory:',f.settings.roleId,f.settings.timezone,f.settings.memory,()=>now),body=new BodyClock(f.settings,memory);
 try{assert.match(clockContext(f.settings,memory),/2026-11-08 23:59:59/);now+=1000;assert.match(clockContext(f.settings,memory),/2026-11-09 00:00:00/);now=Date.parse('2026-11-08T23:29:59Z');assert.equal(body.status().sleeping,true);now+=1000;const text=clockContext(f.settings,memory);assert.match(text,/2026-11-09 07:30:00/);assert.match(text,/GMT\+08:00/);assert.match(text,/已起床，正常清醒/);assert.match(text,/不.*认定对方还没睡/);now=Date.parse('2026-11-09T19:00:00Z');setState(memory,'body:awake-until',now+60000);assert.match(clockContext(f.settings,memory),/被叫醒，暂时清醒/);assert.equal(body.status().localTime,'2026-11-10 03:00:00');
 }finally{body.stop();memory.close();f.cleanup();}
});
class Model extends LlmAdapter{requests:GenerateOptions[]=[];async resolveModel(provider:string,id:string){return {provider,id,name:id,inputModalities:['text','image'] as const,reasoning:{efforts:[{id:'off' as any,name:'关闭'}]}};}async *stream(o:GenerateOptions):AsyncIterable<StreamChunk>{this.requests.push(o);const text=o.system?.includes('仅输出 JSON：{"summary"')?'{"summary":"红白绿蓝的色块依次变化","reply":"色块从红色变到了蓝色。"}':'早上好，现在是七点半。';yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'usage',usage:{inputTokens:50,outputTokens:10,totalTokens:60}};yield {type:'finish',reason:{kind:'stop'}};}}
test('真实 DSH AgentLoop、QQ 动图与自主思考都收到新鲜时间，GIF 实际附件一次调用',async()=>{
 const f=fixture(),ctx=new Context(),model=new Model();f.settings.timezone='Asia/Shanghai';f.settings.media.enabled=true;f.settings.media.ffmpegPath='not-installed';f.settings.media.ffprobePath='not-installed';f.settings.clock.enabled=true;f.settings.clock.wakeAt='07:30';let now=Date.parse('2026-11-08T23:30:00Z');await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);new LocalAttachmentStore(ctx,{dshHome:join(f.dir,'attachments')});ctx.llm.registerAdapter(['deepseek-official'],model);const memory=new MemoryStore(':memory:',f.settings.roleId,f.settings.timezone,f.settings.memory,()=>now),bili=new BilibiliClient(f.settings,memory),driver=new ChatDriver(ctx,f.settings,memory,bili),bytes=readFileSync(gif(f.dir)),media=new MediaReader(ctx,f.settings,memory,async()=>new Response(bytes),async()=>assert.fail('must not prepare external tools'));
 try{await driver.reply({scope:'owner',thread:'qq:private:1',owner:true,platform:'qq',text:'现在几点？',speakerId:'1'});assert.match(JSON.stringify(model.requests.at(-1)),/2026-11-09 07:30:00/);now+=61000;await driver.reply({scope:'owner',thread:'bilibili:dm:1:2',owner:true,platform:'bilibili',text:'现在呢？',speakerId:'2'});assert.match(JSON.stringify(model.requests.at(-1)),/2026-11-09 07:31:01/);
  const before=model.requests.length;await media.reply({id:'gif-time',selfId:'2',userId:'1',thread:'qq:private:1',scope:'owner',owner:true,text:'看看动图'},qq,[{type:'image',url:'https://gchat.qpic.cn/colors.gif'}]);assert.equal(model.requests.length,before+1);const request=model.requests.at(-1)!;assert.match(request.system||'',/07:31:01/);assert.equal(request.messages.flatMap(m=>m.content).filter(c=>c.type==='image').length,1);assert.equal(request.reasoningEffort,'off');await think(ctx,f.settings,memory,'qq-proactive','是否找主人聊天',{},100,AbortSignal.timeout(5000));assert.match(model.requests.at(-1)?.system||'',/07:31:01/);
 }finally{media.stop();await driver.stop();memory.close();await ctx.fiber.dispose();f.cleanup();}
});
