import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFileSync,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {MemoryStore} from '../src/memory.js';
import {exportMemoryPage,importMemory} from '../src/memory-transfer.js';
import {SnowLumaManager} from '../src/snowluma.js';
import {MediaToolsManager,mediaToolsAsset} from '../src/media-tools.js';
import {BilibiliClient,weightedTag} from '../src/bilibili.js';
import {parseSettings} from '../src/config.js';
import {ShiguangRuntime} from '../src/runtime.js';
import {fixture} from './helpers.js';

test('SnowLuma 只启动已安装官方目录及 QQ 原生窗口，重复启动复用进程，不提供代下载',async()=>{
 const f=fixture();let launches=0,opens=0,kills=0;const child=Object.assign(new EventEmitter(),{killed:false,kill(){this.killed=true;kills++;}}) as ChildProcess;
 const manager=new SnowLumaManager(f.dir,()=>f.settings,{platform:'win32',launch(dir,log){assert.equal(dir,f.settings.snowluma.directory);assert.match(log,/snowluma/);launches++;return child;},openQQ(file){assert.equal(file,f.settings.snowluma.qqPath);opens++;}});
 try{assert.equal(manager.view().version,'');assert.throws(()=>manager.start(),/官方/);f.settings.snowluma.directory=join(f.dir,'official');mkdirSync(f.settings.snowluma.directory);writeFileSync(join(f.settings.snowluma.directory,'index.mjs'),'');f.settings.snowluma.qqPath=join(f.dir,'QQ.exe');writeFileSync(f.settings.snowluma.qqPath,'');
  manager.start();manager.start();assert.equal(launches,1);assert.equal(opens,1);assert.equal(manager.consoleUrl().url,'http://127.0.0.1:5099/');assert.equal(manager.view().installed,true);await manager.stop();assert.equal(kills,1);
  for(const webuiUrl of ['http://evil.example','http://127.0.0.1:5099/?token=secret','http://user@127.0.0.1:5099'])assert.throws(()=>parseSettings({...f.settings,snowluma:{...f.settings.snowluma,webuiUrl}},join(f.dir,'config.json')));
 }finally{await manager.stop();f.cleanup();}
});

test('便携媒体工具校验官方元数据与字节，解压后自动应用路径，重启无需重下',async()=>{
 const f=fixture(),bytes=Buffer.from('fixture LGPL media archive'),digest=createHash('sha256').update(bytes).digest('hex'),release={tag_name:'latest',assets:[{name:'ffmpeg-master-latest-win64-lgpl.zip',size:bytes.length,digest:'sha256:'+digest,browser_download_url:'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip'}]};let extracts=0,downloads=0;
 const fetcher:typeof fetch=async url=>{if(String(url).includes('api.github.com'))return Response.json(release);downloads++;return new Response(bytes);};
 const host={platform:'win32',arch:'x64',async check(media:typeof f.settings.media){const ready=media.ffmpegPath.endsWith('.exe')&&existsSync(media.ffmpegPath)&&existsSync(media.ffprobePath);return {ready,message:ready?'FFmpeg 与 FFprobe 可用':'未安装'};},async extract(_archive:string,destination:string){extracts++;mkdirSync(join(destination,'bin'));for(const name of ['ffmpeg.exe','ffprobe.exe'])writeFileSync(join(destination,'bin',name),'fixture');}};
 const apply=(paths:{ffmpegPath:string;ffprobePath:string})=>Object.assign(f.settings.media,paths),manager=new MediaToolsManager(f.dir,()=>f.settings,apply,fetcher,host);
 try{assert.equal((await manager.check()).ready,false);await manager.ensure();assert.equal(manager.view().ready,true);assert.equal(extracts,1);assert.equal(downloads,1);assert.match(f.settings.media.ffmpegPath,/ffmpeg\.exe$/);f.settings.media.ffmpegPath='missing';f.settings.media.ffprobePath='missing';const next=new MediaToolsManager(f.dir,()=>f.settings,apply,fetcher,host);assert.equal((await next.check()).ready,true);assert.equal(downloads,1);
  assert.throws(()=>mediaToolsAsset({...release,tag_name:'../bad'}),/官方/);assert.throws(()=>mediaToolsAsset({...release,assets:[{...release.assets[0],digest:''}]}),/SHA256/);
 }finally{manager.stop();f.cleanup();}
});

