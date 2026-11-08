import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { MemoryStore } from '../src/memory.js';
import { recordUsage, dailyUsage } from '../src/usage.js';
import { fixture } from './helpers.js';

const origin={session:'s',source:'qq' as const,provider:'deepseek',model:'test'};
const now=Date.parse('2026-11-07T16:01:00Z');
function events():SessionEvent[]{return [
 {type:'assistant/message',seq:1,time:now,data:{usage:{inputTokens:100,cacheReadTokens:400,cacheWriteTokens:10,outputTokens:50,reasoningTokens:20},message:{content:[]},stream:[]}},
 {type:'assistant/attempt',seq:2,time:now,data:{stream:[{type:'chunk',time:now,chunk:{type:'usage',usage:{inputTokens:200,outputTokens:30}}}]}},
 {type:'assistant/message',seq:3,time:now,data:{message:{content:[]},stream:[],interrupted:true}},
 ] as unknown as SessionEvent[];}
test('全轮累计、缓存不重复、推理不重复、缺失标记、跨日时区与重启幂等',()=>{
 const f=fixture(),path=join(f.dir,'usage.sqlite');let store=new MemoryStore(path,'a','Asia/Shanghai',f.settings.memory);
 try{
  recordUsage(store,origin,events());recordUsage(store,origin,events());
  const r=dailyUsage(store,'2026-11-08');assert.deepEqual({...r.total},{calls:3,missing:1,input:300,cacheRead:400,cacheWrite:10,output:80,reasoning:20,total:790,exactCalls:1,exactTotal:560,partialCalls:2,unclassified:0,mismatches:0,pending:0});
  assert.equal(r.categories[0]?.category,'qq');assert.equal(dailyUsage(store,'2026-11-07').total.calls,0);
  store.close();store=new MemoryStore(path,'a','Asia/Shanghai',f.settings.memory);recordUsage(store,origin,events());assert.equal(dailyUsage(store,'2026-11-08').total.calls,3);
  assert.throws(()=>dailyUsage(store,'2026-02-30'),/日期/);
 }finally{store.close();f.cleanup();}
});
test('B站整轮只归一次，角色隔离，不把工具网络请求当模型调用',()=>{
 const f=fixture(),path=join(f.dir,'usage.sqlite'),store=new MemoryStore(path,'a','UTC',f.settings.memory),other=new MemoryStore(path,'b','UTC',f.settings.memory);
 try{
  recordUsage(store,origin,[...events(),{type:'tool/call',seq:4,time:now,data:{name:'shiguang_bili_video'}} as SessionEvent]);
  const r=dailyUsage(store,'2026-11-07');assert.equal(r.categories.length,1);assert.equal(r.categories[0]?.category,'bilibili');assert.equal(r.total.calls,3);assert.equal(r.total.total,790);
  assert.equal(dailyUsage(other,'2026-11-07').total.calls,0);
 }finally{store.close();other.close();f.cleanup();}
});
test('旧版数据库先备份再升级，新表不改变原记忆或评论额度',()=>{
 const f=fixture(),path=join(f.dir,'legacy.sqlite');let store=new MemoryStore(path,'a','UTC',f.settings.memory);
 try{
  const id=store.append('owner','qq','p','note','保留原记忆')!;store.reserveComment('old',5,1000);store.db.exec('DROP TABLE llm_usage; PRAGMA user_version=2');store.close();
  store=new MemoryStore(path,'a','UTC',f.settings.memory);assert.ok(existsSync(path+'.v2-backup'));assert.equal(store.detail('owner',id).text,'保留原记忆');assert.equal(store.overview().commentsToday,1);assert.equal(dailyUsage(store).total.calls,0);
 }finally{store.close();f.cleanup();}
});
