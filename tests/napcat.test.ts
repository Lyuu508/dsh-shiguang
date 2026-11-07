import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once,EventEmitter} from 'node:events';
import {mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import type {ChildProcess} from 'node:child_process';
import {NapCatManager,napcatAsset,webuiHash,onebotEndpoint,type NapCatHost} from '../src/napcat.js';
import {parseSettings,napcatBaseUrl} from '../src/config.js';
import {fixture} from './helpers.js';

const bytes=Buffer.from('official-package-fixture');
const asset=(digest=createHash('sha256').update(bytes).digest('hex'))=>({tag_name:'v4.18.42',assets:[{name:'NapCat.Shell.Windows.Node.zip',size:bytes.length,digest:'sha256:'+digest,browser_download_url:'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip'}]});
const json=(data:unknown)=>Response.json({code:0,data});
const onebot=(dir:string)=>()=>{try{return readFileSync(join(dir,'onebot.token'),'utf8')}catch{return '';}};

test('NapCat 安装版本固定官方包和摘要，旧配置保留已有连接，本机后台限制生效',()=>{
 const f=fixture();try{
  assert.equal(napcatAsset(asset()).version,'v4.18.42');
  assert.throws(()=>napcatAsset({...asset(),assets:[{...asset().assets[0],digest:null}]}),/SHA256/);
  assert.throws(()=>napcatAsset({...asset(),assets:[{...asset().assets[0],browser_download_url:'https://github.com/other/repo/evil.zip'}]}));
  const old=structuredClone(f.settings) as any;delete old.napcat;old.qq.enabled=true;old.qq.ownerQQ='10001';
  assert.equal(parseSettings(old,join(f.dir,'config.json')).napcat.mode,'external');
  old.qq.enabled=false;assert.equal(parseSettings(old,join(f.dir,'config.json')).napcat.mode,'managed');
  for(const value of ['http://127.0.0.1.attacker.test:6099','https://example.com','http://127.0.0.1:6099/?token=secret','http://127.0.0.1:6099/api','http://user@localhost:6099'])assert.throws(()=>napcatBaseUrl(value));
  f.settings.qq.wsUrl='ws://other.test:3001';assert.throws(()=>onebotEndpoint(f.settings),/本机/);
  assert.equal(webuiHash('example'),createHash('sha256').update('example.napcat').digest('hex'));
 }finally{f.cleanup();}
});

test('安装包摘要不匹配及非官方重定向不解压不启动，临时文件会清理',async()=>{
 for(const redirect of [false,true]){
  const f=fixture();let extracted=0,launched=0;
  const host:NapCatHost={platform:'win32',arch:'x64',extract:async()=>{extracted++;},launch:()=>{launched++;throw Error('must not launch');},portFree:async()=>true};
  const fetcher:typeof fetch=async url=>String(url).includes('/latest')?Response.json(asset('a'.repeat(64))):redirect?new Response('',{status:302,headers:{location:'https://untrusted.test/napcat.zip'}}):new Response(bytes);
  const manager=new NapCatManager(f.dir,()=>f.settings,onebot(f.dir),fetcher,host);
  try{manager.configure();manager.start();await manager.whenIdle();assert.equal(manager.view().phase,'error');assert.match(manager.view().message,redirect?/跳转/:/SHA256/);assert.equal(extracted,0);assert.equal(launched,0);assert.equal(manager.view().installed,false);assert.ok(!readdirSync(join(f.dir,'napcat')).some(n=>n.endsWith('.zip')||n.startsWith('stage-')||n.endsWith('.lock')));}finally{await manager.stop();f.cleanup();}
 }
});

test('托管安装去重、独立数据目录、QQ 扫码与 OneBot 自动配置，重启复用本机运行包',async()=>{
 const f=fixture();let downloads=0,extracts=0,launches=0,online=false,sets=0;let config:any={network:{httpServers:[{name:'keep',enable:false}],websocketServers:[]}};
 let available=false,requestHeaders:Headers|undefined,loginHash='';
 const child=Object.assign(new EventEmitter(),{exitCode:null,kill(){this.exitCode=0;this.emit('exit',0);return true;}}) as unknown as ChildProcess;
 const host:NapCatHost={platform:'win32',arch:'x64',portFree:async()=>true,extract:async(_file,dest)=>{extracts++;for(const p of ['node.exe','index.js','wrapper.node','napcat/napcat.mjs']){mkdirSync(dirname(join(dest,p)),{recursive:true});writeFileSync(join(dest,p),'fixture');}},launch(directory,work,token){launches++;available=true;assert.equal(directory,join(f.dir,'napcat','runtime'));assert.equal(work,join(f.dir,'napcat','work'));assert.ok(token.length>=32);return child;}};
 const fetcher:typeof fetch=async(url,init)=>{
  const u=new URL(String(url));
  if(u.hostname==='api.github.com'){downloads++;return Response.json(asset());}
  if(u.hostname==='github.com')return new Response(bytes);
  if(!available)throw Error('not started');
  requestHeaders=new Headers(init?.headers);
  if(u.pathname==='/api/auth/login'){loginHash=JSON.parse(String(init?.body)).hash;return json({Credential:'private-auth-credential'});}
  assert.equal(requestHeaders.get('authorization'),'Bearer private-auth-credential');
  if(u.pathname.endsWith('/CheckLoginStatus'))return json({isLogin:online,loginPhase:online?'ready':'waiting_qrcode',qrcodeurl:'https://txz.qq.com/p?k=fixture'});
  if(u.pathname.endsWith('/RefreshQRcode'))return json({qrcodeurl:'https://txz.qq.com/p?k=refreshed'});
  if(u.pathname.endsWith('/GetConfig'))return json(config);
  if(u.pathname.endsWith('/SetConfig')){sets++;config=JSON.parse(JSON.parse(String(init?.body)).config);return json(null);}
  throw Error('unexpected endpoint');
 };
 const manager=new NapCatManager(f.dir,()=>f.settings,onebot(f.dir),fetcher,host);
 let next:NapCatManager|undefined;
 try{
  manager.start();manager.start();await manager.whenIdle();assert.equal(manager.view().phase,'ready');assert.equal(downloads,1);assert.equal(extracts,1);assert.equal(launches,1);
  assert.equal(loginHash,webuiHash(readFileSync(join(f.dir,'napcat','webui.token'),'utf8')));
  const webui=JSON.parse(readFileSync(join(f.dir,'napcat','work','config','webui.json'),'utf8'));assert.equal(webui.host,'127.0.0.1');assert.equal(webui.port,6099);
  const qr=await manager.loginStatus();assert.equal(qr.loggedIn,false);assert.match(qr.image!,/^data:image\/png;base64,/);assert.doesNotMatch(JSON.stringify(manager.view()),/private-auth-credential/);
  await manager.refreshQR();online=true;const logged=await manager.loginStatus();assert.equal(logged.loggedIn,true);assert.equal(logged.bridgeReady,true);
  assert.equal(config.network.httpServers[0].name,'keep');assert.equal(config.network.websocketServers[0].messagePostFormat,'array');assert.equal(config.network.websocketServers[0].token,onebot(f.dir)());assert.equal(sets,1);
  await manager.loginStatus();assert.equal(sets,1);assert.doesNotMatch(JSON.stringify(manager.view()),new RegExp(onebot(f.dir)()));
  const consoleUrl=new URL(manager.consoleUrl().url);assert.equal(consoleUrl.hostname,'127.0.0.1');assert.ok(consoleUrl.searchParams.get('token'));
  await manager.stop();available=false;
  next=new NapCatManager(f.dir,()=>f.settings,onebot(f.dir),fetcher,{...host,launch(...args){const result=host.launch(...args);return Object.assign(new EventEmitter(),{exitCode:null,kill(){return true;}}) as unknown as ChildProcess;}});
  next.start();await next.whenIdle();assert.equal(next.view().phase,'ready');assert.equal(downloads,1);assert.equal(extracts,1);assert.equal(launches,2);
 }finally{await next?.stop();await manager.stop();f.cleanup();}
});

test('已有 NapCat 通过真实 HTTP 验证官方鉴权、扫码状态、刷新，凭据不混入状态',async()=>{
 const f=fixture();f.settings.napcat.mode='external';let online=false,refreshes=0;const requests:string[]=[];
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(req.url||'');let data:unknown;
  if(req.url==='/api/auth/login'){assert.equal(body.hash,webuiHash('external-token'));data={Credential:'secret-credential'};}
  else{assert.equal(req.headers.authorization,'Bearer secret-credential');if(req.url?.endsWith('/RefreshQRcode')){refreshes++;data={qrcodeurl:'https://txz.qq.com/p?k=new'};}else data={isLogin:online,loginPhase:online?'ready':'qrcode_scanned',qrcodeurl:'https://txz.qq.com/p?k=test'};}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,data}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('server not ready');f.settings.napcat.webuiUrl=`http://127.0.0.1:${address.port}`;
 const manager=new NapCatManager(f.dir,()=>f.settings,onebot(f.dir));
 try{
  manager.configure();assert.equal(manager.view().busy,false);await assert.rejects(manager.loginStatus(),/WebUI Token/);
  manager.saveWebuiToken('external-token');const qr=await manager.loginStatus();assert.match(qr.image!,/^data:image/);assert.match(qr.message,/已扫码/);await manager.refreshQR();assert.equal(refreshes,1);
  online=true;assert.equal((await manager.loginStatus()).loggedIn,true);assert.equal(requests.filter(x=>x==='/api/auth/login').length,1);assert.ok(!requests.some(x=>x.includes('OB11')));
  assert.doesNotMatch(JSON.stringify(manager.view()),/external-token|secret-credential/);assert.equal(existsSync(join(f.dir,'onebot.token')),false);
 }finally{await manager.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));f.cleanup();}
});

