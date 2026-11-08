import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {RETENTION_DEFAULTS} from './config.js';
import type { Settings } from './config.js';

export interface ConversationMeta {speakerId?:string;speakerName?:string;turnId?:string;pairInferred?:boolean}
export interface MemoryRow extends ConversationMeta { scope?:string;thread?:string;category?:string; id: string; day: string; time: number; platform: string; kind: string; body: string }
export interface SearchHit extends ConversationMeta { time:number;at:string;scope?:string;thread?:string;category?:string; id: string; day: string; platform: string; kind: string; snippet: string }
const wordSegmenter=new Intl.Segmenter('zh',{granularity:'word'});
const timeFormatters=new Map<string,Intl.DateTimeFormat>();
export function timeLabel(time:number,timezone:string):string{let formatter=timeFormatters.get(timezone);if(!formatter){formatter=new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});timeFormatters.set(timezone,formatter);}return formatter.format(time);}
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export function dayKey(time: number, timezone: string): string {
  let formatter = dayFormatters.get(timezone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); dayFormatters.set(timezone, formatter); }
  const parts = formatter.formatToParts(time);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function searchTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu)) {
    const s = match[0];
    if (/^\p{Script=Han}+$/u.test(s)) {
      const chars = [...s];
      if (chars.length === 1) tokens.add(s);
      else for (let i = 0; i < chars.length - 1; i++) tokens.add(chars[i]! + chars[i + 1]!);
    } else tokens.add(s);
  }
  return [...tokens];
}
function budgetLines(lines: string[], max: number): string {
  const picked: string[] = []; let used = 0;
  for (const line of lines) {
    if (used >= max) break;
    const cut = line.slice(0, Math.max(0, max - used - (picked.length ? 1 : 0)));
    if (cut) { picked.push(cut); used += cut.length + (picked.length > 1 ? 1 : 0); }
  }
  return picked.reverse().join('\n');
}

