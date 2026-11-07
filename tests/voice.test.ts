import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {Context} from '@deepseek-ai/cordis';
import {LlmAdapter,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit';
import {VoiceService,speechAudio,spokenText,wantsVoice} from '../src/voice.js';
import {MemoryStore} from '../src/memory.js';
import {ShiguangRuntime} from '../src/runtime.js';
import {fixture} from './helpers.js';

const mp3=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=0.2','-f','mp3','pipe:1']);
function response(bytes=mp3){return new Response(JSON.stringify({code:0,data:bytes.subarray(0,20).toString('base64')})+'\n'+JSON.stringify({code:0,data:bytes.subarray(20).toString('base64'),usage:{text_words:12}})+'\n'+JSON.stringify({code:20000000}));}
function configure(f:ReturnType<typeof fixture>){Object.assign(f.settings.voice,{enabled:true,appId:'123456',speakerId:'S_fixture'});}
test('火山 HTTP Chunked 音频跨包解析、错误与截断拒绝，不将错误内容当音频播放',async()=>{
 const payload=Buffer.from(await response().text());let offset=0;
 const chunked=new Response(new ReadableStream({pull(controller){if(offset>=payload.length){controller.close();return;}controller.enqueue(payload.subarray(offset,offset+7));offset+=7;}}));
 const audio=await speechAudio(chunked);assert.deepEqual(audio.bytes,mp3);assert.equal(audio.billedChars,12);
 await assert.rejects(speechAudio(new Response('{"code":0,"data":"')),/中断/);
 await assert.rejects(speechAudio(new Response('{"code":55000000,"message":"do not echo secret"}')),error=>{assert.match(String(error),/55000000/);assert.doesNotMatch(String(error),/do not echo/);return true;});
 assert.equal(wantsVoice('用语音回复你好','ask'),true);assert.equal(wantsVoice('你好','ask'),false);assert.equal(spokenText('你好 **朋友** https://example.test',6),'你好 朋友 ');
});
test('APPID / Access Token / 音色请求、API Key 模式、私有缓存、独立字符用量和跨重启额度',async()=>{
 const f=fixture(),memory=new MemoryStore(':memory:',f.settings.roleId,f.settings.timezone,f.settings.memory);configure(f);let calls=0;
 const service=new VoiceService(f.settings,memory,()=> 'voice-test-secret',async(url,init)=>{
  calls++;assert.equal(String(url),'https://openspeech.bytedance.com/api/v3/tts/unidirectional');const headers=new Headers(init?.headers),body=JSON.parse(String(init?.body));
  assert.equal(headers.get('X-Api-Resource-Id'),'seed-icl-2.0');assert.ok(headers.get('X-Api-Request-Id'));
  if(f.settings.voice.authMode==='app'){assert.equal(headers.get('X-Api-App-Id'),'123456');assert.equal(headers.get('X-Api-Access-Key'),'voice-test-secret');assert.equal(headers.has('X-Api-Key'),false);}else{assert.equal(headers.get('X-Api-Key'),'voice-test-secret');assert.equal(headers.has('X-Api-App-Id'),false);}
  assert.equal(body.req_params.speaker,'S_fixture');assert.equal(body.req_params.audio_params.format,'mp3');assert.doesNotMatch(String(init?.body),/persona|memory|voice-test-secret/);return response();
 });
 try{
  const first=await service.synthesize('你好，这是试听');assert.deepEqual(first.bytes,mp3);assert.equal(first.reused,false);
  assert.equal((await service.synthesize('你好，这是试听')).reused,true);assert.equal(calls,1);
  await service.synthesize('你好，这是试听','qq:private:other');assert.equal(calls,2);
  f.settings.voice.authMode='apiKey';await service.synthesize('新的试听');assert.equal(calls,3);assert.equal(service.status().billedChars,36);
  f.settings.voice.dailyLimit=3;const restarted=new VoiceService(f.settings,memory,()=> 'voice-test-secret',async()=>{throw Error('must not call');});await assert.rejects(restarted.synthesize('重新启动'),/次数/);restarted.stop();
  assert.doesNotMatch(JSON.stringify(service.status()),/voice-test-secret/);assert.equal(memory.db.prepare('SELECT count(*) AS n FROM llm_usage').get()?.n,0);
 }finally{service.stop();memory.close();f.cleanup();}
});
test('语音停用不调用服务，网络结果未知与业务失败占用次数，数据库 v5 升级先备份',async()=>{
 const f=fixture(),path=join(f.dir,'memory.sqlite');let memory=new MemoryStore(path,f.settings.roleId,f.settings.timezone,f.settings.memory),calls=0;
 memory.append('owner','qq','p','note','保留今天的记忆');memory.db.exec('DROP TABLE voice_usage; PRAGMA user_version=5');memory.close();memory=new MemoryStore(path,f.settings.roleId,f.settings.timezone,f.settings.memory);
 const service=new VoiceService(f.settings,memory,()=> 'voice-test-secret',async()=>{calls++;throw Error('connection reset');});
 try{
  assert.ok(existsSync(path+'.v5-backup'));assert.match(memory.fastContext('owner','p').todayNotes,/保留/);
  await assert.rejects(service.synthesize('你好'),/开启/);assert.equal(calls,0);configure(f);
  await assert.rejects(service.synthesize('你好'),/未知/);assert.equal(service.status().todayCalls,1);assert.equal(calls,1);
  assert.equal(memory.db.prepare('SELECT status FROM voice_usage').get()?.status,'unknown');
 }finally{service.stop();memory.close();f.cleanup();}
});
test('真实 QQ WebSocket 与 DSH 回复：按需发送文字及复刻语音，密钥不进入设置或模型', {timeout:20000},async()=>{
 const f=fixture(),ctx=new Context(),server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 let runtime:ShiguangRuntime|undefined,spoken=0;const sent:any[]=[],modelRequests:GenerateOptions[]=[];
 class Model extends LlmAdapter {async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{modelRequests.push(options);const text='你好，今天一起练习吉他吧。';yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};}}
 try{
  await mountAgentLoopTestDependencies(ctx);await mountAgentLoopTestHarness(ctx);ctx.llm.registerAdapter(['voice-reply-test'],new Model());
  configure(f);Object.assign(f.settings,{provider:'voice-reply-test',model:'text'});Object.assign(f.settings.qq,{enabled:true,ownerQQ:'1',wsUrl:`ws://127.0.0.1:${address.port}`});
  writeFileSync(join(f.dir,'onebot.token'),'qq-local-secret');writeFileSync(join(f.dir,'voice.access-key'),'volc-local-secret');const config=join(f.dir,'config.json');writeFileSync(config,JSON.stringify(f.settings));
  server.on('connection',socket=>{socket.on('message',raw=>{const req=JSON.parse(raw.toString());if(req.action==='send_private_msg')sent.push(req.params.message[0]);socket.send(JSON.stringify({status:'ok',retcode:0,echo:req.echo,data:{message_id:100}}));});socket.send(JSON.stringify({post_type:'message',message_type:'private',self_id:2,user_id:1,message_id:1,message:[{type:'text',data:{text:'用语音回复我'}}]}));});
  runtime=new ShiguangRuntime(ctx,config,async()=>{spoken++;return response();});
  const until=Date.now()+10000;while(sent.length<2){if(Date.now()>until)throw Error('No voice receipt');await new Promise(r=>setTimeout(r,20));}
  assert.equal(sent[0].type,'text');assert.equal(sent[1].type,'record');assert.deepEqual(Buffer.from(sent[1].data.file.slice('base64://'.length),'base64'),mp3);assert.equal(spoken,1);
  assert.doesNotMatch(JSON.stringify(runtime.view())+JSON.stringify(modelRequests),/volc-local-secret/);assert.doesNotMatch(readFileSync(config,'utf8'),/volc-local-secret/);
 }finally{await runtime?.stop();for(const client of server.clients)client.terminate();await new Promise<void>(r=>server.close(()=>r()));await ctx.fiber.dispose();f.cleanup();}
});
