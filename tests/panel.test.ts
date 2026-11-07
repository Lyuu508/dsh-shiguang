import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { HostConnectionService, Peer } from '@deepseek-ai/dsh-client-connection';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ShiguangRuntime } from '../src/runtime.js';
import { panelAction,registerPanelApi } from '../src/panel-api.js';
import { fixture } from './helpers.js';

function setup(fetcher?:typeof fetch){const f=fixture(),ctx=new Context(),file=join(f.dir,'config.json');writeFileSync(file,JSON.stringify(f.settings));const runtime=new ShiguangRuntime(ctx,file,fetcher);return {...f,ctx,file,runtime,async close(){await runtime.stop();await ctx.fiber.dispose();f.cleanup();}};}
const signal=()=>new AbortController().signal;
test('面板保存即时生效、保留记忆且提供版本冲突保护',async()=>{
 const f=setup();try{
  const id=f.runtime.memory.append('owner','qq','p','note','今天练吉他')!;
  const before=f.runtime.view(); const settings=structuredClone(before.settings);settings.displayName='小拾';settings.memory.todayMaxChars=1800;
  await f.runtime.save(settings,before.revision);
  assert.equal(f.runtime.settings.displayName,'小拾');assert.equal(f.runtime.memory.limits.todayMaxChars,1800);
  assert.match(f.runtime.memory.detail('owner',id).text,/今天练吉他/);assert.ok(existsSync(f.file+'.bak'));
  await assert.rejects(f.runtime.save(settings,before.revision),/其他窗口/);
  const stored=JSON.parse(readFileSync(f.file,'utf8'));assert.equal(stored.displayName,'小拾');
 }finally{await f.close();}
});
test('无效配置不改变文件和运行状态，数据目录与角色标识不被意外迁移',async()=>{
 const f=setup();try{
  const old=f.runtime.view(),bytes=readFileSync(f.file,'utf8');
  await assert.rejects(f.runtime.save({...old.settings,memory:{...old.settings.memory,searchLimit:999}},old.revision),/searchLimit/);
  assert.equal(readFileSync(f.file,'utf8'),bytes);assert.equal(f.runtime.settings.memory.searchLimit,5);
  await assert.rejects(f.runtime.save({...old.settings,dataDir:join(f.dir,'elsewhere')},old.revision),/迁移/);
  assert.equal(readFileSync(f.file,'utf8'),bytes);
 }finally{await f.close();}
});
test('Token 只保存到本机独立文件，面板及 JSON 配置不回显',async()=>{
 const f=setup();try{
  const old=f.runtime.view();await f.runtime.save(old.settings,old.revision,'local-test-token-not-for-model');
  const view=f.runtime.view();assert.equal(view.tokenConfigured,true);assert.equal(view.tokenFromEnvironment,false);
  assert.doesNotMatch(JSON.stringify(view),/local-test-token/);assert.doesNotMatch(readFileSync(f.file,'utf8'),/local-test-token/);
  assert.equal(readFileSync(join(f.dir,'onebot.token'),'utf8'),'local-test-token-not-for-model');
  await f.runtime.save(view.settings,view.revision,'');assert.equal(f.runtime.view().tokenConfigured,true);
 }finally{await f.close();}
});
test('首次加载自动生成默认配置，可以直接从面板开始设置',async()=>{
 const f=fixture(),ctx=new Context(),file=join(f.dir,'new','config.json'),runtime=new ShiguangRuntime(ctx,file);
 try{assert.ok(existsSync(file));assert.equal(runtime.settings.displayName,'拾光');assert.equal(runtime.settings.qq.enabled,false);assert.equal(runtime.status().memory.total,0);}finally{await runtime.stop();await ctx.fiber.dispose();f.cleanup();}
});
test('面板记忆分页、删除和撤销保持原文与全文索引一致',async()=>{
 const f=setup();try{
  const yesterday=Date.now()-86400000;let id='';
  for(let i=0;i<25;i++)id=f.runtime.memory.append('owner','qq','p','user',`吉他 ${i}`,undefined,yesterday)!;
  const day=f.runtime.memory.detail('owner',id).day,first=f.runtime.memory.list('owner',day);assert.equal(first.rows.length,20);assert.ok(first.nextCursor);
  const second=f.runtime.memory.list('owner',day,first.nextCursor!);assert.equal(second.rows.length,5);assert.equal(new Set([...first.rows,...second.rows].map(r=>r.id)).size,25);
  await panelAction(f.runtime,'memory-remove',{scope:'owner',id},signal());assert.throws(()=>f.runtime.memory.detail('owner',id));
  assert.ok(!f.runtime.memory.search('owner','吉他').some(r=>r.id===id));
  await assert.rejects(panelAction(f.runtime,'memory-restore',{scope:'qq:group:5',id},signal()),/没有/);
  await panelAction(f.runtime,'memory-restore',{scope:'owner',id},signal());assert.match(f.runtime.memory.detail('owner',id).text,/吉他/);
  assert.equal(f.runtime.memory.overview().total,25);
 }finally{await f.close();}
});
test('二维码登录仅返回图像和临时票据，不返回 Cookie；登录后可检查账号',async()=>{
 const fetcher:typeof fetch=async(url)=>{
  if(String(url).includes('/generate'))return Response.json({code:0,data:{url:'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=secret-key',qrcode_key:'secret-key'}});
  if(String(url).includes('/nav'))return Response.json({code:0,data:{isLogin:true,uname:'测试伙伴',mid:123}});
  const r=Response.json({code:0,data:{code:0}});r.headers.append('Set-Cookie','SESSDATA=fake-session; Path=/');r.headers.append('Set-Cookie','bili_jct=fake-csrf; Path=/');return r;
 };
 const f=setup(fetcher);try{
  const qr=await f.runtime.startLogin();assert.match(qr.image,/^data:image\/png;base64,/);assert.notEqual(qr.ticket,'secret-key');assert.equal('key'in qr,false);
  assert.equal((await f.runtime.pollLogin('wrong-ticket')).status,'expired');assert.equal((await f.runtime.pollLogin(qr.ticket)).status,'success');
  assert.equal(f.runtime.status().bilibili.credentialSaved,true);assert.doesNotMatch(JSON.stringify(f.runtime.status()),/fake-session|fake-csrf/);
  assert.equal((await f.runtime.bili.account()).name,'测试伙伴');const pending=await f.runtime.startLogin();await panelAction(f.runtime,'bili-logout',{},signal());assert.equal(f.runtime.bili.hasLogin(),false);assert.equal((await f.runtime.pollLogin(pending.ticket)).status,'expired');
 }finally{await f.close();}
});
test('真实 DSH Connection 精确路由只允许 owner，RPC 返回格式与客户端一致',async()=>{
 const f=setup();
 // Browser admission is outside this in-process test; the real route selector
 // below exercises owner authorization after transport admission.
 const connection=new HostConnectionService(f.ctx,[],{} as never);registerPanelApi(f.ctx,f.runtime);
 try{
  await new Promise(r=>setImmediate(r));
  const fetcher=connection.createSharedFetchHandler('/api');
  const request=()=>new Request('http://localhost/api/shiguang',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'panel-test',method:'shiguang',payload:{action:'load',args:{}}})});
  const owner=await fetcher.fetch(request(),connection.browserPeer);assert.equal(owner.status,200);const body=await owner.json();assert.equal(body.rpcId,'panel-test');assert.equal(body.result.ok,true);assert.equal(body.result.value.settings.displayName,'拾光');
  const outsider=new Peer(f.ctx,{principal:{kind:'external-test'} as never});
  try{assert.equal((await fetcher.fetch(request(),outsider)).status,403);}finally{await outsider.dispose();}
 }finally{await f.close();}
});
