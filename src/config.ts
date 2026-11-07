import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

export const MEDIA_DEFAULTS = {
  enabled: false, mode: 'ask' as 'ask' | 'auto', provider: '', model: '',
  ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', localMediaDir: '',
  frames: 3, sheetSize: 512, maxFileMB: 20, maxDurationSeconds: 120,
  timeoutMs: 30000, maxOutputTokens: 320, dailyLimit: 30, contextChars: 600, cacheHours: 24,
};
export type MediaSettings = typeof MEDIA_DEFAULTS;
export const AUTONOMY_DEFAULTS = {
  enabled:false, wakeTimes:['09:00','15:00','21:00'], videosPerWake:2, candidatesPerWake:8,
  maxRunsPerDay:6, autoComment:false, autoDynamic:false, includeQQNotes:false,
  maxOutputTokens:700, contextChars:1200,
  scheduleMode:'fixed' as 'fixed'|'free',minWakeMinutes:45,maxWakeMinutes:240,quietStart:'23:00',quietEnd:'08:00',chooseBrowsing:true,allowDeep:false,recommendOwner:false,autoLike:false,
};
export type AutonomySettings = typeof AUTONOMY_DEFAULTS;
export const NAPCAT_DEFAULTS = { mode: 'managed' as 'managed' | 'external', autoInstall: true, webuiUrl: 'http://127.0.0.1:6099', downloadConnections:4, mirrorUrl:'' };
export const BILI_VISION_DEFAULTS = {enabled:false,autoBrowse:false,provider:'',model:'',frames:4,sheetSize:768,maxFileMB:40,maxDurationSeconds:600,timeoutMs:90000,maxOutputTokens:480,dailyLimit:12,subtitleChars:1800,cacheHours:24,deepSegmentSeconds:90,deepMaxSegments:8};
export const UPDATE_DEFAULTS={timeoutMs:15000,downloadTimeoutMs:300000,retries:2,mirrorUrl:''};
export const PROACTIVE_DEFAULTS={enabled:false,activity:'normal' as 'silent'|'low'|'normal'|'active',minGapMinutes:60,maxGapMinutes:240,maxPerDay:4,decisionsPerDay:8,quietStart:'23:00',quietEnd:'08:00',waitForReply:true,contextChars:1200,maxTokens:480,company:30,care:25,share:20,play:15,chat:10};
export const BILI_SOCIAL_DEFAULTS={ownerUids:[] as string[],dmEnabled:false,pollSeconds:60,repliesPerDay:20,minReplySeconds:10};
export const CLOCK_DEFAULTS={enabled:false,wakeAt:'08:00',sleepAt:'23:00',wakeOnMention:true,wakeChance:25,awakeMinutes:10,minWakeGapMinutes:30};
export const EMOJI_DEFAULTS={enabled:false,dailyLimit:3,decisionsPerDay:8,allowGroups:false,maxFileMB:5,maxOutputTokens:240};
export const VOICE_DEFAULTS = {enabled:false,authMode:'app' as 'app'|'apiKey',appId:'',speakerId:'',resourceId:'seed-icl-2.0',mode:'ask' as 'ask'|'auto',sendText:true,allowGroups:false,maxChars:200,dailyLimit:30,timeoutMs:30000,speechRate:0};
export function mirrorBaseUrl(value:string):URL {
  const u=new URL(value);
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash||!u.hostname.includes('.')||/^[\d.]+$/.test(u.hostname)||['localhost','.localhost','.local','.internal'].some(s=>u.hostname===s||u.hostname.endsWith(s)))throw new Error('下载加速地址应为你信任的公开 HTTPS 镜像前缀，不带账号或查询参数');
  if(!u.pathname.endsWith('/'))u.pathname+='/';return u;
}

export function napcatBaseUrl(value: string): URL {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('NapCat 后台地址应为本机 HTTP 地址，例如 http://127.0.0.1:6099');
  return u;
}

