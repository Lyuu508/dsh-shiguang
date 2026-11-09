import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {createHash,scryptSync} from 'node:crypto';
import {writeFileSync,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {WebSocketServer} from 'ws';
import {locatePrograms} from '../src/discovery.js';
import {SnowLumaManager,parseSnowConnection} from '../src/snowluma.js';
import {ShiguangRuntime} from '../src/runtime.js';
import {flashRoute} from '../src/model-route.js';
import {fixture} from './helpers.js';
function install(dir:string){mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'index.mjs'),'');writeFileSync(join(dir,'launcher.bat'),'');}
function auth(dir:string,secret:string,mustChangePassword=false){mkdirSync(join(dir,'config'),{recursive:true});const salt=Buffer.alloc(16,7);writeFileSync(join(dir,'config','webui.json'),JSON.stringify({passwordSalt:salt.toString('hex'),passwordHash:scryptSync(secret,salt,64,{N:16384,r:8,p:1}).toString('hex'),mustChangePassword}));}
function child(){return Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),killed:false,kill(){this.killed=true;return true;}}) as unknown as ChildProcess;}

test('常用目录快速定位 SnowLuma、QQ 和 FFmpeg，不遍历整个盘符',async()=>{
 const f=fixture();try{const software=join(f.dir,'Downloads','software'),snow=join(software,'SnowLuma-v2.4.2'),qq=join(software,'QQNT'),bin=join(software,'ffmpeg-latest','bin');install(snow);mkdirSync(qq,{recursive:true});mkdirSync(bin,{recursive:true});writeFileSync(join(qq,'QQ.exe'),'fixture');for(const name of ['ffmpeg.exe','ffprobe.exe'])writeFileSync(join(bin,name),'fixture');const r=await locatePrograms(f.settings,{roots:[join(f.dir,'Downloads')],onPath:async()=>[]});assert.equal(r.directory,snow);assert.equal(r.qqPath,join(qq,'QQ.exe'));assert.equal(r.ffmpegPath,join(bin,'ffmpeg.exe'));assert.equal(r.ffprobePath,join(bin,'ffprobe.exe'));assert.ok(r.scanned<20);}finally{f.cleanup();}
});

test('首次启动使用官方引导环境变量，凭据只经显式取回 API 返回，日志与状态不含明文',async()=>{
 const f=fixture(),dir=join(f.dir,'SnowLuma');install(dir);f.settings.snowluma.directory=dir;let password='';const c=child(),manager=new SnowLumaManager(f.dir,()=>f.settings,{platform:'win32',launch(_d,_l,env){password=env!.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD!;auth(dir,password);return c;},openQQ(){}});
 try{manager.start();assert.ok(password.length>20);assert.equal(manager.credential().secret,password);assert.doesNotMatch(JSON.stringify(manager.view()),new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));c.stdout!.emit('data',Buffer.from('initial credentials: user=admin password='+password+'\n'));assert.ok(!readFileSync(join(f.dir,'snowluma','runtime.log'),'utf8').includes(password));auth(dir,'NewStrong!98765');const before=readFileSync(join(dir,'config','webui.json'),'utf8');assert.equal(manager.credential().available,false);assert.equal(readFileSync(join(dir,'config','webui.json'),'utf8'),before);}finally{await manager.stop();f.cleanup();}
});

test('可找回 v0.1.9 私有日志里的初始密码，只返回与当前后台哈希相符的凭据',()=>{
 const f=fixture(),dir=join(f.dir,'SnowLuma');install(dir);f.settings.snowluma.directory=dir;auth(dir,'Fixture!123abc',true);mkdirSync(join(f.dir,'snowluma'));writeFileSync(join(f.dir,'snowluma','runtime.log'),'\u001b[32minitial credentials: user=admin password=Fixture!123abc\u001b[0m\n');const manager=new SnowLumaManager(f.dir,()=>f.settings);try{assert.equal(manager.credential().secret,'Fixture!123abc');assert.ok(existsSync(join(f.dir,'snowluma','webui-secret.json')));}finally{f.cleanup();}
});

