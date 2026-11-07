import React from 'react';
import {settingHelp} from './setting-help.js';
export function Field({label,help,children}: {label:string;help?:string;children:React.ReactNode}) {
 const id=React.useId();
 return <div className="sg-field"><div><label htmlFor={id}>{label}</label> <small id={id+'-tip'} className="sg-setting-tip">（{settingHelp(label)}）</small></div>{React.Children.map(children,child=>React.isValidElement(child)&&typeof child.type==='string'&&['input','textarea','select'].includes(child.type)?React.cloneElement(child as React.ReactElement<{id:string;'aria-describedby'?:string}>,{id,'aria-describedby':id+'-tip'+(help?' '+id+'-help':'')}):child)}{help&&<small id={id+'-help'} className="sg-help">{help}</small>}</div>;
}
export function Toggle({label,help,value,onChange}: {label:string;help?:string;value:boolean;onChange:(v:boolean)=>void}) {
 const id=React.useId();return <div className="sg-toggle"><div><strong>{label}</strong> <small id={id+'-tip'} className="sg-setting-tip">（{settingHelp(label)}）</small>{help&&<p className="sg-help">{help}</p>}</div><label><input aria-label={label} aria-describedby={id+'-tip'} type="checkbox" checked={value} onChange={e=>onChange(e.target.checked)}/><span>{value?'已开启':'已关闭'}</span></label></div>;
}
export function Numeric({label,value,min,onChange}: {label:string;value:number;min:number;onChange:(n:number)=>void}) {
 return <Field label={label} help={label.includes('Token')?'单位为模型 Token；不等于中文字数。可自由调高，实际仍由所选服务的上下文和输出能力决定。':undefined}><input type="number" min={min} value={value} onChange={e=>onChange(Number(e.target.value))}/></Field>;
}
