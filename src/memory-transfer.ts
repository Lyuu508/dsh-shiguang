import { createHash } from 'node:crypto';
import { dayKey, type MemoryStore } from './memory.js';

export interface PortableMemory {weight?:number;accesses?:number;lastUsed?:number;pinned?:boolean;forgotten?:boolean; scope?:string;category?:string; id?:string;time:number;platform:string;thread:string;kind:string;body:string;day?:string }
export const MEMORY_FORMAT='shiguang-memory';
export function exportMemoryPage(memory:MemoryStore,scope:string,range:'today'|'all',after=0,snapshot?:number,day=memory.today()){
  if(!Number.isSafeInteger(after)||after<0||snapshot!==undefined&&(!Number.isSafeInteger(snapshot)||snapshot<0)||!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('导出游标或日期无效');
  const ceiling=snapshot??Number(memory.db.prepare("SELECT coalesce(max(rowid),0) AS n FROM memories WHERE role=? AND (?='*' OR scope=?)").get(memory.roleId,scope,scope)?.n);
  const rows=memory.db.prepare(`SELECT rowid,id,scope,category,day,time,platform,thread,kind,body FROM memories WHERE role=? AND (?='*' OR scope=?) AND rowid>? AND rowid<=? ${range==='today'?'AND day=?':''} ORDER BY rowid LIMIT 51`).all(memory.roleId,scope,scope,after,ceiling,...(range==='today'?[day]:[]));
  const page=rows.slice(0,50);
  return {format:MEMORY_FORMAT,version:1,role:memory.roleId,scope,range,day,timezone:memory.timezone,snapshot:ceiling,rows:page.map(r=>({...memory.portableMeta(String(r.id)),id:String(r.id),scope:String(r.scope),category:String(r.category),day:String(r.day),time:Number(r.time),platform:String(r.platform),thread:String(r.thread),kind:String(r.kind),body:String(r.body)})),nextCursor:rows.length>50?Number(page.at(-1)!.rowid):null};
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
    if(!row||typeof row!=='object'||row.id!==undefined&&(typeof row.id!=='string'||row.id.length>128)||typeof row.body!=='string'||!row.body.trim()||row.body.length>20000||!Number.isSafeInteger(row.time)||row.time<0||!['qq','bilibili','dsh','shared'].includes(row.platform)||!['user','assistant','note','experience','activity'].includes(row.kind)||typeof row.thread!=='string'||row.thread.length>200)throw new Error('记忆中存在无效记录，整批未导入');
    if(row.weight!==undefined&&(!Number.isFinite(row.weight)||row.weight<1||row.weight>10)||row.accesses!==undefined&&(!Number.isSafeInteger(row.accesses)||row.accesses<0)||row.lastUsed!==undefined&&(!Number.isSafeInteger(row.lastUsed)||row.lastUsed<0)||row.pinned!==undefined&&typeof row.pinned!=='boolean'||row.forgotten!==undefined&&typeof row.forgotten!=='boolean')throw new Error('记忆权重或保留状态无效');
    if(row.scope!==undefined&&(typeof row.scope!=='string'||!row.scope.trim()||row.scope==='*')||row.category!==undefined&&(typeof row.category!=='string'||!/^[a-z_-]*$/.test(row.category)))throw new Error('记忆权限范围或活动分类无效');
    return {...row,body:row.body.trim(),time:target==='today'?now:Math.min(row.time,now)};
  });
  let added=0,skipped=0;
  memory.db.exec('BEGIN IMMEDIATE');
  try{
    for(const row of normalized){
      const day=dayKey(row.time,memory.timezone),targetScope=scope==='*'?(row.scope??(row.thread.startsWith('qq:group:')||row.thread.startsWith('qq:private:')?row.thread:'owner')):scope;
      if(row.id&&memory.db.prepare('SELECT 1 FROM memories WHERE id=? AND role=? AND scope=? AND day=?').get(row.id,memory.roleId,targetScope,day)){skipped++;continue;}
      const key='import:'+createHash('sha256').update(JSON.stringify([targetScope,fileType==='text'&&target==='all'?'undated-history':day,row.kind,row.platform,row.body])).digest('hex');
      const inserted=memory.append(targetScope,row.platform,row.thread,row.kind,row.body,key,row.time,row.category??'');if(inserted){memory.importMeta(inserted,row);added++;}else skipped++;
    }
    memory.db.exec('COMMIT');
  }catch(error){memory.db.exec('ROLLBACK');throw error;}
  return {added,skipped,target,day:memory.today()};
}
