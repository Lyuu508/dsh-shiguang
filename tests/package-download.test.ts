import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {downloadPackage,type DownloadProgress} from '../src/package-download.js';
import {fixture} from './helpers.js';

const bytes=Buffer.from(Array.from({length:65536},(_,i)=>(i*31+i%13)%256));
const asset={url:'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip',size:bytes.length,digest:createHash('sha256').update(bytes).digest('hex')};
test('真实 HTTP Range 并行下载，断网重试保留断点，再次只下载剩余部分并校验合并结果',async()=>{
 const f=fixture();let fail=true,active=0,maxActive=0;const ranges:string[]=[];
 const server=createServer((req,res)=>{
  const range=String(req.headers.range),match=/^bytes=(\d+)-(\d+)$/.exec(range);assert.ok(match);const start=Number(match[1]),end=Number(match[2]);ranges.push(range);
  res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1});
  if(start===0&&end===0){res.end(bytes.subarray(0,1));return;}
  active++;maxActive=Math.max(active,maxActive);res.once('close',()=>active--);
  if(fail){res.write(bytes.subarray(start,start+Math.max(1,Math.floor((end-start+1)/2))));setTimeout(()=>res.destroy(),20);}
  else setTimeout(()=>res.end(bytes.subarray(start,end+1)),10);
 });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const fetcher:typeof fetch=async(_url,init)=>fetch(`http://127.0.0.1:${address.port}/asset`,init);
 const target=join(f.dir,'release.zip'),cache=join(f.dir,'cache'),updates:DownloadProgress[]=[];
 try{
  await assert.rejects(downloadPackage(asset,target,cache,{connections:4,mirrorUrl:''},new AbortController().signal,fetcher,p=>updates.push(p)));
  assert.equal(existsSync(target),false);assert.ok(maxActive>1);const files=readdirSync(join(cache,asset.digest+'-4'));assert.ok(files.some(x=>x.startsWith('part-')));
  fail=false;ranges.length=0;
  await downloadPackage(asset,target,cache,{connections:4,mirrorUrl:''},new AbortController().signal,fetcher,p=>updates.push(p));
  assert.deepEqual(readFileSync(target),bytes);assert.ok(updates.some(p=>p.resumed>0));assert.ok(ranges.some(r=>{const [,start,end]=r.match(/^bytes=(\d+)-(\d+)$/)!;return Number(end)>0&&Number(start)%16384>0;}));
  assert.equal(updates.at(-1)?.downloaded,bytes.length);assert.deepEqual(readdirSync(cache),[]);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));f.cleanup();}
});
test('服务器忽略 Range 时回退单连接，不拼接多份完整文件；镜像仍核验官方 SHA256',async()=>{
 const f=fixture(),urls:string[]=[];let calls=0;const updates:DownloadProgress[]=[];
 try{
  const target=join(f.dir,'release.zip');
  await downloadPackage(asset,target,join(f.dir,'cache'),{connections:4,mirrorUrl:'https://trusted-mirror.example/proxy/'},new AbortController().signal,async url=>{calls++;urls.push(String(url));return new Response(bytes);},p=>updates.push(p));
  assert.equal(calls,1);assert.ok(urls[0]?.startsWith('https://trusted-mirror.example/proxy/https://github.com/'));assert.deepEqual(readFileSync(target),bytes);assert.equal(updates.at(-1)?.connections,1);
  await assert.rejects(downloadPackage({...asset,digest:'0'.repeat(64)},join(f.dir,'bad.zip'),join(f.dir,'bad-cache'),{connections:4,mirrorUrl:''},new AbortController().signal,async()=>new Response(bytes)),/校验/);
  assert.equal(existsSync(join(f.dir,'bad.zip')),false);assert.deepEqual(readdirSync(join(f.dir,'bad-cache')),[]);
 }finally{f.cleanup();}
});
test('分段范围错误和非官方下载跳转被拒绝，取消后可保留断点而不发布半成品',async()=>{
 const f=fixture();try{
  await assert.rejects(downloadPackage(asset,join(f.dir,'bad.zip'),join(f.dir,'range'),{connections:2,mirrorUrl:''},new AbortController().signal,async()=>new Response(bytes.subarray(0,1),{status:206,headers:{'content-range':'bytes 0-1/2'}})),/分段/);
  const requested:string[]=[];
  await assert.rejects(downloadPackage(asset,join(f.dir,'bad.zip'),join(f.dir,'redirect'),{connections:2,mirrorUrl:''},new AbortController().signal,async url=>{requested.push(String(url));return new Response('',{status:302,headers:{location:'https://untrusted.test/payload'}});}),/跳转/);assert.equal(requested.length,1);
  const abort=new AbortController();const promise=downloadPackage(asset,join(f.dir,'cancel.zip'),join(f.dir,'cancel'),{connections:4,mirrorUrl:''},abort.signal,async(_url,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});setTimeout(()=>abort.abort(),10);}));
  await assert.rejects(promise,/断点/);assert.equal(existsSync(join(f.dir,'cancel.zip')),false);
 }finally{f.cleanup();}
});
