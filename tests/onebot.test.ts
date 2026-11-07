import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { OneBotClient, parseMessage } from '../src/onebot.js';
import { fixture } from './helpers.js';

const event = (extra = {}) => ({ post_type: 'message', message_type: 'private', message_id: 10, self_id: 2, user_id: 1, message: [{ type: 'text', data: { text: '你好' } }], ...extra });
test('个人号输入只接白名单、忽略自己，并隔离群聊', () => {
  const f = fixture(), c = f.settings.qq; c.ownerQQ = '1'; c.allowedGroups = ['5'];
  try {
    assert.equal(parseMessage(event(), c)?.scope, 'owner');
    assert.equal(parseMessage(event({ user_id: 999 }), c), null);
    assert.equal(parseMessage(event({ user_id: 2 }), c), null);
    assert.equal(parseMessage(event({ message: '[CQ:at,qq=2]坏消息' }), c), null);
    assert.equal(parseMessage(event({ message_type: 'group', group_id: 5 }), c), null);
    const group = parseMessage(event({ message_type: 'group', group_id: 5, message: [{ type: 'at', data: { qq: '2' } }, { type: 'text', data: { text: '你好' } }] }), c);
    assert.equal(group?.scope, 'qq:group:5'); assert.equal(group?.owner, false);
    assert.equal(parseMessage(event({ message_type: 'message_sent' }), c), null);
  } finally { f.cleanup(); }
});
test('真实本地 WebSocket 收消息并使用纯文本消息段发送回复', async () => {
  const f = fixture(), server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address(); assert.equal(typeof address, 'object'); assert.ok(address);
  f.settings.qq.wsUrl = `ws://127.0.0.1:${address.port}`; f.settings.qq.ownerQQ = '1';
  f.settings.qq.tokenEnv = 'SHIGUANG_TEST_TOKEN'; process.env.SHIGUANG_TEST_TOKEN = 'test-token';
  const received: unknown[] = []; let resolveMessage: (m: NonNullable<ReturnType<typeof parseMessage>>) => void;
  const incoming = new Promise<NonNullable<ReturnType<typeof parseMessage>>>(r => { resolveMessage = r; });
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer test-token');
    socket.on('message', data => {
      const v = JSON.parse(data.toString()); received.push(v);
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 }, echo: v.echo }));
    });
    socket.send(JSON.stringify(event()));
  });
  const client = new OneBotClient(f.settings.qq, m => resolveMessage(m), () => {});
  try {
    client.start(); const message = await incoming;
    const result = await client.send(message, '[CQ:at,qq=all]这只是文字');
    assert.equal(result.message_id, 42);
    assert.equal((received[0] as any).action, 'send_private_msg');
    assert.deepEqual((received[0] as any).params.message, [{ type: 'text', data: { text: '[CQ:at,qq=all]这只是文字' } }]);
  } finally { client.stop(); await new Promise<void>(r => server.close(() => r())); delete process.env.SHIGUANG_TEST_TOKEN; f.cleanup(); }
});
test('视频和 GIF 可作为独立消息接收，引用媒体不跨会话，文件 ID 不接受路径',async()=>{
 const f=fixture(),c=f.settings.qq;c.ownerQQ='1';c.allowedGroups=['5'];
 const media=[{type:'image',data:{file:'animation.image',url:'https://gchat.qpic.cn/a.gif'}},{type:'video',data:{file:'video-id'}}];
 const client=new OneBotClient(c,()=>{},()=>{});let calls=0;
 try{
  assert.equal(parseMessage(event({message:media}),c)?.media?.length,2);
  const quoted=parseMessage(event({message:[{type:'reply',data:{id:'-123'}},{type:'text',data:{text:'看看'}}]}),c)!;assert.equal(quoted.replyId,'-123');
  client.action=async()=>{calls++;return {message_type:'private',user_id:'1',message:media};};assert.equal((await client.quotedMedia(quoted)).length,2);
  client.action=async()=>({message_type:'private',user_id:'999',message:media});await assert.rejects(client.quotedMedia(quoted),/不属于/);
  assert.deepEqual(await client.mediaInfo({type:'video',file:'C:\\private\\photo.jpg'}),{});assert.equal(calls,1);
 }finally{client.stop();f.cleanup();}
});
