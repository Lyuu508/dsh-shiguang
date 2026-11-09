import {Worker} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import type {MediaSettings} from './config.js';
import type {FrameSheet} from './media.js';
import {MediaError} from './media.js';
import {timeoutSignal} from './timeouts.js';
async function work<T>(data:unknown,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('../scripts/media-worker.mjs',import.meta.url),{workerData:data,execArgv:[]}),abort=()=>finish(new MediaError('媒体处理已取消或超时，请缩短视频或调大处理等待时间'));
  let settled=false;const finish=(error?:Error,result?:T)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);void worker.terminate();if(error)reject(error);else resolve(result!);};
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  worker.once('message',message=>message.ok?finish(undefined,message.result):finish(new MediaError(message.message,message.diagnostic)));
  worker.once('error',error=>finish(new MediaError('内置解码引擎启动失败，请重新安装当前插件',error.message.replace(/(?:file:\/\/)?[^\s]+(?:node_modules|media-worker)[^\s]*/g,'[插件路径]'))));
  worker.once('exit',code=>{if(!settled)finish(new MediaError(`内置解码任务意外结束（${code}），可检查内存或重试较短视频`));});
 });
}
export async function embeddedFrameSheet(file:string,c:MediaSettings,signal:AbortSignal,range?:{start:number;duration:number}):Promise<FrameSheet>{
 const bytes=await readFile(file);if(bytes.length>c.maxFileMB*1048576)throw new MediaError('媒体超出下载大小上限');const result=await work<FrameSheet>({op:'frames',bytes,config:{frames:c.frames,frameSelection:c.frameSelection,animationFrames:c.animationFrames,sheetSize:c.sheetSize,maxDurationSeconds:c.maxDurationSeconds,maxFileMB:c.maxFileMB},range},signal);return {...result,bytes:Buffer.from(result.bytes)};
}
export function checkEmbeddedEngine(signal:AbortSignal=timeoutSignal(30000)){return work<{ready:boolean;message:string}>({op:'check'},signal);}
