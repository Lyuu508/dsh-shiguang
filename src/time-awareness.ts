import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';
import {bodyClockStatus} from './body-clock.js';
/** Generated locally for every request, independent of old conversation dates. */
export function clockContext(settings:Settings,memory:MemoryStore){
 const state=bodyClockStatus(settings,memory),zone=settings.timezone;
 const offset=new Intl.DateTimeFormat('en',{timeZone:zone,timeZoneName:'longOffset'}).formatToParts(state.now).find(p=>p.type==='timeZoneName')?.value||zone;
 const weekday=new Intl.DateTimeFormat('zh-CN',{timeZone:zone,weekday:'long'}).format(state.now);
 const clock=state.enabled?`伙伴作息：${state.wakeAt} 起床，${state.sleepAt} 入睡；现在${state.sleeping?'在睡眠时段':state.night?'被叫醒，暂时清醒':'已起床，正常清醒'}。`:'伙伴生物钟未开启。';
 return `当前真实时间：${state.localTime} ${weekday}（${zone}，${offset}）。${clock}这是本轮生成时的当前时间，旧记录的时间只表示当时。问几点可直接按这个时间回答；平时无需例行报时。按当前时段自然聊天，不把凌晨的上下文延续成白天仍是深夜；伙伴作息不代表对方的睡眠，不仅凭早上发消息就认定对方还没睡。`;
}
