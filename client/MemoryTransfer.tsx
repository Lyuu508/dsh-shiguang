import {Field} from './Form.js';
import React,{useRef,useState} from 'react';
import type {PanelApi} from './types.js';
type Row={scope?:string;category?:string;id?:string;time:number;platform:string;thread:string;kind:string;body:string;day?:string};
interface Page{format:string;version:number;role:string;scope:string;range:string;day:string;timezone:string;snapshot:number;rows:Row[];nextCursor:number|null}
export function MemoryTransfer({api,scope,onImported}:{api:PanelApi;scope:string;onImported:(target:'today'|'all')=>void}){
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState(''),[target,setTarget]=useState<'today'|'all'>('today'),[file,setFile]=useState<File>();const input=useRef<HTMLInputElement>(null);
  async function download(range:'today'|'all'){
    setBusy(true);setError('');setNotice('正在导出…');
    try{
      let after=0,first:Page|undefined,count=0;const parts:BlobPart[]=[];
      for(;;){
        const page=await api.call<Page>('memory-export',{scope,range,after,snapshot:first?.snapshot,day:first?.day});
        if(!first){first=page;parts.push(JSON.stringify({format:page.format,version:page.version,role:page.role,scope:page.scope,range:page.range,day:page.day,timezone:page.timezone,exportedAt:new Date().toISOString()}).slice(0,-1)+',"memories":[\n');}
        for(const row of page.rows){parts.push((count?',\n':'')+JSON.stringify(row));count++;}setNotice(`正在导出 ${count} 条…`);if(page.nextCursor===null)break;after=page.nextCursor;
      }
      parts.push('\n]}');const url=URL.createObjectURL(new Blob(parts,{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`shiguang-memory-${range}-${first!.day}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice(`已导出 ${count} 条记忆，未导出配置、登录凭据文件或用量账本`);
    }catch(e){setError(e instanceof Error?e.message:'导出未完成');setNotice('');}finally{setBusy(false);}
  }
  async function upload(){
    if(!file)return;setBusy(true);setError('');let added=0,skipped=0;
    try{
      if(file.size>64*1024*1024)throw new Error('单个文件最多 64 MB，请分批导入');
      const text=await file.text(),isJSON=/\.json$/i.test(file.name);let chunks:string[]=[];
      if(isJSON){
        let value:unknown;try{value=JSON.parse(text);}catch{throw new Error('文件不是有效的 JSON');}
        const v=value as {format?:string;version?:number;memories?:Row[]};if(v?.format!=='shiguang-memory'||v.version!==1||!Array.isArray(v.memories)||!v.memories.length)throw new Error('请选择拾光导出的记忆 JSON');
        for(const row of v.memories)if(!row||row.id!==undefined&&(typeof row.id!=='string'||row.id.length>128)||typeof row.body!=='string'||!row.body.trim()||row.body.length>20000||!Number.isSafeInteger(row.time)||row.time<0||!['qq','bilibili','dsh','shared'].includes(row.platform)||!['user','assistant','note','experience','activity'].includes(row.kind)||typeof row.thread!=='string'||row.thread.length>200)throw new Error('文件包含无效记录，尚未导入');
        let batch:Row[]=[],bytes=0;for(const row of v.memories){const size=new Blob([JSON.stringify(row)]).size;if(batch.length&&(bytes+size>1024*1024||batch.length>=500)){chunks.push(JSON.stringify({format:v.format,version:1,memories:batch}));batch=[];bytes=0;}batch.push(row);bytes+=size;}if(batch.length)chunks.push(JSON.stringify({format:v.format,version:1,memories:batch}));
      }else{for(let i=0;i<text.length;i+=250000){const paragraphs=text.slice(i,i+250000).split(/\n\s*\n/).filter(s=>s.trim());for(let j=0;j<paragraphs.length;j+=1000)chunks.push(paragraphs.slice(j,j+1000).join('\n\n'));}if(!chunks.length)throw new Error('文件没有可导入的内容');}
      for(let i=0;i<chunks.length;i++){setNotice(`正在导入第 ${i+1} / ${chunks.length} 批…`);const r=await api.call<{added:number;skipped:number}>('memory-import',{scope,target,fileType:isJSON?'json':'text',document:chunks[i]});added+=r.added;skipped+=r.skipped;}
      setNotice(`导入完成：新增 ${added} 条，跳过重复 ${skipped} 条`);setFile(undefined);if(input.current)input.current.value='';onImported(target);
    }catch(e){setNotice(added||skipped?`前面已新增 ${added} 条、跳过 ${skipped} 条；可修正后重试，已导入内容会去重。`:'');setError(e instanceof Error?e.message:'导入未完成');}finally{setBusy(false);}
  }
  return <section className="sg-section"><h2>把记忆保存到本地，或带回来</h2><div className="sg-row"><button disabled={busy} onClick={()=>void download('today')}>下载今天的记忆</button><button disabled={busy} onClick={()=>void download('all')}>下载全部记忆</button></div><p className="sg-help">导出当前选中权限范围的完整记忆；选择全部本机范围会保留 QQ 私信、群聊和 B 站各自的范围及活动分类。平台和活动筛选只影响上方查看，不会裁掉备份。全部包含今天和历史；下载、上传和索引构建不会调用模型。</p><div className="sg-grid"><Field label="本地记忆文件"><input ref={input} aria-label="本地记忆文件" type="file" accept=".json,.txt,.md" disabled={busy} onChange={e=>setFile(e.target.files?.[0])}/></Field><Field label="导入到"><select aria-label="导入到" value={target} disabled={busy} onChange={e=>setTarget(e.target.value as 'today'|'all')}><option value="today">今天的记忆</option><option value="all">全部记忆 / 历史</option></select></Field></div><p className="sg-help">JSON 保留原始时间；选择“今天”会改记在今天。没有日期的 TXT / Markdown 导入“全部”时作为历史。大文件分批处理，每批校验后写入，重复内容跳过。</p><button disabled={busy||!file} onClick={()=>void upload()}>导入所选记忆</button>{notice&&<p role="status" className="sg-notice">{notice}</p>}{error&&<p role="alert" className="sg-notice error">{error}</p>}</section>;
}
