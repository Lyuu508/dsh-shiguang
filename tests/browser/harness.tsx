import React from 'react';
import { createRoot } from 'react-dom/client';
import { ShiguangPanel } from '../../client/Panel.js';
import type { PanelApi } from '../../client/types.js';
const api:PanelApi={async call<T>(action:string,args:object={},signal?:AbortSignal):Promise<T>{
 const response=await fetch('/api/shiguang',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'shiguang',payload:{action,args}}),signal});
 const envelope=await response.json();if(!envelope.result.ok)throw new Error(envelope.result.error.message);return envelope.result.value;
}};
createRoot(document.getElementById('root')!).render(<ShiguangPanel api={api}/>);
