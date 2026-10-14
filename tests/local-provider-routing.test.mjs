import test from 'node:test';
import assert from 'node:assert/strict';
import {aiRequest,PROVIDERS} from '../dist/ai-client.js';
import {createDesktopAI} from '../desktop/ai.mjs';
import {createKIView} from '../dist/ki.js';

const id='11111111-1111-4111-8111-111111111111';
const client=(label,calls)=>({
  status:async()=>{calls.push(label+':status');return {provider:label};},
  models:async()=>{calls.push(label+':models');return {models:[{id:label+'-model'}]};},
  configure:async body=>{calls.push({label,action:'connection',body});return {models:[{id:label+'-model'}]};},
  complete:async(body,signal)=>{calls.push({label,action:'chat',body,signal});return {content:label+' result'};}
});
function replaceGlobal(t,name,value){const descriptor=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});t.after(()=>{if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];});}

test('all explicit local desktop capabilities select only the local client, including configuration',async()=>{
  const calls=[],handler=createDesktopAI(client('cloud',calls),client('local',calls));
  assert.equal((await handler({provider:'local',action:'status'})).provider,'local');
  assert.equal((await handler({provider:'local',action:'models'})).models[0].id,'local-model');
  const config={port:11434,key:'fixture-only-key'};
  await handler({provider:'local',action:'connection',body:config});
  assert.equal((await handler({provider:'local',action:'chat',id,body:{model:'local-model',messages:[]}})).content,'local result');
  assert.equal(calls.length,4);assert.ok(calls.every(c=>typeof c==='string'?c.startsWith('local:'):c.label==='local'));
  assert.deepEqual(calls[2].body,config);
});

test('a failed local client is surfaced without invoking the cloud client or frontend fetch',async t=>{
  const calls=[],failure=new Error('Local fixture offline');
  const handler=createDesktopAI(client('cloud',calls),{models:async()=>{calls.push('local:models');throw failure;}});
  let fetches=0;
  replaceGlobal(t,'fetch',async()=>{fetches++;throw new Error('must not fetch');});
  replaceGlobal(t,'window',{contextDesktop:{ai:async message=>{try{return {ok:true,value:await handler(message)};}catch(error){return {ok:false,error:error.message};}}}});
  await assert.rejects(aiRequest('local','models'),/Local fixture offline/);
  assert.deepEqual(calls,['local:models']);assert.equal(fetches,0);
});

test('without desktop local selection fails closed for every action instead of using HTTP/cloud routing',async t=>{
  let fetches=0;
  replaceGlobal(t,'window',{});replaceGlobal(t,'fetch',async()=>{fetches++;throw new Error('must not fetch');});
  for(const action of ['status','models','connection','chat','usage'])await assert.rejects(aiRequest('local',action,{body:action==='chat'?{model:'fixture',messages:[]}:undefined}),/kein Cloud-Anbieter/);
  assert.equal(fetches,0);
});

test('provider-scoped cancellation does not abort an OpenRouter request sharing the same UUID',async()=>{
  const signals={},resolvers={};
  const waiting=label=>({complete:(_body,signal)=>{signals[label]=signal;return new Promise(resolve=>{resolvers[label]=resolve;});}});
  const handler=createDesktopAI(waiting('cloud'),waiting('local'));
  const cloud=handler({provider:'openrouter',action:'chat',id,body:{}}),local=handler({provider:'local',action:'chat',id,body:{}});
  await handler({provider:'local',action:'cancel',id});
  assert.equal(signals.local.aborted,true);assert.equal(signals.cloud.aborted,false);
  resolvers.local({content:'ignored fixture'});resolvers.cloud({content:'cloud fixture'});
  await Promise.all([local,cloud]);
  await handler({provider:'local',action:'cancel',id});
});

test('a frontend abort sends cancellation to the same local provider and discards late local output',async t=>{
  const controller=new AbortController(),calls=[];let release,fetches=0;
  replaceGlobal(t,'fetch',async()=>{fetches++;throw new Error('must not fetch');});
  replaceGlobal(t,'window',{contextDesktop:{ai:message=>{
    calls.push(message);
    if(message.action==='cancel')return Promise.resolve({ok:true});
    return new Promise(resolve=>{release=resolve;});
  }}});
  const request=aiRequest('local','chat',{body:{model:'local-model',messages:[]},signal:controller.signal});
  controller.abort();release({ok:true,value:{content:'late answer'}});
  await assert.rejects(request,{name:'AbortError'});
  assert.equal(calls.length,2);assert.equal(calls[0].provider,'local');assert.equal(calls[1].provider,'local');
  assert.equal(calls[1].action,'cancel');assert.equal(calls[1].id,calls[0].id);assert.equal(fetches,0);
});

