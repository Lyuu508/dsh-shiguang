import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers.js';
import {MemoryStore} from '../src/memory.js';
import {BilibiliClient} from '../src/bilibili.js';
import {BiliBlockedError} from '../src/bili-errors.js';
const good='BV1xx411c7mD',data={aid:123,bvid:good,title:'视频',desc:'内容',owner:{name:'作者'},pages:[{cid:11,duration:30},{cid:12,duration:40}],stat:{view:5000}};
function setup(){const f=fixture();f.settings.bilibili.enabled=true;const m=new MemoryStore(':memory:',f.settings.roleId,'UTC',f.settings.memory);return {f,m,close(){m.close();f.cleanup();}};}
const save=(dir:string,identity='companion',token='fixture-session')=>writeFileSync(join(dir,identity==='owner'?'bilibili.owner.cookies.json':'bilibili.cookies.json'),JSON.stringify({SESSDATA:token,bili_jct:'fixture-csrf'}));
test('已登录视频分P携带伙伴会话，只请求一次元信息；模拟访客412可以通过正确登录会话读取',async()=>{
 const s=setup();save(s.f.dir);let calls=0;const b=new BilibiliClient(s.f.settings,s.m,async(url,init)=>{calls++;assert.equal(new URL(String(url)).hostname,'api.bilibili.com');const cookie=new Headers(init?.headers).get('cookie');return cookie?.includes('SESSDATA=fixture-session')?Response.json({code:0,data}):new Response('',{status:412});});try{const result=await b.videoPart(good,2);assert.equal(result.cid,'12');assert.equal(result.duration,40);assert.equal(calls,1);assert.equal(b.riskStatus().active,false);}finally{s.close();}
});
test('伙伴和主人元信息读取只使用各自会话，不互借账号',async()=>{
 const s=setup();save(s.f.dir);save(s.f.dir,'owner','fixture-owner');const seen:string[]=[];const fetcher:typeof fetch=async(_u,init)=>{seen.push(new Headers(init?.headers).get('cookie')||'');return Response.json({code:0,data});};try{await new BilibiliClient(s.f.settings,s.m,fetcher).video(good);await new BilibiliClient(s.f.settings,s.m,fetcher,'owner').video(good);assert.match(seen[0]!,/SESSDATA=fixture-session/);assert.doesNotMatch(seen[0]!,/fixture-owner/);assert.match(seen[1]!,/SESSDATA=fixture-owner/);assert.doesNotMatch(seen[1]!,/fixture-session/);}finally{s.close();}
});
test('未登录仍可读取公开元信息，扫码请求不附带读取会话',async()=>{
 const s=setup();const seen:{url:string;cookie:string|null}[]=[];const b=new BilibiliClient(s.f.settings,s.m,async(u,init)=>{seen.push({url:String(u),cookie:new Headers(init?.headers).get('cookie')});return Response.json({code:0,data:String(u).includes('/generate')?{url:'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=fixture',qrcode_key:'fixture'}:data});});try{await b.video(good);assert.equal(seen[0]?.cookie,null);save(s.f.dir);await b.startLogin();assert.equal(seen[1]?.cookie,null);assert.ok(seen.every(r=>new URL(r.url).hostname==='api.bilibili.com'||new URL(r.url).hostname==='passport.bilibili.com'));}finally{s.close();}
});
test('保存的登录文件损坏时明确报登录错误，不悄悄以访客身份重试',async()=>{
 const s=setup();writeFileSync(join(s.f.dir,'bilibili.cookies.json'),'{}');let calls=0;const b=new BilibiliClient(s.f.settings,s.m,async()=>{calls++;return Response.json({code:0,data});});try{await assert.rejects(b.video(good),/登录文件不完整/);assert.equal(calls,0);}finally{s.close();}
});
test('登录更新和停用后使用最新凭据，不残留旧会话缓存；非法分P不请求网络',async()=>{
 const s=setup();save(s.f.dir);const seen:(string|null)[]=[];const b=new BilibiliClient(s.f.settings,s.m,async(_u,init)=>{seen.push(new Headers(init?.headers).get('cookie'));return Response.json({code:0,data});});try{await b.video(good);save(s.f.dir,'companion','fixture-new');await b.videoPart(good);b.logout();await b.video(good);assert.match(seen[1]!,/fixture-new/);assert.equal(seen[2],null);await assert.rejects(b.videoPart(good,0),/正整数/);assert.equal(seen.length,3);}finally{s.close();}
});
test('正确携带会话仍被412拒绝时保留冷却和停止重试，不切换访客身份或其他接口',async()=>{
 const s=setup();save(s.f.dir);let calls=0;const b=new BilibiliClient(s.f.settings,s.m,async(_u,init)=>{calls++;assert.match(new Headers(init?.headers).get('cookie')!,/fixture-session/);return new Response('',{status:412});});try{await assert.rejects(b.videoPart(good),BiliBlockedError);await assert.rejects(b.video(good),BiliBlockedError);assert.equal(calls,1);assert.equal(b.riskStatus().stage,'视频信息读取');}finally{s.close();}
});
