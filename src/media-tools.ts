import {readFileSync,existsSync,lstatSync,realpathSync,rmSync} from 'node:fs';
import {join,relative,isAbsolute,basename,sep} from 'node:path';
import type {Settings,MediaSettings} from './config.js';
import {checkEmbeddedEngine} from './embedded-media.js';
export interface ToolPaths {ffmpegPath:string;ffprobePath:string}
export interface MediaToolsHost {check?:(config:MediaSettings)=>Promise<{ready:boolean;message:string}>;[key:string]:unknown}
/** Only retire files carrying the exact manifest written by our old installer. */
export function cleanupOwnedMediaTools(dataDir:string){
 const root=join(dataDir,'media-tools'),manifest=join(root,'installed.json');
 if(!existsSync(manifest))return {removed:false,message:'没有拾光自行安装的旧视频工具需要清理'};
 try{
  if(lstatSync(root).isSymbolicLink()||lstatSync(manifest).isSymbolicLink())throw Error('旧工具记录是链接');
  const m=JSON.parse(readFileSync(manifest,'utf8'));if(!/^[a-f0-9]{64}$/.test(m.digest)||typeof m.version!=='string')throw Error('旧安装记录无法验证');
  for(const [key,name] of [['ffmpeg','ffmpeg.exe'],['ffprobe','ffprobe.exe']] as const){
   const value=m[key];if(typeof value!=='string'||isAbsolute(value)||value.includes('\\')&&sep!=='\\'||value.split(/[\\/]/).some((part:string)=>part==='..')||value.split(/[\\/]/)[0]!==m.digest||basename(value)!==name)throw Error('旧工具路径不属于拾光安装包');
   const file=join(root,value);if(existsSync(file)){const rel=relative(realpathSync(root),realpathSync(file));if(rel.startsWith('..')||isAbsolute(rel))throw Error('旧工具指向其他目录');}
  }
  const bundle=join(root,m.digest);if(existsSync(bundle)&&lstatSync(bundle).isSymbolicLink())throw Error('旧工具目录是链接');
  // Never remove the root: it can also contain user-owned files or other versions.
  for(const name of [m.digest,'ffmpeg.zip','parts']){const file=join(root,name);if(existsSync(file)&&lstatSync(file).isSymbolicLink())throw Error('旧工具文件是链接，保留等待手动检查');}
  for(const name of [m.digest,'ffmpeg.zip','parts'])rmSync(join(root,name),{recursive:true,force:true});rmSync(manifest);
  return {removed:true,message:'已清理拾光旧版自行安装的 FFmpeg / FFprobe、安装包及下载断点'};
 }catch(error){return {removed:false,message:'旧工具保留：'+(error instanceof Error?error.message:'清理未完成')};}
}
export class MediaToolsManager {
 private stopped=false;private abort=new AbortController();private pending?:Promise<{ready:boolean;message:string}>;
 private state={phase:'idle',message:'使用随插件安装的内置动图与视频引擎，无需定位或下载 FFmpeg',ready:false,downloaded:0,total:0,speed:0,cleanup:'尚未检查旧工具'};
 constructor(readonly dataDir:string,readonly settings:()=>Settings,_apply?:(paths:ToolPaths)=>void,_fetcher?:typeof fetch,readonly host:MediaToolsHost={},_findLocal?:()=>Promise<void>){}
 view(){return {...this.state,supported:true,busy:!!this.pending,engine:'embedded'};}
 migrate(){if(existsSync(join(this.dataDir,'media-tools','installed.json')))this.start();}
 async check(){
  if(this.stopped)throw Error('媒体工具服务正在停止');
  if(!this.pending){this.abort=new AbortController();this.state={...this.state,phase:'checking',message:'正在检测内置动画和视频解码引擎'};
   this.pending=(async()=>{try{const result=this.host.check?await this.host.check(this.settings().media):await checkEmbeddedEngine(this.abort.signal);this.abort.signal.throwIfAborted();if(!result.ready)throw Error(result.message);
    const cleanup=cleanupOwnedMediaTools(this.dataDir);this.state={...this.state,phase:'ready',ready:true,message:result.message,cleanup:cleanup.message};return result;
   }catch(error){this.state={...this.state,phase:'error',ready:false,message:this.abort.signal.aborted?'内置引擎检测已停止':error instanceof Error?error.message:'内置引擎未就绪'};return {ready:false,message:this.state.message};}finally{this.pending=undefined;}})();
  }
  const result=await this.pending;return {...this.view(),...result};
 }
 start(){if(this.stopped)throw Error('媒体工具服务正在停止');void this.check();return this.view();}
 async ensure(){if(!this.state.ready){const result=await this.check();if(!result.ready)throw Error(result.message);}}
 pause(){this.abort.abort();return this.view();}
 async whenIdle(){await this.pending;}
 stop(){this.stopped=true;this.abort.abort();}
}