test('自动读取 OneBot 快照和覆盖配置，保留鉴权，多个账号不误连',()=>{
 const f=fixture(),dir=join(f.dir,'SnowLuma');install(dir);f.settings.snowluma.directory=dir;mkdirSync(join(dir,'config'));const server={name:'default',host:'0.0.0.0',port:3001,path:'/',role:'Universal',accessToken:'fixture-private-token'};writeFileSync(join(dir,'config','onebot.json'),JSON.stringify({networks:{wsServers:[server]}}));writeFileSync(join(dir,'config','onebot_111.json'),JSON.stringify({mode:'overlay',networks:{wsServers:[{name:'default',port:3456}]}}));const manager=new SnowLumaManager(f.dir,()=>f.settings);try{assert.equal(manager.connection()?.url,'ws://127.0.0.1:3456/');assert.equal(manager.connection()?.token,server.accessToken);writeFileSync(join(dir,'config','onebot_222.json'),JSON.stringify({mode:'snapshot',networks:{wsServers:[{...server,port:4444}]}}));assert.throws(()=>manager.connection(),/多个/);f.settings.snowluma.accountQQ='222';assert.equal(manager.connection()?.url,'ws://127.0.0.1:4444/');writeFileSync(join(dir,'config','onebot.json'),'{broken');assert.equal(manager.connection()?.url,'ws://127.0.0.1:4444/');assert.equal(parseSnowConnection({networks:{wsServers:[{...server,accessToken:''}]}}),undefined);assert.equal(parseSnowConnection({networks:{wsServers:[{...server,host:'evil.example'}]}}),undefined);assert.ok(!JSON.stringify(manager.view()).includes(server.accessToken));}finally{f.cleanup();}
});

test('真实 OneBot WebSocket 从 SnowLuma 自动同步地址和密钥，开启回复不要求手填 Token',async()=>{
 const f=fixture(),ctx=new Context(),ws=new WebSocketServer({host:'127.0.0.1',port:0});await once(ws,'listening');const address=ws.address();assert.ok(address&&typeof address==='object');const dir=join(f.dir,'SnowLuma');install(dir);f.settings.snowluma.directory=dir;Object.assign(f.settings.qq,{enabled:true,ownerQQ:'10001',wsUrl:'ws://127.0.0.1:1',reconnectMs:500});mkdirSync(join(dir,'config'));writeFileSync(join(dir,'config','onebot.json'),JSON.stringify({networks:{wsServers:[{name:'sg',port:address.port,accessToken:'autodetected-fixture-token',role:'Universal',messageFormat:'array'}]}}));const file=join(f.dir,'config.json');writeFileSync(file,JSON.stringify(f.settings));const runtime=new ShiguangRuntime(ctx,file);let token='';ws.on('connection',(socket,req)=>{token=req.headers.authorization||'';socket.on('message',raw=>{const r=JSON.parse(raw.toString());socket.send(JSON.stringify({status:'ok',retcode:0,echo:r.echo,data:r.action==='get_status'?{online:true}:{user_id:222,nickname:'自动连接伙伴'}}));});});
 try{await runtime.syncQQConnection();const until=Date.now()+3000;while(runtime.qq.status().state!=='connected'){if(Date.now()>until)throw Error('not connected');await new Promise(r=>setTimeout(r,10));}assert.equal(token,'Bearer autodetected-fixture-token');assert.equal((await runtime.qq.check()).nickname,'自动连接伙伴');assert.ok(!readFileSync(file,'utf8').includes('autodetected-fixture-token'));assert.ok(!JSON.stringify(runtime.status()).includes('autodetected-fixture-token'));assert.equal(readFileSync(join(f.dir,'onebot.token'),'utf8'),'autodetected-fixture-token');}finally{await runtime.stop();await ctx.fiber.dispose();for(const s of ws.clients)s.terminate();await new Promise<void>(r=>ws.close(()=>r()));f.cleanup();}
});

test('所有场景固定最新 Flash，沿用 DSH 已选官方连接，不回退到其他模型',async()=>{
 const context=(ids:string[],active?:{provider:string;model:string},signed=false)=>({get(name:string){if(name==='llm')return {listProviders:()=>ids.map(id=>({id,name:id}))};if(name==='agents')return {list:()=>active?[{id:'normal-session',model:{current:()=>active}}]:[]};if(name==='deepseekAccount')return {getState:async()=>({status:signed?'credential-stored':'signed-out'})};}} as unknown as Context);
 assert.deepEqual(await flashRoute(context(['deepseek-official','deepseek-account'],{provider:'deepseek-official',model:'deepseek-v4-pro'},true)),{provider:'deepseek-official',model:'deepseek-flash'});assert.equal((await flashRoute(context(['deepseek-official','deepseek-account'],undefined,true))).provider,'deepseek-account');await assert.rejects(flashRoute(context(['other-model'])),/DeepSeek/);
});
