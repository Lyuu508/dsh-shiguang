import type {MemoryStore} from './memory.js';
import {stateValue,setState} from './initiative-state.js';
import {mediaURL} from './media.js';
export interface EmojiSource {account:string;emojiId:string;url?:string;md5?:string}
export function saveEmojiSource(memory:MemoryStore,scope:string,digest:string,value:EmojiSource){
 let url:string|undefined;try{if(value.url&&value.url.length<=4096)url=mediaURL(value.url).href;}catch{}
 const md5=value.md5&&/^[a-f0-9]{32}$/i.test(value.md5)?value.md5.toLowerCase():undefined;
 setState(memory,'emoji:source:'+JSON.stringify([scope,digest]),{account:value.account,emojiId:value.emojiId,url,md5});
}
export function readEmojiSource(memory:MemoryStore,scope:string,digest:string){return stateValue<EmojiSource|undefined>(memory,'emoji:source:'+JSON.stringify([scope,digest]),undefined);}
