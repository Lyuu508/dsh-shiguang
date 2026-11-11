import {saveEmojiSource,readEmojiSource} from './emoji-source.js';
import {QQActionError} from './onebot.js';
import {emojiMeaningScore,genericEmojiRequest,readEmojiMeaning} from './emoji-meaning.js';
import {createHash} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import type {Settings} from './config.js';
import {searchTokens,type MemoryStore} from './memory.js';
import type {OneBotClient,QQMessage} from './onebot.js';
import {stateValue,setState} from './initiative.js';
export function wantsEmoji(text:string){
 if(/(?:不要|别|不用|禁止).{0,12}(?:发|来|给)/.test(text))return false;
 const explicit=/(?:再发|也发|重新发|你也|你再|你给我|你发个|你发一|给我发)/.test(text);
 if(!explicit&&(/(?:看|识别|意思|含义|反应|内容)/.test(text)&&/(?:我|他|她|群友).{0,10}(?:发|给|送).{0,18}(?:表情|动图)/.test(text)||/(?:有没有发|是否发|发了没|发没发|为什么没发|刚才发过)/.test(text)))return false;
 return /(?:发|来|给).{0,18}(?:表情包|动画表情|动图|[个张].{0,4}表情)|(?:表情包|动画表情).{0,12}(?:发给|发来|发到|发去|送到|转发)/.test(text);
}
export class EmojiMatchError extends Error {}
export interface EmojiReceipt {messageId:string;summary:string;emojiId:string}
type Entry={digest:string;summary:string;file:string;emoji_id:string;account:string;scope:string};
export class EmojiSender {
 private abort=new AbortController();
 constructor(readonly settings:Settings,readonly memory:MemoryStore,readonly canAct=()=>true,readonly random=Math.random){}
 status(){const c=this.settings.emoji;return {meaningMatchEnabled:c.matchMeaning,collectEnabled:c.enabled,sendEnabled:c.sendEnabled,groupSendEnabled:c.sendAllowGroups,autoSend:c.autoSend,collectLimit:c.dailyLimit,sendLimit:c.sendsPerDay,library:Number(this.memory.db.prepare("SELECT count(*) AS n FROM emoji_collections WHERE role=? AND status='saved'").get(this.memory.roleId)?.n),sentToday:this.memory.actionQuota('qq-emoji-send').today,collectAttemptsToday:this.memory.actionQuota('qq-emoji').today,last:stateValue(this.memory,'emoji:status',{at:0,message:'可以同步 QQ 已收藏表情，或开启自动收藏后积累'} )};}
 private notice(message:string){setState(this.memory,'emoji:status',{at:this.memory.clock(),message});}
 async sync(qq:OneBotClient,signal:AbortSignal=this.abort.signal,count=this.settings.emoji.syncCount){
  signal=AbortSignal.any([this.abort.signal,signal]);signal.throwIfAborted();
  await qq.ready(signal);const account=await qq.check(signal);if(!account.online||!account.userId)throw new Error('请先登录 QQ，再同步收藏');
  const rows=await qq.action<unknown[]>('fetch_custom_face_detail',{count},signal);signal.throwIfAborted();if(!Array.isArray(rows))throw new Error('SnowLuma 未返回收藏表情列表，请检查桥接版本');let added=0;
  for(const item of rows){if(!item||typeof item!=='object')continue;const r=item as Record<string,unknown>,id=r.emoji_id??r.resId;if(typeof id!=='string'||!id.trim()||id.length>1024||/[\r\n\0]/.test(id))continue;
   const existing=this.memory.db.prepare("SELECT digest,scope FROM emoji_collections WHERE role=? AND account=? AND emoji_id=? AND status='saved'").get(this.memory.roleId,account.userId,id);
   const resource={account:account.userId,emojiId:id,url:typeof r.url==='string'?r.url:undefined,md5:typeof r.md5==='string'?r.md5:undefined};
   if(existing){saveEmojiSource(this.memory,String(existing.scope),String(existing.digest),resource);continue;}
   const digest=createHash('sha256').update(account.userId+':'+id).digest('hex'),summary=typeof r.desc==='string'&&r.desc.trim()?r.desc.trim().slice(0,300):'QQ 已收藏表情（没有文字备注）';
   this.memory.db.prepare("INSERT INTO emoji_collections(role,digest,day,time,status,summary,file,emoji_id,account,scope) VALUES(?,?,?,?,'saved',?,'',?,?,'owner') ON CONFLICT(role,digest) DO UPDATE SET emoji_id=excluded.emoji_id,account=excluded.account,summary=excluded.summary,status='saved'").run(this.memory.roleId,digest,this.memory.today(),this.memory.clock(),summary,id,account.userId);saveEmojiSource(this.memory,'owner',digest,resource);added++;
  }
  this.notice(`已检查 ${rows.length} 个 QQ 收藏，新增 ${added} 个；同步不会调用模型`);return this.status();
 }
 async send(message:QQMessage,qq:OneBotClient,query=message.text,explicit=true,signal?:AbortSignal,onConfirmed?:(receipt:EmojiReceipt)=>void){
  const c=this.settings.emoji;if(!explicit&&(!c.sendEnabled||message.groupId&&!c.sendAllowGroups||!c.autoSend||this.random()*100>=c.autoSendChance))return false;const joined=AbortSignal.any([this.abort.signal,...(signal?[signal]:[])]),guard=()=>{joined.throwIfAborted();if(!this.settings.qq.enabled||!c.sendEnabled||!this.canAct())throw new Error('QQ 表情发送未开启或当前处于睡眠');if(message.groupId&&!c.sendAllowGroups)throw new Error('群聊表情发送未开启');if(message.groupId&&!this.settings.qq.allowedGroups.includes(message.groupId))throw new Error('目标群尚未加入允许的群号');};guard();
  const quota=this.memory.actionQuota('qq-emoji-send');if(quota.today>=c.sendsPerDay||quota.last!==null&&this.memory.clock()-quota.last<c.sendMinGapSeconds*1000){if(explicit)throw new Error('已达到表情发送额度或尚未到发送间隔');return false;}
  await qq.ready(joined);const account=await qq.check(joined);guard();if(!account.online||!account.userId)throw new Error('QQ 账号尚未在线，表情没有发送');if(message.selfId!==account.userId)throw new Error('QQ 账号已变化，表情没有发送');
  const library=()=>this.memory.db.prepare("SELECT digest,summary,file,emoji_id,account,scope FROM emoji_collections WHERE role=? AND (scope=? OR (? AND scope='owner' AND account=? AND emoji_id<>'')) AND status='saved' AND (account='' OR account=?) ORDER BY time DESC").all(this.memory.roleId,message.scope,message.groupId&&c.sendAllowGroups?1:0,account.userId,account.userId) as unknown as Entry[];
  let rows=library();
  if(!rows.length&&explicit&&(message.owner||message.ownerMessage)){await this.sync(qq,joined);rows=library();}
  if(!rows.length){this.notice('当前会话还没有可用表情，请同步 QQ 收藏或先收藏表情');if(explicit)throw new Error('当前会话没有可用的收藏表情');return false;}
  const tokens=searchTokens(query),scores=new Map(rows.map(r=>[r.digest,c.matchMeaning?emojiMeaningScore(query,r.summary,readEmojiMeaning(this.memory,r.scope,r.digest)):tokens.reduce((n,t)=>n+(r.summary.toLowerCase().includes(t)?1:0),0)])),rank=(r:Entry)=>scores.get(r.digest)!;rows.sort((a,b)=>rank(b)-rank(a));const best=rank(rows[0]!);if(c.matchMeaning&&(!Number.isFinite(best)||best<=0&&(!explicit||!genericEmojiRequest(query)))){this.notice('没有匹配当前意思的表情，本次没有发送');if(explicit)throw new EmojiMatchError('我还没有合适表达这个意思的表情，先换一种吧。');return false;}const choices=rows.filter(r=>rank(r)===best),entry=choices[Math.floor(this.random()*choices.length)]!;
  let file:string|undefined;if(!entry.emoji_id||!entry.account){const root=await realpath(join(this.settings.dataDir,'emoji-collection')),target=await realpath(entry.file),rel=relative(root,target);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('本地表情不在拾光收藏目录中');const info=await stat(target);if(!info.isFile()||info.size>c.maxFileMB*1048576)throw new Error('表情文件超过发送大小预算');file='base64://'+(await readFile(target)).toString('base64');}
  guard();const current=await qq.check(joined);guard();if(!current.online||current.userId!==account.userId)throw new Error('QQ 账号已变化，表情没有发送');const key='qq-emoji-send:'+createHash('sha256').update(JSON.stringify([message.selfId,message.thread,message.id])).digest('hex');this.memory.reserveAction('qq-emoji-send',key,c.sendsPerDay,c.sendMinGapSeconds*1000);
  let confirmed=false;try{
   const destination=message.groupId?{group_id:message.groupId}:{user_id:message.userId},sendImage=(source:string)=>qq.action(message.groupId?'send_group_msg':'send_private_msg',{...destination,message:[{type:'image',data:{file:source,sub_type:1,summary:'[动画表情]'}}]},joined);
   let result;
   if(file)result=await sendImage(file);else try{result=await qq.action('send_custom_face',{emoji_id:entry.emoji_id,...destination},joined);}
   catch(error){
    // Only an explicit "unknown action" proves the native action did not run.
    // A timeout, disconnect, generic error or missing receipt must never resend.
    if(!(error instanceof QQActionError)||! /^(?:unknown action|unsupported action|action not found)$/i.test(error.wording.trim()))throw error;
    const source=readEmojiSource(this.memory,entry.scope,entry.digest);if(!source?.url||source.account!==account.userId)throw new Error('当前 SnowLuma 不支持原生收藏发送，且没有同账号的原图地址；请同步收藏后再试');
    guard();const same=await qq.check(joined);guard();if(!same.online||same.userId!==account.userId)throw new Error('QQ 账号已变化，表情没有发送');result=await sendImage(source.url);
   }
   if(!result||!/^\-?\d{1,24}$/.test(String(result.message_id??'')))throw new Error('QQ 没有返回表情消息 ID，请先核实，插件不会自动重发');confirmed=true;this.memory.settleAction(key,'sent',String(result.message_id));this.memory.recordReply(message.scope,'qq',message.thread,'[发送收藏表情] '+entry.summary,message.id,message.selfId,this.settings.displayName);this.notice('已发送真实表情，消息 ID '+result.message_id);onConfirmed?.({messageId:String(result.message_id),summary:entry.summary,emojiId:entry.emoji_id});return true;
  }catch(error){if(!confirmed)this.memory.settleAction(key,'unknown','表情发送结果待核实，不自动重发');this.notice(error instanceof Error?error.message:'表情未能发送');throw error;}
 }
 stop(){this.abort.abort();}
}