test('损坏媒体工具包不会解压、不会应用路径，失败可重试',async()=>{
 const f=fixture(),digest=createHash('sha256').update('good').digest('hex');let extracted=false,applied=false;
 const manager=new MediaToolsManager(f.dir,()=>f.settings,()=>{applied=true;},async url=>String(url).includes('api.github.com')?Response.json({tag_name:'latest',assets:[{name:'ffmpeg-master-latest-win64-lgpl.zip',size:4,digest:'sha256:'+digest,browser_download_url:'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip'}]}):new Response('evil'),{platform:'win32',arch:'x64',async extract(){extracted=true;},async check(){return {ready:false,message:'missing'};}});
 try{await assert.rejects(manager.ensure(),/校验/);assert.equal(extracted,false);assert.equal(applied,false);assert.equal(manager.view().busy,false);assert.equal(manager.view().phase,'error');}finally{manager.stop();f.cleanup();}
});

test('插件停止期间媒体检测返回，不会重新启动下载或写入配置',async()=>{
 const f=fixture();let finish!:(r:{ready:boolean;message:string})=>void,requests=0;const check=new Promise<{ready:boolean;message:string}>(r=>finish=r),manager=new MediaToolsManager(f.dir,()=>f.settings,()=>assert.fail('must not apply'),async()=>{requests++;throw Error('must not download');},{platform:'win32',arch:'x64',check:()=>check,extract:async()=>assert.fail('must not extract')});
 try{const pending=manager.ensure();manager.stop();finish({ready:false,message:'missing'});await assert.rejects(pending,/停止/);assert.throws(()=>manager.start(),/停止/);assert.equal(requests,0);}finally{manager.stop();f.cleanup();}
});

test('主人 B 站凭据独立、历史标签去重并排除黑名单，所有写操作在请求前拒绝',async()=>{
 const f=fixture(),m=new MemoryStore(':memory:','a','UTC',f.settings.memory);f.settings.bilibili.blockedTags=['广告'];let requests=0;
 writeFileSync(join(f.dir,'bilibili.cookies.json'),JSON.stringify({SESSDATA:'companion',bili_jct:'csrf-c'}));writeFileSync(join(f.dir,'bilibili.owner.cookies.json'),JSON.stringify({SESSDATA:'owner',bili_jct:'csrf-o'}));
 const fetcher:typeof fetch=async(url,init)=>{requests++;assert.match(new Headers(init?.headers).get('Cookie')||'',/SESSDATA=owner/);if(String(url).includes('/nav'))return Response.json({code:0,data:{isLogin:true,mid:1,uname:'主人'}});if(String(url).includes('/history/cursor'))return Response.json({code:0,data:{list:[{history:{business:'archive',bvid:'BV1xx411c7mD'}},{history:{business:'archive',bvid:'BV1xx411c7mD'}},{history:{business:'live',oid:4}},{history:{business:'archive',oid:123}}],cursor:{}}});return Response.json({code:0,data:[{tag_name:'天文'},{tag_name:'广告'}]});};
 const owner=new BilibiliClient(f.settings,m,fetcher,'owner');try{const result=await owner.recentInterestTags(2);assert.equal(result.videos,2);assert.deepEqual(result.tags,[{tag:'天文',count:2}]);assert.equal(m.overview().total,0);const before=requests;await assert.rejects(owner.comment('av123','好'),/主人账号/);await assert.rejects(owner.like('av123'),/主人账号/);await assert.rejects(owner.dynamic('好'),/主人账号/);await assert.rejects(owner.sendDirect('123','好'),/主人账号/);assert.equal(requests,before);owner.logout();assert.equal(new BilibiliClient(f.settings,m).hasLogin(),true);assert.equal(owner.hasLogin(),false);assert.match(readFileSync(join(f.dir,'bilibili.cookies.json'),'utf8'),/companion/);
 }finally{m.close();f.cleanup();}
});