test('后台双重验证不会绕过，QQ 二维码拒绝外部域名，安装锁阻止并发进程',async()=>{
 const f=fixture();f.settings.napcat.mode='external';let secondFactor=true;
 const manager=new NapCatManager(f.dir,()=>f.settings,onebot(f.dir),async url=>String(url).includes('/auth/')?json(secondFactor?{require2FA:true}:{Credential:'fixture'}):json({isLogin:false,qrcodeurl:'https://untrusted.test/qr'}));
 try{
  manager.saveWebuiToken('external-token');await assert.rejects(manager.loginStatus(),/双重验证/);secondFactor=false;await assert.rejects(manager.loginStatus(),/官方 QQ/);
  f.settings.napcat.mode='managed';mkdirSync(join(f.dir,'napcat'),{recursive:true});writeFileSync(join(f.dir,'napcat','install.lock'),JSON.stringify({pid:process.pid,id:'other-instance'}));
  const locked=new NapCatManager(f.dir,()=>f.settings,onebot(f.dir),async()=>{throw Error('must not download')},{platform:'win32',arch:'x64',extract:async()=>{},launch:()=>{throw Error('must not launch')},portFree:async()=>true});
  locked.start();await locked.whenIdle();assert.match(locked.view().message,/另一个 DSH/);await locked.stop();
 }finally{await manager.stop();f.cleanup();}
});
