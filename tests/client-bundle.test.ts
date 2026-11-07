import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import React from 'react';
test('浏览器 bundle 遵循 DSH 工厂格式并注册拾光设置入口',()=>{
 let registration:any;const sandbox={window:{__ModuleLoader__:{load:(entry:any)=>{registration=entry;}}}};
 vm.runInNewContext(readFileSync(new URL('../dist/client.js',import.meta.url),'utf8'),sandbox);
 assert.equal(registration.id,'dsh-shiguang');const client=registration.factory((id:string)=>{assert.equal(id,'react');return React;});
 let name='',entry:any;client.apply({get:()=>({rpc:{call:async()=>({ok:true,value:{}})}}),slots:{inject:(key:string,register:()=>void)=>{name=key;register();},register:(options:any,component:any)=>{entry={options,component};return()=>{};}}});
 assert.equal(name,'settings.section');assert.equal(entry.options.id,'shiguang');assert.equal(entry.options.label,'拾光');assert.equal(typeof entry.component,'function');
});
