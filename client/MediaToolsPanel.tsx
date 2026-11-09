import React,{useEffect,useState} from 'react';
import type {PanelApi,Settings} from './types.js';
type View={phase:string;message:string;ready:boolean;busy:boolean;cleanup:string};
export function MediaToolsPanel({api,dirty,onInstalled}:{api:PanelApi;settings:Settings;dirty:boolean;onChange:(s:Settings)=>void;onInstalled?:()=>void}){
 const [view,setView]=useState<View>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{const abort=new AbortController();const poll=()=>void api.call<View>('media-tools-status',{},abort.signal).then(setView).catch(()=>{});poll();const timer=setInterval(poll,2000);return()=>{abort.abort();clearInterval(timer);};},[api]);
 async function check(){setBusy(true);setError('');try{setView(await api.call<View>('media-check'));onInstalled?.();}catch(e){setError(e instanceof Error?e.message:'内置引擎检测未完成');}finally{setBusy(false);}}
 return <section className="sg-section"><h2>内置动图与视频引擎</h2><p className="sg-help">GIF、动画 WebP 和视频在本机解码，画面交给 Flash 识别；QQ 与 B 站共用。引擎随插件安装，无需下载外部 FFmpeg 或填写程序路径。检测引擎不调用模型。视频依然使用有限关键帧，不代表逐帧看完或听到原始音频。</p><div role="status" className={view?.phase==='error'?'sg-notice error':'sg-notice'}>{view?.message||'内置引擎随插件提供，可直接尝试媒体识别。'}{view?.cleanup&&<p>{view.cleanup}</p>}</div><button disabled={dirty||busy||view?.busy} onClick={()=>void check()}>{busy?'正在检查内置引擎…':'检测内置动图与视频引擎'}</button><p className="sg-help">升级时先验证内置引擎，再自动清理拾光旧安装记录对应的 FFmpeg、FFprobe 和下载包。系统或手动安装的程序保留；缺少有效安装记录时保留文件。</p>{dirty&&<p className="sg-help">请先保存设置再检测。</p>}{error&&<p className="sg-notice error" role="alert">{error}</p>}</section>;
}
