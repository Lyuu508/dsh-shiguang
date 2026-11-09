import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UpdateManager, compareVersions, VERSION } from '../src/updates.js';
import { fixture } from './helpers.js';

test('GitHub 包含预览版、按数字选择新版本，校验后只交给 DSH 安装一次',async()=>{
 const f=fixture(),ctx=new Context(),bytes=Buffer.from('mock-package'),calls:string[]=[],paths:string[]=[];
 const hash=createHash('sha256').update(bytes).digest('hex');
 ctx.provide('pluginManager',{installBundle:async(path:string,options:object)=>{paths.push(path);assert.deepEqual(options,{enabled:true,saveExact:true});assert.deepEqual(readFileSync(path),bytes);return{application:'restart-required',version:'0.4.0'};}} as never);
 const fetcher:typeof fetch=async url=>{
  calls.push(String(url));
  if(String(url).includes('api.github.com'))return Response.json([
   {tag_name:'v0.4.1',draft:true},{tag_name:'v0.4.0',prerelease:true,body:'新功能'},
   {tag_name:'v0.3.10',prerelease:false},{tag_name:'malicious/path'},{tag_name:'v0.4.0-beta'}]);
  if(String(url).endsWith('.txt'))return new Response(hash+'  dsh-shiguang-0.4.0.tgz\n');
  return new Response(bytes);
 };
 try{
  writeFileSync(join(f.dir,'config.json'),'keep');const update=new UpdateManager(ctx,f.dir,fetcher);
  const state=await update.check();assert.equal(state.current,VERSION);assert.equal(state.latest?.version,'0.4.0');assert.equal(state.available,true);assert.equal(state.canInstall,true);
  assert.throws(()=>update.start('0.3.10'),/先检查/);assert.equal(update.start('0.4.0').phase,'downloading');update.start('0.4.0');
  await update.whenIdle();assert.equal(paths.length,1);assert.equal(update.view().phase,'done');assert.match(update.view().message,/重启/);
  assert.equal(readFileSync(join(f.dir,'config.json'),'utf8'),'keep');assert.equal(calls.length,3);
  assert.ok(calls[1]?.startsWith('https://raw.githubusercontent.com/Lyuu508/dsh-shiguang/refs/tags/v0.4.0/downloads/'));
  assert.equal(compareVersions('0.1.10','0.1.9'),1);
 }finally{await ctx.fiber.dispose();f.cleanup();}
});
for(const fault of ['checksum','missing','403','installer'])test(`更新失败保护：${fault}`,async()=>{
 const f=fixture(),ctx=new Context();let installs=0;
 ctx.provide('pluginManager',{installBundle:async()=>{installs++;return{application:'failed',error:{code:'package-failed'}};}} as never);
 const fetcher:typeof fetch=async url=>{
  if(String(url).includes('api.github.com'))return fault==='403'?new Response('',{status:403}):Response.json([{tag_name:'v0.4.0'}]);
  if(String(url).endsWith('.txt'))return new Response(fault==='missing'?'wrong file':createHash('sha256').update(fault==='checksum'?'wrong':'mock').digest('hex')+'  dsh-shiguang-0.4.0.tgz');
  return new Response('mock');
 };
 try{
  const update=new UpdateManager(ctx,f.dir,fetcher);await update.check();
  if(fault!=='403'){update.start('0.4.0');await update.whenIdle();}
  assert.equal(update.view().phase,'error');assert.equal(installs,fault==='installer'?1:0);assert.equal(update.view().available,fault!=='403');
 }finally{await ctx.fiber.dispose();f.cleanup();}
});
test('没有安装服务仍可检查，同版或旧版不能降级安装',async()=>{
 const f=fixture(),ctx=new Context(),update=new UpdateManager(ctx,f.dir,async()=>Response.json([{tag_name:'v'+VERSION},{tag_name:'v0.1.0'}]));
 try{const state=await update.check();assert.equal(state.available,false);assert.equal(state.canInstall,false);assert.throws(()=>update.start(VERSION),/先检查/);}finally{await ctx.fiber.dispose();f.cleanup();}
});
test('DSH 重建面板服务后继续显示安装进度和结果，旧进程中断不会永久卡住',async()=>{
 const f=fixture(),ctx=new Context(),bytes=Buffer.from('mock');let finish:((r:object)=>void)|undefined;let started:()=>void=()=>{};
 const installing=new Promise<void>(r=>{started=r;});
 ctx.provide('pluginManager',{installBundle:()=>new Promise(r=>{finish=r;started();})} as never);
 const fetcher:typeof fetch=async url=>String(url).includes('api.github.com')?Response.json([{tag_name:'v0.4.0'}]):new Response(String(url).endsWith('.txt')?createHash('sha256').update(bytes).digest('hex')+'  dsh-shiguang-0.4.0.tgz':bytes);
 try{
  const old=new UpdateManager(ctx,f.dir,fetcher);await old.check();old.start('0.4.0');await installing;
  const rebuilt=new UpdateManager(ctx,f.dir,fetcher);assert.equal(rebuilt.view().phase,'installing');assert.equal((await rebuilt.check()).phase,'installing');assert.throws(()=>rebuilt.start('0.4.0'),/先检查/);
  finish!({application:'restart-required',version:'0.4.0'});await old.whenIdle();assert.equal(rebuilt.view().phase,'done');assert.match(rebuilt.view().message,/重启/);
  assert.equal((await rebuilt.check()).available,false);assert.equal(rebuilt.view().installed,'0.4.0');
  const path=join(f.dir,'updates','status.json'),saved=JSON.parse(readFileSync(path,'utf8'));saved.boot='old-process';saved.state.phase='installing';writeFileSync(path,JSON.stringify(saved));assert.equal(new UpdateManager(ctx,f.dir,fetcher).view().phase,'error');
 }finally{await ctx.fiber.dispose();f.cleanup();}
});

