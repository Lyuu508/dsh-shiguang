import { createHash } from 'node:crypto';
import { dayKey, type MemoryStore } from './memory.js';

export interface PortableMemory { id?:string;time:number;platform:string;thread:string;kind:string;body:string;day?:string }
export const MEMORY_FORMAT='shiguang-memory';
export function exportMemoryPage(memory:MemoryStore,scope:string,range:'today'|'all',after=0,snapshot?:number,day=memory.today()){
  if(!Number.isSafeInteger(after)||after<0||snapshot!==undefined&&(!Number.isSafeInteger(snapshot)||snapshot<0)||!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('导出游标或日期无效');
  const ceiling=snapshot??Number(memory.db.prepare('SELECT coalesce(max(rowid),0) AS n FROM memories WHERE role=? AND scope=?').get(memory.roleId,scope)?.n);
  const rows=memory.db.prepare(`SELECT rowid,id,day,time,platform,thread,kind,body FROM memories WHERE role=? AND scope=? AND rowid>? AND rowid<=? ${range==='today'?'AND day=?':''} ORDER BY rowid LIMIT 51`).all(memory.roleId,scope,after,ceiling,...(range==='today'?[day]:[]));
  const page=rows.slice(0,50);
  return {format:MEMORY_FORMAT,version:1,role:memory.roleId,scope,range,day,timezone:memory.timezone,snapshot:ceiling,rows:page.map(r=>({id:String(r.id),day:String(r.day),time:Number(r.time),platform:String(r.platform),thread:String(r.thread),kind:String(r.kind),body:String(r.body)})),nextCursor:rows.length>50?Number(page.at(-1)!.rowid):null};
}
export function importMemory(memory:MemoryStore,scope:string,target:'today'|'all',document:string,fileType:'json'|'text'){
  if(Buffer.byteLength(document,'utf8')>2*1024*1024)throw new Error('记忆文件最多 2 MB，请分批导入');
  const now=memory.clock();let records:PortableMemory[];
  if(fileType==='text'){
    const parts=document.trim().split(/\n\s*\n/).flatMap(s=>{const out:string[]=[];for(let i=0;i<s.length;i+=4000)out.push(s.slice(i,i+4000));return out;});
    records=parts.map(body=>({time:target==='today'?now:now-36*3600000,platform:'shared',thread:scope,kind:'note',body}));
  }else{
    let value:unknown;try{value=JSON.parse(document);}catch{throw new Error('记忆 JSON 格式无效');}
    if(!value||typeof value!=='object'||(value as any).format!==MEMORY_FORMAT||(value as any).version!==1||!Array.isArray((value as any).memories))throw new Error('请选择拾光导出的记忆 JSON，或使用 TXT / Markdown 文件');
    records=(value as {memories:PortableMemory[]}).memories;
  }
  if(!records.length||records.length>5000)throw new Error('每次导入 1–5000 条记忆');
  const normalized=records.map(row=>{
    if(!row||typeof row!=='object'||row.id!==undefined&&(typeof row.id!=='string'||row.id.length>128)||typeof row.body!=='string'||!row.body.trim()||row.body.length>20000||!Number.isSafeInteger(row.time)||row.time<0||!['qq','bilibili','dsh','shared'].includes(row.platform)||!['user','assistant','note','experience'].includes(row.kind)||typeof row.thread!=='string'||row.thread.length>200)throw new Error('记忆中存在无效记录，整批未导入');
    return {...row,body:row.body.trim(),time:target==='today'?now:Math.min(row.time,now)};
  });
  let added=0,skipped=0;
  memory.db.exec('BEGIN IMMEDIATE');
  try{
    for(const row of normalized){
      const day=dayKey(row.time,memory.timezone);
      if(row.id&&memory.db.prepare('SELECT 1 FROM memories WHERE id=? AND role=? AND scope=? AND day=?').get(row.id,memory.roleId,scope,day)){skipped++;continue;}
      const key='import:'+createHash('sha256').update(JSON.stringify([scope,fileType==='text'&&target==='all'?'undated-history':day,row.kind,row.platform,row.body])).digest('hex');
      if(memory.append(scope,row.platform,row.thread,row.kind,row.body,key,row.time))added++;else skipped++;
    }
    memory.db.exec('COMMIT');
  }catch(error){memory.db.exec('ROLLBACK');throw error;}
  return {added,skipped,target,day:memory.today()};
}
