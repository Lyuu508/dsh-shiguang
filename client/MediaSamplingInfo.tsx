import React from 'react';
import type {Status} from './types.js';
export function focusBiliDuration(){const root=document.getElementById('sg-bili-duration-limit'),section=root?.closest<HTMLElement>('section[data-setting-id]');if(section)section.dispatchEvent(new CustomEvent('shiguang:open-setting',{bubbles:true,detail:section.dataset.settingId}));requestAnimationFrame(()=>{root?.scrollIntoView({behavior:'smooth',block:'center'});root?.querySelector('input')?.focus({preventScroll:true});});}
export function MediaSamplingInfo({status}:{status?:Status}){
 const live=status?.effective.media,last=status?.media,sample=last?.sampling,applied=last?.applied;
 return <div className="sg-notice" role="status">{live&&<p>当前运行：视频上限 {live.videoFrames} 帧 · 动图上限 {live.animationFrames} 帧 · {live.animationUnderstanding?'动图动作优先 / 最多 '+live.animationImages+' 张图':live.frameSelection==='uniform'?'均匀保留画面':'差异筛选'} · 拼图上限 {live.sheetSize} px · 输出上限 {live.maxOutputTokens} Token</p>}
 <p>最近一次本机处理：{sample?sample.kind==='animation'?'动图':sample.kind==='video'?'视频':'静态图片':last?.message||'尚未识别媒体'}</p>
 {!!last?.at&&<small>处理状态：{last.message} · {last.stage||'等待'}</small>}{applied&&<small>本次实际使用的配置：视频 {applied.videoFrames} 帧 / 动图 {applied.animationFrames} 帧，拼图上限 {applied.sheetSize} px，输出上限 {applied.maxOutputTokens} Token。</small>}
 {sample&&<><p>{last?.cacheHit?'复用了摘要缓存：以下是原识别的统计，本次新抽取 0 帧。':'以下来自本机处理统计，不是模型自己报的帧数。'}{sample.sourceFrames?' 原文件 '+sample.sourceFrames+' 帧。':''}</p><p>实际候选 {sample.candidates} 帧 → {sample.mode==='action'?'按动作顺序保留':sample.mode==='uniform'?'均匀保留':'差异筛选后保留'} {sample.selected} 帧；本次适用上限 {sample.limit} 帧。{sample.reason}</p>{last?.imageWidth&&<p>本机准备 {sample.imageCount||1} 张图片（以下为首张）：{last.imageWidth} × {last.imageHeight} px，{sample.columns} 列 × {sample.rows} 行；低清画面不强制放大。模型服务可能按自身规则缩放图片。</p>}</>}
 </div>;
}
