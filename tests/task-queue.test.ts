import test from 'node:test';import assert from 'node:assert/strict';
import {TaskQueue} from '../src/task-queue.js';
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('普通待办达到上限仍接受面板和设置，优先执行且从不并行修改状态',async()=>{
 const q=new TaskQueue(()=>2),held=gate(),started=gate(),order:string[]=[];let running=0,peak=0;
 const first=q.submit(async()=>{running++;peak=Math.max(peak,running);started.release();await held.promise;running--;order.push('active');});await started.promise;
 const chat=q.submit(async()=>{running++;peak=Math.max(peak,running);order.push('chat');running--;});assert.throws(()=>q.submit(async()=>{}),/已达 2 项/);
 const panel=q.submit(async()=>{running++;peak=Math.max(peak,running);order.push('panel');running--;},{kind:'panel'}),settings=q.submit(async()=>{running++;peak=Math.max(peak,running);order.push('settings');running--;},{kind:'settings'});
 assert.equal(q.status().waiting,3);held.release();await Promise.all([first,panel,settings,chat]);await q.idle();assert.deepEqual(order,['active','settings','panel','chat']);assert.equal(peak,1);assert.equal(q.status().total,0);
});
test('相同后台键只占一项，完成后同键可立即继续，不复用已完成的旧结果',async()=>{
 const q=new TaskQueue(()=>2),held=gate();let count=0;const first=q.submit(async()=>{count++;await held.promise;return 1;},{key:'emoji',kind:'background'});const same=q.submit(async()=>{count++;return 2;},{key:'emoji',kind:'background'});assert.equal(first,same);assert.equal(q.status().total,1);held.release();assert.equal(await first,1);
 assert.equal(await q.submit(async()=>{count++;return 3;},{key:'emoji',kind:'background'}),3);assert.equal(count,2);assert.equal(q.status().total,0);
});
test('等待中的请求取消立即腾出名额，后续释放队列也不会执行被取消的发送',async()=>{
 const q=new TaskQueue(()=>2),held=gate(),started=gate(),abort=new AbortController();let sends=0;const first=q.submit(async()=>{started.release();await held.promise;});await started.promise;
 const cancelled=q.submit(async()=>{sends++;},{signal:abort.signal});const rejected=assert.rejects(cancelled,/取消/);abort.abort(Error('取消等待中的发送'));await rejected;assert.equal(q.status().total,1);
 const fresh=q.submit(async()=>{sends++;});held.release();await Promise.all([first,fresh]);assert.equal(sends,1);assert.equal(q.status().total,0);
});
test('停止请求只协作取消，等旧任务收尾才释放串行锁，不重跑已经清理的工作',async()=>{
 const q=new TaskQueue(()=>3),started=gate(),finish=gate();let pendingRuns=0,aborted=false;
 const active=q.submit(async signal=>{started.release();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));await finish.promise;signal.throwIfAborted();});const rejected=assert.rejects(active,/停止/);await started.promise;
 const waiting=q.submit(async()=>{pendingRuns++;});const dropped=assert.rejects(waiting,/取消/);const result=q.cancel();await dropped;assert.equal(result.cleared,1);assert.equal(aborted,true);assert.equal(q.status().active?.cancelling,true);assert.equal(q.status().total,1);
 finish.release();await rejected;await q.idle();assert.equal(pendingRuns,0);await q.submit(async()=>{pendingRuns++;});assert.equal(pendingRuns,1);
});
test('日志抛错和任务抛出undefined也会释放队列；关闭会拒绝待办而不再执行',async()=>{
 const q=new TaskQueue(()=>3,()=>{throw Error('logger failed');});await assert.rejects(q.submit(async()=>{throw undefined;}));assert.equal(q.status().total,0);
 const held=gate(),started=gate(),first=q.submit(async signal=>{started.release();await held.promise;signal.throwIfAborted();});const failed=assert.rejects(first,/停止/);await started.promise;let ran=false;const waiting=q.submit(async()=>{ran=true;});const stopped=assert.rejects(waiting,/停止/);q.close();await stopped;held.release();await failed;await q.idle();assert.equal(ran,false);assert.throws(()=>q.submit(async()=>{}),/停止/);
});

test('保存也能中断长面板请求，已在应用的设置本身不会被停止按钮打断',async()=>{
 const q=new TaskQueue(()=>1),started=gate(),saving=gate(),finish=gate();
 const panel=q.submit(async signal=>{started.release();await new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},{kind:'panel'});const stopped=assert.rejects(panel,/更新/);await started.promise;
 const settings=q.submit(async signal=>{saving.release();await finish.promise;assert.equal(signal.aborted,false);return '已保存';},{kind:'settings'});q.interruptWork();await stopped;await saving.promise;q.cancel();assert.equal(q.status().active?.kind,'settings');assert.equal(q.status().active?.cancelling,false);finish.release();assert.equal(await settings,'已保存');assert.equal(q.status().total,0);
});
