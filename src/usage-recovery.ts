import type {Context} from '@deepseek-ai/cordis';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
import type {MemoryStore} from './memory.js';
import {dayKey} from './memory.js';
import {recordUsage,usageSession,validDay,type UsageOrigin} from './usage.js';
interface Reader {read(offset:number,length:number,options:{signal:AbortSignal}):Promise<{events:readonly SessionEvent[]}>;close():Promise<void>}
interface Persistence {open(id:ReturnType<typeof usageSession>,access:'read',options:{signal:AbortSignal}):Promise<Reader>}
export async function recoverUsage(ctx:Context,memory:MemoryStore,day:string,signal:AbortSignal,apply:(fn:()=>void)=>Promise<void>,progress:(value:{checked:number;restored:number;unavailable:number})=>void){
 validDay(day);const persistence=(ctx as unknown as {get(key:string):unknown}).get('sessionPersistence') as Persistence|undefined;
 if(!persistence?.open)throw new Error('当前 DSH 没有会话持久化读取服务，旧回执无法补齐；新请求仍正常记录');
 const origins=memory.db.prepare("SELECT session,source,provider,model FROM llm_usage WHERE role=? AND day=? AND total_source NOT IN ('provider','complete-components') GROUP BY session").all(memory.roleId,day);let checked=0,restored=0,unavailable=0;
 for(const row of origins){signal.throwIfAborted();let handle:Reader|undefined;
  try{handle=await persistence.open(usageSession(String(row.session)),'read',{signal});const selected:SessionEvent[]=[];let offset=0;
   for(;;){const page=await handle.read(offset,256,{signal});if(!page.events.length)break;for(const event of page.events){if(event.type==='tool/call'||(event.type==='assistant/message'||event.type==='assistant/attempt')&&dayKey(event.time,memory.timezone)===day)selected.push(event);}offset+=page.events.length;}
   await apply(()=>{const before=Number(memory.db.prepare("SELECT count(*) AS n FROM llm_usage WHERE role=? AND session=? AND day=? AND total_source IN ('provider','complete-components')").get(memory.roleId,String(row.session),day)?.n);recordUsage(memory,{session:String(row.session),source:String(row.source) as UsageOrigin['source'],provider:String(row.provider),model:String(row.model)},selected);const after=Number(memory.db.prepare("SELECT count(*) AS n FROM llm_usage WHERE role=? AND session=? AND day=? AND total_source IN ('provider','complete-components')").get(memory.roleId,String(row.session),day)?.n);restored+=Math.max(0,after-before);});
  }catch(error){signal.throwIfAborted();unavailable++;}finally{await handle?.close();checked++;progress({checked,restored,unavailable});}
 }
 return {checked,restored,unavailable};
}
