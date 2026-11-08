import {searchTokens,type MemoryStore} from './memory.js';
export interface SlangEntry {term:string;meaning:string;response:string;updatedAt:number}
const normalize=(text:string)=>text.normalize('NFKC').trim().toLowerCase();
export function teachingRequested(text:string){return /(?:学个梗|学习(?:这个|一下)?(?:梗|黑话)|记住这个(?:梗|黑话)|我教你(?:个|一个)?(?:梗|黑话)|教你(?:个|一个)?(?:梗|黑话))/.test(text);}
export function parseSlangLesson(text:string):Omit<SlangEntry,'updatedAt'>|undefined{
 const m=/^(?:学个梗|记住这个梗|学习黑话|教你个梗)\s*[:：]\s*([^\n|｜=＝]{1,80})\s*[|｜=＝]\s*([^\n|｜]{1,800})(?:[|｜]\s*([^\n]{1,400}))?$/.exec(text.trim());
 return m?{term:m[1]!.trim(),meaning:m[2]!.trim(),response:m[3]?.trim()||''}:undefined;
}
export function saveSlang(memory:MemoryStore,scope:string,lesson:Omit<SlangEntry,'updatedAt'>){
 const term=normalize(lesson.term),meaning=lesson.meaning.trim(),response=lesson.response.trim();
 if(!term||term.length>80||!searchTokens(term).length||!meaning||meaning.length>800||response.length>400)throw new Error('梗名称应为 1–80 字，含义 1–800 字，接话示例至多 400 字');
 memory.db.exec('SAVEPOINT slang_save');try{
  memory.db.prepare('INSERT INTO slang_entries(role,scope,term,meaning,response,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(role,scope,term) DO UPDATE SET meaning=excluded.meaning,response=excluded.response,updated_at=excluded.updated_at').run(memory.roleId,scope,term,meaning,response,memory.clock());
  memory.db.prepare('DELETE FROM slang_tokens WHERE role=? AND scope=? AND term=?').run(memory.roleId,scope,term);
  const insert=memory.db.prepare('INSERT OR IGNORE INTO slang_tokens(role,scope,token,term) VALUES(?,?,?,?)');for(const token of searchTokens(term))insert.run(memory.roleId,scope,token,term);
  memory.db.exec('RELEASE slang_save');
 }catch(error){memory.db.exec('ROLLBACK TO slang_save; RELEASE slang_save');throw error;}
 return {term,meaning,response};
}
export function listSlang(memory:MemoryStore,query=''):SlangEntry[]{return memory.db.prepare('SELECT term,meaning,response,updated_at AS updatedAt FROM slang_entries WHERE role=? AND scope=? AND term LIKE ? ORDER BY updated_at DESC,term LIMIT 100').all(memory.roleId,'owner','%'+normalize(query)+'%') as unknown as SlangEntry[];}
export function deleteSlang(memory:MemoryStore,term:string){const args=[memory.roleId,'owner',normalize(term)];memory.db.prepare('DELETE FROM slang_tokens WHERE role=? AND scope=? AND term=?').run(...args);memory.db.prepare('DELETE FROM slang_entries WHERE role=? AND scope=? AND term=?').run(...args);}
export function recallSlang(memory:MemoryStore,scope:string,text:string,maxHits:number,maxChars:number):string{
 if(!maxHits||!maxChars)return '';const normalized=normalize(text),tokens=searchTokens(normalized).slice(0,128);if(!tokens.length)return '';
 const rows=memory.db.prepare(`SELECT e.term,e.meaning,e.response FROM slang_tokens t JOIN slang_entries e ON e.role=t.role AND e.scope=t.scope AND e.term=t.term WHERE t.role=? AND t.scope=? AND t.token IN (${tokens.map(()=>'?').join(',')}) GROUP BY e.term ORDER BY count(*) DESC,length(e.term) DESC,e.updated_at DESC LIMIT 32`).all(memory.roleId,scope,...tokens);
 return JSON.stringify(rows.filter(r=>normalized.includes(String(r.term))).slice(0,maxHits)).slice(0,maxChars);
}
