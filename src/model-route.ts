import type {Context} from '@deepseek-ai/cordis';
export const FLASH_MODEL='deepseek-flash';
/** Use DSH-owned credentials. Never fall back to a different model or copy a key. */
export async function flashRoute(ctx:Context):Promise<{provider:string;model:string}>{
 const llm=ctx.get('llm');if(!llm)throw new Error('请先在 DSH 登录 DeepSeek 或配置官方模型连接');
 const providers=new Set(llm.listProviders().map(p=>p.id)),known=['deepseek-account','deepseek-official'];
 const active=ctx.get('agents')?.list().filter(a=>!String(a.id).startsWith('shiguang-')).map(a=>a.model.current()).find(r=>r&&known.includes(r.provider)&&providers.has(r.provider));
 if(active)return {provider:active.provider,model:FLASH_MODEL};
 // getState is DSH's credential-free local account-presence API.
 const account=(ctx as unknown as {get(key:string):{getState?:()=>Promise<{status:string}>}|undefined}).get('deepseekAccount');
 if(providers.has('deepseek-account')&&await account?.getState?.().then(s=>s.status==='credential-stored').catch(()=>false))return {provider:'deepseek-account',model:FLASH_MODEL};
 if(providers.has('deepseek-official'))return {provider:'deepseek-official',model:FLASH_MODEL};
 if(providers.has('deepseek-account'))return {provider:'deepseek-account',model:FLASH_MODEL};
 throw new Error('请先在 DSH 登录 DeepSeek 或启用官方 DeepSeek 连接，拾光会自动使用最新 Flash');
}
