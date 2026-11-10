import {createHash} from 'node:crypto';
import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';
import {stateValue,setState} from './initiative-state.js';

export const MOTIVES={company:'陪伴',care:'关心',share:'分享',play:'玩耍',chat:'想聊天'};
export type Motive=keyof typeof MOTIVES;
export interface Relationship {affection:number;motives:Record<Motive,number>;lastReason:string;updatedAt:number;changes:{at:number;kind:string;delta:number;reason:string}[]}
const key=(s:Settings)=>'relationship:'+createHash('sha256').update(s.qq.ownerQQ||[...s.biliSocial.ownerUids].sort().join(',')||'unbound').digest('hex');
const initial=():Relationship=>({affection:30,motives:{company:30,care:30,share:30,play:30,chat:30},lastReason:'从相识开始，等待真实互动与自己的选择',updatedAt:0,changes:[]});
export function relationship(memory:MemoryStore,settings:Settings):Relationship{return stateValue(memory,key(settings),initial());}
export function isMotive(value:unknown):value is Motive{return typeof value==='string'&&Object.hasOwn(MOTIVES,value);}
function change(memory:MemoryStore,s:Settings,event:string,kind:'affection'|Motive,delta:number,reason:string){
 const claim='relationship:event:'+createHash('sha256').update(key(s)+':'+event+':'+kind).digest('hex');
 const saved=memory.db.prepare('INSERT OR IGNORE INTO scheduler_state(role,name,value) VALUES(?,?,?)').run(memory.roleId,claim,JSON.stringify({at:memory.clock()}));if(!saved.changes)return;
 const state=relationship(memory,s),at=memory.clock(),safe=reason.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,160);
 if(kind==='affection')state.affection=Math.min(Number.MAX_SAFE_INTEGER,state.affection+delta);else state.motives[kind]=Math.min(Number.MAX_SAFE_INTEGER,state.motives[kind]+delta);
 state.updatedAt=at;state.lastReason=safe;state.changes=[{at,kind:kind==='affection'?'好感度':MOTIVES[kind],delta,reason:safe},...state.changes].slice(0,16);setState(memory,key(s),state);
}
/** Only call after a real reply receipt, once per owner turn. No model call. */
export function ownerInteraction(memory:MemoryStore,s:Settings,event:string,text:string){
 change(memory,s,event,'affection',1,'和主人完成了一轮交流');
 const motive:Motive=/烦恼|难过|担心|不开心|累了|难受|压力|委屈|失眠/.test(text)?'care':/陪我|陪陪|抱抱|想你|在吗|孤单/.test(text)?'company':/一起玩|打游戏|玩一|开黑|猜谜|讲笑话/.test(text)?'play':/今天|刚才|分享|日常|遇到|出门|吃了|上班|下班|学校/.test(text)?'share':'chat';
 change(memory,s,event,motive,1,'刚和主人聊了'+MOTIVES[motive]+'相关的事');
}
export function wantedContact(memory:MemoryStore,s:Settings,event:string,motive:Motive,reason:string){change(memory,s,event,motive,2,reason);}
export function relationshipPrompt(memory:MemoryStore,s:Settings){const v=relationship(memory,s);return `你与绑定主人的持续关系状态：好感度 ${v.affection}；目前愿望 ${JSON.stringify(v.motives)}（company陪伴、care关心、share分享、play玩耍、chat聊天）。各项最初30，随实际交流和自己的联系意愿积累，不是主人手动分配的抽签权重。最近变化：${v.lastReason}。这只是交流背景，不要报数、演示规则或要求主人维持数值。可以互相分享真实日常、担心和烦恼，先听再自然回应；不编造现实经历，不夸大依赖，不用关系分数索取回复，也不改变任何权限。`;}
