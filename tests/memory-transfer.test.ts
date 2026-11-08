import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../src/memory.js';
import {exportMemoryPage,importMemory} from '../src/memory-transfer.js';
import {fixture} from './helpers.js';

test('QQ 与 B站一起导出，按游标分页且不导出其他会话；新记录不进入已有快照',()=>{
 const f=fixture(),m=new MemoryStore(':memory:','a','UTC',f.settings.memory);try{
  for(let i=0;i<75;i++)m.append('owner',i%2?'qq':'bilibili','p','note','共同的旅行记忆 '+i);
  m.append('qq:group:7','qq','g','note','群聊私有资料');const p=exportMemoryPage(m,'owner','all');assert.equal(p.rows.length,50);assert.ok(p.nextCursor);m.append('owner','qq','p','note','稍后加入');
  const next=exportMemoryPage(m,'owner','all',p.nextCursor!,p.snapshot,p.day);assert.equal(next.rows.length,25);assert.equal(next.nextCursor,null);assert.ok([...p.rows,...next.rows].some(r=>r.platform==='bilibili'));assert.ok(!JSON.stringify([p,next]).includes('群聊私有'));assert.ok(!JSON.stringify(next).includes('稍后加入'));
 }finally{m.close();f.cleanup();}
});
test('导入保留原始时间，重试去重；可复制到今天，跨日自动成为历史且全文索引可快速定位',()=>{
 const f=fixture();let now=Date.parse('2026-11-07T10:00:00Z');const m=new MemoryStore(':memory:','a','UTC',f.settings.memory,()=>now);
 const rows=[{time:now-86400000,platform:'qq',thread:'p',kind:'note',body:'昨天选了雅马哈吉他'},{time:now-86400000,platform:'bilibili',thread:'bilibili',kind:'experience',body:'吉他入门视频介绍'}],doc=JSON.stringify({format:'shiguang-memory',version:1,memories:rows});
 try{
  assert.equal(importMemory(m,'owner','all',doc,'json').added,2);assert.equal(importMemory(m,'owner','all',doc,'json').skipped,2);assert.equal(m.fastContext('owner','p').todayNotes,'');assert.equal(m.search('owner','吉他').length,2);
  assert.equal(importMemory(m,'owner','today',doc,'json').added,2);assert.match(m.fastContext('owner','p').todayNotes,/吉他/);assert.equal(exportMemoryPage(m,'owner','today').rows.length,2);
  now+=86400000;assert.equal(m.fastContext('owner','p').todayNotes,'');assert.equal(m.search('owner','雅马哈').length,2);assert.equal(m.list('owner','').rows.length,4);
 }finally{m.close();f.cleanup();}
});
test('文本导入历史不挤入今天，跨日再次导入会去重；无效文件整批不写入',()=>{
 const f=fixture();let now=Date.now();const m=new MemoryStore(':memory:','a','UTC',f.settings.memory,()=>now);try{
  assert.equal(importMemory(m,'owner','all','喜欢旅行\n\n常弹吉他','text').added,2);assert.equal(m.fastContext('owner','p').todayNotes,'');now+=86400000;assert.equal(importMemory(m,'owner','all','喜欢旅行\n\n常弹吉他','text').skipped,2);
  const valid={time:now,platform:'qq',thread:'p',kind:'note',body:'本批有效内容'};assert.throws(()=>importMemory(m,'owner','all',JSON.stringify({format:'shiguang-memory',version:1,memories:[valid,{...valid,body:42}]}),'json'),/整批未导入/);assert.equal(m.overview().total,2);
  assert.throws(()=>importMemory(m,'owner','today','{"Cookie":"secret"}','json'),/拾光记忆/);
 }finally{m.close();f.cleanup();}
});
