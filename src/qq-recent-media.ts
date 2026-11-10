import {createHash} from 'node:crypto';
import type {QQMessage,QQMediaRef} from './onebot.js';
import type {MemoryStore} from './memory.js';
import {stateValue,setState} from './initiative-state.js';
export interface RecentQQMedia {at:number;selfId:string;scope:string;thread:string;userId:string;sourceMessageId?:string;media:QQMediaRef[]}
export function mediaFollowup(text:string){return !/(?:不要|不用|别).{0,8}(?:看|识别)/.test(text)&&!/(?:BV[0-9a-z]{10}|bilibili\.com|b23\.tv)/i.test(text)&&/(?:这(?:张|个|段).{0,8}(?:图|视频|表情|动图)|(?:图|视频|表情|动图).{0,12}(?:什么|意思|内容|干嘛|看不|看得|看到)|(?:刚才|刚刚|上面|上一条).{0,10}(?:图|视频|表情|动图)|^(?:你|帮我|请)?(?:看看|看一下|看下)(?:图|图片|视频|表情|动图)?[呀啊吧吗么?？!！。~\s]*$)/i.test(text);}
export class QQRecentMedia {
 constructor(readonly memory:MemoryStore){}
 private key(m:QQMessage){return 'qq:recent-media:'+createHash('sha256').update(JSON.stringify([m.selfId,m.scope,m.thread,m.userId])).digest('hex');}
 remember(m:QQMessage){if(!m.media?.length)return;setState(this.memory,this.key(m),{at:this.memory.clock(),selfId:m.selfId,scope:m.scope,thread:m.thread,userId:m.userId,sourceMessageId:m.sourceMessageId,media:m.media.slice(0,4)} satisfies RecentQQMedia);}
 followup(m:QQMessage){if(m.media?.length||m.replyId||!mediaFollowup(m.text))return;const saved=stateValue<RecentQQMedia|null>(this.memory,this.key(m),null),age=saved?this.memory.clock()-saved.at:Infinity;return saved&&age>=0&&age<=30*60000&&saved.selfId===m.selfId&&saved.scope===m.scope&&saved.thread===m.thread&&saved.userId===m.userId?saved:undefined;}
}
