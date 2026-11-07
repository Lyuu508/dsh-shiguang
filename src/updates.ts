import {timeoutSignal} from './timeouts.js';
import type { Context } from '@deepseek-ai/cordis';
import type { PluginManager } from '@deepseek-ai/dsh-plugin-manager';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {UPDATE_DEFAULTS,mirrorBaseUrl} from './config.js';

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url),'utf8')).version;
export const REPOSITORY = 'Lyuu508/dsh-shiguang';
const BOOT = `${process.pid}:${performance.timeOrigin}`;
export interface ReleaseInfo { version: string; url: string; notes: string; published: string }
export interface UpdateState {
  current: string; latest?: ReleaseInfo; installed?: string; available: boolean; checkedAt?: number;
  phase: 'idle' | 'checking' | 'downloading' | 'installing' | 'done' | 'error';
  message: string; canInstall: boolean;
  downloaded?:number;total?:number;attempt?:number;
}
export function compareVersions(a: string, b: string): number {
  const x=a.split('.').map(Number), y=b.split('.').map(Number);
  for (let i=0;i<3;i++) {
    const difference=(x[i] ?? 0)-(y[i] ?? 0);
    if(difference) return Math.sign(difference);
  }
  return 0;
}
export class UpdateManager {
  private state: UpdateState = { current: VERSION, available: false, phase: 'idle', message: '尚未检查更新', canInstall: false };
  private job?: Promise<void>;
  private controller=new AbortController();
  constructor(readonly ctx: Context, readonly dataDir: string, readonly fetcher: typeof fetch = fetch,readonly options=()=>UPDATE_DEFAULTS) {}
  private get stateFile(): string { return join(this.dataDir,'updates','status.json'); }
  private save(): void {
    mkdirSync(join(this.dataDir,'updates'),{recursive:true,mode:0o700});
    writeFileSync(this.stateFile+'.tmp',JSON.stringify({boot:BOOT,state:this.state}),{mode:0o600});
    renameSync(this.stateFile+'.tmp',this.stateFile);
  }
  view(): UpdateState {
    // DSH can rebuild this plugin's services while its installer is still
    // resolving. The old job and the new panel share this small status file.
    try {
      const saved=JSON.parse(readFileSync(this.stateFile,'utf8'));
      if(saved.state && typeof saved.state.phase==='string') {
        this.state={...saved.state,current:VERSION};
        if(['downloading','installing','done'].includes(this.state.phase) && this.state.latest && compareVersions(VERSION,this.state.latest.version)>=0) {
          this.state={...this.state,phase:'done',available:false,message:'此版本已加载，更新完成'};
        } else if(saved.boot!==BOOT && ['checking','downloading','installing'].includes(this.state.phase)) {
          this.state={...this.state,phase:'error',message:'上次更新在进程退出前未完成，请先核实 DSH 插件版本，再重新检查更新'};
        }
      }
    } catch { /* No previous update, or a damaged status file: check again. */ }
    return { ...this.state, latest: this.state.latest && { ...this.state.latest }, canInstall: !!this.ctx.get('pluginManager') };
  }
  private async get(url: string, max: number,binary=false): Promise<Buffer> {
    const options=this.options();
    for(let attempt=1;attempt<=options.retries+1;attempt++){
    this.controller.signal.throwIfAborted();this.state.attempt=attempt;this.save();
    const target=binary&&options.mirrorUrl?mirrorBaseUrl(options.mirrorUrl).href+url:url;
    try{
    const response = await this.fetcher(target, { headers: { Accept: url.includes('api.github.com') ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'dsh-shiguang/'+VERSION },redirect:'error', signal: AbortSignal.any([this.controller.signal,timeoutSignal(binary?options.downloadTimeoutMs:options.timeoutMs)]) });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401,403,404,429].includes(response.status)) throw new Error(`GitHub 暂时无法访问（${response.status}）：请检查仓库权限或 API 限额，也可从仓库手动下载安装包`);
      throw new Error(`GitHub 下载失败（${response.status}），请稍后重试`);
    }
    if (!response.body) throw new Error('GitHub 返回空内容');
    const reader=response.body.getReader(), chunks:Uint8Array[]=[]; let length=0;
    try {
      for (;;) { const {done,value}=await reader.read(); if(done)break; length+=value.length; if(length>max)throw new Error('更新文件超出大小限制'); chunks.push(value);if(binary){this.state={...this.state,downloaded:length,total:Number(response.headers.get('content-length'))||undefined,message:`正在下载并校验安装包：${(length/1048576).toFixed(2)} MB`};this.save();} }
      return Buffer.concat(chunks);
    } finally { await reader.cancel().catch(()=>{}); }
    }catch(error){
      if(this.controller.signal.aborted)throw new Error('已取消更新网络请求，可重新检查或下载');
      const message=error instanceof Error?error.message:'';
      if(attempt>options.retries||/（(?:401|403|404|429)）|大小限制/.test(message))throw new Error(/timeout|aborted|fetch failed|network|terminated/i.test(message)?'连接 GitHub 超时或中断。可以重试、调整等待时间，或从版本页面手动安装。':message||'更新网络请求未完成');
      this.state.message=`连接未完成，正在重试（${attempt+1}/${options.retries+1}）…`;this.save();
    }
    }throw new Error('更新下载未完成');
  }
  beginCheck():UpdateState {
    this.view();
    if(this.job || ['checking','downloading','installing'].includes(this.state.phase)) return this.view();
    if(this.state.installed && compareVersions(this.state.installed,VERSION)>0) {
      this.state={...this.state,phase:'done',available:false,message:`已安装 ${this.state.installed}，请先重启 DSH 并刷新页面`};
      this.save(); return this.view();
    }
    this.controller=new AbortController();
    this.state={...this.state,phase:'checking',message:'正在后台检查 GitHub Release，可离开此页面…'};
    this.save();
    this.job=this.performCheck().finally(()=>{this.job=undefined;});return this.view();
  }
  async check():Promise<UpdateState>{
    this.view();if(this.job||['checking','downloading','installing'].includes(this.state.phase))return this.view();
    this.beginCheck();await this.job;return this.view();
  }
  private async performCheck():Promise<void>{
    try {
      // Published preview releases are included; /releases/latest excludes them.
      let data:unknown;
      try{data=JSON.parse((await this.get(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`,2*1024*1024)).toString('utf8'));}
      catch(error){if(this.controller.signal.aborted)throw error;const fallback=JSON.parse((await this.get(`https://raw.githubusercontent.com/${REPOSITORY}/main/downloads/latest.json`,65536)).toString('utf8'));if(!/^\d+\.\d+\.\d+$/.test(fallback.version))throw error;data=[{tag_name:'v'+fallback.version,body:fallback.notes,published_at:fallback.published}];}
      if(!Array.isArray(data))throw new Error('GitHub 版本列表格式无效');
      const versions:ReleaseInfo[]=data.flatMap(r=> {
        if(!r || r.draft || !/^v\d+\.\d+\.\d+$/.test(r.tag_name)) return [];
        return [{version:r.tag_name.slice(1),url:`https://github.com/${REPOSITORY}/releases/tag/${r.tag_name}`,notes:typeof r.body==='string'?r.body.slice(0,12000):'',published:typeof r.published_at==='string'?r.published_at:''}];
      }).sort((a,b)=>compareVersions(b.version,a.version));
      const latest=versions[0]; if(!latest)throw new Error('仓库暂时没有可用版本');
      const available=compareVersions(latest.version,VERSION)>0;
      this.state={...this.state,latest,available,checkedAt:Date.now(),phase:'idle',message:available?`发现新版本 ${latest.version}`:'当前已是最新版本'};
    } catch(error) { this.state={...this.state,phase:'error',message:error instanceof Error?error.message:'检查更新失败'}; }
    this.save();
  }
  cancel():UpdateState{this.view();if(['checking','downloading'].includes(this.state.phase))this.controller.abort();return this.view();}
  start(version: string): UpdateState {
    this.view();
    if(this.job)return this.view();
    if(this.state.phase==='done')return this.view();
    if(this.state.phase!=='idle' || !this.state.available || !this.state.latest || version!==this.state.latest.version)throw new Error('请先检查更新，再安装列表中的新版本');
    const installer=this.ctx.get('pluginManager');
    if(!installer)throw new Error('当前 DSH 未启用插件管理服务，请在插件管理中启用，或从版本页面手动安装');
    this.controller=new AbortController();
    this.state={...this.state,phase:'downloading',message:'正在后台下载并校验安装包…',downloaded:0,total:undefined};
    this.save();
    this.job=this.install(version,installer).catch(error=>{
      this.state={...this.state,phase:'error',message:error instanceof Error?error.message:'更新未完成'};
      try { this.save(); } catch { this.state.message+='；更新状态无法写入磁盘'; }
    }).finally(()=>{this.job=undefined;});
    return this.view();
  }
  private async install(version: string, installer: Pick<PluginManager,'installBundle'>): Promise<void> {
    const base=`https://raw.githubusercontent.com/${REPOSITORY}/refs/tags/v${version}/downloads/`;
    const filename=`dsh-shiguang-${version}.tgz`;
    const sums=(await this.get(base+`SHA256SUMS-${version}.txt`,16384)).toString('utf8');
    const expected=sums.split(/\r?\n/).map(line=>line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)).find(m=>m?.[2]===filename)?.[1]?.toLowerCase();
    if(!expected)throw new Error('版本缺少有效 SHA256 校验记录，已停止安装');
    const bytes=await this.get(base+filename,32*1024*1024,true);
    if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('安装包 SHA256 校验失败，已停止安装，请重新检查更新');
    this.controller.signal.throwIfAborted();
    const directory=join(this.dataDir,'updates',version); await mkdir(directory,{recursive:true,mode:0o700});
    const file=join(directory,filename); await writeFile(file+'.tmp',bytes,{mode:0o600}); await rename(file+'.tmp',file);
    this.state={...this.state,phase:'installing',message:'校验通过，DSH 正在安装；请等待完成…'};
    this.save();
    // Never remove the running bundle first. DSH owns profile locking and activation.
    // A new local tarball can replace a bundle; startup-only profiles require restart.
    const result=await installer.installBundle(file,{enabled:true,saveExact:true});
    if(result.application==='failed'||result.application==='cancelled'||result.error)throw new Error(`DSH 安装未完成${result.error?.code?'（'+result.error.code+'）':''}，请查看 DSH 插件管理中的诊断后重试`);
    if(result.version && result.version!==version)throw new Error('DSH 返回的安装版本不符，请在插件管理中核实后重启');
    this.state={...this.state,phase:'done',installed:version,available:false,message:result.application==='applied'?'安装完成，请刷新页面；若版本未变化，请重启 DSH':'安装包已写入，请重启 DSH 并刷新页面完成更新'};
    this.save();
  }
  async whenIdle(): Promise<void> { await this.job; }
}
