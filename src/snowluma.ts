import {existsSync,readFileSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {join,resolve,isAbsolute,dirname} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import type {Settings} from './config.js';
export const SNOWLUMA_RELEASES='https://github.com/SnowLuma/SnowLuma/releases';
export interface SnowLumaHost {platform:string;launch(directory:string,log:string):ChildProcess;openQQ(file:string):void}
const host:SnowLumaHost={platform:process.platform,launch(directory,log){const fd=openSync(log,'a',0o600);try{return spawn([join(directory,'node.exe'),join(directory,'node','node.exe'),join(directory,'runtime','node.exe')].find(existsSync)||process.execPath,[join(directory,'index.mjs')],{cwd:directory,windowsHide:true,stdio:['ignore',fd,fd],env:{...process.env}});}finally{closeSync(fd);}},openQQ(file){const child=spawn(file,[],{cwd:dirname(file),detached:true,stdio:'ignore',windowsHide:false});child.on('error',()=>{});child.unref();}};
export class SnowLumaManager {
 private child?:ChildProcess;private phase:'idle'|'starting'|'running'|'error'='idle';private message='请先从官方下载安装 SnowLuma，再填写目录';private error='';
 constructor(readonly dataDir:string,readonly settings:()=>Settings,readonly system:SnowLumaHost=host){}
 private directory(){return this.settings().snowluma.directory.trim();}
 view(){const directory=this.directory();let version='';try{if(directory)version=String(JSON.parse(readFileSync(join(directory,'package.json'),'utf8')).version||'');}catch{}
 return {phase:this.phase,message:this.message,error:this.error,supported:this.system.platform==='win32',installed:!!directory&&isAbsolute(directory)&&existsSync(join(directory,'index.mjs')),running:!!this.child&&!this.child.killed,version,webuiUrl:this.consoleUrl().url,releaseUrl:SNOWLUMA_RELEASES};}
 consoleUrl(){const u=new URL(this.settings().snowluma.webuiUrl);if(u.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('SnowLuma 后台地址需为本机 HTTP 地址');return {url:u.href};}
 configure(){if(this.settings().snowluma.autoStart&&this.view().installed&&this.view().supported)this.start();}
 start(){if(this.system.platform!=='win32')throw new Error('本机启动按钮用于 Windows，请在 SnowLuma 运行的电脑上启动并扫码');if(this.child&&!this.child.killed){this.openQQ();return this.view();}
 const directory=this.directory();if(!directory||!isAbsolute(directory)||!existsSync(join(directory,'index.mjs')))throw new Error('请从 SnowLuma 官方下载并解压，再填写包含 index.mjs 的安装目录');
 mkdirSync(join(this.dataDir,'snowluma'),{recursive:true,mode:0o700});this.phase='starting';this.error='';
 const child=this.child=this.system.launch(resolve(directory),join(this.dataDir,'snowluma','runtime.log'));child.once('error',()=>{this.phase='error';this.error='SnowLuma 启动失败，请检查安装目录、Node 与本机日志';this.message=this.error;this.child=undefined;});child.once('exit',code=>{if(this.child===child){this.child=undefined;this.phase=code===0?'idle':'error';this.message=code===0?'SnowLuma 已退出':'SnowLuma 已退出，请打开官方后台或本机日志核实';}});
 this.phase='running';this.message='已请求启动 SnowLuma，请在 QQ 原生窗口扫码；首次设置 OneBot 后再检测连接';this.openQQ();return this.view();}
 openQQ(){const explicit=this.settings().snowluma.qqPath.trim(),candidates=[explicit,...['ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA'].flatMap(k=>process.env[k]?[join(process.env[k]!,'Tencent','QQNT','QQ.exe'),join(process.env[k]!,'Tencent','QQ','QQ.exe')]:[])].filter(Boolean),file=candidates.find(p=>isAbsolute(p)&&existsSync(p));
 if(file){if(!/(?:^|[\\/])QQ\.exe$/i.test(file))throw new Error('QQ 路径应指向官方桌面客户端 QQ.exe');this.system.openQQ(file);}else this.message='SnowLuma 已请求启动；未检测到 QQ.exe，请手动打开桌面 QQ 扫码，或补填 QQ 程序路径';return this.view();}
 async stop(){const child=this.child;this.child=undefined;if(child&&!child.killed)child.kill();this.phase='idle';}
}
