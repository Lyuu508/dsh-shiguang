import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';
function privateRecallRequested(text:string){
  if(!/(?:私聊|私信|单聊|单独.{0,6}(?:聊|说))/.test(text)||/(?:不要|别|不用|禁止|不许).{0,12}(?:提|说|聊|公开|看|查|读|翻|记|引用|回忆)/.test(text))return false;
  return /(?:吗|什么|啥|谁|哪|[？?])/.test(text)||/(?:^|[，。！？!?\s]|你)(?:还?记得|记不记得)/.test(text)||/(?:查(?:查|一下|看)?|回忆|回想|翻|找|复述|告诉我|说说|看看|看下).{0,36}(?:私聊|私信|单聊|单独)/.test(text);
}

// Callers derive owner/scope from authenticated platform identities, never from
// message text or model tool arguments. Public recall requires an explicit
// saved opt-in AND a request from the authenticated owner in this batch.
export function memoryAccess(settings:Settings,memory:MemoryStore,input:{scope:string;thread:string;owner:boolean;text:string;speakerId?:string;ownerRecallText?:string;participants?:{id:string}[];platform?:string}){
  const group=input.thread.startsWith('qq:group:')||input.thread.startsWith('bilibili:comment:');
  const shared=!group&&(input.owner||!settings.memory.ownerOnlyCrossChat);
  const recallText=input.ownerRecallText??((!input.participants||input.participants.length<=1)?input.text:'');
  const groupRecall=!!settings.memory.allowOwnerGroupRecall&&input.platform==='qq'&&input.thread.startsWith('qq:group:')&&settings.qq.allowedGroups.includes(input.thread.slice(9))&&input.speakerId===settings.qq.ownerQQ&&privateRecallRequested(recallText);
  const scopes=shared?[...new Set([input.scope,...memory.availableScopes()])]:groupRecall?[input.scope,'owner']:[input.scope];
  const crossQuestion=/(?:群里|群聊|QQ群|私聊|私信|QQ.{0,12}(?:说|问|聊|消息)|(?:说|问|聊).{0,12}QQ)/i.test(input.text);
  return {scopes,recentScopes:shared?(crossQuestion?scopes:[...new Set([input.scope,'owner'])]):undefined,crossQuestion,groupRecall,recallText};
}
