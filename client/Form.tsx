import React from 'react';
export function Field({label,help,children}: {label:string;help?:string;children:React.ReactNode}) {
  const id=React.useId();
  return <div className="sg-field"><label htmlFor={id}>{label}</label>{React.Children.map(children,child=>React.isValidElement(child)&&typeof child.type==='string'&&['input','textarea','select'].includes(child.type)?React.cloneElement(child as React.ReactElement<{id:string;'aria-describedby'?:string}>,{id,'aria-describedby':help?id+'-help':undefined}):child)}{help && <small id={id+'-help'} className="sg-help">{help}</small>}</div>;
}
export function Toggle({label,help,value,onChange}: {label:string;help?:string;value:boolean;onChange:(v:boolean)=>void}) {
  return <div className="sg-toggle"><div><strong>{label}</strong>{help && <p className="sg-help">{help}</p>}</div><label><input aria-label={label} type="checkbox" checked={value} onChange={e=>onChange(e.target.checked)}/><span>{value?'已开启':'已关闭'}</span></label></div>;
}
export function Numeric({label,value,min,max,onChange}: {label:string;value:number;min:number;max:number;onChange:(n:number)=>void}) {
  return <Field label={label} help={label.includes('Token')?'单位是模型 Token，不等于中文字数；这里限制输出预算，部分模型的思考也占用该预算。':undefined}><input type="number" min={min} max={max} value={value} onChange={e=>onChange(Number(e.target.value))}/></Field>;
}
