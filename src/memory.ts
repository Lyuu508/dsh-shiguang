import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Settings } from './config.js';

export interface MemoryRow { id: string; day: string; time: number; platform: string; kind: string; body: string }
export interface SearchHit { id: string; day: string; platform: string; kind: string; snippet: string }
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
  constructor(path: string, readonly roleId: string, readonly timezone: string, readonly limits: Settings['memory'], readonly clock = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (Number(version) > 4) throw new Error('记忆数据库来自更新版本，请升级插件');
    if ([1,2,3].includes(Number(version)) && path !== ':memory:' && !existsSync(`${path}.v${version}-backup`)) this.db.prepare('VACUUM INTO ?').run(`${path}.v${version}-backup`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, scope TEXT NOT NULL,
        day TEXT NOT NULL, time INTEGER NOT NULL, platform TEXT NOT NULL, thread TEXT NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, external_key TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS memories_today ON memories(role,scope,day,kind,time DESC,rowid DESC);
      CREATE INDEX IF NOT EXISTS memories_thread ON memories(role,scope,day,thread,time DESC,rowid DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(tokens, namespace, day UNINDEXED, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS actions (
        key TEXT PRIMARY KEY, role TEXT NOT NULL, day TEXT NOT NULL, time INTEGER NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, result TEXT
      );
      CREATE INDEX IF NOT EXISTS actions_quota ON actions(role,kind,day,time DESC);
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
      PRAGMA user_version=4;
    `);
  }
  today(): string { return dayKey(this.clock(), this.timezone); }
  seen(externalKey: string): boolean { return !!this.db.prepare('SELECT 1 FROM memories WHERE external_key=?').get(`${this.roleId}:${externalKey}`); }
  private namespace(scope: string): string { return createHash('sha256').update(JSON.stringify([this.roleId, scope])).digest('hex'); }
  append(scope: string, platform: string, thread: string, kind: string, body: string, externalKey?: string, time = this.clock()): string | null {
    const id = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT OR IGNORE INTO memories(id,role,scope,day,time,platform,thread,kind,body,external_key) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, this.roleId, scope, dayKey(time, this.timezone), time, platform, thread, kind, body, externalKey ? `${this.roleId}:${externalKey}` : null);
      if (!result.changes) { this.db.exec('COMMIT'); return null; }
      this.db.prepare('INSERT INTO memory_fts(rowid,tokens,namespace,day) VALUES(?,?,?,?)').run(result.lastInsertRowid, searchTokens(body).join(' '), this.namespace(scope), dayKey(time, this.timezone));
      this.db.exec('COMMIT'); return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  fastContext(scope: string, thread: string): { day: string; todayNotes: string; recent: string } {
    const day = this.today();
    const notes = this.db.prepare("SELECT body, platform FROM memories WHERE role=? AND scope=? AND day=? AND kind IN ('note','experience') ORDER BY time DESC,rowid DESC LIMIT 80")
      .all(this.roleId, scope, day) as { body: string; platform: string }[];
    const recent = this.db.prepare("SELECT kind,body FROM memories WHERE role=? AND scope=? AND day=? AND thread=? AND kind IN ('user','assistant') ORDER BY time DESC,rowid DESC LIMIT ?")
      .all(this.roleId, scope, day, thread, this.limits.recentMessages) as { kind: string; body: string }[];
    return {
      day,
      todayNotes: budgetLines(notes.map(n => `[${n.platform}] ${n.body}`), this.limits.todayMaxChars),
      recent: budgetLines(recent.map(r => `${r.kind === 'user' ? '对方' : '你'}：${r.body}`), this.limits.recentMaxChars),
    };
  }
  search(scope: string, query: string, range: 'history' | 'today' = 'history', day?: string): SearchHit[] {
    if (!query.trim() || query.length > 200) throw new Error('检索词应为 1–200 字');
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期应为 YYYY-MM-DD');
    const tokens = searchTokens(query).slice(0, 24);
    if (!tokens.length) return [];
    const terms = tokens.map(t => `"${t.replaceAll('"', '""')}"`).join(' OR ');
    const match = `namespace:"${this.namespace(scope)}" AND tokens:(${terms})`;
    const dayClause = day || range === 'today' ? 'day=?' : 'day<?';
    // Rank and bound within FTS before primary-key reads; joining first can
    // make SQLite re-run the virtual-table match for each archived row.
    const rows = this.db.prepare(`WITH hits AS MATERIALIZED (SELECT rowid,rank AS score FROM memory_fts WHERE memory_fts MATCH ? AND ${dayClause} ORDER BY rank LIMIT ?) SELECT m.id,m.day,m.platform,m.kind,m.body FROM hits JOIN memories m ON m.rowid=hits.rowid WHERE m.role=? AND m.scope=? ORDER BY hits.score,m.time DESC`)
      .all(match, day || this.today(), this.limits.searchLimit, this.roleId, scope);
    return rows.map(r => {
      const body = String(r.body);
      const lower = body.toLowerCase();
      const positions = tokens.map(t => lower.indexOf(t)).filter(n => n >= 0);
      const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 45);
      return { id: String(r.id), day: String(r.day), platform: String(r.platform), kind: String(r.kind), snippet: `${start ? '…' : ''}${body.slice(start, start + this.limits.snippetChars)}${body.length > start + this.limits.snippetChars ? '…' : ''}` };
    });
  }
  detail(scope: string, id: string, offset = 0, historyAllowed = true): { id: string; day: string; platform: string; text: string; nextOffset: number | null } {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须为非负整数');
    const row = this.db.prepare('SELECT id,day,platform,body FROM memories WHERE role=? AND scope=? AND id=? AND (? OR day=?)').get(this.roleId, scope, id, historyAllowed ? 1 : 0, this.today()) as { id: string; day: string; platform: string; body: string } | undefined;
    if (!row) throw new Error('记忆不存在或不属于当前会话');
    const end = offset + this.limits.detailMaxChars;
    return { id: row.id, day: row.day, platform: row.platform, text: row.body.slice(offset, end), nextOffset: end < row.body.length ? end : null };
  }
  reserveComment(key: string, perDay: number, intervalMs: number): void {
    const day = this.today(), time = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT key FROM actions WHERE key=?').get(key)) throw new Error('这次评论已提交过或结果待核实；请先去 B 站查看，插件不会重复发送');
      const count = this.db.prepare("SELECT count(*) AS n,max(time) AS last FROM actions WHERE role=? AND kind='bili-comment' AND day=?").get(this.roleId, day) as { n: number; last: number | null };
      if (count.n >= perDay) throw new Error('今日评论次数已用完');
      if (count.last !== null && time - count.last < intervalMs) throw new Error('评论间隔过短，请稍后再试');
      this.db.prepare("INSERT INTO actions(key,role,day,time,kind,status) VALUES(?,?,?,?,'bili-comment','pending')").run(key, this.roleId, day, time);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  settleAction(key: string, status: 'sent' | 'failed' | 'unknown', result: string): void {
    this.db.prepare('UPDATE actions SET status=?,result=? WHERE key=?').run(status, result.slice(0, 500), key);
  }
  overview(): { total: number; today: number; scopes: string[]; commentsToday: number } {
    const total = this.db.prepare('SELECT count(*) AS n FROM memories WHERE role=?').get(this.roleId)!;
    const today = this.db.prepare('SELECT count(*) AS n FROM memories WHERE role=? AND day=?').get(this.roleId, this.today())!;
    const comments = this.db.prepare("SELECT count(*) AS n FROM actions WHERE role=? AND day=? AND kind='bili-comment'").get(this.roleId, this.today())!;
    return { total: Number(total.n), today: Number(today.n), scopes: [...new Set(['owner', ...this.db.prepare('SELECT DISTINCT scope FROM memories WHERE role=?').all(this.roleId).map(r => String(r.scope))])], commentsToday: Number(comments.n) };
  }
  list(scope: string, day: string, before = 0): { rows: (MemoryRow & { cursor: number })[]; nextCursor: number | null } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isSafeInteger(before) || before < 0) throw new Error('日期或分页参数无效');
    const rows = this.db.prepare('SELECT rowid,id,day,time,platform,kind,substr(body,1,240) AS body FROM memories WHERE role=? AND scope=? AND day=? AND (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT 21').all(this.roleId, scope, day, before, before);
    const items = rows.slice(0,20).map(r => ({ id: String(r.id), day: String(r.day), time: Number(r.time), platform: String(r.platform), kind: String(r.kind), body: String(r.body), cursor: Number(r.rowid) }));
    return { rows: items, nextCursor: rows.length > 20 ? items.at(-1)!.cursor : null };
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
      const inserted = this.db.prepare('INSERT INTO memories(id,role,scope,day,time,platform,thread,kind,body,external_key) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,this.roleId,scope,row.day!,row.time!,row.platform!,row.thread!,row.kind!,row.body!,row.external_key!);
      this.db.prepare('INSERT INTO memory_fts(rowid,tokens,namespace,day) VALUES(?,?,?,?)').run(inserted.lastInsertRowid,searchTokens(String(row.body)).join(' '),this.namespace(scope),row.day!);
      this.db.prepare('DELETE FROM memory_trash WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
