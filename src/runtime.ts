import type { Context } from '@deepseek-ai/cordis';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { ensureSettings, loadSettings, parseSettings, type Settings } from './config.js';
import { MemoryStore } from './memory.js';
import { BilibiliClient } from './bilibili.js';
import { OneBotClient } from './onebot.js';
import { ChatDriver } from './agent.js';
import { UpdateManager,VERSION } from './updates.js';
import { MediaReader, MediaError, wantsMedia } from './media.js';
import {Autonomy} from './autonomy.js';
import { SnowLumaManager,type SnowLumaHost } from './snowluma.js';
import {VoiceService,wantsVoice} from './voice.js';
import {BiliVision} from './bili-vision.js';
import type {QQMessage} from './onebot.js';
import {BiliSocial} from './bili-social.js';
import {Proactive} from './proactive.js';
import {BodyClock} from './body-clock.js';
import {EmojiCollector} from './emoji-collector.js';
import {MediaToolsManager,type ToolPaths,type MediaToolsHost} from './media-tools.js';
import {RoleManager} from './roles.js';
import {locatePrograms,type LocatorHost} from './discovery.js';
import {flashRoute} from './model-route.js';
import {setState,stateValue} from './initiative.js';

export class ShiguangRuntime {
  readonly file: string;
  readonly updates: UpdateManager;
  readonly roles:RoleManager;readonly mediaTools:MediaToolsManager;
  private retentionTimer?:NodeJS.Timeout;private connectionTimer?:NodeJS.Timeout;private syncBusy=false;private setupJob?:Promise<void>;
  qqSetup={phase:'idle',message:'先填主人 QQ 号，再自动定位并启动',busy:false};
  readonly snowluma: SnowLumaManager;
  settings!: Settings; memory!: MemoryStore; bili!: BilibiliClient;ownerBili!:BilibiliClient; driver!: ChatDriver; qq!: OneBotClient;
  media!: MediaReader;
  autonomy!:Autonomy;
  voice!:VoiceService;
  biliVision!:BiliVision;
  biliSocial!:BiliSocial;
  proactive!:Proactive;
  bodyClock!:BodyClock;emoji!:EmojiCollector;
  watchJob:{id:string;status:'idle'|'running'|'done'|'error';text:string}={id:'',status:'idle',text:''};
  private watchAbort?:AbortController;
  private stopped = false; private queued = 0; private tail = Promise.resolve();
  interestJob:{status:'idle'|'running'|'done'|'error';tags:{tag:string;count:number}[];message:string}={status:'idle',tags:[],message:''};
  private interestAbort?:AbortController;
  private ownerLogin?:{ticket:string;key:string;expires:number};
  private login?: { ticket: string; key: string; expires: number };
  private lastError = '';
  constructor(readonly ctx: Context, file = '', readonly fetcher: typeof fetch = fetch,readonly services:{snowHost?:SnowLumaHost;locator?:LocatorHost;mediaHost?:MediaToolsHost;localFetch?:typeof fetch}={}) {
    this.file = ensureSettings(file);const settings=loadSettings(this.file);this.roles=new RoleManager(settings.dataDir);this.roles.remember(settings);this.mediaTools=new MediaToolsManager(settings.dataDir,()=>this.settings,paths=>this.applyMediaPaths(paths),fetcher,this.services.mediaHost,()=>this.locateMediaOnly());this.open(settings);
    this.updates = new UpdateManager(ctx,this.settings.dataDir,fetcher,()=>this.settings.updates);
    this.snowluma=new SnowLumaManager(this.settings.dataDir,()=>this.settings,this.services.snowHost,this.services.localFetch);
    this.snowluma.configure();this.connectionTimer=setInterval(()=>void this.syncQQConnection().catch(()=>{}),3000);this.connectionTimer.unref();
  }
  private log = (message: string) => { this.lastError = message; console.info(`[Shiguang] ${message}`); };
  private secretFile(): string { return join(this.settings.dataDir,'onebot.token'); }
  private token(settings = this.settings): string {
    let stored = '';
    try { stored = readFileSync(join(settings.dataDir,'onebot.token'),'utf8').trim(); } catch { /* No panel-managed token yet. */ }
    return stored || (settings.qq.tokenEnv ? process.env[settings.qq.tokenEnv] || '' : '');
  }
  private open(settings: Settings): void {
    this.settings = settings;
    this.memory = new MemoryStore(join(settings.dataDir,'memory.sqlite'),settings.roleId,settings.timezone,settings.memory,Date.now,settings.retention);
    this.memory.sweep();if(this.retentionTimer)clearInterval(this.retentionTimer);this.retentionTimer=setInterval(()=>this.memory.sweep(),3600000);this.retentionTimer.unref();
    this.bodyClock=new BodyClock(settings,this.memory);this.bodyClock.start();
    this.bili = new BilibiliClient(settings,this.memory,this.fetcher);this.ownerBili=new BilibiliClient(settings,this.memory,this.fetcher,'owner');
    this.biliVision=new BiliVision(this.ctx,settings,this.memory,this.bili,this.fetcher,()=>this.mediaTools.ensure());
    this.voice=new VoiceService(settings,this.memory,()=>this.voiceSecret(),this.fetcher);
    this.driver = new ChatDriver(this.ctx,settings,this.memory,this.bili,this.biliVision);
    this.media = new MediaReader(this.ctx,settings,this.memory,this.fetcher,()=>this.mediaTools.ensure());
    this.emoji=new EmojiCollector(this.ctx,settings,this.memory,this.media,()=>this.bodyClock.canAct());
    this.qq = new OneBotClient(settings.qq, message => {
      void this.enqueue(async () => {
        const q=this.settings.qq,owner=!message.groupId && message.userId===q.ownerQQ;
        if(message.groupId?!q.allowedGroups.includes(message.groupId):!owner&&!q.allowedPrivate.includes(message.userId))return;
        const scope=owner?'owner':message.thread;
        if(this.memory.seen(message.id))return;
        if(owner)setState(this.memory,'qq:last-owner',this.memory.clock());
        if(message.keyword&&!message.mentioned){const last=stateValue<number>(this.memory,'keyword:'+message.thread,0),accepted=q.keywordWakeEnabled&&this.memory.clock()-last>=q.keywordCooldownSeconds*1000&&Math.random()*100<q.keywordWakeChance;message.keywordAwakened=accepted;if(q.groupMentionOnly)message.replyAllowed=accepted;}
        if(!q.enabled||message.replyAllowed===false||!this.bodyClock.receive(message)){
          this.memory.append(scope,'qq',message.thread,'user',message.text||(message.media?.length?'收到 QQ 媒体':'收到消息'),message.id,this.memory.clock(),'',{turnId:message.id,speakerId:message.userId,speakerName:message.speakerName});
          if(q.enabled&&message.replyAllowed!==false)this.memory.append(scope,'qq',message.thread,'activity','睡眠期间收到消息，未被叫醒，本次没有回复',undefined,this.memory.clock(),'sleep');
          if(q.enabled&&message.replyAllowed===false&&this.bodyClock.canAct())await this.emoji.consider({...message,scope},this.qq).catch(e=>this.log(e instanceof Error?e.message:'挑选表情未完成'));return;
        }
        if(message.keywordAwakened)setState(this.memory,'keyword:'+message.thread,this.memory.clock());
        this.media.lastObservation=undefined;
        let media=message.media||[];
        const mediaQuote=!!message.replyId&&wantsMedia(message.text,'ask');
        if(media.length||mediaQuote){
          const previous=this.memory.fastContext(scope,message.thread);
          if(!this.memory.append(scope,'qq',message.thread,'user',`${message.text||'发送媒体'} [QQ 媒体请求]`,message.id,this.memory.clock(),'',{turnId:message.id,speakerId:message.userId,speakerName:message.speakerName}))return;
          // A standalone face can be collected independently of the chat vision toggle.
          if(this.settings.emoji.enabled&&!this.settings.media.enabled&&!message.text&&media.length&&media.every(m=>m.type==='image'&&m.emoji)){
            await this.emoji.consider({...message,scope},this.qq).catch(e=>this.log(e instanceof Error?e.message:'挑选表情未完成'));return;
          }
          let reply:string;
          try{
            if(mediaQuote&&!media.length){
              if(!this.settings.media.enabled)reply='视频和动图识别还没开启，可先在 DSH 设置 → 拾光 → QQ 连接 → QQ 识图中打开。';
              else{media=await this.qq.quotedMedia(message);reply=media.length?await this.media.reply({...message,owner,scope},this.qq,media,previous):'引用消息中没有可读取的视频、GIF 或图片，请直接发送媒体或引用包含媒体的消息。';}
            }else reply=await this.media.reply({...message,owner,scope},this.qq,media,previous);
          }catch(error){this.log(error instanceof Error?error.message:'媒体读取失败');reply=error instanceof MediaError?error.message:'媒体识别未完成，请在拾光面板检查模型、FFmpeg 和下载状态。';}
          await this.sendReply(message,reply);this.memory.recordReply(scope,'qq',message.thread,reply,message.id,message.selfId,this.settings.displayName);await this.emoji.consider({...message,scope},this.qq,this.media.lastObservation).catch(e=>this.log(e instanceof Error?e.message:'挑选表情未完成'));this.media.lastObservation=undefined;return;
        }
        const reply = await this.driver.reply({ scope, thread: message.thread, owner, platform: 'qq', text: message.text, externalKey: message.id,turnId:message.id,speakerId:message.userId,speakerName:message.speakerName });
        if (!reply) return;
        await this.sendReply(message,reply);
        this.memory.recordReply(scope,'qq',message.thread,reply,message.id,message.selfId,this.settings.displayName);
      }).catch((_error) => { /* enqueue reports the failure once. */ });
    },this.log,() => this.token());
    this.qq.start();
    this.autonomy=new Autonomy(this.ctx,settings,this.memory,this.bili,run=>this.enqueue(run),this.log,this.biliVision,()=>this.bodyClock.canAct());this.autonomy.start();
    this.biliSocial=new BiliSocial(settings,this.memory,this.bili,this.driver,run=>this.enqueue(run),this.log,()=>this.bodyClock.canAct());this.biliSocial.start();
    this.proactive=new Proactive(this.ctx,settings,this.memory,this.qq,run=>this.enqueue(run),this.log,Math.random,()=>this.bodyClock.canAct());this.proactive.start();
  }
  startWatch(video:string,question:string,part:number,depth:'shallow'|'deep'){
    if(this.watchJob.status==='running')return {...this.watchJob};const id=randomUUID(),abort=this.watchAbort=new AbortController();this.watchJob={id,status:'running',text:'正在后台读取视频，可以离开此页面'};
    void this.enqueue(()=>this.biliVision.watch(video,question,part,abort.signal,depth)).then(text=>{this.watchJob={id,status:'done',text};},error=>{this.watchJob={id,status:'error',text:abort.signal.aborted?'已停止视频识别':error instanceof Error?(/timeout|aborted/i.test(error.message)?'视频识别等待时间已到，可提高处理等待时间或选择浅看':error.message):'视频识别未完成'};});return {...this.watchJob};
  }
  cancelWatch(){this.watchAbort?.abort();return {...this.watchJob};}
  private voiceSecret():string {try{return readFileSync(join(this.settings.dataDir,'voice.access-key'),'utf8').trim();}catch{return '';}}
  async saveVoiceSecret(secret:string){
    if(!secret.trim()||secret.length>4096||/[\s\0]/.test(secret))throw new Error('语音密钥格式无效，请填写语音服务的 Access Token / API Key');
    this.atomicWrite(join(this.settings.dataDir,'voice.access-key'),secret.trim());return this.voice.status();
  }
  private async sendReply(message:QQMessage,reply:string):Promise<void>{
    const v=this.settings.voice;
    if(!v.enabled||message.groupId&&!v.allowGroups||!wantsVoice(message.text,v.mode)){await this.qq.send(message,reply);return;}
    if(v.sendText)await this.qq.send(message,reply);
    let audio;
    try{audio=await this.voice.synthesize(reply,message.scope);}catch(error){
      this.log(error instanceof Error?error.message:'语音合成未完成');
      if(!v.sendText)await this.qq.send(message,reply+'\n（语音生成未完成，本次使用文字。）');return;
    }
    // Once a platform send starts, an unknown receipt must not cause a resend.
    await this.qq.sendVoice(message,audio.bytes);
  }
  enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('拾光正在停止'));
    if (this.queued >= this.settings.maxQueue) return Promise.reject(new Error('待处理消息已满，请稍后再试'));
    this.queued++;
    const task = this.tail.then(() => { if (this.stopped) throw new Error('拾光正在停止'); return run(); });
    this.tail = task.then(() => {},error => this.log(error instanceof Error ? error.message : '操作失败')).finally(() => { this.queued--; });
    return task;
  }
  revision(): string { return createHash('sha256').update(readFileSync(this.file)).digest('hex'); }
  view(): { settings: Settings; revision: string; tokenConfigured: boolean; tokenFromEnvironment: boolean;roles:ReturnType<RoleManager['list']> } {
    const raw = JSON.parse(readFileSync(this.file,'utf8')) as Record<string, unknown>;
    let panelToken=false;try { panelToken=!!readFileSync(this.secretFile(),'utf8').trim(); } catch { /* Token may come from environment instead. */ }
    return {roles:this.roles.list(this.settings.roleId), settings: { ...this.settings, timezone: String(raw.timezone), dataDir: String(raw.dataDir) }, revision: this.revision(), tokenConfigured: !!this.token(), tokenFromEnvironment: !panelToken && !!(this.settings.qq.tokenEnv && process.env[this.settings.qq.tokenEnv]) };
  }
  status() {
    return {revision:this.revision(),version:VERSION,roleId:this.settings.roleId, displayName: this.settings.displayName,clock:this.bodyClock.status(),mediaTools:this.mediaTools.view(), qq:{...this.qq.status(),repliesEnabled:this.settings.qq.enabled}, snowluma:this.snowluma.view(),biliSocial:this.biliSocial.status(),proactive:this.proactive.status(),voice:this.voice.status(), bilibili: { enabled: this.settings.bilibili.enabled, credentialSaved: this.bili.hasLogin(),ownerCredentialSaved:this.ownerBili.hasLogin() }, memory: this.memory.overview(), autonomy:this.autonomy.status(),day: this.memory.today(), timezone: this.settings.timezone, queued: this.queued, lastMessage: this.lastError };
  }
  async save(value: unknown, expected: string, newToken = '', allowRole=false) {
    return this.enqueue(async () => {
      if (expected !== this.revision()) throw new Error('配置已被其他窗口修改，请先重新载入；当前编辑内容已保留');
      const next = parseSettings(value,this.file);
      if(next.voice.enabled&&!this.voiceSecret())throw new Error('请先在语音页面保存 Access Token / API Key，再开启语音');
      if (resolve(next.dataDir) !== resolve(this.settings.dataDir) || !allowRole&&next.roleId !== this.settings.roleId) throw new Error('面板不支持迁移数据目录或角色标识，请保留原值');
      if (newToken.length > 4096 || /[\r\n]/.test(newToken)) throw new Error('OneBot Token 格式无效');
      const effective = newToken.trim() || this.token(next);
      // A local SnowLuma token is synchronized automatically after login.
      if(next.qq.enabled&&!next.qq.ownerQQ)throw new Error('请先填写主人 QQ 号');
      const raw = value as Record<string,unknown>;
      const document = { ...next, timezone: raw.timezone, dataDir: raw.dataDir };
      const secretPath = this.secretFile(), previousToken = existsSync(secretPath) ? readFileSync(secretPath,'utf8') : null;
      if (newToken.trim()) this.atomicWrite(secretPath,newToken.trim());
      try {
        copyFileSync(this.file,`${this.file}.bak`);
        this.atomicWrite(this.file,JSON.stringify(document,null,2)+'\n');
      } catch (error) {
        if (newToken.trim()) this.atomicWrite(secretPath,previousToken || '');
        throw error;
      }
      this.bodyClock.stop();this.emoji.stop();this.biliSocial.stop();this.proactive.stop();this.autonomy.stop();this.media.stop();this.biliVision.stop();this.voice.stop(); await this.driver.stop(); this.qq.stop(); this.memory.close(); this.open(next); this.lastError = '';
      this.roles.remember(this.settings);this.snowluma.configure();
      return this.view();
    });
  }
  async createRole(name:string,persona:string,copy:boolean,revision:string){if(revision!==this.revision())throw new Error('配置已变化，请重新载入再新建角色');this.roles.remember(this.settings);const id=this.roles.create(this.settings,name,persona,copy);return this.switchRole(id,revision);}
  async switchRole(id:string,revision:string){this.roles.remember(this.settings);const view=this.view();const next=this.roles.settingsFor(this.settings,id);return this.save({...next,dataDir:view.settings.dataDir,timezone:view.settings.timezone},revision,'',true);}
  async modelStatus(){try{return {ready:true,...await flashRoute(this.ctx),name:'DeepSeek Flash（跟随官方最新）',message:'使用 DSH 中的 DeepSeek 连接，不需要在拾光填写模型或密钥'};}catch(e){return {ready:false,model:'deepseek-flash',name:'DeepSeek Flash（跟随官方最新）',message:e instanceof Error?e.message:'请先在 DSH 登录 DeepSeek'};}}
  async locateLocal(){const found=await locatePrograms(this.settings,this.services.locator);if(this.stopped)throw new Error('拾光正在停止');const raw=JSON.parse(readFileSync(this.file,'utf8'));raw.snowluma={...this.settings.snowluma,...Object.fromEntries(['directory','qqPath'].filter(k=>found[k as keyof typeof found]).map(k=>[k,found[k as keyof typeof found]]))};if(found.ffmpegPath&&found.ffprobePath)raw.media={...raw.media,ffmpegPath:found.ffmpegPath,ffprobePath:found.ffprobePath};parseSettings(raw,this.file);this.atomicWrite(this.file,JSON.stringify(raw,null,2)+'\n');Object.assign(this.settings.snowluma,raw.snowluma);if(found.ffmpegPath&&found.ffprobePath)Object.assign(this.settings.media,{ffmpegPath:found.ffmpegPath,ffprobePath:found.ffprobePath});return {...this.view(),found,message:`已检查 ${found.scanned} 个常用目录；${found.directory?'找到 SnowLuma':'未找到 SnowLuma'}，${found.qqPath?'找到桌面 QQ':'未找到桌面 QQ'}，${found.ffmpegPath&&found.ffprobePath?'找到视频工具':'未找到完整视频工具'}`};}
  private async locateMediaOnly(){const found=await locatePrograms(this.settings,this.services.locator);if(this.stopped)throw new Error('拾光正在停止');if(found.ffmpegPath&&found.ffprobePath)this.applyMediaPaths({ffmpegPath:found.ffmpegPath,ffprobePath:found.ffprobePath});}
  async syncQQConnection(){if(this.stopped||this.syncBusy||!this.settings.snowluma.directory)return;const connection=this.snowluma.connection();if(!connection||connection.url===this.settings.qq.wsUrl&&connection.token===this.token())return;this.syncBusy=true;try{const current=this.view();await this.save({...current.settings,qq:{...current.settings.qq,wsUrl:connection.url}},current.revision,connection.token);}finally{this.syncBusy=false;}}
  startQQSetup(){if(this.setupJob)return {...this.qqSetup};this.qqSetup={phase:'locating',message:'正在快速查找 SnowLuma、QQ 与视频工具',busy:true};this.setupJob=(async()=>{await this.locateLocal();if(this.stopped)throw new Error('拾光正在停止');if(!this.snowluma.view().installed)throw new Error('未找到 SnowLuma。请点“下载官方 SnowLuma”，解压后再点自动定位');await this.snowluma.prepareConnection();this.qqSetup={phase:'starting',message:'正在启动 SnowLuma 与桌面 QQ',busy:true};if(await this.snowluma.reachable()){this.snowluma.openQQ();}else this.snowluma.start();await this.syncQQConnection();if(this.snowluma.view().supported){for(let attempt=0;attempt<12&&!this.stopped;attempt++){if(await this.snowluma.reachable()){try{this.snowluma.openBackend();}catch{}break;}await new Promise(r=>setTimeout(r,250));}}if(this.stopped)throw new Error('拾光正在停止');this.qqSetup={phase:'done',message:'已请求启动。请在桌面 QQ 扫码；登录后自动同步连接，无需填写地址与 Token。后台凭据可在下方显示或复制。',busy:false};})().catch(e=>{this.qqSetup={phase:'error',message:e instanceof Error?e.message:'QQ 准备未完成',busy:false};}).finally(()=>this.setupJob=undefined);return {...this.qqSetup};}
  private applyMediaPaths(paths:ToolPaths){const raw=JSON.parse(readFileSync(this.file,'utf8'));raw.media={...raw.media,...paths};parseSettings(raw,this.file);this.atomicWrite(this.file,JSON.stringify(raw,null,2)+'\n');Object.assign(this.settings.media,paths);}
  private atomicWrite(file: string, text: string): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary,text,{ mode: 0o600 }); renameSync(temporary,file);
  }
  async startLogin(signal?: AbortSignal,target:'companion'|'owner'='companion') {
    signal?.throwIfAborted();
    const login = await (target==='owner'?this.ownerBili:this.bili).startLogin();
    signal?.throwIfAborted();
    const session = { ticket: randomUUID(), key: login.key, expires: Date.now()+180000 };
    if(target==='owner')this.ownerLogin=session;else this.login=session;
    return { ticket: session.ticket, expires: session.expires, image: await QRCode.toDataURL(login.url,{ width: 256, margin: 2 }) };
  }
  async startInterestScan(count:number){
    if(this.interestJob.status==='running')return {...this.interestJob};
    const abort=this.interestAbort=new AbortController();this.interestJob={status:'running',tags:[],message:'正在读取主人最近观看的标签，不调用模型'};
    // Read-only platform work does not occupy the QQ message queue or write memory.
    void this.ownerBili.recentInterestTags(count,abort.signal).then(result=>{if(this.interestAbort===abort)this.interestJob={status:'done',tags:result.tags,message:`已读取 ${result.videos} 个最近视频，${result.failed} 个未取得标签；请选择想加入的主题`};}).catch(e=>{if(this.interestAbort===abort)this.interestJob={status:'error',tags:[],message:e instanceof Error?e.message:'兴趣读取未完成'};});
    return {...this.interestJob};
  }
  logoutOwnerBili(){this.interestAbort?.abort();this.interestAbort=undefined;this.ownerLogin=undefined;this.ownerBili.logout();this.interestJob={status:'idle',tags:[],message:'主人凭据已停用'};}
  async pollOwnerLogin(ticket:string){if(!this.ownerLogin||this.ownerLogin.ticket!==ticket||Date.now()>=this.ownerLogin.expires)return {status:'expired'};const status=await this.ownerBili.pollLogin(this.ownerLogin.key);if(status==='success'||status==='expired')this.ownerLogin=undefined;return {status};}
  async pollLogin(ticket: string) {
    if (!this.login || this.login.ticket !== ticket || Date.now() >= this.login.expires) return { status: 'expired' };
    const status = await this.bili.pollLogin(this.login.key);
    if (status === 'success' || status === 'expired') this.login = undefined;
    return { status };
  }
  logoutBili(): void { this.login=undefined; this.bili.logout(); }
  async stop(): Promise<void> {
    this.interestAbort?.abort();this.mediaTools.stop();this.stopped = true;if(this.connectionTimer)clearInterval(this.connectionTimer);await this.setupJob;if(this.retentionTimer)clearInterval(this.retentionTimer);
    this.bodyClock.stop();this.emoji.stop();this.biliSocial.stop();this.proactive.stop();this.watchAbort?.abort();
    this.voice.stop();this.biliVision.stop();
    await this.snowluma.stop();
    this.autonomy.stop();
    this.media.stop();
    try { await this.driver.stop(); await this.tail; } finally { this.qq.stop(); this.memory.close(); this.login=undefined; }
  }
}
