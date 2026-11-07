import React,{useEffect,useState} from 'react';
import type {PanelApi,Settings,Status} from './types.js';
import type {NapCatState,QQLoginView} from '../src/napcat.js';
import {Field,Toggle,Numeric} from './Form.js';

export function NapCatPanel({api,settings,status,dirty,onChange}:{api:PanelApi;settings:Settings;status?:Status;dirty:boolean;onChange:(settings:Settings)=>void}){
  const n=settings.napcat;
  const [view,setView]=useState(status?.napcat),[login,setLogin]=useState<QQLoginView>(),[scanning,setScanning]=useState(false);
  const [token,setToken]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>setView(status?.napcat),[status?.napcat]);
  useEffect(()=>{
    if(!scanning)return;const abort=new AbortController();let cancelled=false;let timer:ReturnType<typeof setTimeout>;
    async function poll(){try{const value=await api.call<QQLoginView>('napcat-login',{},abort.signal);if(cancelled)return;setLogin(value);if(value.loggedIn){setScanning(false);return;}timer=setTimeout(()=>void poll(),2500);}catch(e){if(!cancelled){setError(e instanceof Error?e.message:'QQ 登录未完成');setScanning(false);}}}
    timer=setTimeout(()=>void poll(),2500);return()=>{cancelled=true;abort.abort();clearTimeout(timer);};
  },[api,scanning]);
  const edit=(patch:Partial<Settings['napcat']>)=>onChange({...settings,napcat:{...n,...patch}});
  async function run(task:()=>Promise<void>){setBusy(true);setError('');try{await task();}catch(e){setError(e instanceof Error?e.message:'NapCat 操作未完成');}finally{setBusy(false);}}
  const saved=()=>{if(dirty)throw new Error('请先保存设置，再进行 NapCat 安装、扫码或连接操作');};
  return <section className="sg-section"><h2>安装 NapCat，扫码登录 QQ</h2>
    <Field label="NapCat 使用方式"><select value={n.mode} onChange={e=>{setScanning(false);setLogin(undefined);edit({mode:e.target.value as Settings['napcat']['mode']});}}><option value="managed">随拾光安装并管理（Windows x64）</option><option value="external">连接已有 NapCat</option></select></Field>
    {n.mode==='managed'?<><Toggle label="随插件自动安装和启动 NapCat" help="Windows x64 首次加载插件时，从 NapCat 官方 GitHub 下载完整便携包并校验 SHA256。包含独立运行环境；后续复用本机安装。" value={n.autoInstall} onChange={autoInstall=>edit({autoInstall})}/><p className="sg-help">{view?.supported?'无需另外安装 QQ 或手动填写访问 Token。扫码成功后会自动配置本机 OneBot；再填写下方主人 QQ 号并开启回复。':'当前运行 DSH 的系统不支持 Windows 自动安装，可在 Windows x64 使用，或选择连接已有 NapCat。'}</p><div className="sg-notice" role="status">{view?.message||'正在读取 NapCat 状态…'}{view?.version&&<> · {view.version}</>}{view?.phase==='downloading'&&view.total>0&&<><br/>{(view.downloaded/1048576).toFixed(1)} / {(view.total/1048576).toFixed(1)} MB · {((view.speed||0)/1024).toFixed(0)} KB/s · {view.connections||n.downloadConnections} 连接{(view.resumed||0)>0&&<> · 复用断点 {((view.resumed||0)/1048576).toFixed(1)} MB</>}<div className="sg-progress"><span style={{width:`${Math.min(100,view.downloaded/view.total*100)}%`}}/></div></>}</div></>:<p className="sg-help">保留现有 NapCat 和 OneBot 设置。先在高级设置中填写后台地址与 WebUI Token，再点击扫码；OneBot Token 仍在下方单独配置。</p>}
    <div className="sg-row">
      {n.mode==='managed'&&<button disabled={busy||dirty||view?.busy||!view?.supported} onClick={()=>void run(async()=>{saved();setView(await api.call<NapCatState>('napcat-start'));})}>{view?.busy?'正在准备 NapCat…':view?.installed?'启动 / 重试 NapCat':'安装并启动 NapCat'}</button>}
      {view?.phase==='downloading'&&<button onClick={()=>void run(async()=>{setView(await api.call<NapCatState>('napcat-pause'));})}>暂停下载</button>}
      <button className="sg-primary" disabled={busy||dirty||view?.busy||n.mode==='managed'&&view?.phase!=='ready'} onClick={()=>void run(async()=>{saved();setLogin(await api.call<QQLoginView>('napcat-login'));setScanning(true);})}>扫码登录 QQ</button>
      <button disabled={busy||dirty} onClick={()=>{
        const popup=window.open('about:blank','_blank');if(popup)popup.opener=null;
        void run(async()=>{saved();try{const result=await api.call<{url:string}>('napcat-console');if(popup)popup.location.replace(result.url);else throw new Error('浏览器阻止了新窗口，请允许弹出窗口后重试');}catch(e){popup?.close();throw e;}});
      }}>打开 NapCat 后台</button>
    </div>
    {dirty&&<p className="sg-help">请先保存修改，再扫码或打开后台。</p>}
    {login&&<div className="sg-qr">{login.image&&!login.loggedIn&&<img src={login.image} alt="使用手机 QQ 扫描登录二维码"/>}<p role="status">{login.message}</p>{!login.loggedIn&&<div className="sg-row"><button disabled={busy} onClick={()=>void run(async()=>{setLogin(await api.call<QQLoginView>('napcat-refresh'));setScanning(true);})}>刷新 QQ 二维码</button><button onClick={()=>setScanning(false)}>暂停检查</button>{!scanning&&<button onClick={()=>setScanning(true)}>继续检查</button>}</div>}<small className="sg-help">扫码的是负责收发消息的 QQ 号。主人 QQ 通常使用另一个账号；额外验证请在 NapCat 后台完成。</small></div>}
    {error&&<p role="alert" className="sg-notice error">{error}</p>}
    <details><summary>NapCat 后台、下载与已有实例设置</summary>{n.mode==='managed'&&<><Numeric label="NapCat 下载并行连接数" min={1} max={8} value={n.downloadConnections} onChange={downloadConnections=>edit({downloadConnections})}/><Field label="GitHub 下载加速前缀（可选）" help="留空直连官方 GitHub。填写你信任的 HTTPS 镜像前缀；只用于公开运行包，仍按官方 SHA256 校验。下载中切换线路前，请先暂停，保存后再继续。"><input placeholder="https://你信任的镜像地址/" value={n.mirrorUrl} onChange={e=>edit({mirrorUrl:e.target.value})}/></Field><p className="sg-help">默认 4 路分段并行，支持断点续传；不支持分段的服务器自动用单连接。速度也受本机网络和镜像限制。</p></>}<Field label="NapCat 后台地址" help="使用本机地址，例如 http://127.0.0.1:6099。这里的端口与 OneBot 端口不同。"><input value={n.webuiUrl} onChange={e=>edit({webuiUrl:e.target.value})}/></Field><Field label="NapCat WebUI Token" help={view?.tokenConfigured?'已配置，内容不会回显；托管安装自动生成。后台手动改密后可在这里更新。':'填写 NapCat 控制台里的 WebUI Token，不是 OneBot 访问 Token。'}><input type="password" autoComplete="new-password" value={token} onChange={e=>setToken(e.target.value)}/></Field><button disabled={busy||dirty||!token.trim()} onClick={()=>void run(async()=>{saved();setView(await api.call<NapCatState>('napcat-token',{token}));setToken('');})}>保存后台密钥</button><p className="sg-help">后台按钮会使用已保存的密钥打开本机 NapCat 登录页，请勿分享带登录信息的地址。托管运行数据独立保存，插件升级不会覆盖；DSH 退出会停止由插件启动的实例。</p></details>
  </section>;
}
