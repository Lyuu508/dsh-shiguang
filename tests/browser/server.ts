import {listSlang} from '../../src/slang.js';
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
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from '../helpers.js';
import {ShiguangRuntime} from '../../src/runtime.js';
import {registerPanelApi} from '../../src/panel-api.js';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash,scryptSync} from 'node:crypto';
import {recordUsage} from '../../src/usage.js';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
const f=fixture(),ctx=new Context(),qq=new WebSocketServer({port:0,host:'127.0.0.1'});
await once(qq,'listening');const address=qq.address();if(!address||typeof address==='string')throw new Error('mock QQ did not bind');
f.settings.qq.wsUrl=`ws://127.0.0.1:${address.port}/`;f.settings.qq.ownerQQ='10001';
const qqSent:any[]=[];
qq.on('connection',socket=>socket.on('message',raw=>{const request=JSON.parse(raw.toString());if(request.action.startsWith('send_'))qqSent.push(request);const data=request.action==='get_group_list'?[{group_id:20001,group_name:'游戏群'},{group_id:20002,group_name:'闲聊群'}]:request.action==='get_status'?{online:true,good:true}:request.action==='fetch_custom_face_detail'?[{emoji_id:'browser-animated-face',resId:'browser-animated-face',desc:'开心摇摆',url:'https://gchat.qpic.cn/frame-029.gif'}]:request.action.startsWith('send_')?{message_id:91001}:{user_id:10002,nickname:'模拟QQ伙伴'};socket.send(JSON.stringify({status:'ok',retcode:0,echo:request.echo,data}));}));
const audio=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=0.2','-f','mp3','pipe:1']);
const videoFile=join(f.dir,'browser-video.mp4');execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=320x180:r=5:d=2','-threads','1','-pix_fmt','yuv420p','-y',videoFile]);const videoBytes=readFileSync(videoFile);
const frameGif=join(f.dir,'frame-029.gif');execFileSync('ffmpeg',['-v','error','-filter_complex_threads','1',...['red','white','blue'].flatMap(c=>['-f','lavfi','-i',`color=c=${c}:s=64x64:r=20:d=2`]),'-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0','-threads','1','-loop','0','-y',frameGif]);const frameGifBytes=readFileSync(frameGif);
class BrowserVision extends LlmAdapter {
 async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text','image'] as any,reasoning:{efforts:[{id:'off' as any,name:'关闭'}]}};}
 async *stream(_options:GenerateOptions):AsyncIterable<StreamChunk>{const text=_options.system?.includes('整理已有 QQ 收藏')?JSON.stringify({emoji:{meaning:'开心地摇摆表达喜欢',emotions:['开心'],situations:['想夸奖或庆祝的时候'],avoid:[]}}):_options.system?.includes('主人明确请你到一个允许的QQ群发言')?'大家好呀，最近在聊什么好玩的？':JSON.stringify(_options).includes('主人这条群消息已按')?'主人，这个雪球扔得也太准了吧。':JSON.stringify(_options).includes('你在旁听白名单群')?JSON.stringify({reply:'主人，这个雪球扔得也太准了吧。'}):_options.system?.includes('图片识别自检')?JSON.stringify({left:'红色',right:'蓝色'}):JSON.stringify({summary:'红色画面配有吉他姿势字幕。',reply:'抽样画面是红色背景，字幕讲吉他持琴姿势。'});yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'usage',usage:{inputTokens:300,outputTokens:80,totalTokens:380}};yield {type:'finish',reason:{kind:'stop'}};}
}
await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);new LocalAttachmentStore(ctx,{dshHome:join(f.dir,'attachments')});ctx.llm.registerAdapter(['deepseek-official'],new BrowserVision());
let polls=0,qqPolls=0;
const platform:typeof fetch=async(url)=>{
 if(String(url)==='https://gchat.qpic.cn/frame-029.gif')return new Response(frameGifBytes);
 if(String(url).includes('openspeech.bytedance.com'))return new Response(JSON.stringify({code:0,data:audio.toString('base64'),usage:{text_words:12}})+'\n'+JSON.stringify({code:20000000}));
 if(String(url).includes('upos-test.bilivideo.com'))return new Response(videoBytes);
 if(String(url).includes('aisubtitle.hdslb.com'))return Response.json({body:[{from:0,content:'吉他持琴姿势'}]});
 if(String(url).includes('/x/web-interface/history/cursor'))return Response.json({code:0,data:{list:[{history:{business:'archive',bvid:'BV1xx411c7mD'}}],cursor:{}}});
 if(String(url).includes('/x/tag/archive/tags'))return Response.json({code:0,data:[{tag_name:'科技'},{tag_name:'天文'}]});
 if(String(url).includes('/x/web-interface/view'))return Response.json({code:0,data:{aid:123,bvid:'BV1xx411c7mD',title:'测试吉他视频',desc:'持琴姿势',owner:{name:'测试作者'},cid:999,duration:2,pages:[{cid:999,duration:2}]}});
 if(String(url).includes('/x/player/wbi/playurl'))return Response.json({code:0,data:{timelength:2000,dash:{duration:2,video:[{id:16,codecid:7,baseUrl:'https://upos-test.bilivideo.com/video.mp4'}]}}});
 if(String(url).includes('/x/player/wbi/v2'))return Response.json({code:0,data:{subtitle:{subtitles:[{lan:'zh-CN',subtitle_url:'//aisubtitle.hdslb.com/subtitle.json'}]}}});
 if(String(url).includes('api.github.com'))return Response.json([{tag_name:'v0.4.0',prerelease:true,body:'测试更新说明：保留原有记忆。'}]);
 if(String(url).includes('raw.githubusercontent.com'))return new Response(String(url).endsWith('.txt')?createHash('sha256').update('browser-package').digest('hex')+'  dsh-shiguang-0.4.0.tgz':'browser-package');
 if(String(url).includes('/generate')){polls=0;return Response.json({code:0,data:{url:'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=browser-test',qrcode_key:'browser-test'}});}
 if(String(url).includes('/spi'))return Response.json({code:0,data:{b_3:'browser-buvid'}});
 if(String(url).includes('search/type'))return Response.json({code:0,data:{result:[]}});
 if(String(url).includes('/x/msgfeed/reply'))return Response.json({code:0,data:{cursor:{is_end:true},items:[]}});
 if(String(url).includes('/x/v2/reply/add'))return Response.json({code:0,data:{rpid_str:'92001'}});
 if(String(url).includes('/x/v2/reply/reply'))return Response.json({code:0,data:{root:{rpid_str:'500',root_str:'0',oid:123,type:1,member:{mid:'10003',uname:'评论者阿橙'},content:{message:'这个细节是怎么拍出来的？'}},replies:[{rpid_str:'501',root_str:'500',parent_str:'500',oid:123,type:1,member:{mid:'10004',uname:'评论者小雨'},content:{message:'我也想知道这个镜头'}}]}});
 if(String(url).includes('/x/v2/reply?'))return Response.json({code:0,data:{replies:[{rpid_str:'500',root_str:'0',oid:123,type:1,member:{mid:'10003',uname:'评论者阿橙'},content:{message:'这个细节是怎么拍出来的？'}}]}});
 if(String(url).includes('/x/msgfeed/at'))return Response.json({code:0,data:{cursor:{is_end:true},items:[]}});
 if(String(url).includes('/fetch_session_msgs'))return Response.json({code:0,data:{max_seqno:'0',has_more:0,messages:[]}});
 if(String(url).includes('/nav'))return Response.json({code:0,data:{isLogin:true,mid:123456,uname:'测试B站伙伴',wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/bfs/wbi/'+'b'.repeat(32)+'.png'}}});
 if(++polls<2)return Response.json({code:0,data:{code:86101}});
 const r=Response.json({code:0,data:{code:0}});r.headers.append('Set-Cookie','SESSDATA=browser-fake-session; Path=/');r.headers.append('Set-Cookie','bili_jct=browser-fake-csrf; Path=/');return r;
};
const file=join(f.dir,'config.json');writeFileSync(file,JSON.stringify(f.settings));
const snowDir=join(f.dir,'SnowLuma'),qqFile=join(f.dir,'QQ.exe');mkdirSync(join(snowDir,'config'),{recursive:true});writeFileSync(join(snowDir,'index.mjs'),'');writeFileSync(join(snowDir,'launcher.bat'),'');writeFileSync(qqFile,'fixture');writeFileSync(join(snowDir,'config','onebot.json'),JSON.stringify({networks:{wsServers:[{name:'fixture',host:'127.0.0.1',port:address.port,path:'/',role:'Universal',accessToken:'browser-onebot-secret',messageFormat:'array'}]}}));let snowStarted=false;
const runtime=new ShiguangRuntime(ctx,file,platform,{locator:{roots:[f.dir],onPath:async name=>name==='QQ.exe'?[qqFile]:['ffmpeg','ffprobe'].includes(name)?['/usr/bin/'+name]:[]},snowHost:{platform:'win32',openQQ(){},openBrowser(){},launch(_directory,_log,env){snowStarted=true;const secret=env!.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD!,salt=Buffer.alloc(16,5);writeFileSync(join(snowDir,'config','webui.json'),JSON.stringify({passwordSalt:salt.toString('hex'),passwordHash:scryptSync(secret,salt,64).toString('hex'),mustChangePassword:false}));return Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),killed:false,kill(){this.killed=true;return true;}}) as any;}},localFetch:async()=>{if(!snowStarted)throw Error('not started');return Response.json({status:'failed',message:'Unauthorized'},{status:401});}});runtime.memory.append('owner','qq','p','note','今天练习 C 和弦');runtime.memory.append('owner','bilibili','bilibili','experience','上周选了雅马哈吉他',undefined,Date.now()-86400000);
runtime.memory.append('owner','qq','qq:private:10001','user','在吗，我今天带了蓝色雨伞。','browser-owner-question',Date.now(),'',{turnId:'browser-owner-question',speakerId:'10001',speakerName:'主人小鱼'});runtime.memory.recordReply('owner','qq','qq:private:10001','我在，雨天记得把伞带好。','browser-owner-question','10002','小拾');
runtime.memory.append('qq:group:20001','qq','qq:group:20001','user','测试群今天讨论天文');
runtime.memory.append('qq:group:20001','qq','qq:group:20001','user','周六晚上一起看流星雨吧','group-memory-031',Date.now(),'',{turnId:'group-memory-031',speakerId:'10003',speakerName:'群友阿橙'});runtime.memory.recordReply('qq:group:20001','qq','qq:group:20001','好呀，记住是阿橙提议的啦。','group-memory-031','10002','小拾');runtime.memory.append('owner','bilibili','bilibili','experience','观看测试科普视频的抽样画面',undefined,Date.now(),'watch');runtime.memory.append('owner','bilibili','bilibili','experience','在测试科普视频留言：这个实验很清楚。',undefined,Date.now(),'comment');runtime.memory.append('owner','bilibili','bilibili','experience','已点赞测试科普视频',undefined,Date.now(),'like');
ctx.provide('pluginManager',{installBundle:async()=>({application:'restart-required',version:'0.4.0'})} as never);
recordUsage(runtime.memory,{session:'browser-fixture',source:'qq',provider:'fixture',model:'test'},[{type:'assistant/message',seq:1,time:Date.now(),data:{usage:{inputTokens:120,cacheReadTokens:300,outputTokens:80},stream:[],message:{content:[]}}}] as unknown as SessionEvent[]);
const connection=new HostConnectionService(ctx,[],{} as never);registerPanelApi(ctx,runtime);await new Promise(r=>setImmediate(r));
const handler=connection.createSharedFetchHandler('/api');
const result=await build({entryPoints:['tests/browser/harness.tsx'],bundle:true,write:false,format:'iife',platform:'browser',jsx:'transform',define:{'process.env.NODE_ENV':'"development"'}});
const script=result.outputFiles[0]!.contents;
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/harness.js'){res.setHeader('Content-Type','text/javascript');res.end(script);return;}
  if(req.method==='POST'&&req.url==='/fixture/group-slang-0210'){
   for(const socket of qq.clients)socket.send(JSON.stringify({post_type:'message',message_type:'group',message_id:Date.now(),self_id:10002,user_id:10003,group_id:20001,sender:{nickname:'群友阿橙'},message:[{type:'text',data:{text:'红温的意思是因为着急或生气而脸红'}}]}));
   let entries=listSlang(runtime.memory,'红温','all');for(let n=0;n<100&&!entries.length;n++){await new Promise(r=>setTimeout(r,10));entries=listSlang(runtime.memory,'红温','all');}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(entries));return;
  }
  if(req.method==='POST'&&req.url==='/fixture/short-term-032'){await runtime.enqueue(async()=>{const m=runtime.memory,now=m.clock();m.append('qq:group:20001','qq','qq:group:20001','user','周六团建在东门集合','short-trip',now-2*3600000,'',{turnId:'short-trip',speakerId:'10003',speakerName:'群友阿橙'});m.append('qq:group:20001','qq','qq:group:20001','assistant','好呀，东门集合记住啦','short-reply',now-2*3600000+1000,'',{turnId:'short-trip',speakerId:'10002',speakerName:'小拾'});for(let i=0;i<100;i++)m.append('qq:group:20001','qq','qq:group:20001','user','其他群聊'+i,'short-noise-'+i,now-10000+i,'',{speakerId:'10004',speakerName:'群友小雨'});m.fastContext('qq:group:20001','qq:group:20001',undefined,[],{speakerIds:['10003'],query:'接着说呢'});});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(runtime.status().memory.shortTerm));return;}
  if(req.method==='POST'&&req.url==='/fixture/group-emoji-031'){const value=await runtime.enqueue(()=>runtime.qqGroups.sendEmoji('20001','去游戏群发个开心的表情包','browser-group-emoji-'+Date.now(),AbortSignal.timeout(10000)));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...value,delivery:qqSent.at(-1)}));return;}
  if(req.method==='POST'&&req.url==='/fixture/group-task-030'){const value=await runtime.enqueue(()=>runtime.qqGroups.send('20001','去游戏群说：大家晚上好','browser-task-'+Date.now(),AbortSignal.timeout(10000)));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return;}
  if(req.method==='POST'&&req.url==='/fixture/group-0210'){
   for(const socket of qq.clients)socket.send(JSON.stringify({post_type:'message',message_type:'group',message_id:Date.now(),self_id:10002,user_id:10001,group_id:20001,sender:{nickname:'主人'},message:[{type:'text',data:{text:'刚刚这个雪球丢得好好笑'}}]}));res.end('{}');return;
  }
  if(req.method==='POST'&&req.url==='/fixture/media-029'){
   await runtime.enqueue(()=>runtime.media.reply({id:'browser-frame-'+Date.now(),selfId:'10002',userId:'10001',owner:true,scope:'owner',thread:'qq:private:10001',text:'看看这个动图'},runtime.qq,[{type:'image',url:'https://gchat.qpic.cn/frame-029.gif'}]));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(runtime.media.lastStatus));return;
  }
  if(req.method==='POST'&&req.url==='/fixture/duration-029'){
   const original=runtime.bili.videoPart;try{runtime.bili.videoPart=async()=>({video:{aid:'123',bvid:'BV1xx411c7mD',title:'超长示例',description:'',owner:'作者',url:'https://www.bilibili.com/video/BV1xx411c7mD'},cid:'1',duration:601,part:1});runtime.startWatch('BV1xx411c7mD','概括内容',1);await runtime.enqueue(async()=>undefined);}finally{runtime.bili.videoPart=original;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(runtime.watchJob));return;
  }
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
