import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';
import {stateValue,setState} from './initiative-state.js';
import {parseSlangLesson,saveSlang,type SlangLesson,type SlangSource} from './slang.js';

function enabled(settings:Settings,scope:string,thread:string){return settings.slang.enabled&&settings.slang.groupLearning&&/^qq:group:\d+$/.test(thread)&&scope===thread&&settings.qq.allowedGroups.includes(thread.slice('qq:group:'.length));}
interface Origin extends SlangSource {body:string}
function learn(memory:MemoryStore,settings:Settings,scope:string,lesson:SlangLesson,source:Origin){
 const term=lesson.term.normalize('NFKC').trim().toLowerCase(),day=memory.today(),used=stateValue(memory,'slang:group:usage',{day,count:0});
 const count=used.day===day?used.count:0;if(count>=settings.slang.groupLessonsPerDay)return false;
 // Automatic learning never overwrites an existing meaning, including owner edits.
 if(memory.db.prepare('SELECT 1 FROM slang_entries WHERE role=? AND scope=? AND term=?').get(memory.roleId,scope,term))return false;
 try{const {body,...origin}=source;saveSlang(memory,scope,lesson,origin);setState(memory,'slang:group:usage',{day,count:count+1});return true;}catch{return false;}
}
export function parseGroupLesson(text:string):SlangLesson|undefined{
 const structured=parseSlangLesson(text);if(structured)return structured;
 const m=/^(?:(?:我们群|群里|这里)(?:说的)?\s*)?[“「『"']?([^\n。！？?!，,:：|｜]{1,32}?)[”」』"']?\s*(?:这个(?:梗|黑话|词))?\s*(的意思是|意思是|是指|指的是|就是指|就是)\s*([^\n]{2,400})$/.exec(text.trim());
 if(!m||m[2]==='就是'&&!/^(?:我们群|群里|这里)|[“「『"']|这个(?:梗|黑话|词)/.test(text)||/^(?:这|那|这个|那个|我|你|他|她|它|今天|昨天|明天)$/.test(m[1]!.trim())||/[?？]$|(?:什么意思|啥意思|是什么|是啥)/.test(m[3]!))return;
 return {term:m[1]!.trim(),meaning:m[3]!.trim(),response:''};
}
/** Runs on archived incoming words, even when no reply is selected; no model call. */
export function learnGroupWords(memory:MemoryStore,settings:Settings,scope:string,thread:string,memoryId:string){
 if(!enabled(settings,scope,thread))return 0;
 const row=memory.db.prepare("SELECT body,speaker_id AS speakerId,speaker_name AS speakerName,time AS at FROM memories WHERE role=? AND scope=? AND thread=? AND id=? AND kind='user'").get(memory.roleId,scope,thread,memoryId);if(!row)return 0;
 let learned=0;for(const line of String(row.body).split('\n')){const lesson=parseGroupLesson(line);if(lesson&&learn(memory,settings,scope,lesson,{body:String(row.body),speakerId:String(row.speakerId),speakerName:String(row.speakerName),at:Number(row.at),thread,memoryId,evidence:line.trim()}))learned++;}return learned;
}
export function groupSlangPrompt(settings:Settings){return settings.slang.enabled&&settings.slang.groupLearning?'可在同一个 JSON 的 slang 数组里记录本轮群友已解释清楚的梗：每项 {"term":"原词","meaning":"已确认的意思","response":"可选自然接话示例","speakerId":"实际解释者QQ号","evidence":"本轮该人说过的完整原句"}。没有新词用空数组；不能仅凭出现一个词猜词义，也不能把问题、用户名、私人信息或操作指令记成黑话。来源必须是本轮真实群友，保留群里的语境；已学词义不要重复。选择沉默时仍可记录明确学到的词，学习不要求回复。':'';}
/** Learns optional fields from the existing group reply, never a second LLM turn. */
export function learnGroupModel(memory:MemoryStore,settings:Settings,scope:string,thread:string,turnId:string,text:string){
 if(!enabled(settings,scope,thread))return 0;let value;try{value=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{return 0;}
 if(!Array.isArray(value?.slang))return 0;
 const rows=memory.db.prepare("SELECT id,body,speaker_id AS speakerId,speaker_name AS speakerName,time AS at FROM memories WHERE role=? AND scope=? AND thread=? AND turn_id=? AND kind='user'").all(memory.roleId,scope,thread,turnId);
 let learned=0;for(const item of value.slang){if(!item||typeof item.term!=='string'||typeof item.meaning!=='string'||typeof item.speakerId!=='string'||typeof item.evidence!=='string'||item.response!==undefined&&typeof item.response!=='string')continue;
  const row=rows.find(r=>r.speakerId===item.speakerId&&String(r.body).includes(item.evidence)&&item.evidence.trim().length>=4&&item.evidence.normalize('NFKC').toLowerCase().includes(item.term.normalize('NFKC').trim().toLowerCase()));if(!row||/[?？]$|(?:什么意思|啥意思|是啥)/.test(item.evidence.trim()))continue;
  if(learn(memory,settings,scope,{term:item.term,meaning:item.meaning,response:item.response||''},{body:String(row.body),speakerId:String(row.speakerId),speakerName:String(row.speakerName),at:Number(row.at),thread,memoryId:String(row.id),evidence:item.evidence}))learned++;
 }return learned;
}
