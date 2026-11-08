import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {existsSync,statSync,createReadStream,renameSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mirrorBaseUrl} from './config.js';
import type {DownloadAsset,DownloadProgress} from './package-download.js';
function powershell(script:string,args:string[],signal:AbortSignal,maxBuffer=2*1048576):Promise<string>{return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../scripts/'+script,import.meta.url)),...args],{windowsHide:true,signal,maxBuffer},(e,out)=>e?reject(new Error(signal.aborted?'系统下载已取消':'系统网络连接 GitHub 未成功，请检查代理或使用官方下载备用入口')):resolve(out)));}
export async function windowsPublicJSON(url:string,signal:AbortSignal){return JSON.parse((await powershell('Get-PublicJson.ps1',['-Uri',url],signal)).replace(/^\uFEFF/,''));}
export async function verifyPublicPackage(file:string,asset:DownloadAsset,signal:AbortSignal){const hash=createHash('sha256');let size=0;for await(const bytes of createReadStream(file)){signal.throwIfAborted();size+=bytes.length;hash.update(bytes);}if(size!==asset.size||hash.digest('hex')!==asset.digest.toLowerCase())throw new Error('安装包 SHA256 校验失败，未解压或执行');}
export async function windowsPublicPackage(asset:DownloadAsset,target:string,mirror:string,signal:AbortSignal,progress:(v:DownloadProgress)=>void){
 const part=target+'.system-part',base=mirror?mirrorBaseUrl(mirror):undefined,url=base?base.href+asset.url:asset.url,start=Date.now();let resumed=0;try{resumed=statSync(part).size;}catch{}
 const timer=setInterval(()=>{try{const downloaded=statSync(part).size;progress({downloaded,resumed,connections:1,speed:Math.max(0,downloaded-resumed)*1000/Math.max(1,Date.now()-start)});}catch{}},500);timer.unref();
 try{await powershell('Get-PublicPackage.ps1',['-Uri',url,'-Destination',part,'-ExpectedSize',String(asset.size),'-MirrorHost',base?.hostname||''],signal,65536);signal.throwIfAborted();const hash=createHash('sha256');let size=0;for await(const bytes of createReadStream(part)){signal.throwIfAborted();size+=bytes.length;hash.update(bytes);}if(size!==asset.size||hash.digest('hex')!==asset.digest){rmSync(part,{force:true});throw new Error('系统下载的安装包 SHA256 校验失败，未解压或执行');}if(existsSync(target))rmSync(target);renameSync(part,target);progress({downloaded:size,resumed,connections:1,speed:Math.max(0,size-resumed)*1000/Math.max(1,Date.now()-start)});}finally{clearInterval(timer);}
}
