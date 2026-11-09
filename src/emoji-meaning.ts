import type {MemoryStore} from './memory.js';
import {searchTokens} from './memory.js';
import {stateValue,setState} from './initiative-state.js';

export interface EmojiMeaning {meaning:string;emotions:string[];situations:string[];avoid:string[]}
export interface SavedEmojiMeaning extends EmojiMeaning {source:'vision'|'collector'|'manual';updatedAt:number}
const key=(scope:string,digest:string)=>'emoji:meaning:'+JSON.stringify([scope,digest]);
export function parseEmojiMeaning(value:unknown):EmojiMeaning|undefined {
 if(!value||typeof value!=='object')return;const v=value as Record<string,unknown>;
 if(typeof v.meaning!=='string'||!v.meaning.trim()||v.meaning.length>300)return;
 const result:EmojiMeaning={meaning:v.meaning.trim(),emotions:[],situations:[],avoid:[]};
 for(const name of ['emotions','situations','avoid'] as const){const list=v[name]??[];if(!Array.isArray(list)||list.length>12||list.some(x=>typeof x!=='string'||!x.trim()||x.length>80))return;result[name]=[...new Set(list.map(x=>String(x).trim()))];}return result;
}
export function readEmojiMeaning(memory:MemoryStore,scope:string,digest:string){const value=stateValue<SavedEmojiMeaning|undefined>(memory,key(scope,digest),undefined);return value&&parseEmojiMeaning(value)?value:undefined;}
export function saveEmojiMeaning(memory:MemoryStore,scope:string,digest:string,value:EmojiMeaning,source:SavedEmojiMeaning['source']){
 const parsed=parseEmojiMeaning(value);if(!parsed)throw new Error('请填写表情含义，情绪与场景使用简短文字');
 const previous=readEmojiMeaning(memory,scope,digest);if(previous?.source==='manual'&&source!=='manual')return previous;
 const result={...parsed,source,updatedAt:memory.clock()};setState(memory,key(scope,digest),result);return result;
}
export function clearEmojiMeaning(memory:MemoryStore,scope:string,digest:string){memory.db.prepare('DELETE FROM scheduler_state WHERE role=? AND name=?').run(memory.roleId,key(scope,digest));}
export function listEmojiMeanings(memory:MemoryStore,limit:number){return memory.db.prepare("SELECT digest,scope,summary FROM emoji_collections WHERE role=? AND status='saved' ORDER BY time DESC LIMIT ?").all(memory.roleId,limit).map(row=>({digest:String(row.digest),scope:String(row.scope),summary:String(row.summary),semantic:readEmojiMeaning(memory,String(row.scope),String(row.digest))}));}
export const emojiMeaningPrompt='还要区分客观画面与表情的交流含义：结合动作、文字和上下文判断表达的情绪、梗意与适用场景，不把画面中的攻击直接当成真实愤怒。看不清或含义不明时 emoji 为 null，不猜梗典故。若可确认，emoji 为 {"meaning":"这张表情想表达什么","emotions":["例如调皮、委屈、安慰"],"situations":["适合怎样接话"],"avoid":["明确不适合的情境，没有可留空"]}。';

const moods:Record<string,string[]>={
 开心:['开心','高兴','快乐','哈哈','笑死','好耶','真棒','庆祝','恭喜','祝贺'],
 委屈:['委屈','难过','伤心','悲伤','不开心','不高兴','哭','呜呜','可怜','qaq','qwq'],
 安慰:['安慰','抱抱','摸摸','别难过','不哭','心疼','鼓励','加油'],
 生气:['生气','愤怒','红温','气死','恼火','炸毛'],
 调皮:['调皮','俏皮','捣蛋','坏笑','逗你','丢雪球','扔雪球','捉弄','打雪仗'],
 撒娇:['撒娇','蹭蹭','讨抱','求求','拜托','贴贴','想你'],
 无语:['无语','汗颜','尴尬','扶额','沉默','绷不住'],
 拒绝:['拒绝','不行','抗拒','达咩','不要这样'],
 问候:['你好','早安','晚安','再见','拜拜','打招呼'],
 感谢:['谢谢','感谢','谢啦','感激'],
 疑惑:['疑惑','问号','不懂','啥意思','为什么','看不懂'],
};
function emotions(value:string){const text=value.normalize('NFKC').toLowerCase();return Object.entries(moods).filter(([,aliases])=>aliases.some(alias=>{let start=text.indexOf(alias);while(start>=0){if(!/(?:不是|不要|别|不想|不需要|不许|没有|不)\s*$/.test(text.slice(Math.max(0,start-6),start)))return true;start=text.indexOf(alias,start+alias.length);}return false;})).map(([name])=>name);}
function queryWords(query:string){return query.replace(/表情包|动画表情|表情|动图|主人|随便|随机|任意|看看|对应|那种|一[个张]|[发来给我的你个张吧呀啊呢]/g,' ').trim();}
export function genericEmojiRequest(query:string){return !queryWords(query).replace(/\s|[，。！!？?]/g,'');}
/** Local matching only. A specific emotion never falls back to an unrelated face. */
export function emojiMeaningScore(query:string,summary:string,semantic?:EmojiMeaning){
 let desired=emotions(query);if(desired.includes('安慰'))desired=['安慰'];
 const known=emotions(semantic?.emotions.length?semantic.emotions.join(' '):[semantic?.meaning,semantic?.situations.join(' '),summary].join(' '));
 const overlap=desired.filter(m=>known.includes(m)).length;
 if(desired.length&&!overlap)return -Infinity;
 if(semantic?.avoid.length&&emotions(semantic.avoid.join(' ')).some(m=>desired.includes(m)))return -Infinity;
 const text=[summary,semantic?.meaning,semantic?.emotions.join(' '),semantic?.situations.join(' ')].join(' ').normalize('NFKC').toLowerCase(),tokens=searchTokens(queryWords(query));
 return overlap*100+tokens.reduce((n,t)=>n+(text.includes(t)?1:0),0);
}