test('白名单主题按 1–10 权重抽选，配置与概率边界有效',()=>{
 const f=fixture();try{assert.equal(weightedTag(['科技','音乐'],{科技:10,音乐:1},()=>0.89),'科技');assert.equal(weightedTag(['科技','音乐'],{科技:10,音乐:1},()=>0.95),'音乐');for(const weight of [0,11,1.5])assert.throws(()=>parseSettings({...f.settings,bilibili:{...f.settings.bilibili,tagWeights:{科技:weight}}},join(f.dir,'config.json')));}finally{f.cleanup();}
});

test('普通聊天即使反复出现也会淡忘，明确教导和频繁知识问答跨月保留；恢复保持权限隔离',()=>{
 const f=fixture();let now=Date.parse('2026-01-01T10:00:00Z');const m=new MemoryStore(':memory:','a','UTC',f.settings.memory,()=>now);try{
  const routine:string[]=[];for(let i=0;i<6;i++)routine.push(m.append('owner','qq','p','user','今天喝了咖啡。')!);
  const teaching=m.append('owner','qq','p','user','我教你：猎户星云位于猎户座。')!;
  for(let i=0;i<5;i++){m.append('owner','qq','p','user','如何学习吉他和弦？');m.append('owner','qq','p','assistant','吉他和弦需要每天慢练。');}
  m.append('qq:group:7','qq','qq:group:7','user','群里的咖啡秘密');now+=31*86400000;assert.ok(m.sweep().forgotten>=7);assert.equal(m.search('owner','咖啡','all').length,0);assert.ok(m.search('owner','猎户星云','all').some(r=>r.id===teaching));assert.ok(m.search('owner','吉他和弦','all').length>0);assert.ok(m.timeline({scope:'owner',day:'',state:'forgotten'}).rows.some(r=>r.id===routine[0]));m.remember(routine[0]);assert.ok(m.search('owner','咖啡','all').some(r=>r.id===routine[0]));assert.throws(()=>m.remember('unknown'));assert.throws(()=>m.detail('qq:group:7',teaching));assert.ok(m.concepts('owner','吉他').some(r=>r.pinned===1));
 }finally{m.close();f.cleanup();}
});

test('精确检索增加记忆权重和有效期，备份导入保留永久与淡忘状态',()=>{
 const f=fixture();let now=Date.parse('2026-01-01T10:00:00Z');const m=new MemoryStore(':memory:','a','UTC',f.settings.memory,()=>now),copy=new MemoryStore(':memory:','b','UTC',f.settings.memory,()=>now);try{const id=m.append('owner','bilibili','bilibili','experience','那次看了超新星爆发视频')!,old=m.append('owner','qq','p','user','午餐普通闲聊')!;for(let i=0;i<5;i++)m.search('owner','超新星','all');now+=31*86400000;m.sweep();assert.equal(m.portableMeta(id).pinned,true);assert.equal(m.portableMeta(old).forgotten,true);const page=exportMemoryPage(m,'owner','all');assert.equal(importMemory(copy,'owner','all',JSON.stringify({format:page.format,version:1,memories:page.rows}),'json').added,2);const all=copy.timeline({scope:'owner',day:'',state:'all'}).rows;assert.equal(all.find(r=>r.body.includes('超新星'))?.pinned,true);assert.equal(all.find(r=>r.body.includes('午餐'))?.forgotten,true);assert.equal(copy.search('owner','午餐','all').length,0);
 }finally{m.close();copy.close();f.cleanup();}
});

