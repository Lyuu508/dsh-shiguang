import React,{useEffect,useState} from 'react';
import type {PanelApi} from './types.js';
import type {VisionCheckState} from '../src/vision-check.js';
export function VisionCheckPanel({api,dirty}:{api:PanelApi;dirty:boolean}){
 const [view,setView]=useState<VisionCheckState>(),[error,setError]=useState('');
 useEffect(()=>{const abort=new AbortController();const poll=()=>void api.call<VisionCheckState>('vision-check-status',{},abort.signal).then(setView).catch(()=>{});poll();const timer=setInterval(poll,1500);return()=>{clearInterval(timer);abort.abort();};},[api]);
 return <section className="sg-section"><h2>先确认模型真的看得到图片</h2><p className="sg-help">用内置测试图直接检查当前 Flash 的图片能力，不经过 QQ、FFmpeg，也不读取私人聊天。点击后会产生一次模型调用，单列“图片识别自检”用量。通过仅证明本次简单图片识别成功。</p><button className="sg-primary" disabled={dirty||view?.busy} onClick={()=>{setError('');void api.call<VisionCheckState>('vision-check').then(setView).catch(e=>setError(e instanceof Error?e.message:'自检未启动'));}}>{view?.busy?'正在测试模型图片能力…':'测试模型能否看图'}</button>{dirty&&<p className="sg-help">请先保存设置再测试。</p>}{view&&<div role="status" className={view.ok?'sg-notice':view.at&&!view.busy?'sg-notice error':'sg-notice'}>{view.message}<p>环节：{view.stage}{view.provider?' · '+view.provider+' / '+view.model:''}{view.finish?' · 返回 '+view.finish:''}</p>{view.diagnostic&&<small>{view.diagnostic}</small>}</div>}<p className="sg-help">自检通过但 QQ 看不到：查看下方最近识图详情，继续定位 QQ 下载或动图处理。自检失败：先处理这里的连接、附件或模型错误。普通静态图直接用 DSH 图片服务；GIF / 动画仍按差异画面抽帧。</p>{error&&<p role="alert" className="sg-notice error">{error}</p>}</section>;
}
