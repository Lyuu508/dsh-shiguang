import type {MemoryStore} from './memory.js';
export function claimPublicReply(memory:MemoryStore,account:string,comment:string){return !!memory.db.prepare('INSERT OR IGNORE INTO scheduler_state(role,name,value) VALUES(?,?,?)').run(memory.roleId,'bili:incoming:'+account+':'+comment,JSON.stringify({at:memory.clock(),status:'claimed'})).changes;}
