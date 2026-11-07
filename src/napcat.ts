import {timeoutSignal} from './timeouts.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { napcatBaseUrl, type Settings } from './config.js';
import {downloadPackage} from './package-download.js';

const RELEASE = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest';
const ASSET = 'NapCat.Shell.Windows.Node.zip';
const MAX_DOWNLOAD = 256 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NapCat 返回数据格式异常');
  return value as ObjectValue;
}
export function webuiHash(token: string): string { return createHash('sha256').update(token + '.napcat').digest('hex'); }
export function napcatAsset(value: unknown): {version:string;url:string;digest:string;size:number} {
  const release = object(value);
  if (release.draft || release.prerelease || typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !Array.isArray(release.assets)) throw new Error('NapCat 官方版本信息无效');
  const asset = object(release.assets.find(a => a && typeof a === 'object' && a.name === ASSET));
  const expected = `https://github.com/NapNeko/NapCatQQ/releases/download/${release.tag_name}/${ASSET}`;
  if (asset.browser_download_url !== expected || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest) || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_DOWNLOAD) throw new Error('NapCat 官方安装包缺少有效地址、大小或 SHA256，已停止安装');
  return {version:release.tag_name,url:expected,digest:asset.digest.slice(7).toLowerCase(),size:asset.size};
}
export function onebotEndpoint(settings: Settings): {host:string;port:number} {
  const u = new URL(settings.qq.wsUrl);
  if (u.protocol !== 'ws:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || !u.port || u.pathname !== '/' || u.username || u.password || u.search || u.hash) throw new Error('托管 NapCat 请使用本机 ws 地址和明确端口，例如 ws://127.0.0.1:3001；其他连接请选择已有 NapCat');
  return {host:u.hostname === '[::1]' ? '::1' : u.hostname === 'localhost' ? '127.0.0.1' : u.hostname,port:Number(u.port)};
}
export interface NapCatHost {
  platform: string; arch: string;
  extract(archive:string,destination:string,signal:AbortSignal):Promise<void>;
  launch(directory:string,work:string,token:string,log:string):ChildProcess;
  portFree(host:string,port:number):Promise<boolean>;
}
const nativeHost: NapCatHost = {
  platform:process.platform, arch:process.arch,
  extract: (archive,destination,signal) => new Promise((resolve,reject) => {
    execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../scripts/Expand-NapCat.ps1',import.meta.url)),'-Archive',archive,'-Destination',destination],{windowsHide:true,timeout:120000,signal,maxBuffer:65536},error => error ? reject(new Error('NapCat 解压失败，请检查磁盘空间及 Windows PowerShell')) : resolve());
  }),
  launch(directory,work,token,log) {
    if (existsSync(log) && statSync(log).size > 10*1024*1024) renameSync(log,log+'.bak');
    const fd = openSync(log,'a',0o600);
    try {
      return spawn(join(directory,'node.exe'),[join(directory,'index.js')],{cwd:directory,windowsHide:true,stdio:['ignore',fd,fd],env:{...process.env,NAPCAT_WORKDIR:work,NAPCAT_QQ_DATA_DIR:join(work,'qq-data'),NAPCAT_WEBUI_SECRET_KEY:token,NAPCAT_QUICK_ACCOUNT:'',NAPCAT_QUICK_PASSWORD:'',NAPCAT_QUICK_PASSWORD_MD5:''}});
    } finally { closeSync(fd); }
  },
  portFree: (host,port) => new Promise(resolve => {
    const server=createServer(); server.once('error',()=>resolve(false));server.listen({host,port},()=>server.close(()=>resolve(true)));
  }),
};

export interface NapCatState {
  supported:boolean; mode:'managed'|'external'; installed:boolean; version:string;
  phase:'idle'|'downloading'|'extracting'|'starting'|'ready'|'error';
  message:string; downloaded:number; total:number; speed?:number; resumed?:number; connections?:number; busy:boolean; webuiUrl:string; tokenConfigured:boolean;
}
export interface QQLoginView {loggedIn:boolean;phase:string;message:string;image?:string;bridgeReady?:boolean}

export class NapCatManager {
  private readonly root: string;
  private state: Pick<NapCatState,'phase'|'message'|'downloaded'|'total'|'speed'|'resumed'|'connections'> = {phase:'idle',message:'等待安装或启动 NapCat',downloaded:0,total:0};
  private controller = new AbortController();
  private job?: Promise<void>;
  private child?: ChildProcess;
  private credential?: {base:string;value:string;expires:number};
  private authJob?: Promise<string>;
  private bridgeSignature = '';
  private bridgeJob?: Promise<void>;
  private disposed = false;
  private preparation?:AbortController;
  private paused=false;
  constructor(readonly dataDir:string,readonly settings:()=>Settings,readonly onebotToken:()=>string,readonly fetcher:typeof fetch=fetch,readonly host:NapCatHost=nativeHost) {
    this.root=join(dataDir,'napcat');
  }
  private get runtime():string { return join(this.root,'runtime'); }
  private get work():string { return join(this.root,'work'); }
  private secretFile():string {return join(this.root,this.settings().napcat.mode === 'managed' ? 'webui.token' : 'external-webui.token');}
  private write(file:string,text:string):void {
    mkdirSync(this.root,{recursive:true,mode:0o700});
    const temporary=file+'.'+randomUUID()+'.tmp';writeFileSync(temporary,text,{mode:0o600});renameSync(temporary,file);
  }
  private secret():string {try{return readFileSync(this.secretFile(),'utf8').trim();}catch{return '';}}
  private manifest(): {version:string} | undefined {
    try {const m=JSON.parse(readFileSync(join(this.root,'installed.json'),'utf8'));if(typeof m.version === 'string' && this.runtimeValid(this.runtime))return m;}catch{/* Not installed yet. */}
  }
  private runtimeValid(directory:string):boolean { return ['node.exe','index.js','wrapper.node','napcat/napcat.mjs'].every(p=>existsSync(join(directory,p))&&statSync(join(directory,p)).isFile()); }
  view():NapCatState {
    const n=this.settings().napcat,m=this.manifest();
    return {...this.state,supported:this.host.platform==='win32'&&this.host.arch==='x64',mode:n.mode,installed:!!m,version:m?.version||'',busy:!!this.job,webuiUrl:new URL('webui/',napcatBaseUrl(n.webuiUrl)).href,tokenConfigured:!!this.secret()};
  }
  configure():void {
    const n=this.settings().napcat;
    this.credential=undefined;this.bridgeSignature='';
    if(n.mode === 'managed' && n.autoInstall && this.view().supported && !this.paused) this.start();
  }
  start():NapCatState {
    if(this.disposed)throw new Error('NapCat 管理正在停止');
    if(this.settings().napcat.mode !== 'managed')throw new Error('已有 NapCat 请直接扫码或打开后台，无需重复安装');
    if(!this.view().supported)throw new Error('自动安装支持 Windows x64；此系统请连接已有 NapCat');
    if(this.job)return this.view();
    this.paused=false;this.preparation=new AbortController();
    this.state={phase:'starting',message:'正在准备 NapCat…',downloaded:0,total:0};
    this.job=this.prepare().catch(error=>{
      if(!this.disposed)this.state={...this.state,phase:this.paused?'idle':'error',message:this.paused?'下载已暂停，断点已保存；可继续下载':error instanceof Error?error.message:'NapCat 安装未完成'};
    }).finally(()=>{this.job=undefined;});
    return this.view();
  }
  async whenIdle():Promise<void> {await this.job;}
  pause():NapCatState {if(this.state.phase==='downloading'){this.paused=true;this.preparation?.abort();this.state.message='正在暂停下载并保存断点…';}return this.view();}
  private lock():()=>void {
    mkdirSync(this.root,{recursive:true,mode:0o700});const file=join(this.root,'install.lock'),id=randomUUID();
    if(existsSync(file)){
      try {const previous=JSON.parse(readFileSync(file,'utf8'));if(!Number.isSafeInteger(previous.pid)||previous.pid<1)throw new Error('invalid');try{process.kill(previous.pid,0);throw new Error('busy');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw new Error('busy');}rmSync(file);} catch(e){throw new Error('另一个 DSH 可能正在准备 NapCat，请等其结束；异常退出后可删除本机 napcat/install.lock 再试');}
    }
    try{writeFileSync(file,JSON.stringify({pid:process.pid,id}),{flag:'wx',mode:0o600});}catch{throw new Error('另一个 DSH 正在准备 NapCat，请稍后重试');}
    return ()=>{try{if(JSON.parse(readFileSync(file,'utf8')).id===id)rmSync(file);}catch{/* Already released. */}};
  }
  private async get(url:string,max:number,signal:AbortSignal):Promise<Uint8Array> {
    const response=await this.fetcher(url,{headers:{'User-Agent':'dsh-shiguang','Accept':'application/vnd.github+json'},redirect:'error',signal});
    if(!response.ok)throw new Error(`NapCat 官方下载接口 HTTP ${response.status}，请检查 GitHub 连接后重试`);
    return this.readBounded(response,max);
  }
  private async readBounded(response:Response,max:number):Promise<Buffer> {
    if(!response.body)throw new Error('NapCat 返回空内容');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
    try{for(;;){const r=await reader.read();if(r.done)break;total+=r.value.length;if(total>max)throw new Error('NapCat 返回内容超出大小限制');chunks.push(r.value);}return Buffer.concat(chunks);}finally{await reader.cancel().catch(()=>{});}
  }
  private async download(asset:ReturnType<typeof napcatAsset>,file:string,signal:AbortSignal):Promise<void> {
    const n=this.settings().napcat;
    await downloadPackage(asset,file,join(this.root,'downloads'),{connections:n.downloadConnections,mirrorUrl:n.mirrorUrl},signal,this.fetcher,p=>{this.state={...this.state,...p};});
  }
  private ensureTokens():void {
    if(!this.secret())this.write(this.secretFile(),randomBytes(24).toString('hex'));
    if(!this.onebotToken())this.write(join(this.dataDir,'onebot.token'),randomBytes(24).toString('hex'));
  }
  private async ready(signal:AbortSignal):Promise<void> {
    const credential=await this.auth(signal),data=object(await this.request('/QQLogin/CheckLoginStatus',{},credential,signal));
    this.state={...this.state,phase:'ready',message:'NapCat 已就绪，可扫码登录 QQ'};
    if(data.isLogin===true && this.settings().napcat.mode==='managed'){
      try{await this.configureBridge(credential,signal);}catch(error){
        signal.throwIfAborted();
        this.state.message='NapCat 已运行；'+(error instanceof Error?error.message:'请检查 OneBot 连接配置');
      }
    }
  }
  private async prepare():Promise<void> {
    const releaseLock=this.lock(),stage=join(this.root,'stage-'+randomUUID()),archive=join(this.root,'download-'+randomUUID()+'.zip');
    const signal=AbortSignal.any([this.controller.signal,timeoutSignal(15*60*1000),...(this.preparation?[this.preparation.signal]:[])]);
    try{
      if(!this.manifest()){
        if(existsSync(this.runtime))throw new Error('NapCat 安装目录已存在但不完整，请先检查本机 napcat/runtime，插件不会覆盖');
        this.state={phase:'downloading',message:'正在从 NapCat 官方 GitHub 下载 Windows 便携运行包…',downloaded:0,total:0};
        const asset=napcatAsset(JSON.parse(Buffer.from(await this.get(RELEASE,2*1024*1024,signal)).toString('utf8')));
        this.state.total=asset.size;await this.download(asset,archive,signal);
        signal.throwIfAborted();this.state.phase='extracting';this.state.message='SHA256 校验通过，正在解压 NapCat…';
        await this.host.extract(archive,stage,signal);signal.throwIfAborted();
        if(!this.runtimeValid(stage))throw new Error('NapCat 官方包缺少必要运行文件，未启动');
        renameSync(stage,this.runtime);this.write(join(this.root,'installed.json'),JSON.stringify({version:asset.version,sha256:asset.digest,source:asset.url}));
      }
      signal.throwIfAborted();if(this.settings().napcat.mode!=='managed')return;
      this.ensureTokens();
      // A live instance is reusable only when our private WebUI credential works.
      try{await this.ready(signal);return;}catch{this.credential=undefined;}
      if(this.child && this.child.exitCode===null && !this.child.killed)throw new Error('NapCat 仍在运行但后台未就绪，请检查本机 napcat/napcat.log；必要时退出 DSH 后重新启动');
      const base=napcatBaseUrl(this.settings().napcat.webuiUrl),webPort=Number(base.port||80),webHost=base.hostname==='[::1]'?'::1':base.hostname;
      if(!await this.host.portFree(webHost,webPort))throw new Error(`NapCat 后台端口 ${webPort} 已被占用；已有 NapCat 请选择“连接已有 NapCat”，或修改后台端口`);
      const endpoint=onebotEndpoint(this.settings()),configDir=join(this.work,'config');mkdirSync(configDir,{recursive:true,mode:0o700});
      const configFile=join(configDir,'webui.json');let config:ObjectValue={};
      if(existsSync(configFile))config=object(JSON.parse(readFileSync(configFile,'utf8')));
      this.write(configFile,JSON.stringify({...config,host:webHost,port:webPort,token:this.secret(),disableWebUI:false}));
      const onebotFile=join(configDir,'onebot11.json');
      if(!existsSync(onebotFile))this.write(onebotFile,JSON.stringify({network:{websocketServers:[{name:'shiguang',enable:true,...endpoint,messagePostFormat:'array',token:this.onebotToken(),reportSelfMessage:false}]}}));
      this.state={...this.state,phase:'starting',message:'正在启动 NapCat，首次初始化可能需要一会儿…'};
      const child=this.child=this.host.launch(this.runtime,this.work,this.secret(),join(this.root,'napcat.log'));
      let exited=false;child.once('error',()=>{exited=true;});child.once('exit',()=>{exited=true;if(!this.disposed)this.state={...this.state,phase:'error',message:'NapCat 已退出，请在 QQ 连接中重新启动；详情见本机 napcat/napcat.log'};});
      for(let attempt=0;attempt<90;attempt++){
        signal.throwIfAborted();if(exited)throw new Error('NapCat 启动失败，请检查本机 napcat/napcat.log；缺少 DLL 时按官方说明安装 Visual C++ x64 运行库');
        try{await this.ready(signal);return;}catch{/* Native core is still starting. */}
        await delay(1000,undefined,{signal});
      }
      throw new Error('NapCat 后台启动超时，请检查本机 napcat/napcat.log 后重试');
    }finally{rmSync(stage,{recursive:true,force:true});rmSync(archive,{force:true});releaseLock();}
  }
  saveWebuiToken(token:string):NapCatState {
    if(!token.trim()||token.length>256||/[\r\n\0]/.test(token))throw new Error('NapCat WebUI Token 格式无效');
    this.write(this.secretFile(),token.trim());this.credential=undefined;return this.view();
  }
  private async request(path:string,body:ObjectValue={},credential='',signal?:AbortSignal):Promise<unknown> {
    const base=napcatBaseUrl(this.settings().napcat.webuiUrl);
    const response=await this.fetcher(new URL('/api'+path,base),{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([this.controller.signal,timeoutSignal(8000),...(signal?[signal]:[])])});
    if(!response.ok)throw new Error(`NapCat 后台 HTTP ${response.status}，请确认已启动`);
    const value=object(JSON.parse((await this.readBounded(response,1024*1024)).toString('utf8')));
    if(value.code!==0){if(value.message==='Unauthorized'){this.credential=undefined;throw new Error('NapCat 后台登录已过期，请重试或更新 WebUI Token');}throw new Error('NapCat 后台未完成操作，请检查 WebUI Token、登录状态或在后台完成验证');}
    return value.data;
  }
  private async auth(signal?:AbortSignal):Promise<string> {
    const base=napcatBaseUrl(this.settings().napcat.webuiUrl).href;
    if(this.credential?.base===base&&this.credential.expires>Date.now())return this.credential.value;
    if(this.authJob)return this.authJob;
    const token=this.secret();if(!token)throw new Error('请先填写并连接 NapCat WebUI Token；它与 OneBot Token 不同');
    const job=(async()=>{const data=object(await this.request('/auth/login',{hash:webuiHash(token)},'',signal));
      if(data.require2FA===true)throw new Error('NapCat 已开启双重验证，请使用“打开 NapCat 后台”完成 QQ 登录');
      if(typeof data.Credential!=='string'||!data.Credential||data.Credential.length>16384)throw new Error('NapCat 后台没有返回有效登录凭据');
      this.credential={base,value:data.Credential,expires:Date.now()+50*60*1000};return data.Credential;})();
    this.authJob=job;try{return await job;}finally{if(this.authJob===job)this.authJob=undefined;}
  }
  async loginStatus(signal?:AbortSignal):Promise<QQLoginView> {
    const credential=await this.auth(signal),data=object(await this.request('/QQLogin/CheckLoginStatus',{},credential,signal));
    if(data.isLogin===true){
      if(this.settings().napcat.mode==='managed')await this.configureBridge(credential,signal);
      return {loggedIn:true,phase:'ready',message:'QQ 已登录'+(this.settings().napcat.mode==='managed'?'，OneBot 连接已配置':''),bridgeReady:this.settings().napcat.mode==='managed'};
    }
    const phase=typeof data.loginPhase==='string'?data.loginPhase:'waiting_qrcode';
    const message=data.loginError?'QQ 登录需要处理，请打开 NapCat 后台查看验证提示':phase==='qrcode_scanned'?'已扫码，请在手机 QQ 确认':phase==='initializing'?'已确认，正在初始化 QQ…':phase==='reconnecting'?'QQ 登录服务正在重连，请稍候…':'请用手机 QQ 扫码并确认登录';
    let image:string|undefined;
    if(typeof data.qrcodeurl==='string'&&data.qrcodeurl){
      let url:URL;try{url=new URL(data.qrcodeurl);}catch{throw new Error('NapCat 返回的 QQ 二维码地址无效');}
      if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!(url.hostname==='qq.com'||url.hostname.endsWith('.qq.com'))||url.href.length>4096)throw new Error('NapCat 返回的 QQ 二维码不是官方 QQ 地址');
      image=await QRCode.toDataURL(url.href,{width:256,margin:2});
    }
    return {loggedIn:false,phase,message,...(image?{image}:{})};
  }
  async refreshQR(signal?:AbortSignal):Promise<QQLoginView> {
    const credential=await this.auth(signal);await this.request('/QQLogin/RefreshQRcode',{},credential,signal);return this.loginStatus(signal);
  }
  private async configureBridge(credential:string,signal?:AbortSignal):Promise<void> {
    const settings=this.settings(),endpoint=onebotEndpoint(settings),token=this.onebotToken();
    if(!token)throw new Error('请先填写 OneBot Token 或重新启动托管 NapCat');
    const signature=createHash('sha256').update(JSON.stringify([endpoint,token,settings.napcat.webuiUrl])).digest('hex');
    if(this.bridgeSignature===signature)return;
    if(this.bridgeJob){await this.bridgeJob;if(this.bridgeSignature===signature)return;}
    const job=(async()=>{
      const config=object(await this.request('/OB11Config/GetConfig',{},credential,signal)),network=object(config.network??{});
      const servers=Array.isArray(network.websocketServers)?network.websocketServers.map(object):[];
      if(servers.some(s=>s.name!=='shiguang'&&s.enable===true&&s.port===endpoint.port))throw new Error('OneBot 端口已被其他服务配置使用，请在 NapCat 后台处理后重试');
      const next={...config,network:{...network,websocketServers:[...servers.filter(s=>s.name!=='shiguang'),{name:'shiguang',enable:true,...endpoint,messagePostFormat:'array',token,reportSelfMessage:false}]}};
      await this.request('/OB11Config/SetConfig',{config:JSON.stringify(next)},credential,signal);this.bridgeSignature=signature;
    })();
    this.bridgeJob=job;try{await job;}finally{if(this.bridgeJob===job)this.bridgeJob=undefined;}
  }
  consoleUrl():{url:string} {
    const u=new URL('webui/',napcatBaseUrl(this.settings().napcat.webuiUrl));
    const token=this.secret();if(token)u.searchParams.set('token',token);
    return {url:u.href};
  }
  async stop():Promise<void> {
    this.disposed=true;this.controller.abort();
    if(this.child&&this.child.exitCode===null)this.child.kill();
    await this.job;
  }
}
