import {brandString} from '@deepseek-ai/dsh-brand';
import type {SessionId} from '@deepseek-ai/dsh-session';
import {lastAssistantStreamChunk,type TokenUsage} from '@deepseek-ai/dsh-llm';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
import type {MemoryStore} from './memory.js';
import {dayKey} from './memory.js';
export const usageSession=(session:string)=>brandString<SessionId>(session);
export interface UsageOrigin {session:string;category?:'bilibili-mention';source:'qq'|'dsh'|'bilibili';provider:string;model:string}
export interface UsageTotals {calls:number;missing:number;input:number;cacheRead:number;cacheWrite:number;output:number;reasoning:number;total:number;exactCalls:number;exactTotal:number;partialCalls:number;unclassified:number;mismatches:number;pending:number}
export interface UsageReport {day:string;timezone:string;scope:'plugin'|'dsh';total:UsageTotals;categories:(UsageTotals&{category:string})[];models:(UsageTotals&{provider:string;model:string})[];bill?:{label:string;totalTokens:number;calls:number|null;amount:string;recordedAt:number};coverageStarted:number|null}
export const validCount=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const counterNames=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens'] as const;
/** A full provider total is independent of optional cache bucket disclosure. */
export function usageCounters(usage?:TokenUsage){
 const componentsValid=!!usage&&validCount(usage.inputTokens)&&validCount(usage.outputTokens)&&[usage.cacheReadTokens,usage.cacheWriteTokens,usage.reasoningTokens].every(n=>n===undefined||validCount(n));
 const input=componentsValid?usage!.inputTokens:0,output=componentsValid?usage!.outputTokens:0,read=componentsValid?usage!.cacheReadTokens??0:0,write=componentsValid?usage!.cacheWriteTokens??0:0,reasoning=componentsValid?usage!.reasoningTokens??0:0;
 const sum=input+output+read+write,reported=validCount(usage?.totalTokens)?usage.totalTokens:null,full=reported!==null&&(!componentsValid||reported>=input+output)?reported:null;
 const complete=componentsValid&&usage!.cacheReadTokens!==undefined&&usage!.cacheWriteTokens!==undefined;
 const source=full!==null?'provider':complete?'complete-components':componentsValid?'partial-components':'missing';
 const raw=usage?JSON.stringify(Object.fromEntries(counterNames.flatMap(key=>validCount(usage[key])?[[key,usage[key]]]:[]))):'';
 return {missing:componentsValid?0:1,input,read,write,output,reasoning,full,source,unclassified:full===null?0:Math.max(0,full-sum),mismatch:reported!==null&&(reported<sum||complete&&reported!==sum)?1:0,raw};
}
export function counterValues(usage?:TokenUsage){const c=usageCounters(usage);return [c.missing,c.input,c.read,c.write,c.output,c.reasoning,c.full,c.source,c.unclassified,c.mismatch,c.raw];}
const columns='role,session,seq,day,time,source,category,provider,model,missing,input,cache_read,cache_write,output,reasoning,full_total,total_source,unclassified,mismatch,raw_usage';
const upsert=`INSERT INTO llm_usage(${columns}) VALUES(${Array(20).fill('?').join(',')}) ON CONFLICT(role,session,seq) DO UPDATE SET missing=excluded.missing,input=excluded.input,cache_read=excluded.cache_read,cache_write=excluded.cache_write,output=excluded.output,reasoning=excluded.reasoning,full_total=excluded.full_total,total_source=excluded.total_source,unclassified=excluded.unclassified,mismatch=excluded.mismatch,raw_usage=excluded.raw_usage WHERE excluded.total_source IN ('provider','complete-components') OR llm_usage.total_source NOT IN ('provider','complete-components') AND excluded.missing<=llm_usage.missing`;
export function recordMediaUsage(memory:MemoryStore,origin:UsageOrigin,usage?:TokenUsage){recordSingleUsage(memory,origin,'qq-media',usage);}
export function recordSingleUsage(memory:MemoryStore,origin:UsageOrigin,category:'qq-group-task'|'qq-emoji-backfill'|'vision-test'|'qq-media'|'bilibili-auto'|'bilibili-video'|'qq-proactive'|'qq-emoji',usage?:TokenUsage){const time=memory.clock();memory.db.prepare(upsert).run(memory.roleId,origin.session,0,dayKey(time,memory.timezone),time,origin.source,category,origin.provider,origin.model,...counterValues(usage));}
/** Settled attempts are distinct; cumulative usage chunks within an attempt are not added. */
export function recordUsage(memory:MemoryStore,origin:UsageOrigin,events:readonly SessionEvent[]){
 const category=origin.category??(events.some(e=>e.type==='tool/call'&&e.data.name.startsWith('shiguang_bili_'))?'bilibili':origin.source==='bilibili'?'bilibili-dm':origin.source),insert=memory.db.prepare(upsert);
 memory.db.exec('SAVEPOINT usage_record');try{for(const e of events){if(e.type!=='assistant/message'&&e.type!=='assistant/attempt')continue;const usage=e.type==='assistant/message'?lastAssistantStreamChunk(e.data.stream,'usage')?.usage??e.data.usage:lastAssistantStreamChunk(e.data.stream,'usage')?.usage;insert.run(memory.roleId,origin.session,Number(e.seq),dayKey(e.time,memory.timezone),e.time,origin.source,category,origin.provider,origin.model,...counterValues(usage));}memory.db.exec('RELEASE usage_record');}catch(e){memory.db.exec('ROLLBACK TO usage_record; RELEASE usage_record');throw e;}
}
const exact="total_source IN ('provider','complete-components')";
const sums=`count(*) AS calls,coalesce(sum(missing),0) AS missing,coalesce(sum(input),0) AS input,coalesce(sum(cache_read),0) AS cacheRead,coalesce(sum(cache_write),0) AS cacheWrite,coalesce(sum(output),0) AS output,coalesce(sum(reasoning),0) AS reasoning,coalesce(sum(coalesce(full_total,input+cache_read+cache_write+output)),0) AS total,coalesce(sum(CASE WHEN ${exact} THEN 1 ELSE 0 END),0) AS exactCalls,coalesce(sum(CASE WHEN ${exact} THEN coalesce(full_total,input+cache_read+cache_write+output) ELSE 0 END),0) AS exactTotal,coalesce(sum(CASE WHEN ${exact} THEN 0 ELSE 1 END),0) AS partialCalls,coalesce(sum(unclassified),0) AS unclassified,coalesce(sum(mismatch),0) AS mismatches`;
export function validDay(day:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00Z'))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw new Error('日期应为有效的 YYYY-MM-DD');}
export function dailyUsage(memory:MemoryStore,day=memory.today(),scope:'plugin'|'dsh'='plugin'):UsageReport{
 validDay(day);const source=scope==='dsh'?`(SELECT w.* ,coalesce((SELECT category FROM llm_usage u WHERE u.session=w.session ORDER BY u.time DESC LIMIT 1),'dsh-other') AS category FROM llm_wire_usage w)`:'llm_usage',where=scope==='dsh'?'day=?':'role=? AND day=?',values=scope==='dsh'?[day]:[memory.roleId,day],pending=scope==='dsh'?"coalesce(sum(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending":'0 AS pending';
 const query=(select:string,group='')=>memory.db.prepare(`SELECT ${select}${sums},${pending} FROM ${source} WHERE ${where} ${group}`).all(...values);
 const bill=memory.db.prepare('SELECT * FROM provider_bills WHERE day=?').get(day);
 return {day,timezone:memory.timezone,scope,total:query('')[0] as unknown as UsageTotals,categories:query('category,','GROUP BY category ORDER BY category') as unknown as UsageReport['categories'],models:query('provider,model,','GROUP BY provider,model ORDER BY provider,model') as unknown as UsageReport['models'],coverageStarted:scope==='dsh'?(Number(memory.db.prepare('SELECT min(time) AS n FROM llm_wire_usage').get()?.n)||null):null,...(bill?{bill:{label:String(bill.label),totalTokens:Number(bill.total_tokens),calls:bill.calls===null?null:Number(bill.calls),amount:String(bill.amount),recordedAt:Number(bill.recorded_at)}}:{})};
}
export function saveProviderBill(memory:MemoryStore,day:string,value:{label:string;totalTokens:number;calls?:number;amount:string}){
 validDay(day);if(!value.label.trim()||value.label.length>100||!validCount(value.totalTokens)||value.calls!==undefined&&!validCount(value.calls)||!/^\d+(?:\.\d{1,8})?$/.test(value.amount))throw new Error('账单名称、Token、次数或金额格式无效');
 memory.db.prepare('INSERT OR REPLACE INTO provider_bills(day,label,total_tokens,calls,amount,recorded_at) VALUES(?,?,?,?,?,?)').run(day,value.label.trim(),value.totalTokens,value.calls??null,value.amount,memory.clock());return dailyUsage(memory,day,'dsh');
}
