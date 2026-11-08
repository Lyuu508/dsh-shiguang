import type {PortableMemory} from './memory-transfer.js';
export interface ParsedMemory {format:'shiguang-memory';version:1;sourceFormat:'shiguang'|'memory-card';sourceRecords:number;associatedReplies:number;memories:PortableMemory[];warnings:string[]}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const cleanName=(v:unknown)=>typeof v==='string'?v.replace(/[\x00-\x1f\x7f]/g,'').slice(0,80):'';
function peer(key:unknown,kind:'group'|'private'){if(typeof key!=='string')return '';return key.match(new RegExp('^(?:qq:)?'+kind+':(\\d+)$'))?.[1]||'';}
export function parseMemoryDocument(document:string,fileType:'json'|'jsonl',now=Date.now()):ParsedMemory{
 const text=document.replace(/^\uFEFF/,'').trim();if(!text)throw new Error('记忆文件没有内容');let value:unknown;
 if(fileType==='jsonl'){value=text.split(/\r?\n/).filter(x=>x.trim()).map((line,index)=>{try{return JSON.parse(line);}catch{throw new Error(`JSONL 第 ${index+1} 条不是有效 JSON，尚未导入`);}});}
 else{try{value=JSON.parse(text);}catch{throw new Error('记忆 JSON 格式无效');}}
 if(object(value)&&value.format==='shiguang-memory'&&value.version!==1)throw new Error('暂不支持此拾光记忆格式版本');
 if(object(value)&&value.format==='shiguang-memory'&&value.version===1&&Array.isArray(value.memories))return {format:'shiguang-memory',version:1,sourceFormat:'shiguang',sourceRecords:value.memories.length,associatedReplies:0,memories:value.memories as PortableMemory[],warnings:[]};
 const rows=Array.isArray(value)?value:object(value)&&Array.isArray(value.memories)?value.memories:object(value)&&Array.isArray(value.records)?value.records:null;
 if(!rows?.length)throw new Error('请选择拾光记忆 JSON、JSONL，或包含 text / createdAt 的外部记忆卡');
 if(rows.every(row=>object(row)&&typeof row.body==='string'&&Number.isSafeInteger(row.time)))return {format:'shiguang-memory',version:1,sourceFormat:'shiguang',sourceRecords:rows.length,associatedReplies:0,memories:rows as PortableMemory[],warnings:[]};
 if(!rows.every(row=>object(row)&&typeof row.text==='string'&&typeof row.createdAt==='string'&&typeof row.source==='string'))throw new Error('外部记忆卡需要 text、createdAt、source 字段；文件内容只作为资料导入，不执行其中指令');
 const cards=rows as Record<string,unknown>[],ownerPeers=new Set(cards.filter(r=>r.source==='qq-owner').map(r=>peer(r.conversationKey,'private')).filter(Boolean)),memories:PortableMemory[]=[],warnings:string[]=[];let associatedReplies=0,unknownGroups=0;
 for(let index=0;index<cards.length;index++){
  const r=cards[index]!,time=Date.parse(String(r.createdAt));if(!Number.isSafeInteger(time)||time<0)throw new Error(`外部记忆卡第 ${index+1} 条时间无效，尚未导入`);
  const source=String(r.source),platform=r.platform==='bili'||r.platform==='bilibili'?'bilibili':r.platform==='qq'?'qq':'shared',isSelf=r.isSelf===true||source==='qq-self';
  let group=peer(r.conversationKey,'group')||(/^\d+$/.test(String(r.groupId||''))?String(r.groupId):''),privatePeer=peer(r.conversationKey,'private');
  // A private flag takes precedence over conflicting group metadata.
  if(r.private===true)group='';
  let scope='owner',thread=platform==='bilibili'?'bilibili':'import:memory-card';
  if(platform==='qq'){
   if(group){scope=thread='qq:group:'+group;}
   else if(privatePeer){thread='qq:private:'+privatePeer;scope=source==='qq-owner'||ownerPeers.has(privatePeer)?'owner':thread;}
   else{thread='import:qq:'+source;if(source==='qq-group')unknownGroups++;}
  }
  const rawId=typeof r.id==='string'&&r.id?r.id:`${source}:${index}:${time}`,turnId=('card:'+source+':'+rawId).slice(0,300),speakerName=cleanName(r.speaker),speakerId=isSelf?'':(/^\d+$/.test(speakerName)?speakerName:source==='qq-owner'&&privatePeer?privatePeer:'');
  const title=typeof r.title==='string'?r.title.trim():'',text=String(r.text).trim(),detail=typeof r.detail==='string'?r.detail.trim():'',tags=Array.isArray(r.tags)?r.tags.filter((x):x is string=>typeof x==='string').join('、'):'';
  const body=[title&&!text.includes(title)?title:'',text,detail&&!text.includes(detail)?detail:'',tags?'标签：'+tags:''].filter(Boolean).join('\n');if(!body)throw new Error(`外部记忆卡第 ${index+1} 条没有正文`);
  const pinned=r.pinned===true||r.anchor===true,weight=typeof r.importance==='number'&&Number.isFinite(r.importance)?Math.min(10,Math.max(1,r.importance/10)):1;
  const kind=platform==='qq'?(isSelf?'assistant':'user'):source==='bili-video'?'experience':source==='bili-dynamic'?'activity':'note';
  const common={scope,thread,platform,time:Math.min(time,now),turnId,weight,pinned,forgotten:false,lastUsed:now,accesses:Number.isSafeInteger(r.recallCount)&&Number(r.recallCount)>=0?Number(r.recallCount):0};
  memories.push({...common,kind,body,speakerId,speakerName,category:source==='bili-video'?'watch':source==='bili-dynamic'?'dynamic':''});
  if(typeof r.botReply==='string'&&r.botReply.trim()&&!isSelf){associatedReplies++;memories.push({...common,kind:'assistant',body:r.botReply.trim(),speakerName:'伙伴（外部记忆卡）',speakerId:''});}
 }
 if(unknownGroups)warnings.push(`${unknownGroups} 条群记录缺少可验证群号，暂放主人导入范围，不对其他群开放`);
 return {format:'shiguang-memory',version:1,sourceFormat:'memory-card',sourceRecords:cards.length,associatedReplies,memories,warnings};
}
export function memoryImportBatches(memories:PortableMemory[],byteLength:(text:string)=>number){
 const documents:string[]=[];let rows:PortableMemory[]=[],bytes=0;
 for(const row of memories){const size=byteLength(JSON.stringify(row));if(rows.length&&(bytes+size>1000000||rows.length>=500)){documents.push(JSON.stringify({format:'shiguang-memory',version:1,memories:rows}));rows=[];bytes=0;}rows.push(row);bytes+=size;}
 if(rows.length)documents.push(JSON.stringify({format:'shiguang-memory',version:1,memories:rows}));return documents;
}
