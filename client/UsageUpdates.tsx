import React, { useEffect, useState } from 'react';
import type { PanelApi } from './types.js';
import type { UsageReport, UsageTotals } from '../src/usage.js';
import type { UpdateState } from '../src/updates.js';

const message=(e:unknown)=>e instanceof Error?e.message:'读取失败，请重试';
const number=(n:number)=>n.toLocaleString();
const labels:Record<string,string>={qq:'QQ 聊天','qq-media':'QQ 视频 / 动图','bilibili-auto':'B 站自主生活','bilibili-video':'B 站视频识别',bilibili:'B 站任务',dsh:'DSH 对话'};
export function UsagePanel({api,today}:{api:PanelApi;today?:string}) {
  const [day,setDay]=useState(today||''),[report,setReport]=useState<UsageReport>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(!day&&today)setDay(today);},[today,day]);
  async function refresh(){if(!day)return;setBusy(true);setError('');try{setReport(await api.call<UsageReport>('usage',{day}));}catch(e){setError(message(e));}finally{setBusy(false);}}
  useEffect(()=>{const abort=new AbortController();setReport(undefined);setError('');if(day)void api.call<UsageReport>('usage',{day},abort.signal).then(setReport).catch(e=>{if(!abort.signal.aborted)setError(message(e));});return()=>abort.abort();},[api,day]);
  function row(name:string,t:UsageTotals){return <tr key={name}><th scope="row">{name}</th><td>{number(t.calls)}</td><td>{number(t.input)}</td><td>{number(t.cacheRead)}</td><td>{number(t.cacheWrite)}</td><td>{number(t.output)}</td><td>{number(t.total)}</td><td>{number(t.missing)}</td></tr>;}
  return <section className="sg-section"><h2>一天用了多少 Token</h2><div className="sg-row"><label>统计日期 <input aria-label="Token 统计日期" type="date" value={day} onChange={e=>setDay(e.target.value)}/></label><button disabled={busy||!day} onClick={()=>void refresh()}>{busy?'读取中…':'刷新用量'}</button><button onClick={()=>setDay(today||'')}>回到今天</button><button disabled={!report} onClick={()=>{
    if(!report)return;const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`shiguang-usage-${day}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }}>导出当日记录</button></div><p className="sg-help">按设置时区 {report?.timezone||'—'} 统计。只记录本插件创建的模型调用，从本版本安装后开始积累；面板查询不会调用模型。</p>
  {error&&<p role="alert" className="sg-notice error">{error}</p>}
  {report&&<><div className="sg-overview"><div className="sg-status"><span>当日已知总量</span><strong>{number(report.total.total)} Token</strong></div><div className="sg-status"><span>模型调用</span><strong>{number(report.total.calls)} 次</strong></div><div className="sg-status"><span>未返回用量</span><strong>{number(report.total.missing)} 次</strong></div></div><div className="sg-table"><table><caption>分类用量（不重复计数）</caption><thead><tr><th>任务</th><th>调用</th><th>未缓存输入</th><th>缓存读取</th><th>缓存写入</th><th>输出</th><th>已知合计</th><th>缺失</th></tr></thead><tbody>{['qq','qq-media','bilibili','bilibili-video','bilibili-auto','dsh'].map(category=>row(labels[category]!,report.categories.find(c=>c.category===category)||{calls:0,missing:0,input:0,cacheRead:0,cacheWrite:0,output:0,reasoning:0,total:0}))}{row('合计',report.total)}</tbody></table></div>
  <p className="sg-help">调用过 B 站工具的整轮对话（包括工具前后生成）记为 B 站任务，QQ 视频 / 动图与 B 站自主生活按各自的单次模型调用独立归类；其余按 QQ / DSH 归类。B 站 HTTP 请求、扫码、手动查记忆本身不产生模型 Token。重试、失败及中断已返回的用量也会记录；缺失用量不会按 0 宣称实际消耗。</p>
  {report.models.length>0&&<details><summary>按模型查看</summary>{report.models.map(m=><p key={m.provider+'/'+m.model}>{m.provider} / {m.model}：{number(m.total)} Token，{m.calls} 次调用，{m.missing} 次缺失</p>)}</details>}
  {report.total.missing>0&&<p className="sg-notice">部分调用没有可用的 Token 数据，已知合计可能低于实际消耗；请结合模型服务商的账单核对。</p>}</>}
  <details><summary>怎样测试一天的消耗</summary><p>连接 QQ 与 B 站并选择固定模型。记下开始时的数字，先做普通 QQ 聊天，再明确追问旧事，最后通过主人私聊要求读取指定 B 站视频或发表评论。每组完成后刷新，比较各项增量；正常运行一天后导出当天记录，与服务商同一时区、同一 API Key 的用量核对。</p><p>每次模型请求都会计算实际发送的上下文。日常只带限量当天笔记、最近对话和当前输入；追问历史才加入检索片段。工具调用会增加模型轮次，当天内容也可能再次计入输入；缓存命中仍有独立用量。字符预算不等于 Token 数。</p></details></section>;
}

export function UpdatesPanel({api,dirty}:{api:PanelApi;dirty:boolean}) {
  const [state,setState]=useState<UpdateState>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{const abort=new AbortController();const load=()=>void api.call<UpdateState>('update-status',{},abort.signal).then(setState).catch(e=>{if(!abort.signal.aborted)setError(message(e));});load();const timer=setInterval(load,2000);return()=>{abort.abort();clearInterval(timer);};},[api]);
  async function action(name:string){setBusy(true);setError('');try{setState(await api.call<UpdateState>(name,{version:state?.latest?.version}));}catch(e){setError(message(e));}finally{setBusy(false);}}
  const running=busy||!!state&&['checking','downloading','installing'].includes(state.phase);
  return <section className="sg-section"><h2>让拾光跟上新的变化</h2><p>仓库：<a href="https://github.com/Lyuu508/dsh-shiguang" target="_blank" rel="noreferrer">Lyuu508/dsh-shiguang</a></p><div className="sg-overview"><div className="sg-status"><span>正在运行</span><strong>{state?.current||'—'}</strong></div><div className="sg-status"><span>仓库最新</span><strong>{state?.latest?.version||'尚未检查'}</strong></div><div className="sg-status"><span>上次检查</span><strong>{state?.checkedAt?new Date(state.checkedAt).toLocaleString():'—'}</strong></div></div>
  <div className="sg-row"><button disabled={running} onClick={()=>void action('update-check')}>检查更新</button><button className="sg-primary" disabled={running||dirty||!state?.available||!state.canInstall||state.phase!=='idle'} onClick={()=>void action('update-install')}>下载并安装更新</button>{state?.latest&&<a href={state.latest.url} target="_blank" rel="noreferrer">打开版本页面</a>}</div>
  {dirty&&<p className="sg-help">请先保存面板修改，再安装更新。</p>}<p className={state?.phase==='error'?'sg-notice error':'sg-notice'} role="status">{state?.message||'正在读取更新状态…'}</p>{error&&<p role="alert" className="sg-notice error">{error}</p>}
  {state&&!state.canInstall&&<p className="sg-help">当前 DSH 未启用插件管理服务，可从版本页面手动下载后安装。</p>}
  <p className="sg-help">从此仓库的已发布版本获取安装包（包含预览版），校验 SHA256 后由 DSH 安装。配置、登录凭据与记忆保留在原数据目录。DSH 替换插件时可能关闭设置页，重新打开本页可查看保存的进度；完成后按提示重启 DSH 并刷新页面。</p>
  {state?.latest?.notes&&<details open><summary>版本说明</summary><pre className="sg-release-notes">{state.latest.notes}</pre></details>}</section>;
}
