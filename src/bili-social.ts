import {repeatEvery,type ScheduledTimer,timeoutSignal} from './timeouts.js';
import {randomUUID} from 'node:crypto';
import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';
import type {BilibiliClient} from './bilibili.js';
import type {ChatDriver} from './agent.js';

export class BiliSocial {
  private timer?:ScheduledTimer;private pending=false;private stopped=false;private abort=new AbortController();
  private lastPoll=0;private lastError='';
  constructor(readonly settings:Settings,readonly memory:MemoryStore,readonly bili:BilibiliClient,readonly driver:ChatDriver,readonly queue:<T>(run:()=>Promise<T>)=>Promise<T>,readonly log:(message:string)=>void,readonly canAct=()=>true){}
  start(){if(!this.settings.biliSocial.dmEnabled||!this.settings.bilibili.enabled)return;const schedule=()=>{if(this.pending||this.stopped)return;this.pending=true;void this.queue(()=>this.poll()).catch(e=>{this.lastError=e instanceof Error?e.message:'B 站私信未完成';this.log(this.lastError);}).finally(()=>{this.pending=false;});};this.timer=repeatEvery(schedule,this.settings.biliSocial.pollSeconds*1000);this.timer.unref();schedule();}
  stop(){this.stopped=true;this.abort.abort();this.timer?.clear();}
  requestPoll(){if(!this.pending&&!this.stopped){this.pending=true;void this.queue(()=>this.poll()).catch(e=>{this.lastError=e instanceof Error?e.message:'私信检查未完成';this.log(this.lastError);}).finally(()=>{this.pending=false;});}return this.status();}
  status(){return {busy:this.pending,enabled:this.settings.biliSocial.dmEnabled,lastPoll:this.lastPoll,lastError:this.lastError,processed:Number(this.memory.db.prepare('SELECT count(*) AS n FROM bili_dm_receipts WHERE role=?').get(this.memory.roleId)?.n)};}
  private cursor(account:string,uid:string,seq:string){this.memory.db.prepare('INSERT OR REPLACE INTO bili_dm_cursor(role,account,uid,seq) VALUES(?,?,?,?)').run(this.memory.roleId,account,uid,seq);}
  async poll(){
    const c=this.settings.biliSocial;if(!this.canAct()||this.stopped||!c.dmEnabled||!this.settings.bilibili.enabled||!c.ownerUids.length||!this.bili.hasLogin())return this.status();
    const signal=AbortSignal.any([this.abort.signal,timeoutSignal(Math.max(60000,this.settings.replyTimeoutMs+30000))]),account=await this.bili.account(signal);if(!account.loggedIn)throw new Error('B 站私信登录已过期，请重新扫码');
    this.lastPoll=this.memory.clock();this.lastError='';
    for(const uid of c.ownerUids){
      signal.throwIfAborted();if(uid===account.userId)continue;
      const saved=this.memory.db.prepare('SELECT seq FROM bili_dm_cursor WHERE role=? AND account=? AND uid=?').get(this.memory.roleId,account.userId,uid),after=saved?String(saved.seq):undefined;
      const batch=await this.bili.directMessages(uid,after,signal);if(after===undefined){this.cursor(account.userId,uid,batch.seq);continue;}
      let all=true;
      for(const message of batch.messages){
        const quota=this.memory.actionQuota('bili-dm');if(quota.today>=c.repliesPerDay||quota.last!==null&&this.memory.clock()-quota.last<c.minReplySeconds*1000){all=false;break;}
        const claim=this.memory.db.prepare("INSERT OR IGNORE INTO bili_dm_receipts(role,account,uid,seq,status) VALUES(?,?,?,?,'pending')").run(this.memory.roleId,account.userId,uid,message.seq);this.cursor(account.userId,uid,message.seq);if(!claim.changes)continue;
        const id=randomUUID(),thread=`bilibili:dm:${account.userId}:${uid}`;this.memory.db.prepare("INSERT INTO initiative_runs(id,role,day,time,kind,status) VALUES(?,?,?,?,?,'pending')").run(id,this.memory.roleId,this.memory.today(),this.memory.clock(),'bili-dm');
        try{
          const reply=await this.driver.reply({scope:'owner',thread,owner:true,platform:'bilibili',text:message.text,externalKey:`bili-dm:${account.userId}:${uid}:${message.seq}`});signal.throwIfAborted();
          if(!this.canAct())throw new Error('已到睡眠时间，本次私信不发送');
          if(!reply)throw new Error('该私信已处理');
          const content=[...reply].slice(0,500).join(''),receipt=await this.bili.sendDirect(uid,content,`${account.userId}:${uid}:${message.seq}`,signal);
          this.memory.append('owner','bilibili',thread,'assistant',content);
          this.memory.db.prepare("UPDATE bili_dm_receipts SET status='sent' WHERE role=? AND account=? AND uid=? AND seq=?").run(this.memory.roleId,account.userId,uid,message.seq);
          this.memory.db.prepare("UPDATE initiative_runs SET status='done',summary=? WHERE id=?").run(`已回复主人 UID ${uid}；消息 ID ${receipt}`,id);
        }catch(error){this.lastError=error instanceof Error?error.message:'私信处理未完成';this.memory.db.prepare("UPDATE bili_dm_receipts SET status='failed' WHERE role=? AND account=? AND uid=? AND seq=?").run(this.memory.roleId,account.userId,uid,message.seq);this.memory.db.prepare("UPDATE initiative_runs SET status='failed',summary=? WHERE id=?").run(this.lastError.slice(0,500),id);this.log(this.lastError);signal.throwIfAborted();}
      }
      if(all)this.cursor(account.userId,uid,batch.seq);
    }
    return this.status();
  }
}
