import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory.js';
import { BilibiliClient, videoId } from '../src/bilibili.js';
import { fixture } from './helpers.js';

function json(data: unknown, headers: HeadersInit = {}): Response { return new Response(JSON.stringify({ code: 0, data }), { headers: { 'Content-Type': 'application/json', ...headers } }); }
const video = { aid: 123, bvid: 'BV1xx411c7mD', title: '吉他教程', desc: '入门和弦', owner: { name: '作者' } };

test('只接受视频编号和固定 B 站域名，拒绝任意地址与短链', () => {
  assert.deepEqual(videoId('BV1xx411c7mD'), { bvid: 'BV1xx411c7mD' });
  assert.deepEqual(videoId('https://www.bilibili.com/video/BV1xx411c7mD/?share=1'), { bvid: 'BV1xx411c7mD' });
  assert.deepEqual(videoId('av123'), { aid: '123' });
  assert.throws(() => videoId('http://127.0.0.1/admin'));
  assert.throws(() => videoId('https://bilibili.com.attacker.test/video/BV1xx411c7mD'));
  assert.throws(() => videoId('https://b23.tv/test'));
});
test('扫码状态与 Cookie 保存不向调用者返回登录凭据', async () => {
  const f = fixture(), memory = new MemoryStore(':memory:', 'a', 'UTC', f.settings.memory);
  const fetcher: typeof fetch = async url => {
    if (String(url).includes('/generate')) return json({ url: 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=test', qrcode_key: 'test' });
    const response = json({ code: 0 });
    response.headers.append('set-cookie', 'SESSDATA=fake-session; Path=/; HttpOnly');
    response.headers.append('set-cookie', 'bili_jct=fake-csrf; Path=/');
    return response;
  };
  try {
    const api = new BilibiliClient(f.settings, memory, fetcher);
    assert.equal((await api.startLogin()).key, 'test');
    assert.equal(await api.pollLogin('test'), 'success');
    assert.ok(existsSync(join(f.dir, 'bilibili.cookies.json')));
  } finally { memory.close(); f.cleanup(); }
});
test('评论获得回执才写入共享记忆，同一天重复操作不重发', async () => {
  const f = fixture(); f.settings.bilibili.enabled = true; f.settings.bilibili.allowComments = true;
  const memory = new MemoryStore(':memory:', 'a', 'UTC', f.settings.memory);
  writeFileSync(join(f.dir, 'bilibili.cookies.json'), JSON.stringify({ SESSDATA: 'fake-session', bili_jct: 'fake-csrf' }));
  let posts = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes('/view')) { assert.ok(!new Headers(init?.headers).has('Cookie')); return json(video); }
    posts++; assert.equal(init?.method, 'POST');
    assert.match(String(new Headers(init?.headers).get('Cookie')), /SESSDATA=fake-session/);
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get('oid'), '123'); assert.equal(form.get('csrf'), 'fake-csrf');
    assert.equal(form.get('message'), '讲得很清楚');
    return json({ rpid_str: '999999999999999999' });
  };
  try {
    const api = new BilibiliClient(f.settings, memory, fetcher);
    assert.equal((await api.comment('BV1xx411c7mD', '讲得很清楚')).rpid, '999999999999999999');
    assert.match(memory.fastContext('owner', 'qq:private:1').todayNotes, /已在《吉他教程》评论/);
    await assert.rejects(api.comment('BV1xx411c7mD', '讲得很清楚'), /已提交/);
    assert.equal(posts, 1);
  } finally { memory.close(); f.cleanup(); }
});
test('评论发送超时不记为成功，并阻止再次自动提交', async () => {
  const f = fixture(); f.settings.bilibili.enabled = true; f.settings.bilibili.allowComments = true;
  const memory = new MemoryStore(':memory:', 'a', 'UTC', f.settings.memory);
  writeFileSync(join(f.dir, 'bilibili.cookies.json'), JSON.stringify({ SESSDATA: 'fake', bili_jct: 'fake' }));
  let posts = 0;
  const fetcher: typeof fetch = async url => {
    if (String(url).includes('/view')) return json(video);
    posts++; throw new Error('connection reset after write');
  };
  try {
    const api = new BilibiliClient(f.settings, memory, fetcher);
    await assert.rejects(api.comment('av123', '好教程'), /结果未知/);
    assert.equal(memory.fastContext('owner', 'p').todayNotes, '');
    await assert.rejects(api.comment('av123', '好教程'), /已提交/);
    assert.equal(posts, 1);
  } finally { memory.close(); f.cleanup(); }
});
test('评论禁用时不触发请求，验证码不会绕过或重试', async () => {
  const f = fixture(), memory = new MemoryStore(':memory:', 'a', 'UTC', f.settings.memory);
  let posts = 0;
  const fetcher: typeof fetch = async url => {
    if (String(url).includes('/view')) return json(video);
    posts++; return new Response(JSON.stringify({ code: 12015, data: {} }));
  };
  try {
    const api = new BilibiliClient(f.settings, memory, fetcher);
    await assert.rejects(api.comment('av123', '好教程'), /尚未启用/); assert.equal(posts, 0);
    f.settings.bilibili.enabled = true; f.settings.bilibili.allowComments = true;
    writeFileSync(join(f.dir, 'bilibili.cookies.json'), JSON.stringify({ SESSDATA: 'fake', bili_jct: 'fake' }));
    await assert.rejects(api.comment('av123', '好教程'), /官方客户端/);
    assert.equal(posts, 1);
  } finally { memory.close(); f.cleanup(); }
});
