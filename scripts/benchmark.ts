import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MemoryStore } from '../src/memory.js';
import { parseSettings } from '../src/config.js';

const dir = mkdtempSync(join(tmpdir(), 'shiguang-bench-'));
const settings = parseSettings(JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')), join(dir, 'config.json'));
const memory = new MemoryStore(join(dir, 'memory.sqlite'), 'benchmark', 'UTC', settings.memory);
try {
  const count = 50000, yesterday = Date.now() - 86400000;
  memory.db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < count; i++) memory.append('owner', i % 2 ? 'qq' : 'bilibili', 'p', 'user', `历史消息 ${i}，${i % 11 === 0 ? '吉他入门和弦练习' : '普通聊天与日常见闻'}，演示记录用于本地检索测试。`, undefined, yesterday);
  memory.append('owner', 'qq', 'p', 'note', '今天准备练习吉他');
  for (let i = 0; i < 12; i++) memory.append('owner', 'qq', 'p', 'user', `今天的第 ${i} 条消息`);
  memory.db.exec('COMMIT');
  const measure = (run: () => unknown, times: number) => {
    const samples: number[] = [];
    for (let i = 0; i < times; i++) { const start = performance.now(); run(); samples.push(performance.now() - start); }
    samples.sort((a, b) => a - b);
    return { samples: times, p50Ms: +samples[Math.floor(times * .5)]!.toFixed(3), p95Ms: +samples[Math.floor(times * .95)]!.toFixed(3) };
  };
  const fast = memory.fastContext('owner', 'p');
  console.log(JSON.stringify({ node: process.version, platform: process.platform, archiveRows: count, todayContext: measure(() => memory.fastContext('owner', 'p'), 200), sharedTodayContext:measure(()=>memory.fastContext('owner','qq:private:1',['owner']),200),archiveSearch: measure(() => memory.search('owner', '吉他和弦'), 20), todayContextChars: fast.todayNotes.length + fast.recent.length, scope: '仅本地数据库耗时，不含 DSH、模型推理和平台网络延迟' }, null, 2));
} finally { memory.close(); rmSync(dir, { recursive: true, force: true }); }
