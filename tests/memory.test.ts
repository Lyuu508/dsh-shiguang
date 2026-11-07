import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { MemoryStore, dayKey, searchTokens } from '../src/memory.js';
import { historyRequested } from '../src/policy.js';
import { fixture } from './helpers.js';

test('正常聊天只加载今天的笔记和限量最近对话，旧记忆留在归档', () => {
  const f = fixture(); let now = Date.parse('2026-11-07T10:00:00Z');
  const store = new MemoryStore(':memory:', 'a', 'UTC', f.settings.memory, () => now);
  try {
    store.append('owner', 'qq', 'qq:private:1', 'note', '昨天学了吉他', undefined, now - 86400000);
    store.append('owner', 'bilibili', 'bilibili', 'experience', '今天看到了吉他教程');
    for (let n = 0; n < 30; n++) store.append('owner', 'qq', 'qq:private:1', 'user', `第${n}条`);
    const context = store.fastContext('owner', 'qq:private:1');
    assert.match(context.todayNotes, /今天看到了吉他教程/);
    assert.doesNotMatch(context.todayNotes + context.recent, /昨天/);
    assert.equal(context.recent.split('\n').length, 12);
    assert.match(context.recent, /第29条/);
    assert.doesNotMatch(context.recent, /第0条/);
    assert.equal(store.search('owner', '吉他')[0]?.snippet, '昨天学了吉他');
    now += 86400000;
    assert.equal(store.fastContext('owner', 'qq:private:1').todayNotes, '');
    assert.equal(store.fastContext('owner', 'qq:private:1').recent, '');
    assert.equal(store.search('owner', '吉他').length, 2);
  } finally { store.close(); f.cleanup(); }
});
test('日期按配置时区翻页，包括夏令时', () => {
  const t = Date.parse('2026-11-07T16:30:00Z');
  assert.equal(dayKey(t, 'Asia/Shanghai'), '2026-11-08');
  assert.equal(dayKey(t, 'America/New_York'), '2026-11-07');
  assert.equal(dayKey(Date.parse('2026-03-08T07:30:00Z'), 'America/New_York'), '2026-03-08');
});
test('中文双字检索、英文检索和特殊符号查询均有界', () => {
  const f = fixture(), store = new MemoryStore(':memory:', 'a', 'UTC', f.settings.memory);
  try {
    const yesterday = Date.now() - 86400000;
    store.append('owner', 'qq', 'p', 'user', '最近在学习电吉他，计划练习 DeepSeek 插件', undefined, yesterday);
    assert.ok(searchTokens('学习吉他').includes('吉他'));
    assert.equal(store.search('owner', '吉他').length, 1);
    assert.equal(store.search('owner', 'DeepSeek').length, 1);
    assert.deepEqual(store.search('owner', '" OR *'), []);
    for (let i = 0; i < 20; i++) store.append('owner', 'qq', 'p', 'user', '吉他' + '长文'.repeat(1000), undefined, yesterday);
    const hits = store.search('owner', '吉他');
    assert.equal(hits.length, f.settings.memory.searchLimit);
    assert.ok(hits.every(h => h.snippet.length <= f.settings.memory.snippetChars + 2));
  } finally { store.close(); f.cleanup(); }
});
test('角色、群聊与主人记忆隔离，展开同样检查权限', () => {
  const f = fixture(), path = join(f.dir, 'memory.sqlite');
  const a = new MemoryStore(path, 'a', 'UTC', f.settings.memory), b = new MemoryStore(path, 'b', 'UTC', f.settings.memory);
  try {
    const id = a.append('owner', 'qq', 'p', 'note', '私人吉他信息', undefined, Date.now() - 86400000)!;
    assert.deepEqual(a.search('qq:group:5', '吉他'), []);
    assert.deepEqual(b.search('owner', '吉他'), []);
    assert.throws(() => a.detail('qq:group:5', id), /不属于/);
    assert.throws(() => b.detail('owner', id), /不属于/);
  } finally { a.close(); b.close(); f.cleanup(); }
});
test('记忆分页、当天上下文预算和重启后的消息去重', () => {
  const f = fixture(), path = join(f.dir, 'memory.sqlite');
  let store = new MemoryStore(path, 'a', 'UTC', f.settings.memory);
  try {
    const id = store.append('owner', 'qq', 'p', 'user', '内容'.repeat(10000), 'qq:message:1')!;
    assert.equal(store.detail('owner', id).text.length, f.settings.memory.detailMaxChars);
    assert.equal(store.detail('owner', id).nextOffset, f.settings.memory.detailMaxChars);
    assert.throws(() => store.detail('owner', id, -1), /offset/);
    for (let i = 0; i < 30; i++) store.append('owner', 'shared', 'p', 'note', '笔记'.repeat(90));
    const fast = store.fastContext('owner', 'p');
    assert.ok(fast.todayNotes.length <= f.settings.memory.todayMaxChars);
    assert.ok(fast.recent.length <= f.settings.memory.recentMaxChars);
    store.close(); store = new MemoryStore(path, 'a', 'UTC', f.settings.memory);
    assert.equal(store.append('owner', 'qq', 'p', 'user', '重复', 'qq:message:1'), null);
    assert.ok(store.detail('owner', id).text);
  } finally { store.close(); f.cleanup(); }
});
test('评论配额跨重启保留，未知结果占用配额并阻止重复', () => {
  const f = fixture(); let now = Date.now();
  const path = join(f.dir, 'memory.sqlite');
  let store = new MemoryStore(path, 'a', 'UTC', f.settings.memory, () => now);
  try {
    store.reserveComment('first', 2, 1000); store.settleAction('first', 'unknown', 'timeout');
    assert.throws(() => store.reserveComment('first', 2, 1000), /已提交/);
    assert.throws(() => store.reserveComment('second', 2, 1000), /间隔/);
    now += 1001; store.close(); store = new MemoryStore(path, 'a', 'UTC', f.settings.memory, () => now);
    store.reserveComment('second', 2, 1000); now += 1001;
    assert.throws(() => store.reserveComment('third', 2, 1000), /次数/);
  } finally { store.close(); f.cleanup(); }
});
test('日常聊天不开放历史，明确追问和回忆指令才开放', () => {
  assert.equal(historyRequested('你好，今天吃什么'), false);
  assert.equal(historyRequested('你能帮我总结这篇文章吗'), false);
  assert.equal(historyRequested('上周我们聊的吉他型号是什么'), true);
  assert.equal(historyRequested('/回忆 吉他'), true);
  assert.equal(historyRequested('Do you remember my guitar?'), true);
});
test('升级 v1 记忆库只添加回收站，保留旧记忆和操作账本',()=>{
 const f=fixture(),path=join(f.dir,'legacy.sqlite');let store=new MemoryStore(path,'a','UTC',f.settings.memory);
 try{
  const id=store.append('owner','qq','p','note','旧版本记忆')!;store.reserveComment('legacy-action',5,1000);
  store.db.exec('DROP TABLE memory_trash; PRAGMA user_version=1');store.close();store=new MemoryStore(path,'a','UTC',f.settings.memory);
  assert.ok(existsSync(path+'.v1-backup'));
  assert.equal(store.detail('owner',id).text,'旧版本记忆');assert.equal(store.overview().commentsToday,1);
  store.remove('owner',id);store.restore('owner',id);assert.equal(store.detail('owner',id).text,'旧版本记忆');
 }finally{store.close();f.cleanup();}
});
