import {timeoutSignal} from './timeouts.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';

const ENDPOINT='https://openspeech.bytedance.com/api/v3/tts/unidirectional';
export class VoiceError extends Error {}
export const wantsVoice=(text:string,mode:Settings['voice']['mode'])=>mode==='auto'||/(?:\/语音|用语音|语音回复|读给我听|念给我听|说给我听)/.test(text);
export function spokenText(text:string,max:number):string {
  return [...text.replace(/https?:\/\/\S+/g,'链接').replace(/```[\s\S]*?```/g,'代码见文字回复').replace(/[*_`#~]/g,'').trim()].slice(0,max).join('');
}
export interface VoiceAudio {bytes:Buffer;chars:number;billedChars:number|null;reused:boolean}

/** HTTP chunked JSON objects may cross arbitrary TCP chunks, including UTF-8. */
export async function speechAudio(response:Response):Promise<{bytes:Buffer;billedChars:number|null}> {
  if(!response.body)throw new VoiceError('语音服务返回空内容');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),audio:Buffer[]=[];
  let buffer='',received=0,audioBytes=0,billedChars:number|null=null,terminal=false;
  function consume(final=false){
    for(;;){
      buffer=buffer.replace(/^\s+/,'');if(buffer.startsWith('data:'))buffer=buffer.slice(5).replace(/^\s+/,'');
      if(!buffer)break;
      if(buffer[0]!=='{')throw new VoiceError('语音服务返回了非 JSON 音频数据');
      let depth=0,string=false,escaped=false,end=-1;
      for(let i=0;i<buffer.length;i++){
        const ch=buffer[i];if(string){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')string=false;}
        else if(ch==='"')string=true;else if(ch==='{')depth++;else if(ch==='}'&&--depth===0){end=i+1;break;}
      }
      if(end<0){if(final)throw new VoiceError('语音响应中断，未发送不完整音频');break;}
      let value:any;try{value=JSON.parse(buffer.slice(0,end));}catch{throw new VoiceError('语音响应格式无效');}buffer=buffer.slice(end);
      if(terminal)throw new VoiceError('语音服务结束后仍返回额外数据');
      if(value.code===20000000){terminal=true;}
      else if(value.code!==0)throw new VoiceError(`火山语音合成未成功（code=${Number.isSafeInteger(value.code)?value.code:'未知'}），请检查音色、资源权限和鉴权配置`);
      if(value.usage&&Number.isSafeInteger(value.usage.text_words)&&value.usage.text_words>=0)billedChars=value.usage.text_words;
      if(value.code===0&&value.data!==undefined&&value.data!==''){
        if(typeof value.data!=='string'||value.data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.data))throw new VoiceError('语音服务返回的音频编码无效');
        const bytes=Buffer.from(value.data,'base64');audioBytes+=bytes.length;if(audioBytes>2*1024*1024)throw new VoiceError('语音音频超过 2 MB，请缩短内容');audio.push(bytes);
      }
    }
  }
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;received+=value.length;if(received>4*1024*1024)throw new VoiceError('语音响应超过大小限制');buffer+=decoder.decode(value,{stream:true});consume();}
    buffer+=decoder.decode();consume(true);
    const bytes=Buffer.concat(audio);if(!bytes.length)throw new VoiceError('语音服务没有返回可播放的音频');
    if(!(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]!&224)===224))throw new VoiceError('语音服务没有返回有效 MP3 音频');
    return {bytes,billedChars};
  }finally{await reader.cancel().catch(()=>{});}
}

export class VoiceService {
  private abort=new AbortController();
  private cache=new Map<string,{time:number;audio:VoiceAudio}>();
  constructor(readonly settings:Settings,readonly memory:MemoryStore,readonly secret:()=>string,readonly fetcher:typeof fetch=fetch){}
  stop(){this.abort.abort();this.cache.clear();}
  status(){
    const data=this.memory.db.prepare("SELECT count(*) AS calls,coalesce(sum(chars),0) AS chars,sum(billed_chars) AS billedChars,sum(CASE WHEN status='done' THEN 1 ELSE 0 END) AS succeeded FROM voice_usage WHERE role=? AND day=?").get(this.memory.roleId,this.memory.today())!;
    return {configured:!!this.secret(),enabled:this.settings.voice.enabled,todayCalls:Number(data.calls),todayChars:Number(data.chars),billedChars:data.billedChars===null?null:Number(data.billedChars),succeeded:Number(data.succeeded||0),dailyLimit:this.settings.voice.dailyLimit};
  }
  async synthesize(value:string,scope='owner',externalSignal?:AbortSignal):Promise<VoiceAudio>{
    const v=this.settings.voice;if(!v.enabled)throw new VoiceError('请先在语音页面开启火山复刻语音并保存');
    const token=this.secret();if(!token)throw new VoiceError('请先保存火山语音 Access Token / API Key');
    const text=spokenText(value,v.maxChars);if(!text)throw new VoiceError('请填写要朗读的文字');
    const key=createHash('sha256').update(JSON.stringify([scope,v.authMode,v.appId,v.speakerId,v.resourceId,v.speechRate,token,text])).digest('hex'),cached=this.cache.get(key);
    if(cached&&this.memory.clock()-cached.time<3600000)return {...cached.audio,reused:true};
    const id=randomUUID(),chars=[...text].length,signal=AbortSignal.any([this.abort.signal,timeoutSignal(v.timeoutMs),...(externalSignal?[externalSignal]:[])]);
    signal.throwIfAborted();
    this.memory.db.exec('BEGIN IMMEDIATE');
    try{if(this.status().todayCalls>=v.dailyLimit)throw new VoiceError('今天的语音合成次数已用完');this.memory.db.prepare("INSERT INTO voice_usage(id,role,day,time,chars,status) VALUES(?,?,?,?,?,'pending')").run(id,this.memory.roleId,this.memory.today(),this.memory.clock(),chars);this.memory.db.exec('COMMIT');}catch(e){this.memory.db.exec('ROLLBACK');throw e;}
    try{
      const response=await this.fetcher(ENDPOINT,{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json','X-Api-Request-Id':id,'X-Api-Resource-Id':v.resourceId,'X-Control-Require-Usage-Tokens-Return':'*',...(v.authMode==='app'?{'X-Api-App-Id':v.appId,'X-Api-Access-Key':token}:{'X-Api-Key':token})},body:JSON.stringify({user:{uid:this.settings.roleId},req_params:{text,speaker:v.speakerId,...(v.resourceId==='seed-icl-2.0'?{model:'seed-tts-2.0-standard'}:{}),audio_params:{format:'mp3',sample_rate:24000,speech_rate:v.speechRate},additions:JSON.stringify({aigc_metadata:{enable:true,content_producer:'Volcengine',content_propagator:'Shiguang'}})}})});
      if(!response.ok){await response.body?.cancel();throw new VoiceError(`火山语音 HTTP ${response.status}，请检查 APPID、Access Token、音色 ID 和服务额度`);}
      const result=await speechAudio(response),audio={...result,chars,reused:false};
      this.memory.db.prepare("UPDATE voice_usage SET status='done',billed_chars=? WHERE id=? AND role=?").run(result.billedChars,id,this.memory.roleId);
      if(this.cache.size>=10)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,{time:this.memory.clock(),audio});return audio;
    }catch(error){
      this.memory.db.prepare("UPDATE voice_usage SET status=? WHERE id=? AND role=?").run(error instanceof VoiceError?'failed':'unknown',id,this.memory.roleId);
      if(error instanceof VoiceError)throw error;throw new VoiceError(signal.aborted?'语音合成已取消或超时，本次不自动重试':'语音合成网络结果未知，本次不自动重试；请检查服务用量');
    }
  }
}
