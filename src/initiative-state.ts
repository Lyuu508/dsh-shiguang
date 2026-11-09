import type {MemoryStore} from './memory.js';
export function stateValue<T>(memory:MemoryStore,name:string,fallback:T):T {try{const row=memory.db.prepare('SELECT value FROM scheduler_state WHERE role=? AND name=?').get(memory.roleId,name);return row?JSON.parse(String(row.value)):fallback;}catch{return fallback;}}
export function setState(memory:MemoryStore,name:string,value:unknown){memory.db.prepare('INSERT OR REPLACE INTO scheduler_state(role,name,value) VALUES(?,?,?)').run(memory.roleId,name,JSON.stringify(value));}
export function quietAt(time:number,timezone:string,start:string,end:string):boolean {
  if(start===end)return false;const parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(time),now=Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value),min=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3)),a=min(start),b=min(end);return a<b?now>=a&&now<b:now>=a||now<b;
}
