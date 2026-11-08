import {readdir,stat,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import type {Settings} from './config.js';
export interface LocalPaths {directory?:string;qqPath?:string;ffmpegPath?:string;ffprobePath?:string}
export interface LocatorHost {roots:string[];onPath:(name:string)=>Promise<string[]>}
function exec(file:string,args:string[]):Promise<string>{return new Promise(resolve=>execFile(file,args,{windowsHide:true,timeout:1200,maxBuffer:65536},(e,out)=>resolve(e?'':out)));}
export function nativeLocator(settings:Settings):LocatorHost{
 const home=homedir(),env=process.env,roots=[settings.snowluma.directory,settings.snowluma.qqPath?dirname(settings.snowluma.qqPath):'',join(settings.dataDir,'media-tools'),process.cwd(),dirname(process.execPath),...['Downloads','Desktop','Documents','下载','桌面'].map(n=>join(home,n)),...['ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA','ProgramData'].flatMap(k=>env[k]?[join(env[k]!,'Tencent'),join(env[k]!,'SnowLuma'),join(env[k]!,'ffmpeg')]:[]),join(home,'scoop','apps','ffmpeg','current'),join(env.LOCALAPPDATA||home,'Microsoft','WinGet','Links'),join(env.LOCALAPPDATA||home,'Microsoft','WinGet','Packages'),join(env.ProgramData||home,'chocolatey','bin')];
 if(process.platform==='win32')for(const drive of ['C:','D:','E:','F:'])for(const name of ['SnowLuma','ffmpeg','QQNT'])roots.push(join(drive+'\\',name));
 return {roots:roots.filter(Boolean),async onPath(name){if(process.platform!=='win32')return (await exec('which',[name])).trim().split(/\r?\n/).filter(Boolean);const found=(await exec('where.exe',[name])).trim().split(/\r?\n/).filter(Boolean);if(name.toLowerCase()==='qq.exe')for(const hive of ['HKCU','HKLM']){const text=await exec('reg.exe',['query',hive+'\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\QQ.exe','/ve']);const match=text.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);if(match)found.push(match[1]!.trim().replace(/^"|"$/g,''));}return found;}};
}
/** Bounded common-directory discovery; never recursively traverses a whole drive. */
export async function locatePrograms(settings:Settings,host=nativeLocator(settings),signal?:AbortSignal):Promise<LocalPaths&{scanned:number}>{
 const result:LocalPaths={},queue=[...new Set(host.roots.filter(Boolean))].map(dir=>({dir,depth:0})),seen=new Set<string>();const deadline=Date.now()+5000;
 const [qq,ff,fp]=await Promise.all(['QQ.exe','ffmpeg','ffprobe'].map(name=>host.onPath(name).catch(()=>[])));
 for(const [key,files] of [['qqPath',qq],['ffmpegPath',ff],['ffprobePath',fp]] as const)for(const file of files||[]){try{if((await stat(file)).isFile()){result[key]=await realpath(file);break;}}catch{}}
 while(queue.length&&seen.size<700&&Date.now()<deadline){signal?.throwIfAborted();const {dir,depth}=queue.shift()!;let canonical:string;try{canonical=await realpath(dir);if(seen.has(canonical.toLowerCase()))continue;seen.add(canonical.toLowerCase());}catch{continue;}
  if(!result.directory&&existsSync(join(dir,'index.mjs'))&&(existsSync(join(dir,'launcher.bat'))||/snowluma/i.test(basename(dir))))result.directory=canonical;
  for(const [key,names] of [['qqPath',['QQ.exe']],['ffmpegPath',['ffmpeg.exe','ffmpeg']],['ffprobePath',['ffprobe.exe','ffprobe']]] as const)if(!result[key])for(const name of names){const file=join(dir,name);try{if((await stat(file)).isFile()){result[key]=await realpath(file);break;}}catch{}}
  if(depth>=3)continue;try{for(const entry of await readdir(dir,{withFileTypes:true})){if(!entry.isDirectory()||entry.isSymbolicLink()||/^(?:node_modules|\.git|cache|logs|data)$/i.test(entry.name))continue;if(depth===0||/snowluma|ffmpeg|QQNT|Tencent|^QQ$|^bin$|^runtime$|^current$|^[a-f\d]{64}$/i.test(entry.name))queue.push({dir:join(dir,entry.name),depth:depth+1});}}catch{}
 }
 return {...result,scanned:seen.size};
}
