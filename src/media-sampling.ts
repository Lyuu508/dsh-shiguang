export interface SamplingInfo {
 kind:'static'|'animation'|'video';mode:'different'|'uniform';limit:number;sourceFrames?:number;candidates:number;selected:number;columns:number;rows:number;sourceWidth:number;sourceHeight:number;reason:string;
}
export interface AppliedMediaSettings {videoFrames:number;animationFrames:number;frameSelection:'different'|'uniform';sheetSize:number;maxOutputTokens:number;maxDurationSeconds:number;contextChars:number;dailyLimit:number}
export function readMediaCache(value:string):{text:string;sampling?:SamplingInfo}{
 try{const v=JSON.parse(value);if(v?.format==='shiguang-media-sampling-v1'&&typeof v.text==='string')return {text:v.text,...(validSampling(v.sampling)?{sampling:v.sampling}:{})};}catch{}
 return {text:value};
}
function validSampling(value:unknown):value is SamplingInfo{
 if(!value||typeof value!=='object')return false;const v=value as SamplingInfo;
 return ['static','animation','video'].includes(v.kind)&&['different','uniform'].includes(v.mode)&&[v.limit,v.candidates,v.selected,v.columns,v.rows,v.sourceWidth,v.sourceHeight].every(n=>Number.isSafeInteger(n)&&n>=1)&&v.selected<=v.candidates&&v.selected<=v.limit&&typeof v.reason==='string';
}
export function samplingExplanation(info:SamplingInfo){
 return info.kind==='static'?'静态图片直传，动画和视频帧数上限不适用':`${info.kind==='animation'?'动图':'视频'}本机配置上限 ${info.limit} 帧；${info.sourceFrames?'原文件 '+info.sourceFrames+' 帧；':''}实际候选 ${info.candidates} 帧，${info.mode==='uniform'?'均匀保留':'按差异筛选'}后选择 ${info.selected} 帧。${info.reason}`;
}
