import {scheduleTimeout,type ScheduledTimer} from './timeouts.js';
import WebSocket from 'ws';
import {cancellablePause} from './qq-conversation.js';
import { randomUUID } from 'node:crypto';
import type { Settings } from './config.js';

export interface QQMessage {
  id: string; selfId: string; userId: string; groupId?: string;
  thread: string; scope: string; owner: boolean; text: string;
  ownerMessage?:boolean;memoryId?:string;receivedAt?:number;speakerName?:string;keyword?:string;keywordAwakened?:boolean;media?: QQMediaRef[]; replyId?: string;mentioned?:boolean;replyAllowed?:boolean;
}
export interface QQMediaRef { type: 'video' | 'image'; file?: string; url?: string;emoji?:boolean }
type JsonObject = Record<string, unknown>;
function record(v: unknown): v is JsonObject { return !!v && typeof v === 'object' && !Array.isArray(v); }
function id(v: unknown): string | null { return (typeof v === 'string' && /^\d+$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) ? String(v) : null; }
export function mediaSegments(segments: unknown): QQMediaRef[] {
  if(!Array.isArray(segments))return [];
  return segments.flatMap(segment=>{
    if(!record(segment)||!record(segment.data)||!['video','image'].includes(String(segment.type)))return [];
    const rawFile=segment.data.file_id||segment.data.file;
    const file=typeof rawFile==='string'&&rawFile.length<=1024?rawFile:undefined;
    const rawURL=segment.data.url||segment.data.file;const url=typeof rawURL==='string'&&/^https?:\/\//i.test(rawURL)&&rawURL.length<=4096?rawURL:undefined;
    return file||url?[{type:segment.type as QQMediaRef['type'],file,url,emoji:segment.data.sub_type===1||segment.data.sub_type==='1'||typeof segment.data.summary==='string'&&segment.data.summary.includes('表情')||!!file&&/\.gif$/i.test(file)}]:[];
  }).slice(0,4);
}
export function parseMessage(value: unknown, config: Settings['qq'],includePassive=false): QQMessage | null {
  if (!record(value) || value.post_type !== 'message' || !['private', 'group'].includes(String(value.message_type))) return null;
  const userId = id(value.user_id), selfId = id(value.self_id);
  const messageId = typeof value.message_id === 'string' || typeof value.message_id === 'number' ? String(value.message_id) : null;
  if (!userId || !selfId || !messageId || userId === selfId) return null;
  const groupId = value.message_type === 'group' ? id(value.group_id) : undefined;
  if (value.message_type === 'group' && !groupId) return null;
  const owner = !groupId && userId === config.ownerQQ;
  if (groupId ? !config.allowedGroups.includes(groupId) : !owner && !config.allowedPrivate.includes(userId)) return null;
  // Array format prevents untrusted CQ text from being interpreted as a command.
  if (!Array.isArray(value.message)) return null;
  let mentioned = false; const parts: string[] = []; let replyId: string | undefined;
  for (const segment of value.message) {
    if (!record(segment) || !record(segment.data)) continue;
    if (segment.type === 'text' && typeof segment.data.text === 'string') parts.push(segment.data.text);
    if (segment.type === 'at' && String(segment.data.qq) === selfId) mentioned = true;
    if (segment.type === 'reply' && /^-?\d{1,24}$/.test(String(segment.data.id))) replyId=String(segment.data.id);
  }
  const text = parts.join('').trim();
  const keyword=groupId&&config.keywordWakeEnabled?config.wakeWords.find(word=>text.normalize('NFKC').toLowerCase().includes(word.normalize('NFKC').toLowerCase())):undefined;
  if(groupId&&config.groupMentionOnly&&!mentioned&&!keyword&&!includePassive)return null;
  const sender=record(value.sender)?value.sender:{};const speakerName=String(sender.card||sender.nickname||userId).replace(/[\x00-\x1f\x7f]/g,'').slice(0,80);
  const media=mediaSegments(value.message);
  if ((!text && !media.length) || text.length > 10000) return null;
  const thread = groupId ? `qq:group:${groupId}` : `qq:private:${userId}`;
  return { id: `${selfId}:${thread}:${messageId}`, selfId, userId, groupId: groupId || undefined, thread, scope: owner ? 'owner' : thread, owner, ownerMessage:userId===config.ownerQQ, text, speakerName,keyword,media, replyId,mentioned,replyAllowed:!groupId||!config.groupMentionOnly||mentioned||!!keyword };
}

