import {searchTokens,type MemoryStore} from './memory.js';
import {stateValue,setState} from './initiative-state.js';
export interface SlangSource {speakerId:string;speakerName:string;thread:string;memoryId:string;evidence:string;at:number}
export interface SlangEntry {term:string;meaning:string;response:string;updatedAt:number;scope?:string;source?:SlangSource}
export type SlangLesson=Pick<SlangEntry,'term'|'meaning'|'response'>;
const normalize=(text:string)=>text.normalize('NFKC').trim().toLowerCase();
const sourceKey=(scope:string,term:string)=>'slang:source:'+JSON.stringify([scope,normalize(term)]);
export function slangScope(scope:string){if(scope!=='owner'&&!/^qq:group:\d+$/.test(scope))throw new Error('词库应为主人或 QQ 群');return scope;}
export function teachingRequested(text:string){return /(?:学个梗|学习(?:这个|一下)?(?:梗|黑话)|记住这个(?:梗|黑话)|我教你(?:个|一个)?(?:梗|黑话)|教你(?:个|一个)?(?:梗|黑话))/.test(text);}
export function parseSlangLesson(text:string):SlangLesson|undefined{
 const m=/^(?:学个梗|记住这个梗|学习黑话|教你个梗)\s*[:：]\s*([^\n|｜=＝]{1,80})\s*[|｜=＝]\s*([^\n|｜]{1,800})(?:[|｜]\s*([^\n]{1,400}))?$/.exec(text.trim());
 return m?{term:m[1]!.trim(),meaning:m[2]!.trim(),response:m[3]?.trim()||''}:undefined;
}
export function saveSlang(memory:MemoryStore,scope:string,lesson:SlangLesson,source?:SlangSource){
 slangScope(scope);
 const term=normalize(lesson.term),meaning=lesson.meaning.trim(),response=lesson.response.trim();
 if(!term||term.length>80||!searchTokens(term).length||!meaning||meaning.length>800||response.length>400)throw new Error('梗名称应为 1–80 字，含义 1–800 字，接话示例至多 400 字');
 memory.db.exec('SAVEPOINT slang_save');try{
  memory.db.prepare('INSERT INTO slang_entries(role,scope,term,meaning,response,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(role,scope,term) DO UPDATE SET meaning=excluded.meaning,response=excluded.response,updated_at=excluded.updated_at').run(memory.roleId,scope,term,meaning,response,memory.clock());
  memory.db.prepare('DELETE FROM slang_tokens WHERE role=? AND scope=? AND term=?').run(memory.roleId,scope,term);
  const insert=memory.db.prepare('INSERT OR IGNORE INTO slang_tokens(role,scope,token,term) VALUES(?,?,?,?)');for(const token of searchTokens(term))insert.run(memory.roleId,scope,token,term);
  if(source)setState(memory,sourceKey(scope,term),source);
  memory.db.exec('RELEASE slang_save');
 }catch(error){memory.db.exec('ROLLBACK TO slang_save; RELEASE slang_save');throw error;}
 return {term,meaning,response};
}
export function listSlang(memory:MemoryStore,query='',scope='owner'):SlangEntry[]{
 if(scope!=='all')slangScope(scope);
 return (memory.db.prepare(`SELECT scope,term,meaning,response,updated_at AS updatedAt FROM slang_entries WHERE role=? AND ${scope==='all'?"(scope='owner' OR scope GLOB 'qq:group:[0-9]*')":'scope=?'} AND term LIKE ? ORDER BY updated_at DESC,scope,term LIMIT 100`).all(memory.roleId,...(scope==='all'?[]:[scope]),'%'+normalize(query)+'%') as unknown as SlangEntry[]).map(row=>({...row,source:stateValue<SlangSource|undefined>(memory,sourceKey(row.scope!,row.term),undefined)}));
}
export function deleteSlang(memory:MemoryStore,term:string,scope='owner'){slangScope(scope);const args=[memory.roleId,scope,normalize(term)];memory.db.prepare('DELETE FROM slang_tokens WHERE role=? AND scope=? AND term=?').run(...args);memory.db.prepare('DELETE FROM slang_entries WHERE role=? AND scope=? AND term=?').run(...args);memory.db.prepare('DELETE FROM scheduler_state WHERE role=? AND name=?').run(memory.roleId,sourceKey(scope,term));}
export function recallSlang(memory:MemoryStore,scope:string,text:string,maxHits:number,maxChars:number,allowedScopes?:string[]):string{
 if(!maxHits||!maxChars)return '';const normalized=normalize(text),tokens=searchTokens(normalized).slice(0,128);if(!tokens.length)return '';
 const scopes=[...new Set(allowedScopes||[scope])];if(!scopes.length)return '';
 const rows=memory.db.prepare(`SELECT e.scope,e.term,e.meaning,e.response FROM slang_tokens t JOIN slang_entries e ON e.role=t.role AND e.scope=t.scope AND e.term=t.term WHERE t.role=? AND t.scope IN (${scopes.map(()=>'?').join(',')}) AND t.token IN (${tokens.map(()=>'?').join(',')}) GROUP BY e.scope,e.term ORDER BY (e.scope=?) DESC,count(*) DESC,length(e.term) DESC,e.updated_at DESC LIMIT 32`).all(memory.roleId,...scopes,...tokens,scope);
 return JSON.stringify(rows.filter(r=>normalized.includes(String(r.term))).slice(0,maxHits).map(row=>({...row,source:stateValue<SlangSource|undefined>(memory,sourceKey(String(row.scope),String(row.term)),undefined)}))).slice(0,maxChars);
}
