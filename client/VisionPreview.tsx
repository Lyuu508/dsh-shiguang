import React,{useState} from 'react';
import type {PanelApi} from './types.js';
import {SettingSection} from './CompactSettings.js';
export function VisionPreview({api,source}:{api:PanelApi;source:'qq'|'bili'}){
 const [images,setImages]=useState<string[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 return <SettingSection className="sg-section"><h2>{source==='qq'?'QQ':'B站'}实际识别画面</h2><p className="sg-help">查看最近一次准备给模型的真实图片附件缩略图，本机生成，不调用模型。使用缓存或尚未识别时没有新图片；预览用于区分源图、抽帧与模型连接问题，不能证明服务端已理解图片。</p><button disabled={busy} onClick={()=>{setBusy(true);setMessage('');void api.call<{images:string[]}>('media-preview',{source}).then(v=>{setImages(v.images);if(!v.images.length)setMessage('当前没有新的图片附件；先发图并提问或测试一次视频，再刷新预览。');}).catch(e=>setMessage(e instanceof Error?e.message:'预览不可用')).finally(()=>setBusy(false));}}>{busy?'读取本机画面…':'查看实际送出的画面'}</button>{message&&<p className="sg-help">{message}</p>}<div className="sg-grid">{images.map((src,i)=><figure key={src.slice(-80)} style={{margin:0}}><img src={src} alt={'实际图片附件 '+(i+1)} style={{width:'100%',height:'auto',borderRadius:8}}/><figcaption className="sg-help">附件 {i+1}（本机缩略预览）</figcaption></figure>)}</div></SettingSection>;
}
