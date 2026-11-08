import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import type {Context} from '@deepseek-ai/cordis';
import type {GenerateOptions,StreamChunk,TokenUsage} from '@deepseek-ai/dsh-llm';
import {counterValues} from './usage.js';
import {dayKey} from './memory.js';
/** Local counters only: never stores prompts, tool arguments, messages or keys. */
export class UsageObserver {
 private db:DatabaseSync;private stopped=false;private dispose:()=>unknown;lastError='';
 constructor(ctx:Context,path:string,readonly current:()=>{roleId:string;timezone:string},readonly clock=Date.now){
  this.db=new DatabaseSync(path);this.db.exec("PRAGMA busy_timeout=5000; UPDATE llm_wire_usage SET status='interrupted' WHERE status='pending'");this.dispose=ctx.on('llm/stream',(options,next)=>this.observe(options,next));
 }
 private async *observe(options:GenerateOptions,next:()=>AsyncIterable<StreamChunk>):AsyncIterable<StreamChunk>{
  if(this.stopped){yield* next();return;}
  const id=randomUUID(),time=this.clock(),{roleId,timezone}=this.current();let usage:TokenUsage|undefined,status='interrupted';
  this.write(()=>this.db.prepare("INSERT INTO llm_wire_usage(id,session,role,day,time,provider,model,status) VALUES(?,?,?,?,?,?,?,'pending')").run(id,String(options.sessionId||''),roleId,dayKey(time,timezone),time,options.provider,options.model));
  try{for await(const chunk of next()){if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish')status=chunk.reason.kind==='stop'||chunk.reason.kind==='tool-calls'?'done':chunk.reason.kind;yield chunk;}}
  catch(error){status='failed';throw error;}
  finally{this.write(()=>this.db.prepare('UPDATE llm_wire_usage SET status=?,missing=?,input=?,cache_read=?,cache_write=?,output=?,reasoning=?,full_total=?,total_source=?,unclassified=?,mismatch=?,raw_usage=? WHERE id=?').run(status,...counterValues(usage),id));}
 }
 private write(fn:()=>unknown){if(this.stopped)return;try{fn();this.lastError='';}catch{this.lastError='部分本机请求未能写入用量记录，请检查数据目录与磁盘空间';}}
 stop(){this.stopped=true;this.dispose();this.db.close();}
}
