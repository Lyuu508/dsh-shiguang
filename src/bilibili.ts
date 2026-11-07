import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Settings } from './config.js';
import { MemoryStore } from './memory.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('B 站返回了无效的数据格式');
  return value as ObjectValue;
}
export class BiliApiError extends Error {
  constructor(readonly code: number) {
    super(`B 站接口未成功，code=${code}${[12015, -352, -412].includes(code) ? '，需要在官方客户端完成验证后重试' : code === -101 ? '，登录已过期，请重新扫码' : ''}`);
  }
}
const AGENT = 'Mozilla/5.0';
export function videoId(input: string): { bvid: string } | { aid: string } {
  const s = input.trim();
  if (/^BV[0-9A-Za-z]{10}$/.test(s)) return { bvid: s };
  if (/^av\d+$/i.test(s)) return { aid: s.slice(2) };
  let u: URL;
  try { u = new URL(s); } catch { throw new Error('请提供 BV 号、av 号或完整的 B 站视频链接'); }
  if (u.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com'].includes(u.hostname) || u.port || u.username || u.password) throw new Error('仅支持 bilibili.com 的 HTTPS 视频链接，短链请先在浏览器展开');
  const match = /^\/video\/(BV[0-9A-Za-z]{10}|av\d+)\/?$/.exec(u.pathname);
  if (!match) throw new Error('链接中未找到有效视频编号');
  return videoId(match[1]!);
}
export class BilibiliClient {
  private readonly cookiesPath: string;
  constructor(readonly settings: Settings, readonly memory: MemoryStore, readonly fetcher: typeof fetch = fetch) {
    this.cookiesPath = join(settings.dataDir, 'bilibili.cookies.json');
  }
  hasLogin(): boolean {
    try { const cookies = this.cookies(); return Boolean(cookies.SESSDATA && cookies.bili_jct); } catch { return false; }
  }
  logout(): void {
    if (existsSync(this.cookiesPath)) renameSync(this.cookiesPath, `${this.cookiesPath}.logout-${Date.now()}`);
  }
  async account(signal?: AbortSignal): Promise<{ loggedIn: boolean; name: string; userId: string }> {
    const cookies = this.cookies();
    const { data } = await this.request('https://api.bilibili.com/x/web-interface/nav', { headers: { Cookie: Object.entries(cookies).map(([k,v]) => `${k}=${v}`).join('; ') } }, signal);
    return { loggedIn: data.isLogin === true, name: String(data.uname || ''), userId: String(data.mid || '') };
  }
  private cookies(): Record<string, string> {
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.cookiesPath, 'utf8')); } catch { throw new Error('请先在本机执行 npm run bili:login 完成 B 站扫码登录'); }
    const values = object(value);
    if (typeof values.SESSDATA !== 'string' || typeof values.bili_jct !== 'string') throw new Error('B 站登录文件不完整，请重新扫码');
    const cookies: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) if (/^[A-Za-z0-9_]+$/.test(key) && typeof value === 'string' && !/[;\r\n]/.test(value)) cookies[key] = value;
    return cookies;
  }
  private async request(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ data: ObjectValue; response: Response }> {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.settings.bilibili.timeoutMs)]) : AbortSignal.timeout(this.settings.bilibili.timeoutMs);
    const response = await this.fetcher(url, { ...init, headers: { 'User-Agent': AGENT, Referer: 'https://www.bilibili.com/', ...init.headers }, redirect: 'error', signal: combined });
    if (!response.ok) throw new Error(`B 站返回 HTTP ${response.status}，请检查登录或稍后重试`);
    const value = object(await response.json());
    if (value.code !== 0) throw new BiliApiError(Number(value.code));
    return { data: object(value.data), response };
  }
  async startLogin(): Promise<{ url: string; key: string }> {
    const { data } = await this.request('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
    if (typeof data.url !== 'string' || typeof data.qrcode_key !== 'string') throw new Error('B 站登录二维码返回不完整');
    const u = new URL(data.url);
    if (u.protocol !== 'https:' || u.hostname !== 'passport.bilibili.com') throw new Error('B 站二维码地址异常');
    return { url: data.url, key: data.qrcode_key };
  }
  async pollLogin(key: string): Promise<'waiting' | 'scanned' | 'expired' | 'success'> {
    const { data, response } = await this.request(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`);
    if (data.code === 86101) return 'waiting';
    if (data.code === 86090) return 'scanned';
    if (data.code === 86038) return 'expired';
    if (data.code !== 0) throw new BiliApiError(Number(data.code));
    const values: Record<string, string> = {};
    for (const header of response.headers.getSetCookie()) {
      const match = /^([A-Za-z0-9_]+)=([^;]*)/.exec(header);
      if (match) values[match[1]!] = match[2]!;
    }
    if (!values.SESSDATA || !values.bili_jct) throw new Error('扫码已确认但未取得完整 Cookie，请重新登录');
    const temporary = `${this.cookiesPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(values), { mode: 0o600 }); renameSync(temporary, this.cookiesPath);
    return 'success';
  }
  async video(input: string, signal?: AbortSignal): Promise<{ aid: string; bvid: string; title: string; description: string; owner: string; url: string }> {
    if (!this.settings.bilibili.enabled) throw new Error('请先启用 bilibili.enabled');
    const query = new URLSearchParams(videoId(input));
    const { data } = await this.request(`https://api.bilibili.com/x/web-interface/view?${query}`, {}, signal);
    const owner = object(data.owner);
    if ((typeof data.aid !== 'number' && typeof data.aid !== 'string') || typeof data.bvid !== 'string' || typeof data.title !== 'string') throw new Error('B 站视频数据不完整');
    return { aid: String(data.aid), bvid: data.bvid, title: data.title, description: String(data.desc || '').slice(0, 2000), owner: String(owner.name || ''), url: `https://www.bilibili.com/video/${data.bvid}` };
  }
  async comment(input: string, text: string, root = '', parent = '', signal?: AbortSignal): Promise<{ rpid: string; url: string }> {
    const b = this.settings.bilibili;
    if (!b.enabled || !b.allowComments) throw new Error('B 站评论尚未启用，请在本机配置 bilibili.allowComments');
    if (!text.trim() || [...text].length > 1000) throw new Error('评论应为 1–1000 字');
    if ((root && !/^\d+$/.test(root)) || (parent && !/^\d+$/.test(parent)) || (parent && !root)) throw new Error('回复评论时须提供合法的 root 和 parent 评论 ID');
    const cookies = this.cookies();
    const video = await this.video(input, signal);
    const key = createHash('sha256').update(JSON.stringify([this.settings.roleId, this.memory.today(), video.aid, text.trim(), root, parent])).digest('hex');
    const form = new URLSearchParams({ type: '1', oid: video.aid, message: text.trim(), plat: '1', csrf: cookies.bili_jct!, ...(root ? { root, parent: parent || root } : {}) });
    this.memory.reserveComment(key, b.commentsPerDay, b.minCommentIntervalMs);
    let result: { data: ObjectValue; response: Response };
    try {
      result = await this.request('https://api.bilibili.com/x/v2/reply/add', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') }, body: form,
      }, signal);
    } catch (error) {
      this.memory.settleAction(key, error instanceof BiliApiError ? 'failed' : 'unknown', error instanceof BiliApiError ? String(error.code) : '网络或响应异常，需人工核实');
      if (error instanceof BiliApiError) throw error;
      throw new Error('评论发送结果未知，请先去 B 站查看；为避免重复，插件不会自动重发');
    }
    if (result.data.need_captcha === true) { this.memory.settleAction(key, 'unknown', '需要验证码'); throw new Error('B 站要求验证码，请在官方客户端处理并核实评论状态'); }
    const rpid = result.data.rpid_str ?? result.data.rpid;
    if (typeof rpid !== 'string' && typeof rpid !== 'number') { this.memory.settleAction(key, 'unknown', '无评论回执'); throw new Error('B 站未返回评论 ID，请先在客户端核实'); }
    this.memory.settleAction(key, 'sent', String(rpid));
    this.memory.append('owner', 'bilibili', 'bilibili', 'experience', `已在《${video.title}》评论：${text.trim()}；视频 ${video.url}；评论ID ${String(rpid)}`);
    return { rpid: String(rpid), url: `${video.url}#reply${String(rpid)}` };
  }
}