export class MemoryStore {
  readonly db: DatabaseSync;
  constructor(path: string, readonly roleId: string, readonly timezone: string, readonly limits: Settings['memory'], readonly clock = Date.now,readonly retention=RETENTION_DEFAULTS) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (Number(version) > 10) throw new Error('记忆数据库来自更新版本，请升级插件');
    if ([1,2,3,4,5,6,7,8,9].includes(Number(version)) && path !== ':memory:' && !existsSync(`${path}.v${version}-backup`)) this.db.prepare('VACUUM INTO ?').run(`${path}.v${version}-backup`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, scope TEXT NOT NULL,
        day TEXT NOT NULL, time INTEGER NOT NULL, platform TEXT NOT NULL, thread TEXT NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, external_key TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS memories_today ON memories(role,scope,day,kind,time DESC,rowid DESC);
      CREATE INDEX IF NOT EXISTS memories_thread ON memories(role,scope,day,thread,time DESC,rowid DESC);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(role,scope);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(tokens, namespace, day UNINDEXED,state, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS actions (
        key TEXT PRIMARY KEY, role TEXT NOT NULL, day TEXT NOT NULL, time INTEGER NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, result TEXT
      );
      CREATE INDEX IF NOT EXISTS actions_quota ON actions(role,kind,day,time DESC);
      CREATE INDEX IF NOT EXISTS actions_interval ON actions(role,kind,time DESC);
      CREATE TABLE IF NOT EXISTS memory_trash (id TEXT PRIMARY KEY,role TEXT NOT NULL,scope TEXT NOT NULL,payload TEXT NOT NULL,deleted_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS llm_usage (
        role TEXT NOT NULL,session TEXT NOT NULL,seq INTEGER NOT NULL,day TEXT NOT NULL,time INTEGER NOT NULL,
        source TEXT NOT NULL,category TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,
        missing INTEGER NOT NULL,input INTEGER NOT NULL,cache_read INTEGER NOT NULL,cache_write INTEGER NOT NULL,
        output INTEGER NOT NULL,reasoning INTEGER NOT NULL,PRIMARY KEY(role,session,seq)
      );
      CREATE INDEX IF NOT EXISTS llm_usage_day ON llm_usage(role,day,category);
      CREATE TABLE IF NOT EXISTS media_cache (
        role TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,summary TEXT NOT NULL,expires INTEGER NOT NULL,
        PRIMARY KEY(role,scope,key)
      );
      CREATE TABLE IF NOT EXISTS autonomy_runs (
        id TEXT PRIMARY KEY,role TEXT NOT NULL,day TEXT NOT NULL,slot TEXT NOT NULL,time INTEGER NOT NULL,
        status TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',UNIQUE(role,day,slot)
      );
      CREATE INDEX IF NOT EXISTS autonomy_day ON autonomy_runs(role,day,time DESC);
      CREATE TABLE IF NOT EXISTS voice_usage (
        id TEXT PRIMARY KEY,role TEXT NOT NULL,day TEXT NOT NULL,time INTEGER NOT NULL,
        chars INTEGER NOT NULL,billed_chars INTEGER,status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS voice_usage_day ON voice_usage(role,day);
      CREATE TABLE IF NOT EXISTS scheduler_state(role TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(role,name));
      CREATE TABLE IF NOT EXISTS initiative_runs(id TEXT PRIMARY KEY,role TEXT NOT NULL,day TEXT NOT NULL,time INTEGER NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS initiative_day ON initiative_runs(role,kind,day,time DESC);
      CREATE TABLE IF NOT EXISTS bili_dm_cursor(role TEXT NOT NULL,account TEXT NOT NULL,uid TEXT NOT NULL,seq TEXT NOT NULL,PRIMARY KEY(role,account,uid));
      CREATE TABLE IF NOT EXISTS bili_dm_receipts(role TEXT NOT NULL,account TEXT NOT NULL,uid TEXT NOT NULL,seq TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(role,account,uid,seq));
      CREATE TABLE IF NOT EXISTS emoji_collections(role TEXT NOT NULL,digest TEXT NOT NULL,day TEXT NOT NULL,time INTEGER NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',file TEXT NOT NULL DEFAULT '',PRIMARY KEY(role,digest));
    `);
    if(!this.db.prepare('PRAGMA table_info(memories)').all().some(c=>c.name==='category'))this.db.exec("ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT ''");
    if(!this.db.prepare('PRAGMA table_info(memory_fts)').all().some(c=>c.name==='state')){
      this.db.exec("BEGIN IMMEDIATE; CREATE VIRTUAL TABLE memory_fts_next USING fts5(tokens,namespace,day UNINDEXED,state,tokenize='unicode61'); INSERT INTO memory_fts_next(rowid,tokens,namespace,day,state) SELECT rowid,tokens,namespace,day,'active' FROM memory_fts; DROP TABLE memory_fts; ALTER TABLE memory_fts_next RENAME TO memory_fts; COMMIT;");
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_meta(id TEXT PRIMARY KEY,role TEXT NOT NULL,scope TEXT NOT NULL,importance REAL NOT NULL DEFAULT 1,accesses INTEGER NOT NULL DEFAULT 0,last_used INTEGER NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,forgotten INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS memory_expiry ON memory_meta(role,forgotten,pinned,last_used);
      CREATE TABLE IF NOT EXISTS memory_concepts(role TEXT NOT NULL,scope TEXT NOT NULL,term TEXT NOT NULL,weight REAL NOT NULL DEFAULT 1,mentions INTEGER NOT NULL DEFAULT 1,last_used INTEGER NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(role,scope,term));
      CREATE TABLE IF NOT EXISTS memory_terms(role TEXT NOT NULL,scope TEXT NOT NULL,id TEXT NOT NULL,term TEXT NOT NULL,PRIMARY KEY(role,scope,id,term));
      CREATE INDEX IF NOT EXISTS memory_terms_word ON memory_terms(role,scope,term,id);
      CREATE INDEX IF NOT EXISTS memories_activity ON memories(role,platform,day,category,time DESC,rowid DESC);`);
    this.db.prepare("INSERT OR IGNORE INTO memory_meta(id,role,scope,importance,last_used,pinned) SELECT id,role,scope,CASE WHEN kind='note' AND platform<>'dsh' OR kind='user' AND (body LIKE '%请记住%' OR body LIKE '%永远记住%' OR body LIKE '%我教你%') THEN 8 ELSE 1 END,?,CASE WHEN kind='note' AND platform<>'dsh' OR kind='user' AND (body LIKE '%请记住%' OR body LIKE '%永远记住%' OR body LIKE '%我教你%') THEN 1 ELSE 0 END FROM memories WHERE role=?").run(this.clock(),this.roleId);
    this.db.exec('CREATE INDEX IF NOT EXISTS memories_pair ON memories(role,scope,thread,kind,rowid DESC)');
    if(Number(version)<10){
      this.db.exec('BEGIN IMMEDIATE');
      try{
        const columns=new Set(this.db.prepare('PRAGMA table_info(memories)').all().map(c=>String(c.name)));
        for(const [name,type] of [['speaker_id',"TEXT NOT NULL DEFAULT ''"],['speaker_name',"TEXT NOT NULL DEFAULT ''"],['turn_id',"TEXT NOT NULL DEFAULT ''"],['pair_inferred','INTEGER NOT NULL DEFAULT 0']])if(!columns.has(name!))this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`);
        this.db.exec(`UPDATE memories SET turn_id=id WHERE kind='user' AND turn_id='';
          UPDATE memories SET turn_id=coalesce((SELECT u.turn_id FROM memories u WHERE u.role=memories.role AND u.scope=memories.scope AND u.thread=memories.thread AND u.kind='user' AND u.rowid<memories.rowid AND u.time<=memories.time AND u.time>=memories.time-3600000 ORDER BY u.rowid DESC LIMIT 1),id),pair_inferred=1 WHERE kind='assistant' AND turn_id='' AND (external_key IS NULL OR external_key NOT LIKE '%:proactive:%');
          UPDATE memories SET turn_id=id WHERE turn_id=''; PRAGMA user_version=10; COMMIT;`);
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS memories_recent ON memories(role,scope,day,time DESC,rowid DESC) WHERE kind IN ('user','assistant')");
    this.db.exec('CREATE INDEX IF NOT EXISTS memories_turn ON memories(role,scope,thread,turn_id,time,rowid); CREATE INDEX IF NOT EXISTS memories_pair ON memories(role,scope,thread,kind,rowid DESC);');

  }
  today(): string { return dayKey(this.clock(), this.timezone); }
  seen(externalKey: string): boolean { return !!this.db.prepare('SELECT 1 FROM memories WHERE external_key=?').get(`${this.roleId}:${externalKey}`); }
  private namespace(scope: string): string { return createHash('sha256').update(JSON.stringify([this.roleId, scope])).digest('hex'); }
  append(scope: string, platform: string, thread: string, kind: string, body: string, externalKey?: string, time = this.clock(),category = '',metadata:ConversationMeta={}): string | null {
    const id = randomUUID(),speakerId=(metadata.speakerId??'').slice(0,200),speakerName=(metadata.speakerName??'').replace(/[\x00-\x1f\x7f]/g,'').slice(0,80),turnId=(metadata.turnId||externalKey||id).slice(0,300);
    this.db.exec('SAVEPOINT memory_append');
    try {
      const result = this.db.prepare('INSERT OR IGNORE INTO memories(id,role,scope,day,time,platform,thread,kind,body,external_key,category,speaker_id,speaker_name,turn_id,pair_inferred) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, this.roleId, scope, dayKey(time, this.timezone), time, platform, thread, kind, body, externalKey ? `${this.roleId}:${externalKey}` : null,category,speakerId,speakerName,turnId,metadata.pairInferred?1:0);
      if (!result.changes) { this.db.exec('RELEASE memory_append'); return null; }
      this.db.prepare("INSERT INTO memory_fts(rowid,tokens,namespace,day,state) VALUES(?,?,?,?, 'active')").run(result.lastInsertRowid, searchTokens(speakerName+' '+speakerId+' '+body).join(' '), this.namespace(scope), dayKey(time, this.timezone));
      this.indexImportance(id,scope,kind,platform,body,time);
      this.db.exec('RELEASE memory_append'); return id;
    } catch (error) { this.db.exec('ROLLBACK TO memory_append; RELEASE memory_append'); throw error; }
  }
  recordReply(scope:string,platform:string,thread:string,body:string,turnId:string,speakerId='',speakerName='伙伴',externalKey?:string){return this.append(scope,platform,thread,'assistant',body,externalKey,this.clock(),'',{turnId,speakerId,speakerName});}
  private scopes(scope:string,allowed?:string[]){return [...new Set(allowed?.length?allowed:[scope])];}
  private speaker(row:Record<string,any>){return row.kind==='assistant'?(row.speaker_name||'伙伴'):(row.speaker_name||row.speaker_id||(/^qq:private:/.test(row.thread)?String(row.thread).slice(11):'对方（旧记录未保存姓名）'));}
  fastContext(scope: string, thread: string,conversationScopes?:string[]): { day: string; todayNotes: string; recent: string } {
    const day = this.today();
    const notes = this.db.prepare("SELECT body,platform,time FROM memories WHERE role=? AND scope=? AND EXISTS (SELECT 1 FROM memory_meta WHERE memory_meta.id=memories.id AND forgotten=0) AND day=? AND kind IN ('note','experience') ORDER BY time DESC,rowid DESC LIMIT 80")
      .all(this.roleId,scope,day) as {body:string;platform:string;time:number}[];
    const shared=!!conversationScopes?.length;
    const recent=this.db.prepare(`SELECT kind,body,time,platform,thread,speaker_id,speaker_name FROM memories INDEXED BY ${shared?'memories_recent':'memories_thread'} WHERE role=? AND scope IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM memory_meta WHERE memory_meta.id=memories.id AND forgotten=0) AND day=? ${shared?'':'AND thread=?'} AND kind IN ('user','assistant') ORDER BY time DESC,rowid DESC LIMIT ?`)
      .all(this.roleId,JSON.stringify(this.scopes(scope,conversationScopes)),day,...(shared?[]:[thread]),this.limits.recentMessages);
    return {day,todayNotes:budgetLines(notes.map(n=>`[${timeLabel(n.time,this.timezone)}] [${n.platform}] ${n.body}`),this.limits.todayMaxChars),recent:budgetLines(recent.map(r=>`[${timeLabel(Number(r.time),this.timezone)}] [${r.platform} ${r.thread}] ${this.speaker(r)}${r.speaker_id?'('+r.speaker_id+')':''}：${r.body}`),this.limits.recentMaxChars)};
  }
  search(scope: string, query: string, range: 'history' | 'today' | 'all' = 'history', day?: string,allowedScopes?:string[]): SearchHit[] {
    if (!query.trim() || query.length > 200) throw new Error('检索词应为 1–200 字');
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期应为 YYYY-MM-DD');
    const tokens = searchTokens(query).slice(0, 24);
    if (!tokens.length) return [];
    const terms = tokens.map(t => `"${t.replaceAll('"', '""')}"`).join(' OR ');
    const scopes=this.scopes(scope,allowedScopes),namespaces=scopes.map(s=>`namespace:"${this.namespace(s)}"`).join(' OR ');
    const match = `(${namespaces}) AND state:active AND tokens:(${terms})`;
    const dayClause = day || range === 'today' ? 'day=?' : range==='all'?'day<=?':'day<?';
    // Rank and bound within FTS before primary-key reads; joining first can
    // make SQLite re-run the virtual-table match for each archived row.
    const rows = this.db.prepare(`WITH hits AS MATERIALIZED (SELECT rowid,rank AS score FROM memory_fts WHERE memory_fts MATCH ? AND ${dayClause} ORDER BY rank LIMIT ?) SELECT m.id,m.day,m.time,m.platform,m.kind,m.body,m.scope,m.thread,m.turn_id,m.speaker_id,m.speaker_name FROM hits CROSS JOIN memories m ON m.rowid=hits.rowid WHERE m.role=? AND m.scope IN (SELECT value FROM json_each(?)) ORDER BY hits.score*(1+coalesce((SELECT importance FROM memory_meta WHERE id=m.id),1)/10.0),m.time DESC LIMIT ?`)
      .all(match, day || this.today(), this.limits.searchLimit*4, this.roleId,JSON.stringify(scopes),this.limits.searchLimit);
    return rows.map(r => {
      const pair=this.db.prepare("SELECT kind,body,thread,speaker_id,speaker_name FROM memories WHERE role=? AND scope=? AND thread=? AND turn_id=? AND day=? AND kind IN ('user','assistant') AND EXISTS (SELECT 1 FROM memory_meta WHERE memory_meta.id=memories.id AND forgotten=0) ORDER BY time,rowid LIMIT 4").all(this.roleId,String(r.scope),String(r.thread),String(r.turn_id),String(r.day));
      const body=pair.length>1?pair.map(x=>this.speaker(x)+'：'+String(x.body).slice(0,Math.max(40,Math.floor(this.limits.snippetChars/pair.length)-20))).join(' / '):(['user','assistant'].includes(String(r.kind))?this.speaker(r)+'：':'')+String(r.body);
      const lower = body.toLowerCase();
      const positions = tokens.map(t => lower.indexOf(t)).filter(n => n >= 0);
      const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 45);
      this.touch(String(r.id));
      return {scope:String(r.scope),thread:String(r.thread),speakerId:String(r.speaker_id),speakerName:String(r.speaker_name),turnId:String(r.turn_id), id: String(r.id), day: String(r.day),time:Number(r.time),at:String(r.day)+' '+timeLabel(Number(r.time),this.timezone), platform: String(r.platform), kind: String(r.kind), snippet: `${start ? '…' : ''}${body.slice(start, start + this.limits.snippetChars)}${body.length > start + this.limits.snippetChars ? '…' : ''}` };
    });
  }
  detail(scope: string, id: string, offset = 0, historyAllowed = true,allowedScopes?:string[],includeForgotten=false): { id: string; day: string;time:number;at:string; platform: string; text: string; nextOffset: number | null } {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须为非负整数');
    const row = this.db.prepare('SELECT id,day,time,platform,body FROM memories WHERE role=? AND scope IN (SELECT value FROM json_each(?)) AND id=? AND (? OR EXISTS (SELECT 1 FROM memory_meta WHERE memory_meta.id=memories.id AND forgotten=0)) AND (? OR day=?)').get(this.roleId,JSON.stringify(this.scopes(scope,allowedScopes)), id,includeForgotten?1:0, historyAllowed ? 1 : 0, this.today()) as { id: string; day: string;time:number; platform: string; body: string } | undefined;
    if (!row) throw new Error('记忆不存在或不属于当前会话');
    this.touch(id);
    const end = offset + this.limits.detailMaxChars;
    return { id: row.id, day: row.day,time:row.time,at:row.day+' '+timeLabel(row.time,this.timezone), platform: row.platform, text: row.body.slice(offset, end), nextOffset: end < row.body.length ? end : null };
  }
  reserveComment(key: string, perDay: number, intervalMs: number): void {
    this.reserveAction('bili-comment',key,perDay,intervalMs);
  }
  actionQuota(kind:'bili-comment'|'bili-dynamic'|'qq-proactive'|'bili-dm'|'bili-like'|'qq-emoji',day=this.today()):{today:number;last:number|null}{
    const count=this.db.prepare('SELECT count(*) AS n FROM actions WHERE role=? AND kind=? AND day=?').get(this.roleId,kind,day);
    const last=this.db.prepare('SELECT time FROM actions WHERE role=? AND kind=? ORDER BY time DESC LIMIT 1').get(this.roleId,kind);
    return {today:Number(count?.n),last:last?Number(last.time):null};
  }
  reserveAction(kind:'bili-comment'|'bili-dynamic'|'qq-proactive'|'bili-dm'|'bili-like'|'qq-emoji',key:string,perDay:number,intervalMs:number):void {
    const day = this.today(), time = this.clock();
    const label=kind==='bili-comment'?'评论':kind==='bili-dynamic'?'动态':kind==='bili-dm'?'B 站私信':kind==='bili-like'?'B 站点赞':kind==='qq-emoji'?'QQ 表情收藏':'QQ 主动联系';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT key FROM actions WHERE key=?').get(key)) throw new Error(`这次${label}已提交过或结果待核实；请先去 B 站查看，插件不会重复发送`);
      const quota=this.actionQuota(kind,day);
      if (quota.today >= perDay) throw new Error(`今日${label}次数已用完`);
      if (quota.last !== null && time - quota.last < intervalMs) throw new Error(`${label}间隔过短，请稍后再试`);
      this.db.prepare("INSERT INTO actions(key,role,day,time,kind,status) VALUES(?,?,?,?,?,'pending')").run(key,this.roleId,day,time,kind);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  settleAction(key: string, status: 'sent' | 'failed' | 'unknown', result: string): void {
    this.db.prepare('UPDATE actions SET status=?,result=? WHERE key=?').run(status, result.slice(0, 500), key);
  }
  availableScopes():string[]{return [...new Set(['owner',...this.db.prepare('SELECT DISTINCT scope FROM memories WHERE role=?').all(this.roleId).map(r=>String(r.scope))])];}
  overview(): { total: number; today: number; scopes: string[]; commentsToday: number } {
    const total = this.db.prepare('SELECT count(*) AS n FROM memories WHERE role=?').get(this.roleId)!;
    const today = this.db.prepare('SELECT count(*) AS n FROM memories WHERE role=? AND day=?').get(this.roleId, this.today())!;
    const comments = this.db.prepare("SELECT count(*) AS n FROM actions WHERE role=? AND day=? AND kind='bili-comment'").get(this.roleId, this.today())!;
    return { total: Number(total.n), today: Number(today.n), scopes:this.availableScopes(), commentsToday: Number(comments.n) };
  }
  list(scope: string, day: string, before = 0): { rows: (MemoryRow & { cursor: number })[]; nextCursor: number | null } {
    if (day!==''&&!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isSafeInteger(before) || before < 0) throw new Error('日期或分页参数无效');
    const filter=day?'AND day=?':'';
    const rows = this.db.prepare(`SELECT rowid,id,day,time,platform,kind,substr(body,1,240) AS body FROM memories WHERE role=? AND scope=? ${filter} AND (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT 21`).all(this.roleId,scope,...(day?[day]:[]),before,before);
    const items = rows.slice(0,20).map(r => ({ id: String(r.id), day: String(r.day), time: Number(r.time), platform: String(r.platform), kind: String(r.kind), body: String(r.body), cursor: Number(r.rowid) }));
    return { rows: items, nextCursor: rows.length > 20 ? items.at(-1)!.cursor : null };
  }
  timeline(options:{platform?:string;channel?:string;category?:string;scope?:string;state?:string;day?:string;before?:number;beforeTime?:number;query?:string}={}) {
    const {state='active',platform='all',channel='all',category='all',scope='*',day=this.today(),before=0,beforeTime=0,query=''}=options;
    if(!['all','qq','bilibili'].includes(platform)||!['all','private','group'].includes(channel)||!['all','watch','comment','like','emoji','sleep'].includes(category)||day&&!/^\d{4}-\d{2}-\d{2}$/.test(day)||![before,beforeTime].every(n=>Number.isSafeInteger(n)&&n>=0)||query.length>200)throw new Error('记忆筛选或分页参数无效');
    if(!['active','forgotten','all'].includes(state))throw new Error('记忆状态无效');
    const clauses=['m.role=?'],values:(string|number)[]=[this.roleId];
    if(state!=='all'){clauses.push('EXISTS (SELECT 1 FROM memory_meta WHERE memory_meta.id=m.id AND forgotten=?)');values.push(state==='forgotten'?1:0);}
    if(scope!=='*'){clauses.push('m.scope=?');values.push(scope);}
    if(platform!=='all'){clauses.push('m.platform=?');values.push(platform);}
    if(day){clauses.push('m.day=?');values.push(day);}
    if(channel!=='all'){clauses.push(channel==='group'?"m.thread LIKE 'qq:group:%'":"m.platform='qq' AND m.thread NOT LIKE 'qq:group:%'");}
    const classify="CASE WHEN m.category<>'' THEN m.category WHEN m.platform='bilibili' AND m.body LIKE '%评论%' AND m.body LIKE '%评论ID%' THEN 'comment' WHEN m.platform='bilibili' AND m.kind='experience' AND (m.body LIKE '%视频%' OR m.body LIKE '《%') THEN 'watch' ELSE '' END";
    if(category!=='all'){clauses.push(`(${classify})=?`);values.push(category);}
    if(before){clauses.push('(m.time<? OR (m.time=? AND m.rowid<?))');values.push(beforeTime,beforeTime,before);}
    if(query.trim()){const terms=searchTokens(query).slice(0,24).map(t=>'"'+t.replaceAll('"','""')+'"').join(' OR ');if(!terms)return {rows:[],nextCursor:null};clauses.push('m.rowid IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?)');values.push(terms);}
    const rows=this.db.prepare(`SELECT m.speaker_id,m.speaker_name,m.turn_id,m.pair_inferred,m.rowid,m.id,m.scope,m.thread,m.day,m.time,m.platform,m.kind,substr(m.body,1,400) AS body,(${classify}) AS category,(SELECT importance FROM memory_meta WHERE id=m.id) AS weight,(SELECT pinned FROM memory_meta WHERE id=m.id) AS pinned,(SELECT forgotten FROM memory_meta WHERE id=m.id) AS forgotten FROM memories m WHERE ${clauses.join(' AND ')} ORDER BY m.time DESC,m.rowid DESC LIMIT 41`).all(...values);
    const items=rows.slice(0,40).map(r=>({speakerId:String(r.speaker_id),speakerName:String(r.speaker_name),turnId:String(r.turn_id),pairInferred:!!r.pair_inferred,id:String(r.id),scope:String(r.scope),thread:String(r.thread),day:String(r.day),time:Number(r.time),platform:String(r.platform),kind:String(r.kind),body:String(r.body),category:String(r.category),weight:Number(r.weight),pinned:!!r.pinned,forgotten:!!r.forgotten}));
    const last=rows[39];return {rows:items,nextCursor:rows.length>40&&last?{id:Number(last.rowid),time:Number(last.time)}:null};
  }
  conversationPage(options:Parameters<MemoryStore['timeline']>[0]={}){
    const page=this.timeline(options),seen=new Set<string>();
    const rows=page.rows.filter(row=>{const key=JSON.stringify([row.day,row.scope,row.thread,row.turnId]);if(!['user','assistant'].includes(row.kind))return true;if(seen.has(key))return false;seen.add(key);return true;}).map(row=>{
      if(!['user','assistant'].includes(row.kind))return {...row,messages:[row]};
      const state=options.state??'active',day=row.day;
      const records=this.db.prepare(`SELECT id,speaker_id,speaker_name,turn_id,pair_inferred,time,day,platform,kind,substr(body,1,400) AS body FROM memories WHERE role=? AND scope=? AND thread=? AND turn_id=? AND kind IN ('user','assistant') ${day?'AND day=?':''} ${state==='all'?'':'AND EXISTS (SELECT 1 FROM memory_meta WHERE memory_meta.id=memories.id AND forgotten=?)'} ORDER BY time,rowid LIMIT 20`).all(this.roleId,row.scope,row.thread,row.turnId,...(day?[day]:[]),...(state==='all'?[]:[state==='forgotten'?1:0]));
      return {...row,messages:records.map(r=>({...row,...this.portableMeta(String(r.id)),id:String(r.id),kind:String(r.kind),body:String(r.body),time:Number(r.time),day:String(r.day),speakerId:String(r.speaker_id),speakerName:String(r.speaker_name),pairInferred:!!r.pair_inferred}))};
    });return {...page,rows};
  }
  remove(scope: string, id: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM memories WHERE role=? AND scope=? AND id=?').get(this.roleId, scope, id);
      if (!row) throw new Error('记忆不存在或不属于当前角色');
      this.db.prepare('INSERT INTO memory_trash(id,role,scope,payload,deleted_at) VALUES(?,?,?,?,?)').run(id,this.roleId,scope,JSON.stringify(row),this.clock());
      this.db.prepare('DELETE FROM memory_fts WHERE rowid=?').run(row.rowid!);
      this.db.prepare('DELETE FROM memories WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  restore(scope: string, id: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const trashed = this.db.prepare('SELECT payload FROM memory_trash WHERE id=? AND role=? AND scope=?').get(id,this.roleId,scope);
      if (!trashed) throw new Error('回收站中没有这条记忆');
      const row = JSON.parse(String(trashed.payload)) as Record<string, string | number | null>;
      const inserted = this.db.prepare('INSERT INTO memories(id,role,scope,day,time,platform,thread,kind,body,external_key,category,speaker_id,speaker_name,turn_id,pair_inferred) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,this.roleId,scope,row.day!,row.time!,row.platform!,row.thread!,row.kind!,row.body!,row.external_key!,row.category??'',row.speaker_id??'',row.speaker_name??'',row.turn_id??id,row.pair_inferred??0);
      this.db.prepare("INSERT INTO memory_fts(rowid,tokens,namespace,day,state) VALUES(?,?,?,?, 'active')").run(inserted.lastInsertRowid,searchTokens(String(row.body)).join(' '),this.namespace(scope),row.day!);
      if(this.db.prepare('SELECT forgotten FROM memory_meta WHERE id=?').get(id)?.forgotten)this.db.prepare("UPDATE memory_fts SET state='forgotten' WHERE rowid=?").run(inserted.lastInsertRowid);
      this.db.prepare('DELETE FROM memory_trash WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  portableMeta(id:string){const r=this.db.prepare('SELECT importance,accesses,last_used,pinned,forgotten FROM memory_meta WHERE role=? AND id=?').get(this.roleId,id);return r?{weight:Number(r.importance),accesses:Number(r.accesses),lastUsed:Number(r.last_used),pinned:!!r.pinned,forgotten:!!r.forgotten}:{};}
  importMeta(id:string,value:{weight?:number;accesses?:number;lastUsed?:number;pinned?:boolean;forgotten?:boolean}){const current=this.db.prepare('SELECT importance,accesses,pinned,forgotten FROM memory_meta WHERE role=? AND id=?').get(this.roleId,id);if(!current)return;this.db.prepare('UPDATE memory_meta SET importance=?,accesses=?,last_used=?,pinned=?,forgotten=? WHERE role=? AND id=?').run(value.weight??current.importance!,value.accesses??current.accesses!,Math.min(value.lastUsed??this.clock(),this.clock()),value.pinned===undefined?current.pinned!:value.pinned?1:0,value.forgotten===undefined?current.forgotten!:value.forgotten?1:0,this.roleId,id);if(value.forgotten!==undefined)this.db.prepare('UPDATE memory_fts SET state=? WHERE rowid=(SELECT rowid FROM memories WHERE id=? AND role=?)').run(value.forgotten?'forgotten':'active',id,this.roleId);}
  private conceptsFor(body:string){const stop=new Set(['你好','谢谢','哈哈','今天','明天','昨天','我们','你们','他们','这个','那个','什么','怎么','时候','之前','已经','一个','可以','不是','就是','一下','没有','知道','觉得','自己','主人','视频','回复','消息','需要','现在','一下','好的','记录','进行','今日','记忆','聊天','闲聊','日常','普通','测试','内容','问题','一句','每次','这次','但是','因为','所以','其实','一些','一般','事情','的话','然后','这样','这些','还有','比如','真的','感觉','应该','最近','喜欢','希望','想要','记得','不要','让我','告诉','建议','hello','thanks','thank','please','okay']);return [...new Set([...wordSegmenter.segment(body.replace(/https?:\/\/\S+/g,''))].filter(x=>x.isWordLike).map(x=>x.segment.toLowerCase()))].filter(t=>t.length>1&&!stop.has(t)&&!/^\d+$/.test(t)).slice(0,100);}
  private indexImportance(id:string,scope:string,kind:string,platform:string,body:string,time:number){
    const teaching=kind==='user'&&!/(?:不要|不用|别)记住/.test(body)&&/(?:请记住|记住我|永远记住|我教你|纠正|更正|我的生日|我对.*过敏)/.test(body),pinned=teaching||kind==='note'&&platform!=='dsh',question=kind==='user'&&/(?:怎么|如何|为什么|请教|教我|解释|是什么|[？?])/.test(body),answer=kind==='assistant'&&Number(this.db.prepare("SELECT meta.importance FROM memories m JOIN memory_meta meta ON meta.id=m.id WHERE m.role=? AND m.scope=? AND m.kind='user' AND m.thread=(SELECT thread FROM memories WHERE id=?) ORDER BY m.time DESC,m.rowid DESC LIMIT 1").get(this.roleId,scope,id)?.importance)>=4,importance=pinned?8:question||answer?4:kind==='experience'?3:1;
    this.db.prepare('INSERT OR IGNORE INTO memory_meta(id,role,scope,importance,last_used,pinned) VALUES(?,?,?,?,?,?)').run(id,this.roleId,scope,importance,time,pinned?1:0);
    const add=this.db.prepare('INSERT OR IGNORE INTO memory_terms(role,scope,id,term) VALUES(?,?,?,?)');
    for(const term of this.conceptsFor(body)){
      add.run(this.roleId,scope,id,term);
      this.db.prepare('INSERT INTO memory_concepts(role,scope,term,weight,mentions,last_used,pinned) VALUES(?,?,?,?,?,?,?) ON CONFLICT(role,scope,term) DO UPDATE SET mentions=mentions+excluded.mentions,weight=min(10,weight+excluded.mentions*0.5),last_used=max(last_used,excluded.last_used),pinned=max(pinned,excluded.pinned)').run(this.roleId,scope,term,pinned?8:1,kind==='user'||pinned?1:0,time,pinned?1:0);
      const concept=this.db.prepare('SELECT mentions,pinned,weight FROM memory_concepts WHERE role=? AND scope=? AND term=?').get(this.roleId,scope,term);
      if(concept&&(Number(concept.mentions)>=this.retention.promoteAfter||concept.pinned)){if(Number(concept.weight)<10)this.promoteTerm(scope,term);else if(importance>=3)this.db.prepare('UPDATE memory_meta SET pinned=1,importance=max(importance,8) WHERE id=? AND role=?').run(id,this.roleId);}
    }
  }
  private promoteTerm(scope:string,term:string){this.db.prepare('UPDATE memory_concepts SET pinned=1,weight=10 WHERE role=? AND scope=? AND term=?').run(this.roleId,scope,term);this.db.prepare('UPDATE memory_meta SET pinned=1,importance=max(importance,8) WHERE importance>=3 AND role=? AND scope=? AND id IN (SELECT id FROM memory_terms WHERE role=? AND scope=? AND term=?)').run(this.roleId,scope,this.roleId,scope,term);}
  private touch(id:string){const row=this.db.prepare('SELECT m.scope,m.kind,m.platform,m.body,m.time,meta.accesses FROM memory_meta meta JOIN memories m ON m.id=meta.id WHERE m.id=? AND m.role=?').get(id,this.roleId);if(!row)return;if(!this.db.prepare('SELECT 1 FROM memory_terms WHERE role=? AND scope=? AND id=? LIMIT 1').get(this.roleId,String(row.scope),id))this.indexImportance(id,String(row.scope),String(row.kind),String(row.platform),String(row.body),Number(row.time));this.db.prepare('UPDATE memory_meta SET accesses=accesses+1,last_used=?,importance=min(10,importance+1),pinned=CASE WHEN accesses+1>=? THEN 1 ELSE pinned END WHERE id=? AND role=?').run(this.clock(),this.retention.promoteAfter,id,this.roleId);for(const r of this.db.prepare('SELECT term FROM memory_terms WHERE role=? AND scope=? AND id=?').all(this.roleId,String(row.scope),id)){this.db.prepare('UPDATE memory_concepts SET last_used=?,weight=min(10,weight+0.5) WHERE role=? AND scope=? AND term=?').run(this.clock(),this.roleId,String(row.scope),String(r.term));}}
  sweep(){if(!this.retention.enabled)return {forgotten:0};const cutoff=this.clock()-this.retention.forgetAfterDays*86400000,rows=this.db.prepare('SELECT m.id,m.rowid FROM memory_meta meta JOIN memories m ON m.id=meta.id WHERE meta.role=? AND meta.forgotten=0 AND meta.pinned=0 AND meta.last_used<?').all(this.roleId,cutoff);this.db.exec('SAVEPOINT forget');try{for(const r of rows){this.db.prepare('UPDATE memory_meta SET forgotten=1 WHERE id=?').run(r.id!);this.db.prepare("UPDATE memory_fts SET state='forgotten' WHERE rowid=?").run(r.rowid!);}this.db.exec('RELEASE forget');}catch(e){this.db.exec('ROLLBACK TO forget; RELEASE forget');throw e;}return {forgotten:rows.length};}
  remember(id:string,pinned=false){const row=this.db.prepare('SELECT rowid FROM memories WHERE role=? AND id=?').get(this.roleId,id);if(!row)throw new Error('记忆不存在');this.db.prepare('UPDATE memory_meta SET forgotten=0,pinned=?,importance=CASE WHEN ?=1 THEN 10 ELSE importance END,last_used=? WHERE role=? AND id=?').run(pinned?1:0,pinned?1:0,this.clock(),this.roleId,id);this.db.prepare("UPDATE memory_fts SET state='active' WHERE rowid=?").run(row.rowid!);}
  concepts(scope='owner',query=''){return this.db.prepare('SELECT term,weight,mentions,last_used,pinned FROM memory_concepts WHERE role=? AND scope=? AND term LIKE ? ORDER BY pinned DESC,weight DESC,last_used DESC LIMIT 100').all(this.roleId,scope,'%'+query+'%');}
  setConcept(scope:string,term:string,weight:number,pinned:boolean){if(!Number.isFinite(weight)||weight<1||weight>10)throw new Error('词条权重为 1–10');const r=this.db.prepare('UPDATE memory_concepts SET weight=?,pinned=?,last_used=? WHERE role=? AND scope=? AND term=?').run(weight,pinned?1:0,this.clock(),this.roleId,scope,term);if(!r.changes)throw new Error('词条不存在');this.db.prepare('UPDATE memory_meta SET importance=?,pinned=? WHERE role=? AND scope=? AND id IN (SELECT id FROM memory_terms WHERE role=? AND scope=? AND term=?)').run(weight,pinned?1:0,this.roleId,scope,this.roleId,scope,term);}
  close(): void { this.db.close(); }
}