export interface Settings {
  roleId: string; displayName: string; persona: string; timezone: string; dataDir: string;
  provider: string; model: string; replyTimeoutMs: number; maxReplyChars: number; maxQueue: number;
  memory: { todayMaxChars: number; recentMessages: number; recentMaxChars: number; searchLimit: number; snippetChars: number; detailMaxChars: number };
  media: MediaSettings;
  autonomy: AutonomySettings;
  napcat: typeof NAPCAT_DEFAULTS;
  biliVision: typeof BILI_VISION_DEFAULTS;
  voice: typeof VOICE_DEFAULTS;
  updates:typeof UPDATE_DEFAULTS;
  proactive:typeof PROACTIVE_DEFAULTS;
  biliSocial:typeof BILI_SOCIAL_DEFAULTS;
  clock:typeof CLOCK_DEFAULTS;
  emoji:typeof EMOJI_DEFAULTS;
  qq: { enabled: boolean; wsUrl: string; tokenEnv: string; ownerQQ: string; allowedPrivate: string[]; allowedGroups: string[]; groupMentionOnly: boolean; actionTimeoutMs: number; reconnectMs: number };
  bilibili: { enabled: boolean; allowComments: boolean;manualWhitelist:boolean;allowLikes:boolean;likesPerDay:number;minLikeIntervalMs:number; commentsPerDay: number; minCommentIntervalMs: number; timeoutMs: number; allowedTags:string[];blockedTags:string[];allowDynamics:boolean;dynamicsPerDay:number;minDynamicIntervalMs:number };
}

