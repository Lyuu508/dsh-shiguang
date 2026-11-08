import type {Context} from '@deepseek-ai/cordis';
import {BlockAssembler,ReasoningEffortId} from '@deepseek-ai/dsh-llm';
import type {Settings} from './config.js';
import type {MemoryStore} from './memory.js';
import {flashRoute} from './model-route.js';
import {staticImage,visionFinishDiagnostic} from './media.js';
import {usageSession,recordSingleUsage} from './usage.js';
import {randomUUID} from 'node:crypto';
import {timeoutSignal} from './timeouts.js';
const probe=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR4nO3PsQkAAAzDsPz/dHpFliLwbFCaTBvvu94DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAAcuOzw4j9XSHcAAAAASUVORK5CYII=','base64');
export interface VisionCheckState {busy:boolean;ok:boolean;at:number;stage:string;message:string;provider:string;model:string;finish:string;diagnostic:string}
export class VisionCheck {
 private abort=new AbortController();
 state:VisionCheckState={busy:false,ok:false,at:0,stage:'尚未自检',message:'先确认模型能直接识别图片，再检查 QQ 下载或动图抽帧',provider:'',model:'',finish:'',diagnostic:''};
 constructor(readonly ctx:Context,readonly settings:Settings,readonly memory:MemoryStore){}
 stop(){this.abort.abort();}
 async run(){
  if(this.state.busy)return this.state;this.state={...this.state,busy:true,ok:false,at:this.memory.clock(),stage:'检查模型与附件',message:'正在测试',diagnostic:'',finish:''};const signal=AbortSignal.any([this.abort.signal,timeoutSignal(this.settings.replyTimeoutMs)]);
  try{const route=await flashRoute(this.ctx);Object.assign(this.state,route);const llm=this.ctx.get('llm');if(!llm)throw Error('DSH 模型服务尚未启用');const info=await llm.resolveModelInfo(route.provider,route.model,signal);if(!info.inputModalities?.includes('image'))throw Error('当前连接的 Flash 未声明支持图片，请核对 DSH 模型连接');
   const image=await staticImage(this.ctx,probe,512,1048576,signal);if(!image)throw Error('无法创建测试图片');this.state.stage='调用图片模型';const assembler=new BlockAssembler(),session='shiguang-vision-check-'+randomUUID();
   try{for await(const chunk of llm.stream({...route,sessionId:usageSession(session),signal,reasoningEffort:ReasoningEffortId('off'),maxTokens:320,system:'图片识别自检。只读取真实图片，不猜测。仅输出 JSON：{"left":"左半边主要颜色的中文名称","right":"右半边主要颜色的中文名称"}。看不到则写未知。',messages:[{role:'user',content:[{type:'text',text:'这张图的左右两半各是什么颜色？'},{type:'image',attachment:image}]}]}))assembler.push(chunk);}finally{recordSingleUsage(this.memory,{session,source:'dsh',...route},'vision-test',assembler.usage);}
   this.state.finish=assembler.finish.kind;this.state.stage='校验模型回答';if(assembler.finish.kind!=='stop')throw Error(visionFinishDiagnostic(assembler.finish,320));
   const text=assembler.blocks().filter(b=>b.type==='text').map(b=>b.text).join('').replace(/<think>[\s\S]*?(?:<\/think>|$)/gi,'').trim();let result;try{const a=text.indexOf('{'),b=text.lastIndexOf('}');result=JSON.parse(text.slice(a,b+1));}catch{throw Error('模型有返回，但没有可校验的颜色结果；请核对连接和服务日志');}
   if(typeof result?.left!=='string'||typeof result?.right!=='string'||!/^(?:纯|正|鲜)?红色?$/.test(result.left.trim())||!/^(?:纯|正)?蓝色?$/.test(result.right.trim()))throw Error('未通过图片颜色校验，不能据此确认模型看到了图片');
   this.state.ok=true;this.state.stage='完成';this.state.message='通过：模型正确识别了图片左右颜色';this.state.diagnostic='本次直传真实图片，思考关闭；不经过 QQ 下载和 FFmpeg。仅证明本次简单图片识别通过。';
  }catch(error){this.state.message=error instanceof Error?error.message:'识图自检失败';this.state.message=this.state.message.replace(/sk-[\w-]+|Bearer\s+\S+/gi,'[密钥已隐藏]').slice(0,600);this.state.diagnostic='失败环节：'+this.state.stage+'。没有自动重试；无 QQ 消息或私人记忆参与。';}finally{this.state.busy=false;this.state.at=this.memory.clock();}
  return {...this.state};
 }
}
