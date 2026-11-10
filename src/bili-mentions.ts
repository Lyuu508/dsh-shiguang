import {claimPublicReply} from './bili-reply-state.js';
import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';
import type {BilibiliClient,BiliMention} from './bilibili.js';
import type {ChatDriver} from './agent.js';
import {repeatEvery,timeoutSignal,type ScheduledTimer} from './timeouts.js';
import {stateValue,setState} from './initiative.js';
import {publicTextAllowed} from './autonomy.js';
type Cursor={id:string;time:number};
const newer=(a:Cursor,b:Cursor)=>a.time>b.time||a.time===b.time&&BigInt(a.id)>BigInt(b.id);
export class BiliMentions {
 private timer?:ScheduledTimer;private pending=false;private stopped=false;private abort=new AbortController();private lastPoll=0;private lastError='';private message='开启后先建立通知边界，再接收主人新的评论 @';
 constructor(readonly settings:Settings,readonly memory:MemoryStore,readonly bili:BilibiliClient,readonly driver:ChatDriver,readonly queue:<T>(run:()=>Promise<T>)=>Promise<T>,readonly log:(message:string)=>void,readonly canAct=()=>true){}
 start(){if(!this.settings.biliSocial.mentionEnabled||!this.settings.bilibili.enabled)return;const tick=()=>this.requestPoll();this.timer=repeatEvery(tick,this.settings.biliSocial.pollSeconds*1000);this.timer.unref();tick();}
 stop(){this.stopped=true;this.abort.abort();this.timer?.clear();}
 requestPoll(){if(!this.pending&&!this.stopped){this.pending=true;void this.queue(async()=>{if(!this.stopped)await this.poll();}).catch(e=>{this.lastError=e instanceof Error?e.message:'评论 @ 检查未完成';this.log(this.lastError);}).finally(()=>this.pending=false);}return this.status();}
 status(){const c=this.settings.biliSocial,b=this.settings.bilibili;return {enabled:c.mentionEnabled,busy:this.pending,lastPoll:this.lastPoll,lastError:this.lastError,message:this.message,blockedReasons:[...(!c.mentionEnabled?['评论 @ 监听未开启']:[]),...(!b.enabled?['B站工具未开启']:[]),...(!c.ownerUids.length?['主人 UID 白名单为空']:[]),...(!this.bili.hasLogin()?['伙伴尚未登录 B站']:[]),...(!b.allowComments?['允许发表评论未开启，暂不接收评论任务']:[]),...(!this.canAct()?['生物钟处于睡眠']:[])],processed:Number(this.memory.db.prepare("SELECT count(*) AS n FROM bili_mention_receipts WHERE role=? AND status='sent'").get(this.memory.roleId)?.n),runs:this.memory.db.prepare('SELECT time,status,summary FROM bili_mention_receipts WHERE role=? ORDER BY time DESC LIMIT 8').all(this.memory.roleId)};}
 async poll(){
  const c=this.settings.biliSocial;if(this.stopped||this.status().blockedReasons.length)return this.status();
  const signal=AbortSignal.any([this.abort.signal,timeoutSignal(this.settings.replyTimeoutMs+this.settings.biliVision.timeoutMs*this.settings.autonomy.videosPerWake+this.settings.replyTimeoutMs*this.settings.biliVision.deepMaxSegments*this.settings.autonomy.videosPerWake+60000)]);
  const account=await this.bili.account(signal);if(!account.loggedIn)throw new Error('B站伙伴登录已过期，请重新扫码');this.lastPoll=this.memory.clock();this.lastError='';
  const state='bili:mention-cursor:'+account.userId,baseline=stateValue<Cursor|null>(this.memory,state,null),first=await this.bili.mentionsPage(undefined,signal);
  if(!baseline){setState(this.memory,state,{id:first.newest.time>=Math.floor(this.memory.clock()/1000)?first.newest.id:'0',time:Math.max(first.newest.time,Math.floor(this.memory.clock()/1000))});this.message='已建立评论 @ 边界，请主人在视频评论里重新 @ 伙伴；不会补发旧通知';return this.status();}
  let page=first,next=first.next,latest=baseline,complete=false;const notices=new Map<string,BiliMention>(),seenCursors=new Set<string>();
  for(let index=0;index<c.mentionMaxPages;index++){
   if(newer(page.newest,latest))latest=page.newest;for(const item of page.items)if(newer(item,baseline)&&item.uid!==account.userId&&c.ownerUids.includes(item.uid))notices.set(item.id,item);
   if(!next||page.oldestTime<baseline.time){complete=true;break;}if(index===c.mentionMaxPages-1)break;
   const key=next.id+':'+next.time;if(seenCursors.has(key))throw new Error('B站 @ 通知分页游标未前进，本次未推进边界');seenCursors.add(key);page=await this.bili.mentionsPage(next,signal);next=page.next;
  }
  if(!complete)throw new Error('新 @ 通知超过本轮页预算，请提高“评论 @ 每轮最多读取页数”后再检查');
  const ordered=[...notices.values()].sort((a,b)=>a.time-b.time||(BigInt(a.id)<BigInt(b.id)?-1:1));let all=true;
  for(const notice of ordered){
   signal.throwIfAborted();if(!this.canAct()){all=false;break;}if(this.memory.db.prepare('SELECT 1 FROM bili_mention_receipts WHERE role=? AND account=? AND notice_id=?').get(this.memory.roleId,account.userId,notice.id))continue;
   const quota=this.memory.actionQuota('bili-mention'),comments=this.memory.actionQuota('bili-comment'),now=this.memory.clock();if(quota.today>=c.mentionRepliesPerDay||quota.last!==null&&now-quota.last<c.mentionMinReplySeconds*1000||comments.today>=this.settings.bilibili.commentsPerDay||comments.last!==null&&now-comments.last<this.settings.bilibili.minCommentIntervalMs){this.message='等待评论回复间隔或今日额度，未推进这些任务的边界';all=false;break;}
   const claim=this.memory.db.prepare("INSERT OR IGNORE INTO bili_mention_receipts(role,account,notice_id,time,status) VALUES(?,?,?,?,'pending')").run(this.memory.roleId,account.userId,notice.id,this.memory.clock());if(!claim.changes)continue;
   const key='bili-mention:'+account.userId+':'+notice.id;let sent=false;
   try{
    this.message='正在核实原评论作者与真实 @，随后处理任务';const original=await this.bili.verifyMention(notice,account.userId,signal),video=await this.bili.video('av'+notice.aid,signal);
    if(!claimPublicReply(this.memory,account.userId,original.id)){this.memory.db.prepare("UPDATE bili_mention_receipts SET status='ignored',summary='同条评论已由评论回复入口处理' WHERE role=? AND account=? AND notice_id=?").run(this.memory.roleId,account.userId,notice.id);continue;}
    const thread=`bilibili:comment:${notice.aid}:${original.root}`,turnId=key;
    const reply=await this.driver.reply({scope:thread,thread,owner:true,public:true,allowPlatformTools:c.tasksEnabled,platform:'bilibili',text:original.text,externalKey:key,turnId,speakerId:notice.uid,speakerName:original.name,signal,taskContext:`这是主人在公开的视频评论区真实 @ 你。当前视频：${JSON.stringify({bvid:video.bvid,title:video.title,url:video.url})}。当前 root=${original.root}、parent=${original.id}。主人说“这个视频”指当前视频；明确要求读取视频内容时调用观看工具，完成后在本楼层自然回复。只使用当前评论区与公开视频资料，不能查询或转述私聊记忆。不要额外重复给本楼层发评论，最终回复由服务端发送。公开任务支持读取视频、浏览、点赞与在原楼层回复；另发评论或动态请让主人通过私信安排。`});
    signal.throwIfAborted();if(!this.canAct())throw new Error('已到睡眠时间，本轮评论不再发送');if(!reply||!publicTextAllowed(reply))throw new Error('没有可公开发送的回复，本次停止');
    this.memory.reserveAction('bili-mention',key,c.mentionRepliesPerDay,c.mentionMinReplySeconds*1000);
    const content=[...reply].slice(0,1000).join(''),result=await this.bili.comment(video.bvid,content,original.root,original.id,signal);sent=true;this.memory.settleAction(key,'sent',result.rpid);this.memory.recordReply(thread,'bilibili',thread,content,turnId,account.userId,this.settings.displayName);
    this.memory.append('owner','bilibili','bilibili','experience',`主人 ${original.name}（UID ${notice.uid}）在《${video.title}》@了伙伴。原话：${original.text.slice(0,260)}；伙伴实际回复：${content.slice(0,300)}；视频 ${video.url}；评论 ${result.url}`,key+':shared',this.memory.clock(),'comment-mention',{turnId:key,speakerId:notice.uid,speakerName:original.name});
    this.memory.db.prepare("UPDATE bili_mention_receipts SET status='sent',summary=? WHERE role=? AND account=? AND notice_id=?").run(`已在《${video.title}》回复主人 @；${result.url}`,this.memory.roleId,account.userId,notice.id);this.message='已完成评论任务并取得回复 ID';
   }catch(error){this.lastError=error instanceof Error?error.message:'评论任务未完成';if(!sent)this.memory.settleAction(key,'unknown','任务未完成，请核实已执行的操作');this.memory.db.prepare("UPDATE bili_mention_receipts SET status=?,summary=? WHERE role=? AND account=? AND notice_id=?").run(sent?'sent':'failed',this.lastError.slice(0,500),this.memory.roleId,account.userId,notice.id);this.log(this.lastError);signal.throwIfAborted();}
  }
  if(all)setState(this.memory,state,latest);return this.status();
 }
}
