import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { Settings } from './config.js';

export interface QQMessage {
  id: string; selfId: string; userId: string; groupId?: string;
  thread: string; scope: string; owner: boolean; text: string;
}
type JsonObject = Record<string, unknown>;
function record(v: unknown): v is JsonObject { return !!v && typeof v === 'object' && !Array.isArray(v); }
function id(v: unknown): string | null { return (typeof v === 'string' && /^\d+$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) ? String(v) : null; }
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
  let mentioned = false; const parts: string[] = [];
  for (const segment of value.message) {
    if (!record(segment) || !record(segment.data)) continue;
    if (segment.type === 'text' && typeof segment.data.text === 'string') parts.push(segment.data.text);
    if (segment.type === 'at' && String(segment.data.qq) === selfId) mentioned = true;
  }
  if (groupId && config.groupMentionOnly && !mentioned) return null;
  const text = parts.join('').trim();
  if (!text || text.length > 10000) return null;
  const thread = groupId ? `qq:group:${groupId}` : `qq:private:${userId}`;
  return { id: `${selfId}:${thread}:${messageId}`, selfId, userId, groupId: groupId || undefined, thread, scope: owner ? 'owner' : thread, owner, text };
}

export class OneBotClient {
  private socket?: WebSocket;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private pending = new Map<string, { resolve: (v: JsonObject) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly config: Settings['qq'], readonly onMessage: (message: QQMessage) => void, readonly log: (message: string) => void) {}
  start(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.config.wsUrl, {
      headers: { Authorization: `Bearer ${process.env[this.config.tokenEnv] || ''}` },
      maxPayload: 1024 * 1024, handshakeTimeout: this.config.actionTimeoutMs,
    });
    this.socket = socket;
    socket.on('open', () => this.log('QQ OneBot 已连接'));
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
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('QQ 连接断开，发送结果未知；请到 QQ 核实，插件不会自动重发')); }
      this.pending.clear();
      if (!this.stopped) this.retry = setTimeout(() => this.start(), this.config.reconnectMs);
    });
  }
  send(message: QQMessage, text: string): Promise<JsonObject> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('QQ 尚未连接，回复未发送'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo); reject(new Error('QQ 发送超时，结果未知；请到 QQ 核实，插件不会自动重发'));
      }, this.config.actionTimeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      const params = message.groupId ? { group_id: message.groupId, message: [{ type: 'text', data: { text } }] } : { user_id: message.userId, message: [{ type: 'text', data: { text } }] };
      socket.send(JSON.stringify({ action: message.groupId ? 'send_group_msg' : 'send_private_msg', params, echo }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(echo); reject(new Error('QQ 写入失败，结果待核实；请检查连接')); }
      });
    });
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.retry);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('QQ 连接正在停止')); }
    this.pending.clear(); this.socket?.terminate();
  }
}
