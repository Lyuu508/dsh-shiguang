import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {LocalAttachmentStore} from '@deepseek-ai/dsh-attachment-local';
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit';
import {LlmAdapter,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {Context} from '@deepseek-ai/cordis';
import {HostConnectionService} from '@deepseek-ai/dsh-client-connection';
import {WebSocketServer} from 'ws';
import {once} from 'node:events';
import {build} from 'esbuild';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from '../helpers.js';
import {ShiguangRuntime} from '../../src/runtime.js';
import {registerPanelApi} from '../../src/panel-api.js';
import {createHash} from 'node:crypto';
import {recordUsage} from '../../src/usage.js';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
const f=fixture(),ctx=new Context(),qq=new WebSocketServer({port:0,host:'127.0.0.1'});
await once(qq,'listening');const address=qq.address();if(!address||typeof address==='string')throw new Error('mock QQ did not bind');
f.settings.qq.wsUrl=`ws://127.0.0.1:${address.port}`;f.settings.qq.ownerQQ='10001';
qq.on('connection',socket=>socket.on('message',raw=>{const request=JSON.parse(raw.toString());socket.send(JSON.stringify({status:'ok',retcode:0,echo:request.echo,data:request.action==='get_status'?{online:true,good:true}:{user_id:10002,nickname:'模拟QQ伙伴'}}));}));
const audio=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=0.2','-f','mp3','pipe:1']);
const videoFile=join(f.dir,'browser-video.mp4');execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=320x180:r=5:d=2','-threads','1','-pix_fmt','yuv420p','-y',videoFile]);const videoBytes=readFileSync(videoFile);
class BrowserVision extends LlmAdapter {
 async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text','image'] as any};}
 async *stream(_options:GenerateOptions):AsyncIterable<StreamChunk>{const text=JSON.stringify({summary:'红色画面配有吉他姿势字幕。',reply:'抽样画面是红色背景，字幕讲吉他持琴姿势。'});yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'usage',usage:{inputTokens:300,outputTokens:80}};yield {type:'finish',reason:{kind:'stop'}};}
}
await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);new LocalAttachmentStore(ctx,{dshHome:join(f.dir,'attachments')});ctx.llm.registerAdapter(['browser-vision'],new BrowserVision());
let polls=0,qqPolls=0;
const platform:typeof fetch=async(url)=>{
 if(String(url).includes('openspeech.bytedance.com'))return new Response(JSON.stringify({code:0,data:audio.toString('base64'),usage:{text_words:12}})+'\n'+JSON.stringify({code:20000000}));
 if(String(url).includes('upos-test.bilivideo.com'))return new Response(videoBytes);
 if(String(url).includes('aisubtitle.hdslb.com'))return Response.json({body:[{from:0,content:'吉他持琴姿势'}]});
 if(String(url).includes('/x/web-interface/history/cursor'))return Response.json({code:0,data:{list:[{history:{business:'archive',bvid:'BV1xx411c7mD'}}],cursor:{}}});
 if(String(url).includes('/x/tag/archive/tags'))return Response.json({code:0,data:[{tag_name:'科技'},{tag_name:'天文'}]});
 if(String(url).includes('/x/web-interface/view'))return Response.json({code:0,data:{aid:123,bvid:'BV1xx411c7mD',title:'测试吉他视频',desc:'持琴姿势',owner:{name:'测试作者'},cid:999,duration:2,pages:[{cid:999,duration:2}]}});
 if(String(url).includes('/x/player/wbi/playurl'))return Response.json({code:0,data:{timelength:2000,dash:{duration:2,video:[{id:16,codecid:7,baseUrl:'https://upos-test.bilivideo.com/video.mp4'}]}}});
 if(String(url).includes('/x/player/wbi/v2'))return Response.json({code:0,data:{subtitle:{subtitles:[{lan:'zh-CN',subtitle_url:'//aisubtitle.hdslb.com/subtitle.json'}]}}});
 if(String(url).includes('api.github.com'))return Response.json([{tag_name:'v0.1.100',prerelease:true,body:'测试更新说明：保留原有记忆。'}]);
 if(String(url).includes('raw.githubusercontent.com'))return new Response(String(url).endsWith('.txt')?createHash('sha256').update('browser-package').digest('hex')+'  dsh-shiguang-0.1.100.tgz':'browser-package');
 if(String(url).includes('/generate')){polls=0;return Response.json({code:0,data:{url:'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=browser-test',qrcode_key:'browser-test'}});}
 if(String(url).includes('/spi'))return Response.json({code:0,data:{b_3:'browser-buvid'}});
 if(String(url).includes('search/type'))return Response.json({code:0,data:{result:[]}});
 if(String(url).includes('/nav'))return Response.json({code:0,data:{isLogin:true,mid:123456,uname:'测试B站伙伴',wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/bfs/wbi/'+'b'.repeat(32)+'.png'}}});
 if(++polls<2)return Response.json({code:0,data:{code:86101}});
 const r=Response.json({code:0,data:{code:0}});r.headers.append('Set-Cookie','SESSDATA=browser-fake-session; Path=/');r.headers.append('Set-Cookie','bili_jct=browser-fake-csrf; Path=/');return r;
};
const file=join(f.dir,'config.json');writeFileSync(file,JSON.stringify(f.settings));
const runtime=new ShiguangRuntime(ctx,file,platform);runtime.memory.append('owner','qq','p','note','今天练习 C 和弦');runtime.memory.append('owner','bilibili','bilibili','experience','上周选了雅马哈吉他',undefined,Date.now()-86400000);
runtime.memory.append('qq:group:20001','qq','qq:group:20001','user','测试群今天讨论天文');runtime.memory.append('owner','bilibili','bilibili','experience','观看测试科普视频的抽样画面',undefined,Date.now(),'watch');runtime.memory.append('owner','bilibili','bilibili','experience','在测试科普视频留言：这个实验很清楚。',undefined,Date.now(),'comment');runtime.memory.append('owner','bilibili','bilibili','experience','已点赞测试科普视频',undefined,Date.now(),'like');
ctx.provide('pluginManager',{installBundle:async()=>({application:'restart-required',version:'0.1.100'})} as never);
recordUsage(runtime.memory,{session:'browser-fixture',source:'qq',provider:'fixture',model:'test'},[{type:'assistant/message',seq:1,time:Date.now(),data:{usage:{inputTokens:120,cacheReadTokens:300,outputTokens:80},stream:[],message:{content:[]}}}] as unknown as SessionEvent[]);
const connection=new HostConnectionService(ctx,[],{} as never);registerPanelApi(ctx,runtime);await new Promise(r=>setImmediate(r));
const handler=connection.createSharedFetchHandler('/api');
const result=await build({entryPoints:['tests/browser/harness.tsx'],bundle:true,write:false,format:'iife',platform:'browser',jsx:'transform',define:{'process.env.NODE_ENV':'"development"'}});
const script=result.outputFiles[0]!.contents;
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/harness.js'){res.setHeader('Content-Type','text/javascript');res.end(script);return;}
  if(req.url==='/api/shiguang'){
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
   const request=new Request('http://127.0.0.1:4178/api/shiguang',{method:'POST',headers:{'Content-Type':'application/json'},body:Buffer.concat(chunks)});
   const response=await handler.fetch(request,connection.browserPeer);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>拾光面板联调预览</title><body style="margin:0;background:#f8faf7"><div id="root"></div><script src="/harness.js"></script></body></html>');
 }catch(error){res.statusCode=500;res.end(error instanceof Error?error.message:'test server error');}
});
server.listen(4178,'127.0.0.1',()=>console.log('Shiguang UI test server: http://127.0.0.1:4178'));
async function stop(){server.close();for(const client of qq.clients)client.terminate();qq.close();await runtime.stop();await ctx.fiber.dispose();f.cleanup();process.exit(0);}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