test('invalid providers and pre-aborted requests cannot dispatch either a desktop or a cloud capability',async t=>{
  let requests=0;
  replaceGlobal(t,'window',{contextDesktop:{ai:async()=>{requests++;}}});replaceGlobal(t,'fetch',async()=>{requests++;});
  for(const provider of ['unknown','__proto__','constructor'])await assert.rejects(aiRequest(provider,'models'),/Ungültige/);
  const signal=AbortSignal.abort();await assert.rejects(aiRequest('local','models',{signal}),{name:'AbortError'});
  const handler=createDesktopAI(client('cloud',[]),client('local',[]));
  await assert.rejects(handler({provider:'kiconnect',action:'models'}));
  await assert.rejects(handler({provider:'local',action:'models',url:'https://outside.invalid'}));
  assert.equal(requests,0);assert.ok(Object.hasOwn(PROVIDERS,'local'));
});

test('saved local provider selection loads local models even when the chat archive is unavailable',async t=>{
  const events=new Map(),calls=[],saved=new Map([['context-ai-provider','local']]);
  const doc={addEventListener:(type,handler)=>{const list=events.get(type)||[];list.push(handler);events.set(type,list);},querySelector:()=>null,querySelectorAll:()=>[]};
  replaceGlobal(t,'document',doc);
  replaceGlobal(t,'window',{addEventListener:()=>{},dispatchEvent:()=>true,contextDesktop:{ai:async message=>{calls.push(message);return {ok:true,value:{models:[{id:'local-fixture'}]}};}}});
  replaceGlobal(t,'localStorage',{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)});
  replaceGlobal(t,'indexedDB',undefined);
  replaceGlobal(t,'fetch',async()=>{throw new Error('cloud routing is forbidden');});
  const view=createKIView({onChange:()=>{},getContext:()=>({workspace:{activeCourse:'',projects:[],notes:[],tasks:[]},updates:[]})});
  await view.load();await Promise.resolve();
  assert.deepEqual(view.configuration(),{provider:'local',model:'local-fixture',ready:true});
  assert.deepEqual(calls.map(call=>[call.provider,call.action]),[['local','models'],['local','usage']]);assert.match(calls[1].id,/^[a-f0-9-]{36}$/i);
});

test('changing the provider selector from OpenRouter to local persists local choice and invokes only local discovery',async t=>{
  const events=new Map(),calls=[],announced=[],saved=new Map([['context-ai-provider','openrouter']]);
  replaceGlobal(t,'document',{addEventListener:(type,handler)=>{const list=events.get(type)||[];list.push(handler);events.set(type,list);},querySelector:()=>null,querySelectorAll:()=>[]});
  replaceGlobal(t,'window',{addEventListener:()=>{},dispatchEvent:event=>{announced.push(event.type);return true;},contextDesktop:{ai:async message=>{calls.push(message);return {ok:true,value:{models:[{id:'selected-local-model'}]}};}}});
  replaceGlobal(t,'localStorage',{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)});
  replaceGlobal(t,'indexedDB',undefined);
  replaceGlobal(t,'fetch',async()=>{throw new Error('no cloud fallback is permitted');});
  const view=createKIView({onChange:()=>{},getContext:()=>({workspace:{activeCourse:'alpha',projects:[{id:'alpha',name:'Kurs alpha'}],notes:[],tasks:[]},updates:[]})});
  assert.equal(view.configuration().provider,'openrouter');
  await Promise.all(events.get('change').map(handler=>handler({target:{id:'ki-provider',value:'local',dataset:{}}})));
  for(let i=0;i<20&&view.isBusy();i++)await Promise.resolve();
  assert.equal(view.isBusy(),false);
  assert.deepEqual(view.configuration(),{provider:'local',model:'selected-local-model',ready:true});
  assert.equal(saved.get('context-ai-provider'),'local');assert.deepEqual(announced,['context-ai-changed']);
  assert.deepEqual(calls.map(call=>[call.provider,call.action]),[['local','models'],['local','usage']]);assert.match(calls[1].id,/^[a-f0-9-]{36}$/i);
});
