import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';

// Callers derive owner/scope from authenticated platform identities, never from
// message text or model tool arguments. A group is always confined to itself.
export function memoryAccess(settings:Settings,memory:MemoryStore,input:{scope:string;thread:string;owner:boolean;text:string}){
  const group=input.thread.startsWith('qq:group:');
  const shared=!group&&(input.owner||!settings.memory.ownerOnlyCrossChat);
  const scopes=shared?[...new Set([input.scope,...memory.availableScopes()])]:[input.scope];
  const crossQuestion=/(?:群里|群聊|QQ群|私聊|私信|QQ.{0,12}(?:说|问|聊|消息)|(?:说|问|聊).{0,12}QQ)/i.test(input.text);
  return {scopes,recentScopes:shared?(crossQuestion?scopes:[...new Set([input.scope,'owner'])]):undefined,crossQuestion};
}
