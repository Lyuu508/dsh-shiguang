import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Settings} from './config.js';
const keys=['displayName','persona','provider','model','maxReplyChars','replyTimeoutMs','memory','retention','clock','voice'] as const;
type Profile=Pick<Settings,(typeof keys)[number]> & {roleId:string};
export class RoleManager {
 private profiles:Record<string,Profile>={};private file:string;
 constructor(readonly dataDir:string){this.file=join(dataDir,'roles.json');try{const value=JSON.parse(readFileSync(this.file,'utf8'));if(value.version===1&&value.roles&&typeof value.roles==='object')this.profiles=value.roles;}catch{}}
 private write(){mkdirSync(this.dataDir,{recursive:true,mode:0o700});const file=this.file+'.'+randomUUID()+'.tmp';writeFileSync(file,JSON.stringify({version:1,roles:this.profiles},null,2)+'\n',{mode:0o600});renameSync(file,this.file);}
 remember(settings:Settings){this.profiles[settings.roleId]=Object.fromEntries(['roleId',...keys].map(key=>[key,structuredClone(settings[key as keyof Settings])])) as Profile;this.write();}
 list(active:string){return Object.values(this.profiles).map(p=>({id:p.roleId,name:p.displayName,active:p.roleId===active}));}
 create(settings:Settings,name:string,persona:string,copy:boolean){if(!name.trim())throw new Error('请填写新角色名称');const id='role-'+randomUUID().slice(0,12),profile=Object.fromEntries(['roleId',...keys].map(key=>[key,structuredClone(settings[key as keyof Settings])])) as Profile;profile.roleId=id;profile.displayName=name.trim();profile.persona=persona.trim()||(copy?settings.persona:'')||'你是一个自然、真诚的 AI 伙伴。记住已经确认的重要事实，不编造经历。';if(!copy)profile.voice={...profile.voice,enabled:false,speakerId:''};this.profiles[id]=profile;this.write();return id;}
 settingsFor(current:Settings,id:string):Settings{const profile=this.profiles[id];if(!profile)throw new Error('角色不存在');return {...current,...structuredClone(profile)};}
}
