import {repeatEvery,type ScheduledTimer,timeoutSignal} from './timeouts.js';
import {randomUUID} from 'node:crypto';
import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';
import type {BilibiliClient} from './bilibili.js';
import type {ChatDriver} from './agent.js';

export class BiliSocial {
  private timer?:ScheduledTimer;private pending=false;private stopped=false;private abort=new AbortController();
  private lastMessage='开启后先建立边界，再处理新私信';private lastPoll=0;private lastError='';
  constructor(readonly settings:Settings,readonly memory:MemoryStore,readonly bili:BilibiliClient,readonly driver:ChatDriver,readonly queue:<T>(run:()=>Promise<T>)=>Promise<T>,readonly log:(message:string)=>void,readonly canAct=()=>true){}
  start(){if(!this.settings.biliSocial.dmEnabled||!this.settings.bilibili.enabled)return;const schedule=()=>{if(this.pending||this.stopped)return;this.pending=true;void this.queue(async()=>{if(!this.stopped)await this.poll();}).catch(e=>{this.lastError=e instanceof Error?e.message:'B 站私信未完成';this.log(this.lastError);}).finally(()=>{this.pending=false;});};this.timer=repeatEvery(schedule,this.settings.biliSocial.pollSeconds*1000);this.timer.unref();schedule();}
  stop(){this.stopped=true;this.abort.abort();this.timer?.clear();}
  requestPoll(){if(!this.pending&&!this.stopped){this.pending=true;void this.queue(async()=>{if(!this.stopped)await this.poll();}).catch(e=>{this.lastError=e instanceof Error?e.message:'私信检查未完成';this.log(this.lastError);}).finally(()=>{this.pending=false;});}return this.status();}
  status(){return {message:this.lastMessage,blockedReasons:[...(!this.settings.biliSocial.dmEnabled?['主人私信回复未开启']:[]),...(!this.settings.bilibili.enabled?['B站工具未开启']:[]),...(!this.settings.biliSocial.ownerUids.length?['主人 UID 白名单为空']:[]),...(!this.bili.hasLogin()?['伙伴尚未登录 B站']:[]),...(!this.canAct()?['生物钟处于睡眠']:[])],tasksEnabled:this.settings.biliSocial.tasksEnabled,busy:this.pending,enabled:this.settings.biliSocial.dmEnabled,lastPoll:this.lastPoll,lastError:this.lastError,processed:Number(this.memory.db.prepare('SELECT count(*) AS n FROM bili_dm_receipts WHERE role=?').get(this.memory.roleId)?.n)};}
  private cursor(account:string,uid:string,seq:string){this.memory.db.prepare('INSERT OR REPLACE INTO bili_dm_cursor(role,account,uid,seq) VALUES(?,?,?,?)').run(this.memory.roleId,account,uid,seq);}
  async poll(){
    const c=this.settings.biliSocial;if(!this.canAct()||this.stopped||!c.dmEnabled||!this.settings.bilibili.enabled||!c.ownerUids.length||!this.bili.hasLogin())return this.status();
    const signal=AbortSignal.any([this.abort.signal,timeoutSignal(Math.max(60000,this.settings.replyTimeoutMs+30000+(c.tasksEnabled?this.settings.biliVision.timeoutMs*this.settings.autonomy.videosPerWake+this.settings.replyTimeoutMs*this.settings.biliVision.deepMaxSegments*this.settings.autonomy.videosPerWake:0)))]),account=await this.bili.account(signal);if(!account.loggedIn)throw new Error('B 站私信登录已过期，请重新扫码');
    this.lastPoll=this.memory.clock();this.lastError='';
    for(const uid of c.ownerUids){
      signal.throwIfAborted();if(uid===account.userId)continue;
      const saved=this.memory.db.prepare('SELECT seq FROM bili_dm_cursor WHERE role=? AND account=? AND uid=?').get(this.memory.roleId,account.userId,uid),after=saved?String(saved.seq):undefined;
      const batch=await this.bili.directMessages(uid,after,signal);if(after===undefined){this.cursor(account.userId,uid,batch.seq);this.lastMessage='已建立私信边界，请主人再发一条新消息；不会补发旧对话';continue;}
      let all=true;
      for(const message of batch.messages){
        const quota=this.memory.actionQuota('bili-dm');if(quota.today>=c.repliesPerDay||quota.last!==null&&this.memory.clock()-quota.last<c.minReplySeconds*1000){all=false;break;}
        this.lastMessage='收到主人新私信，正在理解或执行任务';const claim=this.memory.db.prepare("INSERT OR IGNORE INTO bili_dm_receipts(role,account,uid,seq,status) VALUES(?,?,?,?,'pending')").run(this.memory.roleId,account.userId,uid,message.seq);this.cursor(account.userId,uid,message.seq);if(!claim.changes)continue;
        const id=randomUUID(),thread=`bilibili:dm:${account.userId}:${uid}`;this.memory.db.prepare("INSERT INTO initiative_runs(id,role,day,time,kind,status) VALUES(?,?,?,?,?,'pending')").run(id,this.memory.roleId,this.memory.today(),this.memory.clock(),'bili-dm');
        try{
          const reply=await this.driver.reply({scope:'owner',thread,owner:true,platform:'bilibili',text:message.text,externalKey:`bili-dm:${account.userId}:${uid}:${message.seq}`,turnId:`bili-dm:${account.userId}:${uid}:${message.seq}`,speakerId:uid,speakerName:`主人 UID ${uid}`,signal,allowPlatformTools:c.tasksEnabled});signal.throwIfAborted();
          if(!this.canAct())throw new Error('已到睡眠时间，本次私信不发送');
          if(!reply)throw new Error('该私信已处理');
          const content=[...reply].slice(0,500).join(''),receipt=await this.bili.sendDirect(uid,content,`${account.userId}:${uid}:${message.seq}`,signal);
          this.lastMessage='已完成本轮私信处理并取得回复回执';this.memory.recordReply('owner','bilibili',thread,content,`bili-dm:${account.userId}:${uid}:${message.seq}`,account.userId,this.settings.displayName);
          this.memory.db.prepare("UPDATE bili_dm_receipts SET status='sent' WHERE role=? AND account=? AND uid=? AND seq=?").run(this.memory.roleId,account.userId,uid,message.seq);
          this.memory.db.prepare("UPDATE initiative_runs SET status='done',summary=? WHERE id=?").run(`已回复主人 UID ${uid}；消息 ID ${receipt}`,id);
        }catch(error){this.lastError=error instanceof Error?error.message:'私信处理未完成';this.memory.db.prepare("UPDATE bili_dm_receipts SET status='failed' WHERE role=? AND account=? AND uid=? AND seq=?").run(this.memory.roleId,account.userId,uid,message.seq);this.memory.db.prepare("UPDATE initiative_runs SET status='failed',summary=? WHERE id=?").run(this.lastError.slice(0,500),id);this.log(this.lastError);signal.throwIfAborted();}
      }
      if(all)this.cursor(account.userId,uid,batch.seq);
    }
    return this.status();
  }
}
