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
export interface BiliVideo {aid:string;bvid:string;title:string;description:string;owner:string;url:string}
export function normalizedTag(text:string):string{return text.normalize('NFKC').trim().replace(/^#+|#+$/g,'').toLowerCase();}
export function tagsAllowed(tags:string[],allowed:string[],blocked:string[]):boolean {
  const values=tags.map(normalizedTag);return !blocked.some(t=>values.includes(normalizedTag(t)))&&(!allowed.length||allowed.some(t=>values.includes(normalizedTag(t))));
}
const MIXIN=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
export function wbiQuery(params:Record<string,string>,imageKey:string,subKey:string,time=Date.now()):string {
  if(!/^[a-f\d]{32}$/i.test(imageKey)||!/^[a-f\d]{32}$/i.test(subKey))throw new Error('B 站 WBI 签名密钥无效');
  const key=MIXIN.map(i=>(imageKey+subKey)[i]).join('').slice(0,32),all={...params,wts:String(Math.floor(time/1000))};
  const query=Object.keys(all).sort().map(k=>`${encodeURIComponent(k)}=${encodeURIComponent(all[k as keyof typeof all]!.replace(/[!'()*]/g,''))}`).join('&');
  return query+'&w_rid='+createHash('md5').update(query+key).digest('hex');
}
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
  private tagCache=new Map<string,{time:number;tags:string[]}>();
  private playbackKeys?:{image:string;sub:string;expires:number};
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
    try { value = JSON.parse(readFileSync(this.cookiesPath, 'utf8')); } catch { throw new Error('请先在设置 → 拾光 → B 站账号完成扫码登录'); }
    const values = object(value);
    if (typeof values.SESSDATA !== 'string' || typeof values.bili_jct !== 'string') throw new Error('B 站登录文件不完整，请重新扫码');
    const cookies: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) if (/^[A-Za-z0-9_]+$/.test(key) && typeof value === 'string' && !/[;\r\n]/.test(value)) cookies[key] = value;
    return cookies;
  }
  private async request<T=ObjectValue>(url: string, init: RequestInit = {}, signal?: AbortSignal,array=false): Promise<{ data:T; response: Response }> {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.settings.bilibili.timeoutMs)]) : AbortSignal.timeout(this.settings.bilibili.timeoutMs);
    const response = await this.fetcher(url, { ...init, headers: { 'User-Agent': AGENT, Referer: 'https://www.bilibili.com/', ...init.headers }, redirect: 'error', signal: combined });
    if (!response.ok) throw new Error(`B 站返回 HTTP ${response.status}，请检查登录或稍后重试`);
    const value = object(await response.json());
    if (value.code !== 0) throw new BiliApiError(Number(value.code));
    if(array&&!Array.isArray(value.data))throw new Error('B 站标签数据格式无效');
    return { data:(array?value.data:object(value.data)) as T,response };
  }
  async startLogin(): Promise<{ url: string; key: string }> {
    const { data } = await this.request('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
    if (typeof data.url !== 'string' || typeof data.qrcode_key !== 'string') throw new Error('B 站登录二维码返回不完整');
    let u: URL;
    try { u = new URL(data.url); } catch { throw new Error('B 站二维码地址异常，请重新生成'); }
    const loginPaths: Record<string,string[]> = {
      'passport.bilibili.com': ['/h5-app/passport/login/scan'],
      'account.bilibili.com': ['/h5/account-h5/auth/scan-web'],
    };
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || !loginPaths[u.hostname]?.includes(u.pathname)) throw new Error('B 站二维码地址异常：未收到官方扫码页面');
    if (!data.qrcode_key || data.qrcode_key.length > 256 || u.searchParams.get('qrcode_key') !== data.qrcode_key) throw new Error('B 站二维码与登录票据不匹配，请重新生成');
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
  async video(input: string, signal?: AbortSignal): Promise<BiliVideo> {
    if (!this.settings.bilibili.enabled) throw new Error('请先启用 bilibili.enabled');
    const query = new URLSearchParams(videoId(input));
    const { data } = await this.request(`https://api.bilibili.com/x/web-interface/view?${query}`, {}, signal);
    const owner = object(data.owner);
    if ((typeof data.aid !== 'number' && typeof data.aid !== 'string') || typeof data.bvid !== 'string' || typeof data.title !== 'string') throw new Error('B 站视频数据不完整');
    if(this.settings.bilibili.allowedTags.length||this.settings.bilibili.blockedTags.length){const tags=await this.tags(String(data.bvid),signal);if(!tagsAllowed(tags,this.settings.bilibili.allowedTags,this.settings.bilibili.blockedTags))throw new Error('视频标签未通过白黑名单，本次不读取或互动');}
    return { aid: String(data.aid), bvid: data.bvid, title: data.title, description: String(data.desc || '').slice(0, 2000), owner: String(owner.name || ''), url: `https://www.bilibili.com/video/${data.bvid}` };
  }
  private async playerRequest(path:string,params:Record<string,string>,signal?:AbortSignal):Promise<ObjectValue>{
    const cookies=this.cookies(),headers={Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ')};
    if(!this.playbackKeys||this.playbackKeys.expires<this.memory.clock()){
      const {data}=await this.request('https://api.bilibili.com/x/web-interface/nav',{headers},signal);
      if(data.isLogin!==true)throw new Error('B 站登录已过期，请重新扫码');
      const keys=object(data.wbi_img),key=(value:unknown)=>typeof value==='string'?new URL(value).pathname.split('/').at(-1)!.split('.')[0]!:'';
      this.playbackKeys={image:key(keys.img_url),sub:key(keys.sub_url),expires:this.memory.clock()+300000};
    }
    const query=wbiQuery(params,this.playbackKeys.image,this.playbackKeys.sub,this.memory.clock());
    return (await this.request('https://api.bilibili.com'+path+'?'+query,{headers},signal)).data;
  }
  async videoPart(input:string,part=1,signal?:AbortSignal):Promise<{video:BiliVideo;cid:string;duration:number;part:number}>{
    const video=await this.video(input,signal);
    const {data}=await this.request('https://api.bilibili.com/x/web-interface/view?bvid='+encodeURIComponent(video.bvid),{},signal);
    if(!Number.isSafeInteger(part)||part<1||part>100)throw new Error('视频分 P 应为 1–100');
    const page=Array.isArray(data.pages)?data.pages[part-1]:part===1?{cid:data.cid,duration:data.duration}:undefined;
    if(!page||!Number.isSafeInteger(page.cid)||page.cid<1||!Number.isFinite(page.duration)||page.duration<=0)throw new Error('未取得有效视频分 P 和时长');
    return {video,cid:String(page.cid),duration:page.duration,part};
  }
  async playback(bvid:string,cid:string,signal?:AbortSignal):Promise<{urls:string[];duration:number}>{
    const data=await this.playerRequest('/x/player/wbi/playurl',{bvid,cid,qn:'16',fnval:'16',fnver:'0',fourk:'0'},signal);
    if(data.is_preview===true||data.is_preview===1||data.need_vip===true||data.need_login===true||data.is_drm===true)throw new Error('当前账号仅有预览或没有完整播放权限，本次不读取内容');
    const dash=data.dash&&typeof data.dash==='object'?data.dash as ObjectValue:undefined;
    const candidates=Array.isArray(dash?.video)?dash.video.filter(v=>v&&typeof v==='object'&&(!v.codecid||v.codecid===7)).sort((a,b)=>(Number(a.id)||999)-(Number(b.id)||999)||(Number(a.bandwidth)||0)-(Number(b.bandwidth)||0)):[];
    const selected=candidates[0];let urls:string[]=[];
    if(selected)urls=[selected.baseUrl??selected.base_url,...(selected.backupUrl??selected.backup_url??[])].filter((u):u is string=>typeof u==='string');
    else if(Array.isArray(data.durl)&&data.durl.length===1){const item=data.durl[0];if(item&&typeof item.url==='string')urls=[item.url,...(Array.isArray(item.backup_url)?item.backup_url:[])];}
    if(!urls.length)throw new Error('当前账号没有可读取的普通视频流，请在 B 站检查播放权限');
    const duration=Number(data.timelength)/1000||Number(dash?.duration);
    if(!Number.isFinite(duration)||duration<=0)throw new Error('无法确认实际播放时长');
    return {urls:urls.slice(0,5),duration};
  }
  async subtitle(bvid:string,cid:string,signal?:AbortSignal):Promise<string|undefined>{
    const data=await this.playerRequest('/x/player/wbi/v2',{bvid,cid},signal);
    const subtitle=data.subtitle as ObjectValue|undefined;
    const subtitles=Array.isArray(subtitle?.subtitles)?subtitle.subtitles.filter(s=>s&&typeof s.subtitle_url==='string'&&s.subtitle_url):[];
    const selected=subtitles.find(s=>/^(?:ai-)?zh/.test(String(s.lan)))??subtitles[0];
    if(!selected)return undefined;return new URL(selected.subtitle_url,'https://www.bilibili.com').href;
  }
  async tags(input:string,signal?:AbortSignal):Promise<string[]>{
    const query=new URLSearchParams(videoId(input)),key=query.toString(),cached=this.tagCache.get(key);
    if(cached&&this.memory.clock()-cached.time<300000)return cached.tags;
    const cookies=this.cookies(),headers={Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ')};
    const {data}=await this.request<unknown[]>(`https://api.bilibili.com/x/tag/archive/tags?${query}`,{headers},signal,true);
    const tags=data.flatMap(row=>row&&typeof row==='object'&&typeof (row as ObjectValue).tag_name==='string'?[String((row as ObjectValue).tag_name).slice(0,80)]:[]).slice(0,100);
    if(this.tagCache.size>200)this.tagCache.clear();this.tagCache.set(key,{time:this.memory.clock(),tags});return tags;
  }
  async browse(rotation=0,signal?:AbortSignal):Promise<(BiliVideo&{tags:string[]})[]>{
    const b=this.settings.bilibili,a=this.settings.autonomy;
    if(!b.enabled||!b.allowedTags.length)throw new Error('浏览前需要启用 B 站并填写标签白名单');
    let cookies=this.cookies();
    if(!cookies.buvid3){
      const {data}=await this.request('https://api.bilibili.com/x/frontend/finger/spi',{},signal);
      if(typeof data.b_3!=='string'||/[;\r\n]/.test(data.b_3))throw new Error('无法建立 B 站浏览会话，请重新登录');
      cookies={...cookies,buvid3:data.b_3};const tmp=`${this.cookiesPath}.${randomUUID()}.tmp`;writeFileSync(tmp,JSON.stringify(cookies),{mode:0o600});renameSync(tmp,this.cookiesPath);
    }
    const headers={Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ')};
    const {data:nav}=await this.request('https://api.bilibili.com/x/web-interface/nav',{headers},signal),keys=object(nav.wbi_img);
    const extract=(v:unknown)=>typeof v==='string'?new URL(v).pathname.split('/').at(-1)!.split('.')[0]!:'';
    const keyword=b.allowedTags[Math.abs(rotation)%b.allowedTags.length]!;
    const query=wbiQuery({search_type:'video',keyword,page:String(1+Math.floor(Math.abs(rotation)/b.allowedTags.length)%3),page_size:'20',order:'pubdate'},extract(keys.img_url),extract(keys.sub_url),this.memory.clock());
    const {data}=await this.request(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`,{headers},signal);
    if(!Array.isArray(data.result))throw new Error('B 站搜索未返回可用视频');
    const videos:(BiliVideo&{tags:string[]})[]=[];
    for(const row of data.result.slice(0,a.candidatesPerWake)){
      signal?.throwIfAborted();if(!row||typeof row!=='object'||typeof row.bvid!=='string'||!/^BV[\dA-Za-z]{10}$/.test(row.bvid))continue;
      if(this.memory.seen('bili:browse:'+row.bvid)||videos.some(v=>v.bvid===row.bvid))continue;
      const tags=await this.tags(row.bvid,signal);if(!tagsAllowed(tags,b.allowedTags,b.blockedTags))continue;
      const video=await this.video(row.bvid,signal);videos.push({...video,tags});if(videos.length>=a.videosPerWake)break;
    }
    return videos;
  }
  async dynamic(text:string,signal?:AbortSignal):Promise<{id:string;url:string}>{
    const b=this.settings.bilibili;if(!b.enabled||!b.allowDynamics)throw new Error('B 站动态发布尚未开启');
    text=text.trim();if(!text||[...text].length>500)throw new Error('文字动态应为 1–500 字');
    if(b.blockedTags.some(t=>normalizedTag(text).includes(normalizedTag(t))))throw new Error('动态包含黑名单标签词，本次不发布');
    const cookies=this.cookies(),key=createHash('sha256').update(JSON.stringify([this.settings.roleId,this.memory.today(),'dynamic',text])).digest('hex');
    this.memory.reserveAction('bili-dynamic',key,b.dynamicsPerDay,b.minDynamicIntervalMs);
    let result:{data:ObjectValue;response:Response};
    try{
      result=await this.request(`https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=${encodeURIComponent(cookies.bili_jct!)}`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ')},body:JSON.stringify({dyn_req:{scene:1,content:{contents:[{raw_text:text,type:1,biz_id:''}]},meta:{app_meta:{from:'create.dynamic.web',mobi_app:'web'}}}})},signal);
    }catch(error){this.memory.settleAction(key,error instanceof BiliApiError?'failed':'unknown',error instanceof BiliApiError?String(error.code):'发送结果未知，请核实');if(error instanceof BiliApiError)throw error;throw new Error('动态发送结果未知，请在 B 站核实；插件不会自动重发');}
    if(result.data.need_captcha===true||result.data.v_voucher){this.memory.settleAction(key,'unknown','需要官方验证');throw new Error('B 站要求验证，请先在官方客户端处理并核实动态状态');}
    const id=result.data.dyn_id_str??result.data.dyn_id;
    if(!(typeof id==='string'&&/^[1-9]\d*$/.test(id))&&!(typeof id==='number'&&Number.isSafeInteger(id)&&id>0)){this.memory.settleAction(key,'unknown','未收到动态 ID');throw new Error('B 站没有返回动态 ID，请先核实发送状态');}
    this.memory.settleAction(key,'sent',String(id));const url=`https://t.bilibili.com/${id}`;
    this.memory.append('owner','bilibili','bilibili','experience',`已发布文字动态：${text}；${url}`);return {id:String(id),url};
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
