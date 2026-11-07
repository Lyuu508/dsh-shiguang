import {createServer} from 'node:http';
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
let polls=0;
const platform:typeof fetch=async(url)=>{
 if(String(url).includes('api.github.com'))return Response.json([{tag_name:'v0.1.100',prerelease:true,body:'测试更新说明：保留原有记忆。'}]);
 if(String(url).includes('raw.githubusercontent.com'))return new Response(String(url).endsWith('.txt')?createHash('sha256').update('browser-package').digest('hex')+'  dsh-shiguang-0.1.100.tgz':'browser-package');
 if(String(url).includes('/generate')){polls=0;return Response.json({code:0,data:{url:'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=browser-test',qrcode_key:'browser-test'}});}
 if(String(url).includes('/nav'))return Response.json({code:0,data:{isLogin:true,mid:123456,uname:'测试B站伙伴'}});
 if(++polls<2)return Response.json({code:0,data:{code:86101}});
 const r=Response.json({code:0,data:{code:0}});r.headers.append('Set-Cookie','SESSDATA=browser-fake-session; Path=/');r.headers.append('Set-Cookie','bili_jct=browser-fake-csrf; Path=/');return r;
};
const file=join(f.dir,'config.json');writeFileSync(file,JSON.stringify(f.settings));
const runtime=new ShiguangRuntime(ctx,file,platform);runtime.memory.append('owner','qq','p','note','今天练习 C 和弦');runtime.memory.append('owner','bilibili','bilibili','experience','上周选了雅马哈吉他',undefined,Date.now()-86400000);
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
