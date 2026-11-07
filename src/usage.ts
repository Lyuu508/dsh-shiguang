import { lastAssistantStreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { MemoryStore } from './memory.js';
import { dayKey } from './memory.js';

export interface UsageOrigin { session: string; source: 'qq' | 'dsh'; provider: string; model: string }
export interface UsageTotals {
  calls: number; missing: number; input: number; cacheRead: number; cacheWrite: number;
  output: number; reasoning: number; total: number;
}
export interface UsageReport {
  day: string; timezone: string; total: UsageTotals;
  categories: (UsageTotals & { category: string })[];
  models: (UsageTotals & { provider: string; model: string })[];
}
const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
function counters(usage?: TokenUsage): number[] {
  if (!usage || !valid(usage.inputTokens) || !valid(usage.outputTokens) ||
    [usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens].some(n => n !== undefined && !valid(n))) return [1,0,0,0,0,0];
  return [0, usage.inputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0, usage.outputTokens, usage.reasoningTokens ?? 0];
}
/** One row per settled model attempt, including tool steps, retries and cancellations. */
export function recordUsage(memory: MemoryStore, origin: UsageOrigin, events: readonly SessionEvent[]): void {
  const category = events.some(e => e.type === 'tool/call' && e.data.name.startsWith('shiguang_bili_')) ? 'bilibili' : origin.source;
  const insert = memory.db.prepare(`INSERT OR IGNORE INTO llm_usage
    (role,session,seq,day,time,source,category,provider,model,missing,input,cache_read,cache_write,output,reasoning)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  memory.db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of events) {
      if (e.type !== 'assistant/message' && e.type !== 'assistant/attempt') continue;
      const usage = e.type === 'assistant/message' ? e.data.usage : lastAssistantStreamChunk(e.data.stream, 'usage')?.usage;
      insert.run(memory.roleId, origin.session, Number(e.seq), dayKey(e.time, memory.timezone), e.time,
        origin.source, category, origin.provider, origin.model, ...counters(usage));
    }
    memory.db.exec('COMMIT');
  } catch (error) { memory.db.exec('ROLLBACK'); throw error; }
}
const sums = `count(*) AS calls,coalesce(sum(missing),0) AS missing,coalesce(sum(input),0) AS input,
  coalesce(sum(cache_read),0) AS cacheRead,coalesce(sum(cache_write),0) AS cacheWrite,
  coalesce(sum(output),0) AS output,coalesce(sum(reasoning),0) AS reasoning,
  coalesce(sum(input+cache_read+cache_write+output),0) AS total`;
export function dailyUsage(memory: MemoryStore, day = memory.today()): UsageReport {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day+'T00:00:00Z')) || new Date(day+'T00:00:00Z').toISOString().slice(0,10) !== day) throw new Error('日期应为有效的 YYYY-MM-DD');
  const query = (select: string, group = '') => memory.db.prepare(`SELECT ${select}${sums} FROM llm_usage WHERE role=? AND day=? ${group}`).all(memory.roleId,day);
  return { day, timezone: memory.timezone, total: query('')[0] as unknown as UsageTotals,
    categories: query('category,','GROUP BY category ORDER BY category') as unknown as UsageReport['categories'],
    models: query('provider,model,','GROUP BY provider,model ORDER BY provider,model') as unknown as UsageReport['models'] };
}
