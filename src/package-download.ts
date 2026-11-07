import {createHash} from 'node:crypto';
import {mkdir,open,stat,rm,rename} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {mirrorBaseUrl} from './config.js';

export interface DownloadAsset {url:string;digest:string;size:number}
export interface DownloadProgress {downloaded:number;speed:number;resumed:number;connections:number}
const LIMIT=256*1024*1024;
/** Persisted ranges contain public release bytes only; the official digest is authoritative. */
export async function downloadPackage(asset:DownloadAsset,target:string,cacheRoot:string,options:{connections:number;mirrorUrl:string},signal:AbortSignal,fetcher:typeof fetch=fetch,progress:(p:DownloadProgress)=>void=()=>{}):Promise<void>{
  if(!/^[a-f0-9]{64}$/i.test(asset.digest)||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>LIMIT)throw new Error('安装包摘要或大小无效');
  const mirror=options.mirrorUrl?mirrorBaseUrl(options.mirrorUrl):undefined;
  const count=Math.max(1,Math.min(Math.floor(options.connections)||1,asset.size));
  const directory=join(cacheRoot,asset.digest+'-'+count);await mkdir(directory,{recursive:true,mode:0o700});
  const stop=new AbortController(),combined=AbortSignal.any([signal,stop.signal]);
  const initial=mirror?mirror.href+asset.url:asset.url;
  let total=0,resumed=0,connections=count;const started=performance.now();
  const report=()=>progress({downloaded:total,resumed,connections,speed:Math.max(0,(total-resumed)*1000/Math.max(1,performance.now()-started))});
  async function request(start:number,end:number):Promise<Response>{
    let url=initial;
    for(let i=0;i<6;i++){
      const u=new URL(url),allowed=['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com',...(mirror?[mirror.hostname]:[])];
      if(u.protocol!=='https:'||u.port||u.username||u.password||!allowed.includes(u.hostname))throw new Error('NapCat 下载跳转地址异常');
      const response=await fetcher(url,{headers:{'User-Agent':'dsh-shiguang','Accept-Encoding':'identity',Range:`bytes=${start}-${end}`},redirect:'manual',signal:combined});
      if(![301,302,303,307,308].includes(response.status))return response;
      const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new Error('NapCat 下载跳转地址缺失');url=new URL(location,url).href;
    }throw new Error('NapCat 下载跳转次数过多');
  }
  const spans=Array.from({length:count},(_,i)=>({start:Math.floor(i*asset.size/count),end:Math.floor((i+1)*asset.size/count)-1,file:join(directory,`part-${i}`),bytes:0}));
  for(const span of spans){try{const size=(await stat(span.file)).size;if(size>span.end-span.start+1){await rm(span.file);}else span.bytes=size;}catch{/* First attempt. */}total+=span.bytes;}
  resumed=total;report();
  async function consume(response:Response,file:string,max:number,append:boolean):Promise<number>{
    if(!response.ok||!response.body){await response.body?.cancel();throw new Error(`NapCat 下载 HTTP ${response.status}，可稍后继续`);}
    const encoding=response.headers.get('content-encoding');if(encoding&&encoding!=='identity'){await response.body.cancel();throw new Error('下载服务器没有按原始字节返回安装包');}
    const fd=await open(file,append?'a':'w',0o600),reader=response.body.getReader();let bytes=0;
    try{for(;;){const result=await reader.read();if(result.done)break;combined.throwIfAborted();bytes+=result.value.length;if(bytes>max)throw new Error('安装包下载内容超出声明范围');await fd.writeFile(result.value);total+=result.value.length;report();}if(bytes!==max)throw new Error('安装包下载中断，已保存断点');return bytes;}finally{await reader.cancel().catch(()=>{});await fd.close();}
  }
  try{
    if(total<asset.size){
      const probe=await request(0,0);
      if(probe.status===200){
        // A server ignoring Range must never be concatenated into several parts.
        const single=join(directory,'single');total=0;resumed=0;connections=1;report();
        await consume(probe,single,asset.size,false);
        await assemble([single]);return;
      }
      if(probe.status!==206||probe.headers.get('content-range')!==`bytes 0-0/${asset.size}`){await probe.body?.cancel();throw new Error(`下载服务器不支持有效的分段请求（HTTP ${probe.status}）`);}
      await probe.body?.cancel();
      const tasks=spans.map(async span=>{
        for(let attempt=0;attempt<2;attempt++){
          const current=await stat(span.file).then(s=>s.size).catch(()=>0),remaining=span.end-span.start+1-current;
          if(!remaining)return;
          let response:Response|undefined;
          try{
            combined.throwIfAborted();const start=span.start+current;response=await request(start,span.end);
            if(response.status!==206||response.headers.get('content-range')!==`bytes ${start}-${span.end}/${asset.size}`){await response.body?.cancel();throw new Error('分段下载响应范围无效，断点未写入');}
            await consume(response,span.file,remaining,true);return;
          }catch(error){
            combined.throwIfAborted();if(attempt||response&&response.status!==206)throw error;
          }
        }
      });
      try{await Promise.all(tasks);}catch(error){stop.abort();await Promise.allSettled(tasks);throw error;}
    }
    await assemble(spans.map(s=>s.file));
  }catch(error){
    if(signal.aborted)throw new Error('下载已暂停，断点已保存，下次可继续');
    if(error instanceof Error&&/校验/.test(error.message))await rm(directory,{recursive:true,force:true});
    throw error instanceof Error?error:new Error('NapCat 下载未完成，已保留断点');
  }
  async function assemble(parts:string[]):Promise<void>{
    combined.throwIfAborted();const temporary=target+'.part',fd=await open(temporary,'w',0o600),hash=createHash('sha256');let bytes=0;
    try{
      for(const part of parts){for await(const chunk of createReadStream(part)){combined.throwIfAborted();bytes+=chunk.length;if(bytes>asset.size)throw new Error('安装包大小校验失败');hash.update(chunk);await fd.writeFile(chunk);}}
      if(bytes!==asset.size||hash.digest('hex')!==asset.digest)throw new Error('NapCat 安装包 SHA256 或大小校验失败，未解压或启动');
      await fd.close();await rename(temporary,target);await rm(directory,{recursive:true,force:true});total=asset.size;report();
    }finally{await fd.close().catch(()=>{});await rm(temporary,{force:true});}
  }
}