export class OneBotClient {
  private socket?: WebSocket;
  private stopped = false;
  private retry?: ScheduledTimer;
  private state: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  private statusMessage = '尚未连接';
  private heartbeat?:NodeJS.Timeout;private lastPacketAt=0;private lastMessageAt=0;private connectedAt=0;private disconnectedAt=0;private closeCode=0;private reconnectAttempts=0;private nextRetryAt=0;private connectionError='';
  private pending = new Map<string, { resolve: (v: JsonObject|unknown[]) => void; reject: (e: Error) => void; timer: ScheduledTimer }>();
  constructor(public config: Settings['qq'], public onMessage: (message: QQMessage) => void, readonly log: (message: string) => void, readonly token = () => process.env[config.tokenEnv] || '') {}
  status() { return {state:this.state,message:this.statusMessage,lastPacketAt:this.lastPacketAt,lastMessageAt:this.lastMessageAt,connectedAt:this.connectedAt,disconnectedAt:this.disconnectedAt,closeCode:this.closeCode,reconnectAttempts:this.reconnectAttempts,nextRetryAt:this.nextRetryAt,error:this.connectionError}; }
  configure(config:Settings['qq'],onMessage=this.onMessage){this.config=config;this.onMessage=onMessage;}
  reconnect(){
    this.retry?.clear();this.nextRetryAt=0;if(this.heartbeat)clearInterval(this.heartbeat);
    const old=this.socket;this.socket=undefined;this.state='disconnected';
    for(const request of this.pending.values()){request.timer.clear();request.reject(new Error('QQ 连接配置更新，发送结果未知；请到 QQ 核实，插件不会自动重发'));}this.pending.clear();old?.terminate();this.start();
  }
  start(): void {
    if(this.stopped||this.socket&&(this.socket.readyState===WebSocket.OPEN||this.socket.readyState===WebSocket.CONNECTING))return;
    this.retry?.clear();this.nextRetryAt=0;
    if(!this.token()){this.statusMessage='等待 SnowLuma 自动同步连接，请先一键启动并扫码';return;}
    this.state='connecting';this.statusMessage='正在连接 SnowLuma';this.reconnectAttempts++;
    const socket=new WebSocket(this.config.wsUrl,{headers:{Authorization:`Bearer ${this.token()}`},maxPayload:1024*1024,handshakeTimeout:0});
    this.socket=socket;const handshake=scheduleTimeout(()=>{if(this.socket===socket)this.connectionError='SnowLuma 连接握手超时';socket.terminate();},this.config.actionTimeoutMs);
    const alive=()=>{if(this.socket===socket)this.lastPacketAt=Date.now();};
    socket.on('open',()=>{handshake.clear();if(this.socket!==socket||this.stopped)return;this.state='connected';this.connectedAt=Date.now();this.lastPacketAt=this.connectedAt;this.connectionError='';this.statusMessage='OneBot 桥接已连接';this.log('QQ OneBot 已连接');
      if(this.heartbeat)clearInterval(this.heartbeat);this.heartbeat=setInterval(()=>{if(this.socket!==socket||socket.readyState!==WebSocket.OPEN)return;if(Date.now()-this.lastPacketAt>65000){this.connectionError='桥接超过 65 秒未回应心跳，正在恢复连接';socket.terminate();}else socket.ping();},30000);this.heartbeat.unref();
    });
    socket.on('pong',alive);socket.on('ping',alive);
    socket.on('message',raw=>{
      if(this.socket!==socket||this.stopped)return;alive();let value:unknown;
      try{value=JSON.parse(raw.toString());}catch{this.log('忽略无效的 OneBot JSON');return;}
      if(!record(value))return;
      if(typeof value.echo==='string'&&this.pending.has(value.echo)){
        const request=this.pending.get(value.echo)!;request.timer.clear();this.pending.delete(value.echo);
        if(value.status==='ok'&&value.retcode===0&&(record(value.data)||Array.isArray(value.data)))request.resolve(value.data);
        else request.reject(new Error(`QQ 操作未成功，retcode=${String(value.retcode)}；请检查 SnowLuma 日志`));return;
      }
      const message=parseMessage(value,this.config,true);if(message){this.lastMessageAt=Date.now();this.onMessage(message);}
    });
    socket.on('error',(error:Error & {code?:string})=>{if(this.socket!==socket||this.stopped)return;this.connectionError=error.code==='ECONNREFUSED'?'SnowLuma 消息接口未启动或已经退出':/401|403/.test(error.message)?'SnowLuma 拒绝鉴权，请同步消息密钥':error.code==='ENOTFOUND'?'无法定位 SnowLuma 消息地址':'SnowLuma 连接异常，请检查桥接进程与 QQ 登录状态';this.log(this.connectionError);});
    socket.on('close',(code)=>{handshake.clear();if(this.socket!==socket)return;if(this.heartbeat)clearInterval(this.heartbeat);this.socket=undefined;this.state='disconnected';this.disconnectedAt=Date.now();this.closeCode=code;
      this.statusMessage=this.stopped?'连接已停止':`桥接已断开（${code}），将在 ${Math.ceil(this.config.reconnectMs/1000)} 秒后重连`;
      for(const request of this.pending.values()){request.timer.clear();request.reject(new Error('QQ 连接断开，发送结果未知；请到 QQ 核实，插件不会自动重发'));}this.pending.clear();
      if(!this.stopped){this.log(this.connectionError||this.statusMessage);this.nextRetryAt=Date.now()+this.config.reconnectMs;this.retry=scheduleTimeout(()=>this.start(),this.config.reconnectMs);}
    });
  }
  async ready(signal:AbortSignal=new AbortController().signal):Promise<void>{
    if(this.stopped)throw new Error('QQ 连接服务已停止');if(!this.token())throw new Error('尚未取得 SnowLuma 消息密钥，请先一键启动 QQ 并扫码');
    const timeout=AbortSignal.timeout(Math.max(this.config.actionTimeoutMs,this.config.reconnectMs*2+1000)),waiting=AbortSignal.any([signal,timeout]);
    try{while(!this.socket||this.socket.readyState!==WebSocket.OPEN){waiting.throwIfAborted();if(this.stopped)throw new Error('QQ 连接服务已停止');if(!this.nextRetryAt||Date.now()>=this.nextRetryAt)this.start();await cancellablePause(100,waiting);}}
    catch(error){signal.throwIfAborted();if(timeout.aborted)throw new Error('等待 QQ 重连超时，请确认 SnowLuma 仍在运行并已登录 QQ');throw error;}
  }
  action<T extends JsonObject|unknown[]=JsonObject>(action: string, params: JsonObject): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('QQ 尚未连接，回复未发送'));
    const echo = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = scheduleTimeout(() => {
        this.pending.delete(echo); reject(new Error('QQ 发送超时，结果未知；请到 QQ 核实，插件不会自动重发'));
      }, this.config.actionTimeoutMs);
      this.pending.set(echo, { resolve:value=>resolve(value as T), reject, timer });
      socket.send(JSON.stringify({ action, params, echo }), error => {
        if (error) { timer.clear(); this.pending.delete(echo); reject(new Error('QQ 写入失败，结果待核实；请检查连接')); }
      });
    });
  }
  send(message: QQMessage, text: string): Promise<JsonObject> {
    const params = message.groupId ? { group_id: message.groupId, message: [{ type: 'text', data: { text } }] } : { user_id: message.userId, message: [{ type: 'text', data: { text } }] };
    return this.action(message.groupId ? 'send_group_msg' : 'send_private_msg', params);
  }
  sendVoice(message:QQMessage,bytes:Buffer):Promise<JsonObject>{
    if(!bytes.length||bytes.length>2*1024*1024)return Promise.reject(new Error('QQ 语音内容为空或超过 2 MB'));
    const record={type:'record',data:{file:'base64://'+bytes.toString('base64')}};
    return this.action(message.groupId?'send_group_msg':'send_private_msg',message.groupId?{group_id:message.groupId,message:[record]}:{user_id:message.userId,message:[record]});
  }
  async quotedMedia(message: QQMessage): Promise<QQMediaRef[]> {
    if(!message.replyId)return [];
    const result=await this.action('get_msg',{message_id:message.replyId});
    const same=message.groupId
      ? result.message_type==='group' && String(result.group_id)===message.groupId
      : result.message_type==='private' && String(result.user_id ?? (record(result.sender)?result.sender.user_id:''))===message.userId;
    if(!same)throw new Error('引用的媒体不属于当前会话，无法读取');
    return mediaSegments(result.message);
  }
  async mediaInfo(media: QQMediaRef): Promise<JsonObject> {
    if(!media.file||/^(?:[a-z]:[\\/]|[\\/]|\.\.)/i.test(media.file)||media.file.includes('..')||media.file.length>1024||/[\r\n\0]/.test(media.file)||/^https?:\/\//i.test(media.file))return {};
    return this.action(media.type==='image'?'get_image':'get_file',{file:media.file});
  }
  async check(): Promise<{ online: boolean; nickname: string; userId: string }> {
    const [status, info] = await Promise.all([this.action('get_status', {}), this.action('get_login_info', {})]);
    return { online: status.online === true, nickname: typeof info.nickname === 'string' ? info.nickname : '', userId: id(info.user_id) || '' };
  }
  stop(): void {
    this.stopped = true; this.retry?.clear();if(this.heartbeat)clearInterval(this.heartbeat);this.nextRetryAt=0;this.state='disconnected';this.statusMessage='连接已停止';
    for (const request of this.pending.values()) { request.timer.clear(); request.reject(new Error('QQ 连接正在停止')); }
    this.pending.clear(); this.socket?.terminate();
  }
}
