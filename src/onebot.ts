import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { Settings } from './config.js';

export interface QQMessage {
  id: string; selfId: string; userId: string; groupId?: string;
  thread: string; scope: string; owner: boolean; text: string;
  media?: QQMediaRef[]; replyId?: string;
}
export interface QQMediaRef { type: 'video' | 'image'; file?: string; url?: string }
type JsonObject = Record<string, unknown>;
function record(v: unknown): v is JsonObject { return !!v && typeof v === 'object' && !Array.isArray(v); }
function id(v: unknown): string | null { return (typeof v === 'string' && /^\d+$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) ? String(v) : null; }
export function mediaSegments(segments: unknown): QQMediaRef[] {
  if(!Array.isArray(segments))return [];
  return segments.flatMap(segment=>{
    if(!record(segment)||!record(segment.data)||!['video','image'].includes(String(segment.type)))return [];
    const file=typeof segment.data.file==='string'&&segment.data.file.length<=1024?segment.data.file:undefined;
    const url=typeof segment.data.url==='string'&&segment.data.url.length<=4096?segment.data.url:undefined;
    return file||url?[{type:segment.type as QQMediaRef['type'],file,url}]:[];
  }).slice(0,4);
}
export function parseMessage(value: unknown, config: Settings['qq']): QQMessage | null {
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
  if (groupId && config.groupMentionOnly && !mentioned) return null;
  const text = parts.join('').trim();
  const media=mediaSegments(value.message);
  if ((!text && !media.length) || text.length > 10000) return null;
  const thread = groupId ? `qq:group:${groupId}` : `qq:private:${userId}`;
  return { id: `${selfId}:${thread}:${messageId}`, selfId, userId, groupId: groupId || undefined, thread, scope: owner ? 'owner' : thread, owner, text, media, replyId };
}

export class OneBotClient {
  private socket?: WebSocket;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private state: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  private statusMessage = '尚未连接';
  private pending = new Map<string, { resolve: (v: JsonObject) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly config: Settings['qq'], readonly onMessage: (message: QQMessage) => void, readonly log: (message: string) => void, readonly token = () => process.env[config.tokenEnv] || '') {}
  status(): { state: string; message: string } { return { state: this.state, message: this.statusMessage }; }
  start(): void {
    if (this.stopped) return;
    if (!this.token()) { this.statusMessage = '请先在设置面板填写 OneBot Token'; return; }
    this.state = 'connecting'; this.statusMessage = '正在连接 NapCat';
    const socket = new WebSocket(this.config.wsUrl, {
      headers: { Authorization: `Bearer ${this.token()}` },
      maxPayload: 1024 * 1024, handshakeTimeout: this.config.actionTimeoutMs,
    });
    this.socket = socket;
    socket.on('open', () => { this.state = 'connected'; this.statusMessage = 'OneBot 桥接已连接'; this.log('QQ OneBot 已连接'); });
    socket.on('message', raw => {
      let value: unknown;
      try { value = JSON.parse(raw.toString()); } catch { this.log('忽略无效的 OneBot JSON'); return; }
      if (!record(value)) return;
      if (typeof value.echo === 'string' && this.pending.has(value.echo)) {
        const request = this.pending.get(value.echo)!; clearTimeout(request.timer); this.pending.delete(value.echo);
        if (value.status === 'ok' && value.retcode === 0 && record(value.data)) request.resolve(value.data);
        else request.reject(new Error(`QQ 操作未成功，retcode=${String(value.retcode)}；请检查 NapCat 日志`));
        return;
      }
      const message = parseMessage(value, this.config);
      if (message) this.onMessage(message);
    });
    socket.on('error', () => this.log('QQ 连接异常，请检查 NapCat 地址、Token 和登录状态'));
    socket.on('close', () => {
      this.state = 'disconnected'; this.statusMessage = this.stopped ? '连接已停止' : '连接断开，正在等待重连';
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('QQ 连接断开，发送结果未知；请到 QQ 核实，插件不会自动重发')); }
      this.pending.clear();
      if (!this.stopped) this.retry = setTimeout(() => this.start(), this.config.reconnectMs);
    });
  }
  action(action: string, params: JsonObject): Promise<JsonObject> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('QQ 尚未连接，回复未发送'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo); reject(new Error('QQ 发送超时，结果未知；请到 QQ 核实，插件不会自动重发'));
      }, this.config.actionTimeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      socket.send(JSON.stringify({ action, params, echo }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(echo); reject(new Error('QQ 写入失败，结果待核实；请检查连接')); }
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
    if(!media.file || !/^[a-zA-Z0-9_.-]{1,1024}$/.test(media.file) || media.file.includes('..'))return {};
    return this.action(media.type==='image'?'get_image':'get_file',{file:media.file});
  }
  async check(): Promise<{ online: boolean; nickname: string; userId: string }> {
    const [status, info] = await Promise.all([this.action('get_status', {}), this.action('get_login_info', {})]);
    return { online: status.online === true, nickname: typeof info.nickname === 'string' ? info.nickname : '', userId: id(info.user_id) || '' };
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.retry);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('QQ 连接正在停止')); }
    this.pending.clear(); this.socket?.terminate();
  }
}
