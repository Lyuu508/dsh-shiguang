import {clockContext} from './time-awareness.js';
import {flashRoute} from './model-route.js';
import type {Context} from '@deepseek-ai/cordis';
import {BlockAssembler} from '@deepseek-ai/dsh-llm';
import {randomUUID} from 'node:crypto';
import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';
import {usageSession,recordSingleUsage} from './usage.js';

export {stateValue,setState,quietAt} from './initiative-state.js';
export function jitterMinutes(min:number,max:number,random=Math.random):number{return Math.round(min+(max-min)*Math.max(0,Math.min(.999999,random())));}
export function jsonDecision(text:string):any {try{return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw new Error('自主决定格式无效，本次不发送或重试');}}
export async function think(ctx:Context,settings:Settings,memory:MemoryStore,category:'bilibili-auto'|'qq-proactive',system:string,data:unknown,maxTokens:number,signal:AbortSignal):Promise<string>{
  const route=await flashRoute(ctx),llm=ctx.get('llm');
  if(!route||!llm)throw new Error('请先在角色与回复配置可用模型');
  const session='initiative-'+randomUUID(),assembler=new BlockAssembler();try{for await(const chunk of llm.stream({...route,sessionId:usageSession(session),system:system+'\n'+clockContext(settings,memory),messages:[{role:'user',content:[{type:'text',text:JSON.stringify(data)}]}],maxTokens,signal}))assembler.push(chunk);}finally{recordSingleUsage(memory,{session,source:category==='qq-proactive'?'qq':'dsh',...route},category,assembler.usage);}
  if(assembler.finish.kind!=='stop')throw new Error('自主思考未完整返回，本次不发送或重试');return assembler.blocks().filter(b=>b.type==='text').map(b=>b.text).join('');
}
