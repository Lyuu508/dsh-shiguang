export type TaskKind='settings'|'panel'|'chat'|'background';
export interface TaskOptions {kind?:TaskKind;label?:string;key?:string;signal?:AbortSignal;cancel?:()=>void}
interface Task {kind:TaskKind;label:string;key?:string;addedAt:number;startedAt:number;controller:AbortController;cancel?:()=>void;cleanup:()=>void;run:(signal:AbortSignal)=>Promise<unknown>;resolve:(value:unknown)=>void;reject:(error:unknown)=>void;promise:Promise<unknown>}
const order:Record<TaskKind,number>={settings:0,panel:1,chat:2,background:3};
const ordinary=(task:Task)=>task.kind==='chat'||task.kind==='background';
/** All mutations still run serially; owner controls have reserved admission. */
export class TaskQueue {
 private pending:Task[]=[];private active?:Task;private keys=new Map<string,Task>();private closed=false;private idleWaiters:(()=>void)[]=[];
 private last={at:0,message:'待处理队列空闲'};
 constructor(readonly limit:()=>number,readonly log:(message:string)=>void=()=>{},readonly clock=Date.now){}
 submit<T>(run:(signal:AbortSignal)=>Promise<T>,options:TaskOptions={}):Promise<T>{
  if(this.closed)throw Error('拾光正在停止');options.signal?.throwIfAborted();
  const kind=options.kind||'chat',existing=options.key?this.keys.get(options.key):undefined;if(existing)return existing.promise as Promise<T>;
  const all=[...this.pending,...(this.active?[this.active]:[])];
  if((kind==='chat'||kind==='background')&&all.filter(ordinary).length>=this.limit())throw Error(`聊天与后台待办已达 ${this.limit()} 项；可在任务状态中停止当前任务并清理等待，设置操作仍可提交`);
  if(kind==='panel'&&all.filter(t=>t.kind==='panel').length>=6)throw Error('后台操作正在等待处理，请等待或停止当前任务后再试');
  if(kind==='settings'&&all.filter(t=>t.kind==='settings').length>=2)throw Error('已有设置正在保存，请等待保存完成');
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const result=new Promise<T>((yes,no)=>{resolve=yes;reject=no;}),promise={promise:result,resolve,reject},task:Task={kind,label:options.label||'处理消息',key:options.key,addedAt:this.clock(),startedAt:0,controller:new AbortController(),cancel:options.cancel,cleanup:()=>{},run,resolve:v=>promise.resolve(v as T),reject:promise.reject,promise:promise.promise};
  const abort=()=>this.abortTask(task,options.signal?.reason||Error('操作已取消'));options.signal?.addEventListener('abort',abort,{once:true});task.cleanup=()=>options.signal?.removeEventListener('abort',abort);
  this.pending.push(task);if(task.key)this.keys.set(task.key,task);queueMicrotask(()=>this.pump());return promise.promise;
 }
 private forget(task:Task){task.cleanup();if(task.key&&this.keys.get(task.key)===task)this.keys.delete(task.key);}
 private abortTask(task:Task,reason:unknown){
  if(task===this.active){if(task.kind==='settings'||task.controller.signal.aborted)return;task.controller.abort(reason);try{task.cancel?.();}catch{}return;}
  const at=this.pending.indexOf(task);if(at<0)return;this.pending.splice(at,1);this.forget(task);task.controller.abort(reason);task.reject(reason);this.notifyIdle();
 }
 private pump(){
  if(this.active||!this.pending.length){this.notifyIdle();return;}let index=0;for(let i=1;i<this.pending.length;i++)if(order[this.pending[i]!.kind]<order[this.pending[index]!.kind])index=i;
  const task=this.pending.splice(index,1)[0]!;this.active=task;task.startedAt=this.clock();
  void Promise.resolve().then(()=>{task.controller.signal.throwIfAborted();return task.run(task.controller.signal);}).then(value=>this.finish(task,undefined,value),error=>this.finish(task,error,undefined,true));
 }
 private finish(task:Task,error:unknown,value?:unknown,failed=false){
  this.forget(task);this.active=undefined;
  if(failed){try{if(!task.controller.signal.aborted)this.log(error instanceof Error?error.message:'操作未完成');}catch{}task.reject(error);}else task.resolve(value);
  this.pump();
 }
 private notifyIdle(){if(this.active||this.pending.length)return;for(const done of this.idleWaiters.splice(0))done();}
 idle(){return !this.active&&!this.pending.length?Promise.resolve():new Promise<void>(resolve=>this.idleWaiters.push(resolve));}
 interruptWork(reason=Error('配置将更新，停止旧任务后应用新设置')){if(this.active&&this.active.kind!=='settings')this.abortTask(this.active,reason);}
 clearWaiting(reason=Error('等待任务已取消；原始消息仍保留'),includeSettings=false){const jobs=this.pending.filter(t=>includeSettings||t.kind!=='settings');for(const task of jobs)this.abortTask(task,reason);return jobs.length;}
 cancel(){const cleared=this.clearWaiting(),running=!!this.active&&this.active.kind!=='settings';if(running)this.abortTask(this.active!,Error('已请求停止当前任务，不自动重发'));this.last={at:this.clock(),message:running?'已发出停止请求，等待当前操作安全收尾；等待任务已清理':'已清理等待任务，原始消息与已完成结果保留'};return {cleared,running,...this.status()};}
 close(){this.closed=true;this.clearWaiting(Error('拾光正在停止'),true);if(this.active&&this.active.kind!=='settings')this.abortTask(this.active,Error('拾光正在停止'));}
 status(){const now=this.clock(),counts={settings:0,panel:0,chat:0,background:0};for(const t of this.pending)counts[t.kind]++;return {total:this.pending.length+(this.active?1:0),waiting:this.pending.length,limit:this.limit(),counts,active:this.active?{label:this.active.label,kind:this.active.kind,since:this.active.startedAt,seconds:Math.max(0,Math.floor((now-this.active.startedAt)/1000)),cancelling:this.active.controller.signal.aborted}:null,last:this.last};}
}
