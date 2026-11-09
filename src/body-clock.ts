import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';
import type {QQMessage} from './onebot.js';
import {quietAt,stateValue,setState} from './initiative-state.js';

export class BodyClock {
 private timer?:NodeJS.Timeout;
 start(){if(!this.settings.clock.enabled)return;this.tick();this.timer=setInterval(()=>this.tick(),30000);this.timer.unref();}
 stop(){if(this.timer)clearInterval(this.timer);}
 tick(){const sleeping=this.status().sleeping,previous=stateValue<boolean|null>(this.memory,'body:sleeping',null);if(previous!==sleeping){setState(this.memory,'body:sleeping',sleeping);this.memory.append('owner','dsh','dsh:body-clock','activity',sleeping?'生物钟：进入睡眠，暂停自主浏览和主动联系':'生物钟：已起床，恢复正常活动',undefined,this.memory.clock(),'sleep');}}
 constructor(readonly settings:Settings,readonly memory:MemoryStore,readonly random=Math.random){}
 status(){return bodyClockStatus(this.settings,this.memory);}
 canAct(){return !this.status().sleeping;}
 receive(message:QQMessage):boolean{
  const state=this.status();if(!state.sleeping)return true;
  const c=this.settings.clock,now=this.memory.clock(),last=stateValue<number>(this.memory,'body:last-wake',0);
  if(last>0&&now-last<c.minWakeGapMinutes*60000)return false;
  const keyword=!!message.keywordAwakened;if(message.poke?!c.wakeOnPoke||this.random()*100>=c.wakeChance:keyword?!c.wakeOnKeyword:!message.mentioned||!c.wakeOnMention||this.random()*100>=c.wakeChance)return false;
  setState(this.memory,'body:last-wake',now);setState(this.memory,'body:awake-until',now+c.awakeMinutes*60000);
  this.memory.append(message.scope,'qq',message.thread,'activity',`睡眠期间被 ${message.userId} ${message.poke?'头像互动':keyword?'关键词“'+message.keyword+'”':'@'} 唤醒，临时清醒 ${c.awakeMinutes} 分钟`,undefined,now,'sleep');return true;
 }
}

export function localClockTime(now:number,timezone:string){return new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(now);}
export function bodyClockStatus(settings:Settings,memory:MemoryStore){const c=settings.clock,now=memory.clock(),night=c.enabled&&quietAt(now,settings.timezone,c.sleepAt,c.wakeAt),awakeUntil=stateValue<number>(memory,'body:awake-until',0);return {enabled:c.enabled,sleeping:night&&now>=awakeUntil,night,awakeUntil,wakeAt:c.wakeAt,sleepAt:c.sleepAt,now,localTime:localClockTime(now,settings.timezone)};}
