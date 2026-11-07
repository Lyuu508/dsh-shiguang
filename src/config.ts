import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface Settings {
  roleId: string; persona: string; timezone: string; dataDir: string;
  provider: string; model: string; replyTimeoutMs: number; maxReplyChars: number; maxQueue: number;
  memory: { todayMaxChars: number; recentMessages: number; recentMaxChars: number; searchLimit: number; snippetChars: number; detailMaxChars: number };
  qq: { enabled: boolean; wsUrl: string; tokenEnv: string; ownerQQ: string; allowedPrivate: string[]; allowedGroups: string[]; groupMentionOnly: boolean; actionTimeoutMs: number; reconnectMs: number };
  bilibili: { enabled: boolean; allowComments: boolean; commentsPerDay: number; minCommentIntervalMs: number; timeoutMs: number };
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
function integer(v: unknown, key: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`配置 ${key} 应在 ${min}–${max} 之间`);
  return v;
}
function ids(v: unknown, key: string): string[] {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !/^\d+$/.test(x))) throw new Error(`配置 ${key} 应为 QQ 号码字符串数组`);
  return v as string[];
}
export function configFile(path = ''): string {
  return resolve(path || process.env.DSH_SHIGUANG_CONFIG || resolve(homedir(), '.dsh', 'shiguang', 'config.json'));
}
export function parseSettings(value: unknown, file: string): Settings {
  const c = object(value, 'root'), m = object(c.memory, 'memory'), q = object(c.qq, 'qq'), b = object(c.bilibili, 'bilibili');
  const zone = string(c.timezone, 'timezone');
  const timezone = zone === 'system' ? Intl.DateTimeFormat().resolvedOptions().timeZone : zone;
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  const dataPath = string(c.dataDir, 'dataDir');
  const s: Settings = {
    roleId: string(c.roleId, 'roleId'), persona: string(c.persona, 'persona'), timezone,
    dataDir: isAbsolute(dataPath) ? dataPath : resolve(dirname(file), dataPath),
    provider: string(c.provider, 'provider'), model: string(c.model, 'model'),
    replyTimeoutMs: integer(c.replyTimeoutMs, 'replyTimeoutMs', 1000, 600000),
    maxReplyChars: integer(c.maxReplyChars, 'maxReplyChars', 100, 10000), maxQueue: integer(c.maxQueue, 'maxQueue', 1, 100),
    memory: {
      todayMaxChars: integer(m.todayMaxChars, 'memory.todayMaxChars', 100, 20000),
      recentMessages: integer(m.recentMessages, 'memory.recentMessages', 1, 100),
      recentMaxChars: integer(m.recentMaxChars, 'memory.recentMaxChars', 100, 20000),
      searchLimit: integer(m.searchLimit, 'memory.searchLimit', 1, 20),
      snippetChars: integer(m.snippetChars, 'memory.snippetChars', 50, 1000),
      detailMaxChars: integer(m.detailMaxChars, 'memory.detailMaxChars', 100, 10000),
    },
    qq: {
      enabled: boolean(q.enabled, 'qq.enabled'), wsUrl: string(q.wsUrl, 'qq.wsUrl'), tokenEnv: string(q.tokenEnv, 'qq.tokenEnv'),
      ownerQQ: string(q.ownerQQ, 'qq.ownerQQ'), allowedPrivate: ids(q.allowedPrivate, 'qq.allowedPrivate'), allowedGroups: ids(q.allowedGroups, 'qq.allowedGroups'),
      groupMentionOnly: boolean(q.groupMentionOnly, 'qq.groupMentionOnly'),
      actionTimeoutMs: integer(q.actionTimeoutMs, 'qq.actionTimeoutMs', 1000, 120000), reconnectMs: integer(q.reconnectMs, 'qq.reconnectMs', 500, 60000),
    },
    bilibili: {
      enabled: boolean(b.enabled, 'bilibili.enabled'), allowComments: boolean(b.allowComments, 'bilibili.allowComments'),
      commentsPerDay: integer(b.commentsPerDay, 'bilibili.commentsPerDay', 0, 100),
      minCommentIntervalMs: integer(b.minCommentIntervalMs, 'bilibili.minCommentIntervalMs', 1000, 86400000),
      timeoutMs: integer(b.timeoutMs, 'bilibili.timeoutMs', 1000, 120000),
    },
  };
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(s.roleId)) throw new Error('roleId 只能使用字母、数字、下划线和连字符');
  if (Boolean(s.provider) !== Boolean(s.model)) throw new Error('provider 和 model 必须同时填写或同时留空，留空使用 DSH 默认模型');
  const u = new URL(s.qq.wsUrl);
  if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('qq.wsUrl 必须为不带凭据或查询参数的 ws/wss 地址');
  if (s.qq.enabled && (!/^\d+$/.test(s.qq.ownerQQ) || !s.qq.tokenEnv || !process.env[s.qq.tokenEnv])) throw new Error('启用 QQ 前，请设置 ownerQQ 和 tokenEnv 指向的本机环境变量');
  return s;
}
export function loadSettings(path = ''): Settings {
  const file = configFile(path);
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { throw new Error(`尚未配置 Shiguang。请在插件目录执行 npm run setup，配置文件：${file}`); }
  const settings = parseSettings(JSON.parse(text), file);
  mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
  return settings;
}
