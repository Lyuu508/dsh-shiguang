import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
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
    if (Number(version) > 1) throw new Error('记忆数据库来自更新版本，请升级插件');
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
      PRAGMA user_version=1;
    `);
  }
  today(): string { return dayKey(this.clock(), this.timezone); }
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
  close(): void { this.db.close(); }
}
