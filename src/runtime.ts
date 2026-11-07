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
import { UpdateManager } from './updates.js';
import { MediaReader, MediaError, wantsMedia } from './media.js';
import {Autonomy} from './autonomy.js';
import { NapCatManager } from './napcat.js';
import {VoiceService,wantsVoice} from './voice.js';
import {BiliVision} from './bili-vision.js';
import type {QQMessage} from './onebot.js';
import {BiliSocial} from './bili-social.js';
import {Proactive} from './proactive.js';
import {BodyClock} from './body-clock.js';
import {EmojiCollector} from './emoji-collector.js';
import {setState} from './initiative.js';

export class ShiguangRuntime {
  readonly file: string;
  readonly updates: UpdateManager;
  readonly napcat: NapCatManager;
  settings!: Settings; memory!: MemoryStore; bili!: BilibiliClient; driver!: ChatDriver; qq!: OneBotClient;
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
  private login?: { ticket: string; key: string; expires: number };
  private lastError = '';
  constructor(readonly ctx: Context, file = '', readonly fetcher: typeof fetch = fetch) {
    this.file = ensureSettings(file); this.open(loadSettings(this.file));
    this.updates = new UpdateManager(ctx,this.settings.dataDir,fetcher,()=>this.settings.updates);
    this.napcat = new NapCatManager(this.settings.dataDir,()=>this.settings,()=>this.token(),fetcher);
    this.napcat.configure();
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
    this.memory = new MemoryStore(join(settings.dataDir,'memory.sqlite'),settings.roleId,settings.timezone,settings.memory);
    this.bodyClock=new BodyClock(settings,this.memory);this.bodyClock.start();
    this.bili = new BilibiliClient(settings,this.memory,this.fetcher);
    this.biliVision=new BiliVision(this.ctx,settings,this.memory,this.bili,this.fetcher);
    this.voice=new VoiceService(settings,this.memory,()=>this.voiceSecret(),this.fetcher);
    this.driver = new ChatDriver(this.ctx,settings,this.memory,this.bili,this.biliVision);
    this.media = new MediaReader(this.ctx,settings,this.memory,this.fetcher);
    this.emoji=new EmojiCollector(this.ctx,settings,this.memory,this.media,()=>this.bodyClock.canAct());
    this.qq = new OneBotClient(settings.qq, message => {
      void this.enqueue(async () => {
        const q=this.settings.qq,owner=!message.groupId && message.userId===q.ownerQQ;
        if (!q.enabled || (message.groupId ? !q.allowedGroups.includes(message.groupId) : !owner && !q.allowedPrivate.includes(message.userId))) return;
        const scope=owner?'owner':message.thread;
        if(this.memory.seen(message.id))return;
        if(owner)setState(this.memory,'qq:last-owner',this.memory.clock());
        if(message.replyAllowed===false||!this.bodyClock.receive(message)){
          this.memory.append(scope,'qq',message.thread,'user',message.text||(message.media?.length?'收到 QQ 媒体':'收到消息'),message.id);
          if(message.replyAllowed!==false)this.memory.append(scope,'qq',message.thread,'activity','睡眠期间收到消息，未被叫醒，本次没有回复',undefined,this.memory.clock(),'sleep');
          if(message.replyAllowed===false&&this.bodyClock.canAct())await this.emoji.consider({...message,scope},this.qq).catch(e=>this.log(e instanceof Error?e.message:'挑选表情未完成'));return;
        }
        this.media.lastObservation=undefined;
        let media=message.media||[];
        const mediaQuote=!!message.replyId&&wantsMedia(message.text,'ask');
        if(media.length||mediaQuote){
          const previous=this.memory.fastContext(scope,message.thread);
          if(!this.memory.append(scope,'qq',message.thread,'user',`${message.text||'发送媒体'} [QQ 媒体请求]`,message.id))return;
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
          await this.sendReply(message,reply);this.memory.append(scope,'qq',message.thread,'assistant',reply);await this.emoji.consider({...message,scope},this.qq,this.media.lastObservation).catch(e=>this.log(e instanceof Error?e.message:'挑选表情未完成'));this.media.lastObservation=undefined;return;
        }
        const reply = await this.driver.reply({ scope, thread: message.thread, owner, platform: 'qq', text: message.text, externalKey: message.id });
        if (!reply) return;
        await this.sendReply(message,reply);
        this.memory.append(scope,'qq',message.thread,'assistant',reply);
      }).catch((_error) => { /* enqueue reports the failure once. */ });
    },this.log,() => this.token());
    if (settings.qq.enabled) this.qq.start();
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
  view(): { settings: Settings; revision: string; tokenConfigured: boolean; tokenFromEnvironment: boolean } {
    const raw = JSON.parse(readFileSync(this.file,'utf8')) as Record<string, unknown>;
    let panelToken=false;try { panelToken=!!readFileSync(this.secretFile(),'utf8').trim(); } catch { /* Token may come from environment instead. */ }
    return { settings: { ...this.settings, timezone: String(raw.timezone), dataDir: String(raw.dataDir) }, revision: this.revision(), tokenConfigured: !!this.token(), tokenFromEnvironment: !panelToken && !!(this.settings.qq.tokenEnv && process.env[this.settings.qq.tokenEnv]) };
  }
  status() {
    return { displayName: this.settings.displayName,clock:this.bodyClock.status(), qq: this.settings.qq.enabled ? this.qq.status() : { state: 'disabled', message: 'QQ 回复已关闭' }, napcat:this.napcat.view(),biliSocial:this.biliSocial.status(),proactive:this.proactive.status(),voice:this.voice.status(), bilibili: { enabled: this.settings.bilibili.enabled, credentialSaved: this.bili.hasLogin() }, memory: this.memory.overview(), autonomy:this.autonomy.status(),day: this.memory.today(), timezone: this.settings.timezone, queued: this.queued, lastMessage: this.lastError };
  }
  async save(value: unknown, expected: string, newToken = '') {
    return this.enqueue(async () => {
      if (expected !== this.revision()) throw new Error('配置已被其他窗口修改，请先重新载入；当前编辑内容已保留');
      const next = parseSettings(value,this.file);
      if(next.voice.enabled&&!this.voiceSecret())throw new Error('请先在语音页面保存 Access Token / API Key，再开启语音');
      if (resolve(next.dataDir) !== resolve(this.settings.dataDir) || next.roleId !== this.settings.roleId) throw new Error('面板不支持迁移数据目录或角色标识，请保留原值');
      if (newToken.length > 4096 || /[\r\n]/.test(newToken)) throw new Error('OneBot Token 格式无效');
      const effective = newToken.trim() || this.token(next);
      if (next.qq.enabled && !effective) throw new Error('请先填写 OneBot Token，再开启 QQ 回复');
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
      this.napcat.configure();
      return this.view();
    });
  }
  private atomicWrite(file: string, text: string): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary,text,{ mode: 0o600 }); renameSync(temporary,file);
  }
  async startLogin(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const login = await this.bili.startLogin();
    signal?.throwIfAborted();
    this.login = { ticket: randomUUID(), key: login.key, expires: Date.now()+180000 };
    return { ticket: this.login.ticket, expires: this.login.expires, image: await QRCode.toDataURL(login.url,{ width: 256, margin: 2 }) };
  }
  async pollLogin(ticket: string) {
    if (!this.login || this.login.ticket !== ticket || Date.now() >= this.login.expires) return { status: 'expired' };
    const status = await this.bili.pollLogin(this.login.key);
    if (status === 'success' || status === 'expired') this.login = undefined;
    return { status };
  }
  logoutBili(): void { this.login=undefined; this.bili.logout(); }
  async stop(): Promise<void> {
    this.stopped = true;
    this.bodyClock.stop();this.emoji.stop();this.biliSocial.stop();this.proactive.stop();this.watchAbort?.abort();
    this.voice.stop();this.biliVision.stop();
    await this.napcat.stop();
    this.autonomy.stop();
    this.media.stop();
    try { await this.driver.stop(); await this.tail; } finally { this.qq.stop(); this.memory.close(); this.login=undefined; }
  }
}