test('慢检查立即返回后台状态；重复点击不重复请求，页面轮询取到完成结果',async()=>{
 const f=fixture(),ctx=new Context();let release:(v:Response)=>void=()=>{},calls=0;
 const update=new UpdateManager(ctx,f.dir,async()=>{calls++;return new Promise(r=>{release=r;});});
 try{assert.equal(update.beginCheck().phase,'checking');assert.equal(update.beginCheck().phase,'checking');assert.equal(calls,1);release(Response.json([{tag_name:'v0.4.0'}]));await update.whenIdle();assert.equal(update.view().latest?.version,'0.4.0');}finally{await ctx.fiber.dispose();f.cleanup();}
});
test('GitHub API 限额时读取仓库版本清单；下载才使用指定加速，校验仍用官方地址',async()=>{
 const f=fixture(),ctx=new Context(),bytes=Buffer.from('mock'),urls:string[]=[];ctx.provide('pluginManager',{installBundle:async()=>({application:'restart-required',version:'0.4.0'})} as never);
 const u=new UpdateManager(ctx,f.dir,async url=>{urls.push(String(url));if(String(url).includes('api.github.com'))return new Response('',{status:403});if(String(url).endsWith('latest.json'))return Response.json({version:'0.4.0',notes:'备用版本清单'});if(String(url).endsWith('.txt'))return new Response(createHash('sha256').update(bytes).digest('hex')+'  dsh-shiguang-0.4.0.tgz');return new Response(bytes);},()=>({...f.settings.updates,mirrorUrl:'https://mirror.example.test/'}));
 try{await u.check();assert.equal(u.view().latest?.version,'0.4.0');u.start('0.4.0');await u.whenIdle();assert.equal(u.view().phase,'done');assert.ok(urls[2]?.startsWith('https://raw.githubusercontent.com/'));assert.ok(urls[3]?.startsWith('https://mirror.example.test/https://raw.githubusercontent.com/'));}finally{await ctx.fiber.dispose();f.cleanup();}
});
test('连接超时重试次数有上限，错误中文化；取消检查会终止请求且不调用安装器',async()=>{
 const f=fixture(),ctx=new Context();let calls=0;
 try{const u=new UpdateManager(ctx,f.dir,async()=>{calls++;throw new DOMException('The operation was aborted due to timeout','TimeoutError');},()=>({...f.settings.updates,retries:1}));await u.check();assert.equal(calls,4);assert.match(u.view().message,/连接 GitHub 超时/);
 const c=new UpdateManager(ctx,f.dir,async(_url,init)=>new Promise((_r,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})));c.beginCheck();c.cancel();await c.whenIdle();assert.equal(c.view().phase,'error');assert.match(c.view().message,/已取消/);
 }finally{await ctx.fiber.dispose();f.cleanup();}
});
