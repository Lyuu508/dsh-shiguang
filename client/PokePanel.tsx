import {SettingSection} from './CompactSettings.js';
import React from 'react';
import type {Settings,Status} from './types.js';
import {Field,Toggle,Numeric} from './Form.js';
export function PokePanel({settings:s,status,onChange}:{settings:Settings;status?:Status;onChange:(s:Settings)=>void}){
 const p=s.qq.poke,edit=(patch:Partial<typeof p>)=>onChange({...s,qq:{...s.qq,poke:{...p,...patch}}});
 return <SettingSection className="sg-section"><h2>双击头像，也接住你的互动</h2><p className="sg-help">QQ 的拍一拍、搓一搓、揉一揉使用同一种头像互动通知，按实际目标识别，不依赖动作名称。仅限主人、允许私聊或白名单群；需要 SnowLuma 上报 poke 通知。</p><Toggle label="回应 QQ 双击头像互动" value={p.enabled} onChange={enabled=>edit({enabled})}/><Toggle label="允许在白名单群回应头像互动" value={p.allowGroups} onChange={allowGroups=>edit({allowGroups})}/><div className="sg-grid"><Numeric label="头像互动回应概率（%）" min={0} value={p.replyChance} onChange={replyChance=>edit({replyChance})}/><Numeric label="同一人头像互动冷却（秒）" min={0} value={p.cooldownSeconds} onChange={cooldownSeconds=>edit({cooldownSeconds})}/></div><Field label="未上报动作时的称呼"><input value={p.actionText} onChange={e=>edit({actionText:e.target.value})}/></Field><Field label="头像互动回应习惯"><textarea rows={3} value={p.replyStyle} onChange={e=>edit({replyStyle:e.target.value})}/></Field><p className="sg-notice" role="status">{status?.qq.poke.last.message||'尚未收到头像互动'}。当前运行：{status?.qq.poke.enabled?'互动开启':'互动关闭'}。头像互动使用独立概率，不再叠加普通消息的 95% / 85%；仍遵守 QQ 回复总开关、等待节奏与角色页生物钟。</p></SettingSection>;
}
