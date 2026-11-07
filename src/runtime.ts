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

export class ShiguangRuntime {
  readonly file: string;
  readonly updates: UpdateManager;
  settings!: Settings; memory!: MemoryStore; bili!: BilibiliClient; driver!: ChatDriver; qq!: OneBotClient;
  media!: MediaReader;
  autonomy!:Autonomy;
  private stopped = false; private queued = 0; private tail = Promise.resolve();
  private login?: { ticket: string; key: string; expires: number };
  private lastError = '';
  constructor(readonly ctx: Context, file = '', readonly fetcher: typeof fetch = fetch) {
    this.file = ensureSettings(file); this.open(loadSettings(this.file));
    this.updates = new UpdateManager(ctx,this.settings.dataDir,fetcher);
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
    this.bili = new BilibiliClient(settings,this.memory,this.fetcher);
    this.driver = new ChatDriver(this.ctx,settings,this.memory,this.bili);
    this.media = new MediaReader(this.ctx,settings,this.memory,this.fetcher);
    this.qq = new OneBotClient(settings.qq, message => {
      void this.enqueue(async () => {
        const q=this.settings.qq,owner=!message.groupId && message.userId===q.ownerQQ;
        if (!q.enabled || (message.groupId ? !q.allowedGroups.includes(message.groupId) : !owner && !q.allowedPrivate.includes(message.userId))) return;
        const scope=owner?'owner':message.thread;
        if(this.memory.seen(message.id))return;
        let media=message.media||[];
        const mediaQuote=!!message.replyId&&wantsMedia(message.text,'ask');
        if(media.length||mediaQuote){
          const previous=this.memory.fastContext(scope,message.thread);
          if(!this.memory.append(scope,'qq',message.thread,'user',`${message.text||'发送媒体'} [QQ 媒体请求]`,message.id))return;
          let reply:string;
          try{
            if(mediaQuote&&!media.length){
              if(!this.settings.media.enabled)reply='视频和动图识别还没开启，可先在 DSH 设置 → 拾光 → QQ 识图中打开。';
              else{media=await this.qq.quotedMedia(message);reply=media.length?await this.media.reply({...message,owner,scope},this.qq,media,previous):'引用消息中没有可读取的视频、GIF 或图片，请直接发送媒体或引用包含媒体的消息。';}
            }else reply=await this.media.reply({...message,owner,scope},this.qq,media,previous);
          }catch(error){this.log(error instanceof Error?error.message:'媒体读取失败');reply=error instanceof MediaError?error.message:'媒体识别未完成，请在拾光面板检查模型、FFmpeg 和下载状态。';}
          await this.qq.send(message,reply);this.memory.append(scope,'qq',message.thread,'assistant',reply);return;
        }
        const reply = await this.driver.reply({ scope, thread: message.thread, owner, platform: 'qq', text: message.text, externalKey: message.id });
        if (!reply) return;
        await this.qq.send(message,reply);
        this.memory.append(scope,'qq',message.thread,'assistant',reply);
      }).catch((_error) => { /* enqueue reports the failure once. */ });
    },this.log,() => this.token());
    if (settings.qq.enabled) this.qq.start();
    this.autonomy=new Autonomy(this.ctx,settings,this.memory,this.bili,run=>this.enqueue(run),this.log);this.autonomy.start();
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
    return { displayName: this.settings.displayName, qq: this.settings.qq.enabled ? this.qq.status() : { state: 'disabled', message: 'QQ 回复已关闭' }, bilibili: { enabled: this.settings.bilibili.enabled, credentialSaved: this.bili.hasLogin() }, memory: this.memory.overview(), autonomy:this.autonomy.status(),day: this.memory.today(), timezone: this.settings.timezone, queued: this.queued, lastMessage: this.lastError };
  }
  async save(value: unknown, expected: string, newToken = '') {
    return this.enqueue(async () => {
      if (expected !== this.revision()) throw new Error('配置已被其他窗口修改，请先重新载入；当前编辑内容已保留');
      const next = parseSettings(value,this.file);
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
      this.autonomy.stop();this.media.stop(); await this.driver.stop(); this.qq.stop(); this.memory.close(); this.open(next); this.lastError = '';
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
    this.autonomy.stop();
    this.media.stop();
    try { await this.driver.stop(); await this.tail; } finally { this.qq.stop(); this.memory.close(); this.login=undefined; }
  }
}
