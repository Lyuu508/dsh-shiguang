import React,{useEffect,useState} from 'react';
import type {PanelApi,Status} from './types.js';
export function TaskQueuePanel({api,queue,onRecovered}:{api:PanelApi;queue?:Status['taskQueue'];onRecovered:()=>void}){
 const [view,setView]=useState(queue),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>setView(queue),[queue]);
 const shown=!!view&&(!!view.active||view.waiting>0||view.last.at>0&&Date.now()-view.last.at<15000);
 useEffect(()=>{if(!shown)return;const abort=new AbortController();let pending=false;const poll=()=>{if(pending)return;pending=true;void api.call<Status['taskQueue']>('tasks-status',{},abort.signal).then(setView).catch(()=>{}).finally(()=>pending=false);};const timer=setInterval(poll,1500);return()=>{clearInterval(timer);abort.abort();};},[api,shown]);
 if(!shown||!view)return null;
 return <aside className="sg-notice" aria-label="待办任务状态"><div role="status"><strong>{view.active?view.active.cancelling?'正在停止，等待安全收尾':view.active.label:'当前没有执行中的任务'}</strong>{view.active&&<span> · 已持续 {view.active.seconds} 秒</span>}<p>等待 {view.waiting} 项：聊天 {view.counts.chat}，后台 {view.counts.background}，面板 {view.counts.panel}，设置 {view.counts.settings}。</p>{view.last.at>0&&<p>{view.last.message}</p>}</div><button disabled={busy||!view.active&&!view.waiting} onClick={()=>{setBusy(true);setError('');void api.call<Status['taskQueue']>('tasks-cancel').then(next=>{setView(next);onRecovered();}).catch(e=>setError(e instanceof Error?e.message:'停止请求未完成')).finally(()=>setBusy(false));}}>{busy?'正在提交停止请求…':'停止当前任务并清理等待'}</button><p className="sg-help">保存设置有独立名额并优先处理，会先停止旧任务，等安全收尾后应用。清理待办保留原始消息与已完成结果；已发出的消息不会撤回，结果不明的操作不会自动重发。</p>{error&&<p role="alert">{error}</p>}</aside>;
}
