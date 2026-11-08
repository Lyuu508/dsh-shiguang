import {setState,stateValue} from './initiative.js';
import {timeoutSignal} from './timeouts.js';
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
export function losslessJSON(text:string):unknown {
  let out='',quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){const ch=text[i]!;if(quoted){out+=ch;if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}if(ch==='"'){quoted=true;out+=ch;continue;}
    if(ch==='-'||/\d/.test(ch)){const match=/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));if(match){out+=/^-?\d{16,}$/.test(match[0])?JSON.stringify(match[0]):match[0];i+=match[0].length-1;continue;}}out+=ch;
  }return JSON.parse(out);
}
const AGENT = 'Mozilla/5.0';
export interface BiliVideo {views?:number;aid:string;bvid:string;title:string;description:string;owner:string;url:string}
export function normalizedTag(text:string):string{return text.normalize('NFKC').trim().replace(/^#+|#+$/g,'').toLowerCase();}
export function tagsAllowed(tags:string[],allowed:string[],blocked:string[]):boolean {
  const values=tags.map(normalizedTag);return !blocked.some(t=>values.includes(normalizedTag(t)))&&(!allowed.length||allowed.some(t=>values.includes(normalizedTag(t))));
}
export function weightedTag(tags:string[],weights:Record<string,number>,random=Math.random){const sum=tags.reduce((n,t)=>n+(weights[t]??5),0);let point=random()*sum;for(const tag of tags){point-=weights[tag]??5;if(point<0)return tag;}return tags.at(-1)!;}
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
export interface BiliComment {id:string;root:string;uid:string;name:string;text:string;mentions:string[];likes:number}
export interface BiliMention {id:string;time:number;uid:string;name:string;aid:string;root:string;parent:string}
function decimalId(value:unknown){const id=String(value??'');return /^[1-9]\d*$/.test(id)&&!(typeof value==='number'&&!Number.isSafeInteger(value))?id:'';}
function parsedComment(value:unknown,aid:string):BiliComment|undefined{
 if(!value||typeof value!=='object')return;const r=value as any,id=decimalId(r.rpid_str??r.rpid),uid=decimalId(r.member?.mid??r.mid);
 if(!id||!uid||r.oid!==undefined&&String(r.oid)!==aid||r.type!==undefined&&Number(r.type)!==1||typeof r.content?.message!=='string'||r.state!==undefined&&Number(r.state)!==0)return;
 const root=decimalId(r.root_str??r.root)||id;
 return {id,root,uid,name:String(r.member?.uname||uid).slice(0,80),text:r.content.message.slice(0,10000),mentions:Array.isArray(r.content.members)?r.content.members.flatMap((m:any)=>decimalId(m?.mid)||[]):[],likes:Number.isSafeInteger(r.like)&&r.like>=0?r.like:0};
}
export class BilibiliClient {
  private readonly cookiesPath: string;
  private tagCache=new Map<string,{time:number;tags:string[]}>();
  private playbackKeys?:{image:string;sub:string;expires:number};
  constructor(readonly settings: Settings, readonly memory: MemoryStore, readonly fetcher: typeof fetch = fetch,readonly identity:'companion'|'owner'='companion') {
    this.cookiesPath = join(settings.dataDir,identity==='owner'?'bilibili.owner.cookies.json':'bilibili.cookies.json');
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
    const combined = signal ? AbortSignal.any([signal, timeoutSignal(this.settings.bilibili.timeoutMs)]) : timeoutSignal(this.settings.bilibili.timeoutMs);
    const response = await this.fetcher(url, { ...init, headers: { 'User-Agent': AGENT, Referer: 'https://www.bilibili.com/', ...init.headers }, redirect: 'error', signal: combined });
    if (!response.ok) throw new Error(`B 站返回 HTTP ${response.status}，请检查登录或稍后重试`);
    const value = object(losslessJSON(await response.text()));
    if (value.code !== 0) throw new BiliApiError(Number(value.code));
    if(array&&!Array.isArray(value.data))throw new Error('B 站标签数据格式无效');
    return { data:(array?value.data:object(value.data??{})) as T,response };
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
    if(this.settings.bilibili.manualWhitelist&&this.settings.bilibili.allowedTags.length||this.settings.bilibili.blockedTags.length){
      const tags=await this.tags(String(data.bvid),signal),b=this.settings.bilibili,blocked=b.blockedTags.filter(t=>tags.map(normalizedTag).includes(normalizedTag(t)));
      if(blocked.length)throw new Error(`这个视频命中黑名单标签：${blocked.join('、')}。视频实际标签：${tags.join('、')||'无'}。请在 B 站账号中调整黑名单后再读取。`);
      if(b.manualWhitelist&&!tagsAllowed(tags,b.allowedTags,[]))throw new Error(`这个视频没有命中白名单：${b.allowedTags.join('、')}。视频实际标签：${tags.join('、')||'无'}。手动指定的视频可关闭“手动读取也要求白名单”后再试；自动浏览仍按白名单筛选。`);
    }
    return { ...(Number.isSafeInteger((data.stat as any)?.view)&&(data.stat as any).view>=0?{views:(data.stat as any).view}:{}),aid: String(data.aid), bvid: data.bvid, title: data.title, description: String(data.desc || '').slice(0, 2000), owner: String(owner.name || ''), url: `https://www.bilibili.com/video/${data.bvid}` };
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
    if(!Number.isSafeInteger(part)||part<1)throw new Error('视频分 P 应为正整数');
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
  async recentInterestTags(limit=30,signal?:AbortSignal){
    if(this.identity!=='owner')throw new Error('请先登录独立的主人账号');if(!Number.isSafeInteger(limit)||limit<1)throw new Error('读取数量应为正整数');
    const account=await this.account(signal);if(!account.loggedIn)throw new Error('主人账号登录已过期，请重新扫码');
    const cookies=this.cookies(),headers={Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ')},ids:string[]=[],seen=new Set<string>();let cursor:Record<string,string>={};
    while(ids.length<limit){const query=new URLSearchParams({ps:'30',type:'archive',...cursor}),{data}=await this.request('https://api.bilibili.com/x/web-interface/history/cursor?'+query,{headers},signal);if(!Array.isArray(data.list))throw new Error('主人观看历史格式异常');let added=0;for(const item of data.list){const history=item?.history;if(!history||history.business!=='archive')continue;const id=typeof history.bvid==='string'&&/^BV[\dA-Za-z]{10}$/.test(history.bvid)?history.bvid:typeof history.oid==='number'&&history.oid>0?'av'+history.oid:'';if(id&&!seen.has(id)){seen.add(id);ids.push(id);added++;if(ids.length>=limit)break;}}
      if(!added||ids.length>=limit||!data.cursor||typeof data.cursor!=='object')break;const next=data.cursor as ObjectValue;cursor={max:String(next.max??''),view_at:String(next.view_at??''),business:String(next.business??'archive')};if(!cursor.max)break;
    }
    const counts=new Map<string,{tag:string;count:number}>();let failed=0;
    for(let i=0;i<ids.length;i+=3){const rows=await Promise.allSettled(ids.slice(i,i+3).map(id=>this.tags(id,signal)));for(const row of rows){if(row.status==='rejected'){signal?.throwIfAborted();failed++;continue;}for(const tag of row.value){if(this.settings.bilibili.blockedTags.some(x=>normalizedTag(x)===normalizedTag(tag)))continue;const key=normalizedTag(tag),entry=counts.get(key);counts.set(key,{tag:entry?.tag||tag,count:(entry?.count||0)+1});}}}
    return {videos:ids.length,failed,tags:[...counts.values()].sort((a,b)=>b.count-a.count||a.tag.localeCompare(b.tag)),ownerName:account.name};
  }
  browseStatus(){return stateValue(this.memory,'bili:selection',{at:0,tag:'',examined:0,selected:0,message:'尚未开始搜索'});}
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
    const keyword=weightedTag(b.allowedTags,b.tagWeights);
    const progress=(examined:number,selected:number,message:string)=>setState(this.memory,'bili:selection',{at:this.memory.clock(),tag:keyword,examined,selected,message,order:b.browseOrder,minViews:b.minViews});progress(0,0,'已按标签权重选择主题，正在搜索');
    const pageKey='bili:search-cursor:'+createHash('sha256').update(JSON.stringify([normalizedTag(keyword),b.browseOrder,b.minViews,b.blockedTags])).digest('hex');
    const stored=stateValue(this.memory,pageKey,{day:'',page:1,offset:0}),today=this.memory.today();
    let page=stored.day===today&&Number.isSafeInteger(stored.page)&&stored.page>0?stored.page:b.browseOrder==='pubdate'?1+Math.floor(Math.abs(rotation)/b.allowedTags.length)%3:1;
    let offset=stored.day===today&&Number.isSafeInteger(stored.offset)&&stored.offset>=0?stored.offset:0,examined=0;
    const videos:(BiliVideo&{tags:string[]})[]=[],checkpoint=(position:number)=>setState(this.memory,pageKey,{day:today,page,offset:position});
    // Already-viewed rows are local lookups and do not consume tag/API candidate
    // budget. Retain page+position so popular rankings cannot get stuck at page 1.
    for(let fetched=0;fetched<a.candidatesPerWake&&examined<a.candidatesPerWake;fetched++){
      const query=wbiQuery({search_type:'video',keyword,page:String(page),page_size:'20',order:b.browseOrder},extract(keys.img_url),extract(keys.sub_url),this.memory.clock());
      const {data}=await this.request('https://api.bilibili.com/x/web-interface/wbi/search/type?'+query,{headers},signal);
      if(!Array.isArray(data.result))throw new Error('B 站搜索未返回可用视频');
      let index=offset;
      for(;index<data.result.length&&examined<a.candidatesPerWake;index++){
        signal?.throwIfAborted();const row=data.result[index] as ObjectValue;
        if(!row||typeof row!=='object'||typeof row.bvid!=='string'||!/^BV[\dA-Za-z]{10}$/.test(row.bvid)||this.memory.seen('bili:browse:'+row.bvid)||videos.some(v=>v.bvid===row.bvid)){checkpoint(index+1);continue;}
        examined++;const tags=await this.tags(row.bvid,signal);if(!tagsAllowed(tags,b.allowedTags,b.blockedTags)){checkpoint(index+1);continue;}
        const video=await this.video(row.bvid,signal);if(b.minViews&&(!Number.isSafeInteger(video.views)||video.views!<b.minViews)){checkpoint(index+1);continue;}
        videos.push({...video,tags});checkpoint(index+1);if(videos.length>=a.videosPerWake){progress(examined,videos.length,'已找到通过真实标签筛选的视频');return videos;}
      }
      if(index<data.result.length)break;
      if(data.result.length<20){page=1;checkpoint(0);break;}
      page++;offset=0;checkpoint(0);
    }
    progress(examined,videos.length,videos.length?'已完成筛选':'本轮没有通过标签 / 播放量门槛的新视频；已保留搜索位置，下轮继续');return videos;
  }

  async dynamic(text:string,signal?:AbortSignal):Promise<{id:string;url:string}>{
    if(this.identity==='owner')throw new Error('主人账号仅用于读取观看兴趣，不能发送互动');
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
  async comment(input: string, text: string, root = '', parent = '', signal?: AbortSignal,mentions:Record<string,string>={}): Promise<{ rpid: string; url: string }> {
    if(this.identity==='owner')throw new Error('主人账号仅用于读取观看兴趣，不能发送互动');
    const b = this.settings.bilibili;
    if (!b.enabled || !b.allowComments) throw new Error('B 站评论尚未启用，请在本机配置 bilibili.allowComments');
    if (!text.trim() || [...text].length > 1000) throw new Error('评论应为 1–1000 字');
    if ((root && !/^\d+$/.test(root)) || (parent && !/^\d+$/.test(parent)) || (parent && !root)) throw new Error('回复评论时须提供合法的 root 和 parent 评论 ID');
    const cookies = this.cookies();
    const video = await this.video(input, signal);
    const key = createHash('sha256').update(JSON.stringify([this.settings.roleId, this.memory.today(), video.aid, text.trim(), root, parent])).digest('hex');
    const form = new URLSearchParams({ type: '1', oid: video.aid, message: text.trim(), plat: '1', csrf: cookies.bili_jct!, ...(root ? { root, parent: parent || root } : {}) });
    if(Object.keys(mentions).length){for(const [name,uid] of Object.entries(mentions))if(!this.settings.biliSocial.ownerUids.includes(uid)||!text.includes('@'+name))throw new Error('只能 @ 主人 UID 白名单中的已核验账号');form.set('at_name_to_mid',JSON.stringify(mentions));}
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
    if (!/^[1-9]\d*$/.test(String(rpid)) || typeof rpid==='number'&&!Number.isSafeInteger(rpid)) { this.memory.settleAction(key, 'unknown', '无评论回执'); throw new Error('B 站未返回评论 ID，请先在客户端核实'); }
    this.memory.settleAction(key, 'sent', String(rpid));
    this.memory.append('owner', 'bilibili', 'bilibili', 'experience', `已在《${video.title}》评论：${text.trim()}；视频 ${video.url}；评论ID ${String(rpid)}`,undefined,this.memory.clock(),'comment');
    return { rpid: String(rpid), url: `${video.url}#reply${String(rpid)}` };
  }
  async like(input:string,signal?:AbortSignal):Promise<{liked:boolean;url:string}>{
    if(this.identity==='owner')throw new Error('主人账号仅用于读取观看兴趣，不能发送互动');
    const c=this.settings.bilibili;if(!c.enabled||!c.allowLikes)throw new Error('请先在 B 站账号开启点赞权限');
    const video=await this.video(input,signal),cookies=this.cookies(),key=createHash('sha256').update(JSON.stringify([this.settings.roleId,this.memory.today(),'like',video.aid])).digest('hex');
    this.memory.reserveAction('bili-like',key,c.likesPerDay,c.minLikeIntervalMs);
    try{const response=await this.request('https://api.bilibili.com/x/web-interface/archive/like',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ')},body:new URLSearchParams({aid:video.aid,like:'1',csrf:cookies.bili_jct!})},signal);if(response.data.need_captcha===true||response.data.v_voucher)throw new Error('B 站需要在官方客户端完成验证');}
    catch(error){this.memory.settleAction(key,error instanceof BiliApiError?'failed':'unknown','请核实平台点赞状态');throw new Error(error instanceof BiliApiError?error.message:'点赞结果未知，请到 B 站核实，不会自动重发');}
    this.memory.settleAction(key,'sent','点赞接口返回成功');this.memory.append('owner','bilibili','bilibili','experience',`已点赞《${video.title}》；${video.url}`,undefined,this.memory.clock(),'like');return {liked:true,url:video.url};
  }
  async recommend(input:string,text:string,signal?:AbortSignal):Promise<{rpid:string;url:string}>{
    if(this.identity==='owner')throw new Error('主人账号仅用于读取观看兴趣，不能发送互动');
    const uids=this.settings.biliSocial.ownerUids;if(!this.settings.autonomy.recommendOwner||!uids.length)throw new Error('请先开启推荐并填写主人 UID 白名单');
    const account=await this.account(signal);if(!account.loggedIn)throw new Error('B 站登录已过期');
    const mentions:Record<string,string>={};
    for(const uid of uids){if(uid===account.userId)continue;const data=await this.playerRequest('/x/space/wbi/acc/info',{mid:uid},signal);if(typeof data.name!=='string'||!data.name.trim()||data.name.length>80)throw new Error('未能核验主人昵称，本次不发送纯文字假 @');if(mentions[data.name]&&mentions[data.name]!==uid)throw new Error('主人昵称重复，无法准确 @，请缩小 UID 白名单');mentions[data.name]=uid;}
    if(!Object.keys(mentions).length)throw new Error('无法通过评论 @ 当前登录账号自己，请填写主人的另一个 UID');
    return this.comment(input,Object.keys(mentions).map(n=>'@'+n+' ').join('')+text,'','',signal,mentions);
  }
  async topComments(input:string,limit=5,signal?:AbortSignal):Promise<BiliComment[]>{
    const video=await this.video(input,signal),cookies=this.cookies(),headers={Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ')};
    const rows:BiliComment[]=[];for(let page=1;rows.length<limit;page++){
      const query=new URLSearchParams({type:'1',oid:video.aid,sort:'1',pn:String(page),ps:String(Math.min(20,limit-rows.length))});
      const {data}=await this.request('https://api.bilibili.com/x/v2/reply?'+query,{headers},signal);
      const raw=Array.isArray(data.replies)?data.replies:[];for(const row of raw){const comment=parsedComment(row,video.aid);if(comment&&!rows.some(r=>r.id===comment.id))rows.push(comment);}
      if(raw.length<Math.min(20,limit-rows.length+raw.length)||!raw.length||page>=Math.ceil(limit/20)+1)break;
    }return rows.slice(0,limit);
  }
  async mentionsPage(cursor?:{id:string;time:number},signal?:AbortSignal):Promise<{items:BiliMention[];oldestTime:number;newest:{id:string;time:number};next?:{id:string;time:number}}>{
    if(!this.settings.bilibili.enabled||!this.settings.biliSocial.mentionEnabled||this.identity==='owner')throw new Error('请先开启伙伴账号的评论 @ 监听');
    const cookies=this.cookies(),headers={Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ')},query=new URLSearchParams({platform:'web',build:'0',mobi_app:'web',...(cursor?{id:cursor.id,at_time:String(cursor.time)}:{})});
    const {data}=await this.request('https://api.bilibili.com/x/msgfeed/at?'+query,{headers:{...headers,Referer:'https://message.bilibili.com/'}},signal),items:BiliMention[]=[];let oldestTime=Infinity,newest={id:'0',time:0};
    if(!Array.isArray(data.items))throw new Error('B 站 @ 通知格式异常');
    for(const raw of data.items){const n=raw as any,t=Number(n?.at_time),nid=decimalId(n?.id);if(Number.isSafeInteger(t)&&nid){oldestTime=Math.min(oldestTime,t);if(t>newest.time||t===newest.time&&BigInt(nid)>BigInt(newest.id))newest={id:nid,time:t};}const r=raw as any,item=r?.item,id=decimalId(r?.id),uid=decimalId(r?.user?.mid),aid=decimalId(item?.subject_id),parent=decimalId(item?.source_id),time=Number(r?.at_time);
      if(!id||!uid||!aid||!parent||Number(item?.business_id)!==1||!Number.isSafeInteger(time)||time<0)continue;
      items.push({id,time,uid,name:String(r.user?.nickname||uid).slice(0,80),aid,parent,root:decimalId(item.root_id)||parent});
    }
    const c=data.cursor as any,next=c&&!c.is_end&&decimalId(c.id)&&Number.isSafeInteger(Number(c.time))?{id:String(c.id),time:Number(c.time)}:undefined;return {items,oldestTime,newest,next};
  }
  async verifyMention(notice:BiliMention,selfId:string,signal?:AbortSignal):Promise<BiliComment>{
    if(!this.settings.biliSocial.ownerUids.includes(notice.uid))throw new Error('该评论作者不是主人 UID 白名单');
    const cookies=this.cookies(),headers={Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ')};
    for(let page=1;page<=5;page++){
      const query=new URLSearchParams({type:'1',oid:notice.aid,root:notice.root,pn:String(page),ps:'20'}),{data}=await this.request('https://api.bilibili.com/x/v2/reply/reply?'+query,{headers},signal);
      const replies=Array.isArray(data.replies)?data.replies:[],raw=[data.root,...replies];
      for(const row of raw){const comment=parsedComment(row,notice.aid);if(comment?.id!==notice.parent)continue;if(comment.uid!==notice.uid||comment.root!==notice.root||!comment.mentions.includes(selfId))throw new Error('评论作者、楼层或真实 @ 对象与通知不一致，本次不执行');return comment;}
      if(replies.length<20)break;
    }throw new Error('未能从原评论楼层核实这条 @，可能已删除、撤回或超出本轮读取范围');
  }
  private async vc(path:string,init:RequestInit={},signal?:AbortSignal):Promise<ObjectValue>{
    const cookies=this.cookies(),response=await this.fetcher('https://api.vc.bilibili.com'+path,{...init,headers:{'User-Agent':AGENT,Referer:'https://message.bilibili.com/','Content-Type':'application/x-www-form-urlencoded',Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; '),...init.headers},redirect:'error',signal:AbortSignal.any([timeoutSignal(this.settings.bilibili.timeoutMs),...(signal?[signal]:[])])});
    if(!response.ok)throw new Error('B 站私信 HTTP '+response.status);
    if(!response.body)throw new Error('B 站私信响应为空');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>1024*1024)throw new Error('B 站私信响应过大');chunks.push(r.value);}}finally{await reader.cancel().catch(()=>{});}
    const value=object(losslessJSON(Buffer.concat(chunks).toString('utf8')));if(value.code!==0)throw new BiliApiError(Number(value.code));return object(value.data);
  }
  private dmAllowed(uid:string){if(!this.settings.bilibili.enabled||!this.settings.biliSocial.dmEnabled||!this.settings.biliSocial.ownerUids.includes(uid))throw new Error('该 UID 未获主人私信白名单授权');}
  async directMessages(uid:string,after?:string,signal?:AbortSignal):Promise<{seq:string;messages:{seq:string;text:string}[]}>{
    this.dmAllowed(uid);if(after!==undefined&&!/^\d+$/.test(after))throw new Error('私信游标无效');
    let end:string|undefined;const rows:{seq:string;text:string}[]=[];let highest=after??'0';
    for(let page=0;page<5;page++){
      const query=new URLSearchParams({talker_id:uid,session_type:'1',size:'20',sender_device_id:'1',mobi_app:'web',build:'0',...(after!==undefined?{begin_seqno:after}:{}),...(end?{end_seqno:end}:{})});
      const data=await this.vc('/svr_sync/v1/svr_sync/fetch_session_msgs?'+query,{},signal),messages=Array.isArray(data.messages)?data.messages:[];
      const max=String(data.max_seqno??'0');if(/^\d+$/.test(max)&&BigInt(max)>BigInt(highest))highest=max;
      for(const row of messages){const seq=String(row?.msg_seqno??'');if(/^\d+$/.test(seq)&&BigInt(seq)>BigInt(highest))highest=seq;}
      if(after===undefined)return {seq:highest,messages:[]};
      for(const row of messages){const seq=String(row?.msg_seqno??'');if(!/^\d+$/.test(seq)||BigInt(seq)<=BigInt(after)||String(row.sender_uid)!==uid||Number(row.receiver_type)!==1||Number(row.msg_type)!==1||row.msg_status!==undefined&&row.msg_status!==null&&Number(row.msg_status)!==0||typeof row.content!=='string')continue;let body:unknown;try{body=JSON.parse(row.content);}catch{continue;}const text=(body as {content?:unknown})?.content;if(typeof text==='string'&&text.trim()&&text.length<=10000)rows.push({seq,text});}
      if(!data.has_more||!messages.length)return {seq:highest,messages:[...new Map(rows.map(r=>[r.seq,r])).values()].sort((a,b)=>BigInt(a.seq)<BigInt(b.seq)?-1:1)};
      const min=String(data.min_seqno??'');if(!/^\d+$/.test(min)||BigInt(min)<=BigInt(after))return {seq:highest,messages:rows.sort((a,b)=>BigInt(a.seq)<BigInt(b.seq)?-1:1)};if(end===min)throw new Error('私信分页游标未前进，本轮不跳过消息');end=min;
    }throw new Error('新私信积压超过本轮读取范围，本次未推进游标；请在官方客户端处理积压');
  }
  async sendDirect(uid:string,text:string,externalKey:string,signal?:AbortSignal):Promise<string>{
    if(this.identity==='owner')throw new Error('主人账号仅用于读取观看兴趣，不能发送互动');
    this.dmAllowed(uid);text=text.trim();if(!text||Buffer.byteLength(JSON.stringify({content:text}))>2000)throw new Error('B 站私信正文为空或超过 2000 字节');
    const account=await this.account(signal);if(!account.loggedIn||!/^\d+$/.test(account.userId)||uid===account.userId)throw new Error('B 站私信账号无效或正在给自己发消息');
    const cookies=this.cookies(),key=createHash('sha256').update(JSON.stringify([account.userId,uid,externalKey])).digest('hex');
    this.memory.reserveAction('bili-dm',key,this.settings.biliSocial.repliesPerDay,this.settings.biliSocial.minReplySeconds*1000);
    try{
      // Same documented WBI image keys; no private session cookie leaves Bilibili.
      if(!this.playbackKeys||this.playbackKeys.expires<this.memory.clock()){const {data}=await this.request('https://api.bilibili.com/x/web-interface/nav',{headers:{Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ')}},signal);const keys=object(data.wbi_img),extract=(v:unknown)=>typeof v==='string'?new URL(v).pathname.split('/').at(-1)!.split('.')[0]!:'';this.playbackKeys={image:extract(keys.img_url),sub:extract(keys.sub_url),expires:this.memory.clock()+300000};}
      const device=randomUUID(),query=wbiQuery({w_sender_uid:account.userId,w_receiver_id:uid,w_dev_id:device},this.playbackKeys.image,this.playbackKeys.sub,this.memory.clock()),form=new URLSearchParams({'msg[sender_uid]':account.userId,'msg[receiver_id]':uid,'msg[receiver_type]':'1','msg[msg_type]':'1','msg[msg_status]':'0','msg[dev_id]':device,'msg[timestamp]':String(Math.floor(Date.now()/1000)),'msg[new_face_version]':'1','msg[content]':JSON.stringify({content:text}),csrf:cookies.bili_jct!,csrf_token:cookies.bili_jct!,build:'0',mobi_app:'web'});
      const data=await this.vc('/web_im/v1/web_im/send_msg?'+query,{method:'POST',body:form},signal),receipt=String(data.msg_key??'');if(!/^[1-9]\d*$/.test(receipt))throw new Error('未收到私信消息 ID');this.memory.settleAction(key,'sent',receipt);return receipt;
    }catch(error){this.memory.settleAction(key,error instanceof BiliApiError?'failed':'unknown','需核实平台状态');if(error instanceof BiliApiError)throw error;throw new Error('B 站私信发送结果未知，不会自动重发，请在官方客户端核实');}
  }
}