test('v8 升级备份并迁移全文索引，旧普通记录获得 30 天过渡而不立即消失',()=>{
 const f=fixture(),file=join(f.dir,'legacy.sqlite');let now=Date.parse('2026-11-01T00:00:00Z');let m=new MemoryStore(file,'a','UTC',f.settings.memory,()=>now);const id=m.append('owner','qq','p','user','春天的观星旅行',undefined,now-180*86400000)!;m.db.exec('DROP TABLE memory_meta; DROP TABLE memory_concepts; DROP TABLE memory_terms; CREATE VIRTUAL TABLE old_fts USING fts5(tokens,namespace,day UNINDEXED); INSERT INTO old_fts(rowid,tokens,namespace,day) SELECT rowid,tokens,namespace,day FROM memory_fts; DROP TABLE memory_fts; ALTER TABLE old_fts RENAME TO memory_fts; PRAGMA user_version=8;');m.close();
 try{m=new MemoryStore(file,'a','UTC',f.settings.memory,()=>now);assert.ok(existsSync(file+'.v8-backup'));assert.equal(m.sweep().forgotten,0);assert.ok(m.search('owner','观星').some(r=>r.id===id));now+=31*86400000;assert.equal(m.sweep().forgotten,1);assert.equal(m.search('owner','观星').length,0);}finally{m.close();f.cleanup();}
});

test('创建与切换角色保留各自记忆、人设及作息，共用当前连接；重启后档案仍在',async()=>{
 const f=fixture(),ctx=new Context(),file=join(f.dir,'config.json');writeFileSync(file,JSON.stringify(f.settings));let runtime=new ShiguangRuntime(ctx,file);try{const original=runtime.settings.roleId;const id=runtime.memory.append('owner','qq','p','user','原角色的山野故事')!;const oldQQ=runtime.settings.qq.wsUrl;const next=await runtime.createRole('新伙伴','喜欢星空',false,runtime.revision());assert.equal(next.settings.displayName,'新伙伴');assert.notEqual(next.settings.roleId,original);assert.equal(runtime.settings.qq.wsUrl,oldQQ);assert.equal(runtime.memory.overview().total,0);assert.throws(()=>runtime.memory.detail('owner',id));runtime.memory.append('owner','bilibili','bilibili','experience','新伙伴看星云');await runtime.switchRole(original,runtime.revision());assert.match(runtime.memory.detail('owner',id).text,/山野/);assert.equal(runtime.memory.search('owner','星云','all').length,0);assert.equal(runtime.view().roles.length,2);await runtime.stop();runtime=new ShiguangRuntime(ctx,file);assert.equal(runtime.view().roles.length,2);assert.equal(runtime.settings.roleId,original);assert.match(runtime.memory.detail('owner',id).text,/山野/);await assert.rejects(runtime.switchRole(next.settings.roleId,'stale'),/其他窗口/);
 }finally{await runtime.stop();await ctx.fiber.dispose();f.cleanup();}
});

test('两个 B 站登录票据互不覆盖，停用主人凭据不影响伙伴二维码',async()=>{
 const f=fixture(),ctx=new Context(),file=join(f.dir,'config.json');writeFileSync(file,JSON.stringify(f.settings));let key=0;const runtime=new ShiguangRuntime(ctx,file,async url=>{if(String(url).includes('/generate')){const k='k'+(++key);return Response.json({code:0,data:{url:'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key='+k,qrcode_key:k}});}const r=Response.json({code:0,data:{code:0}});r.headers.append('set-cookie','SESSDATA=fixture-session; Path=/');r.headers.append('set-cookie','bili_jct=fixture-csrf; Path=/');return r;});
 try{const companion=await runtime.startLogin(),owner=await runtime.startLogin(undefined,'owner');runtime.logoutOwnerBili();assert.equal((await runtime.pollOwnerLogin(owner.ticket)).status,'expired');assert.equal((await runtime.pollLogin(companion.ticket)).status,'success');assert.equal(runtime.bili.hasLogin(),true);assert.equal(runtime.ownerBili.hasLogin(),false);}finally{await runtime.stop();await ctx.fiber.dispose();f.cleanup();}
});
