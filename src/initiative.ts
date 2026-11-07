import type {Context} from '@deepseek-ai/cordis';
import {BlockAssembler} from '@deepseek-ai/dsh-llm';
import {randomUUID} from 'node:crypto';
import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';
import {recordSingleUsage} from './usage.js';

export function stateValue<T>(memory:MemoryStore,name:string,fallback:T):T {try{const row=memory.db.prepare('SELECT value FROM scheduler_state WHERE role=? AND name=?').get(memory.roleId,name);return row?JSON.parse(String(row.value)):fallback;}catch{return fallback;}}
export function setState(memory:MemoryStore,name:string,value:unknown){memory.db.prepare('INSERT OR REPLACE INTO scheduler_state(role,name,value) VALUES(?,?,?)').run(memory.roleId,name,JSON.stringify(value));}
export function quietAt(time:number,timezone:string,start:string,end:string):boolean {
  if(start===end)return false;const parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(time),now=Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value),min=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3)),a=min(start),b=min(end);return a<b?now>=a&&now<b:now>=a||now<b;
}
export function jitterMinutes(min:number,max:number,random=Math.random):number{return Math.round(min+(max-min)*Math.max(0,Math.min(.999999,random())));}
export function jsonDecision(text:string):any {try{return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw new Error('自主决定格式无效，本次不发送或重试');}}
export async function think(ctx:Context,settings:Settings,memory:MemoryStore,category:'bilibili-auto'|'qq-proactive',system:string,data:unknown,maxTokens:number,signal:AbortSignal):Promise<string>{
  const route=settings.provider?{provider:settings.provider,model:settings.model}:ctx.agents.list().filter(a=>!String(a.id).startsWith('shiguang-')).map(a=>a.model.current()).find(Boolean),llm=ctx.get('llm');
  if(!route||!llm)throw new Error('请先在角色与回复配置可用模型');
  const assembler=new BlockAssembler();try{for await(const chunk of llm.stream({...route,system,messages:[{role:'user',content:[{type:'text',text:JSON.stringify(data)}]}],maxTokens,signal}))assembler.push(chunk);}finally{recordSingleUsage(memory,{session:'initiative-'+randomUUID(),source:category==='qq-proactive'?'qq':'dsh',...route},category,assembler.usage);}
  if(assembler.finish.kind!=='stop')throw new Error('自主思考未完整返回，本次不发送或重试');return assembler.blocks().filter(b=>b.type==='text').map(b=>b.text).join('');
}
