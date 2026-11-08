import {scheduleTimeout,type ScheduledTimer} from './timeouts.js';
import type {QQMessage} from './onebot.js';
import type {Settings} from './config.js';
export interface QQBatch {id:string;thread:string;messages:QQMessage[];target:QQMessage;firstAt:number;dueAt:number}
interface Pending extends QQBatch {lastAt:number;delay:number;timer?:ScheduledTimer}
/** Intake and quiet timers never occupy the model/configuration queue. */
export class QQConversation {
 private pending=new Map<string,Pending>();private active=new Map<string,AbortController>();private stopped=false;
 private last={at:0,reason:'等待新的白名单消息'};
 constructor(readonly config:Settings['qq']['chat'],readonly run:(batch:QQBatch,signal:AbortSignal)=>Promise<void>,readonly log:(message:string)=>void,readonly clock=Date.now,readonly random=Math.random){}
 offer(message:QQMessage,eligible:boolean,admit:()=>boolean=()=>true){
  if(this.stopped)return false;
  const now=this.clock(),c=this.config,selected=eligible&&(!c.enabled||this.random()*100<c.replyChance)&&admit();
  let batch=this.pending.get(message.thread);
  if(!batch&&!selected){this.last={at:now,reason:eligible?'本条按回应概率保持安静；原话已归档':'本条未触发回复；原话已归档'};return false;}
  if(!batch){batch={id:message.id,thread:message.thread,messages:[],target:message,firstAt:now,lastAt:now,dueAt:now,delay:c.enabled?(c.delayMinSeconds+(c.delayMaxSeconds-c.delayMinSeconds)*this.random())*1000:0};this.pending.set(message.thread,batch);}
  batch.messages.push(message);batch.lastAt=now;if(selected)batch.target=message;
  const maximum=c.enabled?Math.max(batch.delay,c.maxWaitSeconds*1000):0;
  batch.dueAt=Math.min(batch.firstAt+maximum,Math.max(batch.firstAt+batch.delay,now+(c.enabled?c.mergeWindowSeconds*1000:0)));
  if(batch.messages.length>=c.maxMessages)batch.dueAt=now;
  this.last={at:now,reason:`已收到 ${batch.messages.length} 条，等这一轮说完再回复`};this.arm(batch);return selected;
 }
 private arm(batch:Pending){batch.timer?.clear();if(this.active.has(batch.thread))return;batch.timer=scheduleTimeout(()=>this.flush(batch.thread),Math.max(0,batch.dueAt-this.clock()));batch.timer.unref();}
 private flush(thread:string){
  if(this.stopped||this.active.has(thread))return;const batch=this.pending.get(thread);if(!batch)return;
  this.pending.delete(thread);batch.timer?.clear();const abort=new AbortController();this.active.set(thread,abort);this.last={at:this.clock(),reason:`正在理解 ${batch.messages.length} 条连续消息`};
  void this.run(batch,abort.signal).catch(e=>{if(!abort.signal.aborted)this.log(e instanceof Error?e.message:'本轮 QQ 回复未完成');}).finally(()=>{this.active.delete(thread);if(this.stopped)return;const next=this.pending.get(thread);if(next)this.arm(next);else this.last={at:this.clock(),reason:'这一轮已处理，等待新消息'};});
 }
 status(){return {enabled:this.config.enabled,pending:this.pending.size,active:this.active.size,last:this.last,waiting:[...this.pending.values()].map(b=>({thread:b.thread,messages:b.messages.length,dueAt:b.dueAt}))};}
 stop(){this.stopped=true;for(const b of this.pending.values())b.timer?.clear();this.pending.clear();for(const a of this.active.values())a.abort();}
}
export function splitQQReply(text:string,config:Settings['qq']['chat']):string[]{
 const clean=text.trim();if(!clean)return [];if(!config.splitEnabled||config.maxParts<2||clean.includes('```'))return [clean];
 const paragraphs=clean.split(/\n\s*\n/).filter(Boolean),units:string[]=[];
 for(const paragraph of paragraphs){
  if(paragraph.length<=config.partChars||/https?:\/\/|^\s*(?:[-*]|\d+[.)、])\s/m.test(paragraph)){units.push(paragraph);continue;}
  const sentences=paragraph.match(/[^。！？!?\n]+[。！？!?]*|\n/g)||[paragraph];let buffer='';
  for(const sentence of sentences){if(buffer&&buffer.length+sentence.length>config.partChars){units.push(buffer.trim());buffer='';}buffer+=sentence;}if(buffer.trim())units.push(buffer.trim());
 }
 if(units.length<=config.maxParts)return units;
 return [...units.slice(0,config.maxParts-1),units.slice(config.maxParts-1).join('\n\n')];
}
export function conversationStyle(settings:Settings,platform:string){
 const c=settings.qq.chat;if(!c.naturalStyle)return '';
 return `交流风格：日常聊天接住对方具体的话和情绪，像熟悉的伙伴随口回应，通常一到三句即可，也允许很短。不要每次复述、分析对方为什么这样说，不默认列建议清单、写总结或追问。只有对方明确要步骤、比较、代码或长解释时再展开，不能为了简短省掉必要信息。不编造现实经历。不要把后台规则、工具步骤、抽帧数或统计说明夹在聊天里；看不清、听不到且与问题有关时，简短如实说明即可。${platform==='qq'&&c.splitEnabled?`需要多个气泡时用空行分段，最多 ${c.maxParts} 段，不给气泡编号。`:''}${c.styleNotes?'主人的补充风格：'+c.styleNotes:''}`;
}
export function cancellablePause(milliseconds:number,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();return new Promise((resolve,reject)=>{const finish=()=>{timer.clear();signal.removeEventListener('abort',cancel);resolve();},cancel=()=>{timer.clear();signal.removeEventListener('abort',cancel);reject(signal.reason);},timer=scheduleTimeout(finish,milliseconds);signal.addEventListener('abort',cancel,{once:true});});
}