function object(v: unknown, key: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`配置 ${key} 必须是对象`);
  return v as Record<string, unknown>;
}
function string(v: unknown, key: string): string {
  if (typeof v !== 'string') throw new Error(`配置 ${key} 必须是字符串`);
  return v;
}
function boolean(v: unknown, key: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`配置 ${key} 必须是布尔值`);
  return v;
}
function integer(v: unknown, key: string, min: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new Error(`配置 ${key} 应为不小于 ${min} 的安全整数`);
  return v;
}
function ids(v: unknown, key: string): string[] {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !/^\d+$/.test(x))) throw new Error(`配置 ${key} 应为数字 ID 字符串数组`);
  return v as string[];
}
function strings(v:unknown,key:string):string[]{
  if(!Array.isArray(v)||v.some(s=>typeof s!=='string'||!s.trim()))throw new Error(`配置 ${key} 应为非空文本数组`);
  return [...new Set((v as string[]).map(s=>s.trim()))];
}
export function configFile(path = ''): string {
  return resolve(path || process.env.DSH_SHIGUANG_CONFIG || resolve(homedir(), '.dsh', 'shiguang', 'config.json'));
}
export function parseSettings(value: unknown, file: string): Settings {
  const c = object(value, 'root'), m = object(c.memory, 'memory'), q = object(c.qq, 'qq'), b = object(c.bilibili, 'bilibili');
  const v = { ...MEDIA_DEFAULTS, ...(c.media === undefined ? {} : object(c.media,'media')) };
  const a = { ...AUTONOMY_DEFAULTS, ...(c.autonomy===undefined?{}:object(c.autonomy,'autonomy')) };
  // Preserve existing manually configured bridges when upgrading older profiles.
  const n = { ...NAPCAT_DEFAULTS, mode: q.enabled ? 'external' : 'managed', ...(c.napcat === undefined ? {} : object(c.napcat,'napcat')) };
  const bv={...BILI_VISION_DEFAULTS,...(c.biliVision===undefined?{}:object(c.biliVision,'biliVision'))},vo={...VOICE_DEFAULTS,...(c.voice===undefined?{}:object(c.voice,'voice'))};
  const up={...UPDATE_DEFAULTS,...(c.updates===undefined?{}:object(c.updates,'updates'))},pr={...PROACTIVE_DEFAULTS,...(c.proactive===undefined?{}:object(c.proactive,'proactive'))},bs={...BILI_SOCIAL_DEFAULTS,...(c.biliSocial===undefined?{}:object(c.biliSocial,'biliSocial'))};
  const clock={...CLOCK_DEFAULTS,...(c.clock===undefined?{}:object(c.clock,'clock'))},emoji={...EMOJI_DEFAULTS,...(c.emoji===undefined?{}:object(c.emoji,'emoji'))};
  const zone = string(c.timezone, 'timezone');
  const timezone = zone === 'system' ? Intl.DateTimeFormat().resolvedOptions().timeZone : zone;
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  const dataPath = string(c.dataDir, 'dataDir');
  const s: Settings = {
    roleId: string(c.roleId, 'roleId'), displayName: string(c.displayName ?? '拾光', 'displayName'), persona: string(c.persona, 'persona'), timezone,
    dataDir: isAbsolute(dataPath) ? dataPath : resolve(dirname(file), dataPath),
    provider: string(c.provider, 'provider'), model: string(c.model, 'model'),
    replyTimeoutMs: integer(c.replyTimeoutMs, 'replyTimeoutMs',1000),
    maxReplyChars: integer(c.maxReplyChars, 'maxReplyChars',100), maxQueue: integer(c.maxQueue, 'maxQueue',1),
    memory: {
      todayMaxChars: integer(m.todayMaxChars, 'memory.todayMaxChars',100),
      recentMessages: integer(m.recentMessages, 'memory.recentMessages',1),
      recentMaxChars: integer(m.recentMaxChars, 'memory.recentMaxChars',100),
      searchLimit: integer(m.searchLimit, 'memory.searchLimit',1),
      snippetChars: integer(m.snippetChars, 'memory.snippetChars',50),
      detailMaxChars: integer(m.detailMaxChars, 'memory.detailMaxChars',100),
    },
    media: {
      enabled: boolean(v.enabled,'media.enabled'), mode: string(v.mode,'media.mode') as MediaSettings['mode'],
      provider: string(v.provider,'media.provider'), model: string(v.model,'media.model'),
      ffmpegPath: string(v.ffmpegPath,'media.ffmpegPath'), ffprobePath: string(v.ffprobePath,'media.ffprobePath'), localMediaDir: string(v.localMediaDir,'media.localMediaDir'),
      frames: integer(v.frames,'media.frames',1), sheetSize: integer(v.sheetSize,'media.sheetSize',256),
      maxFileMB: integer(v.maxFileMB,'media.maxFileMB',1), maxDurationSeconds: integer(v.maxDurationSeconds,'media.maxDurationSeconds',1),
      timeoutMs: integer(v.timeoutMs,'media.timeoutMs',1000), maxOutputTokens: integer(v.maxOutputTokens,'media.maxOutputTokens',128),
      dailyLimit: integer(v.dailyLimit,'media.dailyLimit',0), contextChars: integer(v.contextChars,'media.contextChars',0), cacheHours: integer(v.cacheHours,'media.cacheHours',1),
    },
    napcat: { mode: string(n.mode,'napcat.mode') as 'managed'|'external', autoInstall: boolean(n.autoInstall,'napcat.autoInstall'), webuiUrl: string(n.webuiUrl,'napcat.webuiUrl'),downloadConnections:integer(n.downloadConnections,'napcat.downloadConnections',1),mirrorUrl:string(n.mirrorUrl,'napcat.mirrorUrl') },
    biliVision:{enabled:boolean(bv.enabled,'biliVision.enabled'),autoBrowse:boolean(bv.autoBrowse,'biliVision.autoBrowse'),provider:string(bv.provider,'biliVision.provider'),model:string(bv.model,'biliVision.model'),frames:integer(bv.frames,'biliVision.frames',1),sheetSize:integer(bv.sheetSize,'biliVision.sheetSize',256),maxFileMB:integer(bv.maxFileMB,'biliVision.maxFileMB',1),maxDurationSeconds:integer(bv.maxDurationSeconds,'biliVision.maxDurationSeconds',1),timeoutMs:integer(bv.timeoutMs,'biliVision.timeoutMs',1000),maxOutputTokens:integer(bv.maxOutputTokens,'biliVision.maxOutputTokens',128),dailyLimit:integer(bv.dailyLimit,'biliVision.dailyLimit',0),subtitleChars:integer(bv.subtitleChars,'biliVision.subtitleChars',0),cacheHours:integer(bv.cacheHours,'biliVision.cacheHours',1),deepSegmentSeconds:integer(bv.deepSegmentSeconds,'biliVision.deepSegmentSeconds',15),deepMaxSegments:integer(bv.deepMaxSegments,'biliVision.deepMaxSegments',1)},
    voice:{enabled:boolean(vo.enabled,'voice.enabled'),authMode:string(vo.authMode,'voice.authMode') as 'app'|'apiKey',appId:string(vo.appId,'voice.appId'),speakerId:string(vo.speakerId,'voice.speakerId'),resourceId:string(vo.resourceId,'voice.resourceId'),mode:string(vo.mode,'voice.mode') as 'ask'|'auto',sendText:boolean(vo.sendText,'voice.sendText'),allowGroups:boolean(vo.allowGroups,'voice.allowGroups'),maxChars:integer(vo.maxChars,'voice.maxChars',20),dailyLimit:integer(vo.dailyLimit,'voice.dailyLimit',0),timeoutMs:integer(vo.timeoutMs,'voice.timeoutMs',1000),speechRate:integer(vo.speechRate,'voice.speechRate',-50)},
    qq: {
      enabled: boolean(q.enabled, 'qq.enabled'), wsUrl: string(q.wsUrl, 'qq.wsUrl'), tokenEnv: string(q.tokenEnv, 'qq.tokenEnv'),
      ownerQQ: string(q.ownerQQ, 'qq.ownerQQ'), allowedPrivate: ids(q.allowedPrivate, 'qq.allowedPrivate'), allowedGroups: ids(q.allowedGroups, 'qq.allowedGroups'),
      groupMentionOnly: boolean(q.groupMentionOnly, 'qq.groupMentionOnly'),
      actionTimeoutMs: integer(q.actionTimeoutMs, 'qq.actionTimeoutMs',1000), reconnectMs: integer(q.reconnectMs, 'qq.reconnectMs',500),
    },
    clock:{enabled:boolean(clock.enabled,'clock.enabled'),wakeAt:string(clock.wakeAt,'clock.wakeAt'),sleepAt:string(clock.sleepAt,'clock.sleepAt'),wakeOnMention:boolean(clock.wakeOnMention,'clock.wakeOnMention'),wakeChance:integer(clock.wakeChance,'clock.wakeChance',0),awakeMinutes:integer(clock.awakeMinutes,'clock.awakeMinutes',1),minWakeGapMinutes:integer(clock.minWakeGapMinutes,'clock.minWakeGapMinutes',0)},
    emoji:{enabled:boolean(emoji.enabled,'emoji.enabled'),dailyLimit:integer(emoji.dailyLimit,'emoji.dailyLimit',0),decisionsPerDay:integer(emoji.decisionsPerDay,'emoji.decisionsPerDay',0),allowGroups:boolean(emoji.allowGroups,'emoji.allowGroups'),maxFileMB:integer(emoji.maxFileMB,'emoji.maxFileMB',1),maxOutputTokens:integer(emoji.maxOutputTokens,'emoji.maxOutputTokens',1)},
    updates:{timeoutMs:integer(up.timeoutMs,'updates.timeoutMs',3000),downloadTimeoutMs:integer(up.downloadTimeoutMs,'updates.downloadTimeoutMs',30000),retries:integer(up.retries,'updates.retries',0),mirrorUrl:string(up.mirrorUrl,'updates.mirrorUrl')},
    proactive:{enabled:boolean(pr.enabled,'proactive.enabled'),activity:string(pr.activity,'proactive.activity') as typeof PROACTIVE_DEFAULTS['activity'],minGapMinutes:integer(pr.minGapMinutes,'proactive.minGapMinutes',10),maxGapMinutes:integer(pr.maxGapMinutes,'proactive.maxGapMinutes',10),maxPerDay:integer(pr.maxPerDay,'proactive.maxPerDay',0),decisionsPerDay:integer(pr.decisionsPerDay,'proactive.decisionsPerDay',1),quietStart:string(pr.quietStart,'proactive.quietStart'),quietEnd:string(pr.quietEnd,'proactive.quietEnd'),waitForReply:boolean(pr.waitForReply,'proactive.waitForReply'),contextChars:integer(pr.contextChars,'proactive.contextChars',0),maxTokens:integer(pr.maxTokens,'proactive.maxTokens',128),company:integer(pr.company,'proactive.company',0),care:integer(pr.care,'proactive.care',0),share:integer(pr.share,'proactive.share',0),play:integer(pr.play,'proactive.play',0),chat:integer(pr.chat,'proactive.chat',0)},
    biliSocial:{ownerUids:ids(bs.ownerUids,'biliSocial.ownerUids'),dmEnabled:boolean(bs.dmEnabled,'biliSocial.dmEnabled'),pollSeconds:integer(bs.pollSeconds,'biliSocial.pollSeconds',30),repliesPerDay:integer(bs.repliesPerDay,'biliSocial.repliesPerDay',0),minReplySeconds:integer(bs.minReplySeconds,'biliSocial.minReplySeconds',0)},
    autonomy:{
      enabled:boolean(a.enabled,'autonomy.enabled'),wakeTimes:strings(a.wakeTimes,'autonomy.wakeTimes').sort(),
      videosPerWake:integer(a.videosPerWake,'autonomy.videosPerWake',1),candidatesPerWake:integer(a.candidatesPerWake,'autonomy.candidatesPerWake',1),
      maxRunsPerDay:integer(a.maxRunsPerDay,'autonomy.maxRunsPerDay',1),autoComment:boolean(a.autoComment,'autonomy.autoComment'),autoDynamic:boolean(a.autoDynamic,'autonomy.autoDynamic'),includeQQNotes:boolean(a.includeQQNotes,'autonomy.includeQQNotes'),
      maxOutputTokens:integer(a.maxOutputTokens,'autonomy.maxOutputTokens',128),contextChars:integer(a.contextChars,'autonomy.contextChars',0),
      scheduleMode:string(a.scheduleMode,'autonomy.scheduleMode') as 'fixed'|'free',minWakeMinutes:integer(a.minWakeMinutes,'autonomy.minWakeMinutes',15),maxWakeMinutes:integer(a.maxWakeMinutes,'autonomy.maxWakeMinutes',15),quietStart:string(a.quietStart,'autonomy.quietStart'),quietEnd:string(a.quietEnd,'autonomy.quietEnd'),chooseBrowsing:boolean(a.chooseBrowsing,'autonomy.chooseBrowsing'),allowDeep:boolean(a.allowDeep,'autonomy.allowDeep'),recommendOwner:boolean(a.recommendOwner,'autonomy.recommendOwner'),autoLike:boolean(a.autoLike,'autonomy.autoLike'),
    },
    bilibili: {
      enabled: boolean(b.enabled, 'bilibili.enabled'),manualWhitelist:boolean(b.manualWhitelist??false,'bilibili.manualWhitelist'),allowLikes:boolean(b.allowLikes??false,'bilibili.allowLikes'),likesPerDay:integer(b.likesPerDay??20,'bilibili.likesPerDay',0),minLikeIntervalMs:integer(b.minLikeIntervalMs??60000,'bilibili.minLikeIntervalMs',0), allowComments: boolean(b.allowComments, 'bilibili.allowComments'),
      commentsPerDay: integer(b.commentsPerDay, 'bilibili.commentsPerDay',0),
      minCommentIntervalMs: integer(b.minCommentIntervalMs, 'bilibili.minCommentIntervalMs',1000),
      timeoutMs: integer(b.timeoutMs, 'bilibili.timeoutMs',1000),
      allowedTags:strings(b.allowedTags??[],'bilibili.allowedTags'),blockedTags:strings(b.blockedTags??[],'bilibili.blockedTags'),
      allowDynamics:boolean(b.allowDynamics??false,'bilibili.allowDynamics'),dynamicsPerDay:integer(b.dynamicsPerDay??2,'bilibili.dynamicsPerDay',0),minDynamicIntervalMs:integer(b.minDynamicIntervalMs??3600000,'bilibili.minDynamicIntervalMs',60000),
    },
  };
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(s.roleId)) throw new Error('roleId 只能使用字母、数字、下划线和连字符');
  if (!s.displayName.trim()) throw new Error('角色名称不能为空');
  if (Boolean(s.provider) !== Boolean(s.model)) throw new Error('provider 和 model 必须同时填写或同时留空，留空使用 DSH 默认模型');
  if (!['ask','auto'].includes(s.media.mode)) throw new Error('视频识别模式或拼图尺寸无效');
  if (Boolean(s.media.provider) !== Boolean(s.media.model)) throw new Error('视觉模型的 provider 和 model 必须同时填写或同时留空');
  if ([s.media.ffmpegPath,s.media.ffprobePath].some(p=>!p.trim() || /[\r\n\0]/.test(p))) throw new Error('请填写有效的 FFmpeg / FFprobe 程序路径');
  const u = new URL(s.qq.wsUrl);
  if (!['managed','external'].includes(s.napcat.mode)) throw new Error('NapCat 安装模式无效');
  napcatBaseUrl(s.napcat.webuiUrl);
  if(s.napcat.mirrorUrl)mirrorBaseUrl(s.napcat.mirrorUrl);
  if(s.updates.mirrorUrl)mirrorBaseUrl(s.updates.mirrorUrl);
  for(const value of [s.clock.wakeAt,s.clock.sleepAt,s.autonomy.quietStart,s.autonomy.quietEnd,s.proactive.quietStart,s.proactive.quietEnd])if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw new Error('安静时段使用 HH:mm');
  if(!['fixed','free'].includes(s.autonomy.scheduleMode)||s.autonomy.minWakeMinutes>s.autonomy.maxWakeMinutes)throw new Error('自主醒来模式或间隔范围无效');
  if(!['silent','low','normal','active'].includes(s.proactive.activity)||s.proactive.minGapMinutes>s.proactive.maxGapMinutes||s.proactive.enabled&&!(s.proactive.company+s.proactive.care+s.proactive.share+s.proactive.play+s.proactive.chat))throw new Error('主动私聊活跃度、间隔或动机权重无效');
  if(s.biliSocial.ownerUids.some(uid=>!/[1-9]/.test(uid)))throw new Error('B 站主人 UID 应为正整数');
  if(Boolean(s.biliVision.provider)!==Boolean(s.biliVision.model))throw new Error('B 站视觉模型需同时填写提供方和模型，拼图尺寸请选择预设值');
  if(!['app','apiKey'].includes(s.voice.authMode)||!['ask','auto'].includes(s.voice.mode)||!['seed-icl-1.0','seed-icl-2.0'].includes(s.voice.resourceId))throw new Error('语音鉴权方式、触发方式或复刻资源 ID 无效');
  if(s.voice.appId&&!/^\d{1,32}$/.test(s.voice.appId)||s.voice.speakerId&&!/^[A-Za-z0-9_-]{1,128}$/.test(s.voice.speakerId))throw new Error('请填写有效的火山 APPID 和音色 ID');
  if(s.voice.enabled&&(!s.voice.speakerId||s.voice.authMode==='app'&&!s.voice.appId))throw new Error('开启语音前请填写音色 ID，以及 APPID（APP 鉴权模式）');
  if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('qq.wsUrl 必须为不带凭据或查询参数的 ws/wss 地址');
  if (s.qq.enabled && !/^\d+$/.test(s.qq.ownerQQ)) throw new Error('启用 QQ 前，请设置 ownerQQ');
  if (s.qq.tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.qq.tokenEnv)) throw new Error('Token 环境变量名称无效');
  if(s.autonomy.wakeTimes.some(t=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))throw new Error('醒来时间应为 HH:mm');
  if(s.autonomy.enabled&&(!s.bilibili.enabled||!s.bilibili.allowedTags.length||s.autonomy.scheduleMode==='fixed'&&!s.autonomy.wakeTimes.length))throw new Error('启用自主生活前需要开启 B 站、填写白名单标签和所需醒来时间');
  if(s.clock.wakeChance>100)throw new Error('被 @ 唤醒概率应在 0–100% 之间');
  if(s.voice.speechRate < -50 || s.voice.speechRate>100)throw new Error('火山语音协议要求语速在 -50–100 之间');
  return s;
}
export function ensureSettings(path = ''): string {
  const file = configFile(path);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, readFileSync(new URL('../config.example.json', import.meta.url)), { flag: 'wx', mode: 0o600 });
  }
  return file;
}
export function loadSettings(path = ''): Settings {
  const file = configFile(path);
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { throw new Error(`尚未配置 Shiguang。请在插件目录执行 npm run setup，配置文件：${file}`); }
  const settings = parseSettings(JSON.parse(text), file);
  mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
  return settings;
}
