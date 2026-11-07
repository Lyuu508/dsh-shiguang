import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import { ShiguangPanel } from './Panel.js';
import type { PanelApi } from './types.js';

export const inject = ['slots','connection'];
export function apply(ctx: Context): void {
  const connection=ctx.get('connection') as ConnectionHandle;
  const api: PanelApi = { async call<T>(action:string,args:object={},signal?:AbortSignal):Promise<T>{
    const result=await connection.rpc.call('/api','shiguang',{action,args},signal);
    if(!result.ok)throw new Error(result.error.message);
    return result.value as T;
  }};
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'shiguang',label:'拾光',order:65,inject:()=>({api})},ShiguangPanel));
}
