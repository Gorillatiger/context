import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalendarView} from '../dist/calendar.js';
import {initialState} from '../dist/core.js';

const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function deferred(){let resolve,reject;return {promise:new Promise((done,fail)=>{resolve=done;reject=fail;}),resolve:value=>resolve(value),reject:error=>reject(error)};}
function fixture(t,{hook}={}){
 const oldDocument=globalThis.document,oldWindow=globalThis.window,handlers=new Map(),calls=[];let writable=false;
 const calendars=title=>({calendars:[{id:'own',title,writable:true,canEdit:true}]});
 const status=()=>({outlook:{configured:true,connected:true,clientId:'synthetic-client',tenant:'common',syncEnabled:writable,readOnly:!writable},google:{configured:false,connected:false}});
 globalThis.document={visibilityState:'visible',addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener(){},getElementById:()=>null};
 globalThis.window={contextDesktop:{calendar:async message=>{
  calls.push(message);const next=hook?await hook(message,{calendars,status}):undefined;
  if(next!==undefined)return {ok:true,value:next};
  if(message.action==='status')return {ok:true,value:status()};
  if(message.action==='configure')writable=message.body.syncEnabled;
  if(message.action==='calendars')return {ok:true,value:calendars('Eigener Zielkalender')};
  return {ok:true,value:{connected:true}};
 }}};
 const view=createCalendarView({getContext:()=>({workspace:initialState(),updates:[]}),onChange(){},onSave:()=>true,onShow(){},onTask(){}});
 t.after(()=>{view.dispose();globalThis.document=oldDocument;globalThis.window=oldWindow;});
 const click=action=>handlers.get('click')({target:{closest:()=>({dataset:{calendar:action}})},preventDefault(){}});
 return {view,calls,click,async ready(){await view.load(true);click('connections');await tick();calls.length=0;}};
}

test('enabling Outlook write access completes configure, connect, status and calendars into target selection',async t=>{
 const f=fixture(t);await f.ready();f.click('enable-sync');await tick();
 assert.deepEqual(f.calls.map(message=>message.action),['configure','connect','status','calendars']);
 const html=f.view.render();assert.doesNotMatch(html,/version is not defined/);assert.match(html,/Outlook ist mit Schreibrechten verbunden/);assert.match(html,/Eigener Zielkalender/);assert.match(html,/id="calendar-sync-target"/);
});

test('a forced connection refresh fences an older permission flow before it fetches calendars',async t=>{
 const gate=deferred();let hold=false,entered=false;
 const f=fixture(t,{hook:async(message,{calendars,status})=>{
  if(hold&&message.action==='status'&&!entered){entered=true;return gate.promise;}
  if(hold&&message.action==='calendars')return calendars('Neuer Zielkalender');
 }});
 await f.ready();hold=true;f.click('enable-sync');await tick();assert.equal(entered,true);
 await f.view.load(true);gate.resolve({outlook:{configured:true,connected:true,clientId:'obsolete-client',tenant:'common',syncEnabled:true,readOnly:false},google:{configured:false,connected:false}});await tick();
 assert.equal(f.calls.filter(message=>message.action==='calendars').length,1,'the obsolete permission flow must not issue another calendar request');
 const html=f.view.render();assert.match(html,/Neuer Zielkalender/);assert.doesNotMatch(html,/obsolete-client|version is not defined|Outlook ist mit Schreibrechten verbunden/);assert.match(html,/Deine Kalenderkonten/);
});

test('a late calendar response cannot replace the newer list or change its connection panel',async t=>{
 const gate=deferred();let hold=false,entered=false;
 const f=fixture(t,{hook:async(message,{calendars})=>{
  if(hold&&message.action==='calendars'&&!entered){entered=true;return gate.promise;}
  if(hold&&message.action==='calendars')return calendars('Aktueller Zielkalender');
 }});
 await f.ready();hold=true;f.click('enable-sync');await tick();assert.equal(entered,true);
 await f.view.load(true);gate.resolve({calendars:[{id:'obsolete',title:'Veralteter Zielkalender',writable:true,canEdit:true}]});await tick();
 const html=f.view.render();assert.match(html,/Aktueller Zielkalender/);assert.doesNotMatch(html,/Veralteter Zielkalender|version is not defined|Outlook ist mit Schreibrechten verbunden/);assert.match(html,/Deine Kalenderkonten/);
});

test('cancel ignores an in-flight calendar reply and retains an explicit cancellation result',async t=>{
 const gate=deferred();let hold=false,entered=false;
 const f=fixture(t,{hook:async(message)=>{if(hold&&message.action==='calendars'){entered=true;return gate.promise;}}});
 await f.ready();hold=true;f.click('enable-sync');await tick();assert.equal(entered,true);
 const request=f.calls.find(message=>message.action==='calendars');f.click('cancel');gate.resolve({calendars:[{id:'cancelled',title:'Abgebrochener Zielkalender',writable:true,canEdit:true}]});await tick();
 assert(f.calls.some(message=>message.action==='cancel'&&message.id===request.id));
 const html=f.view.render();assert.match(html,/Einlesen abgebrochen/);assert.doesNotMatch(html,/Abgebrochener Zielkalender|version is not defined|Outlook ist mit Schreibrechten verbunden/);
});

for(const stage of ['configure','connect']){
 test(`a newer connection refresh stops the permission flow after its delayed ${stage} reply`,async t=>{
  const gate=deferred();let hold=false,entered=false;
  const f=fixture(t,{hook:async(message,{calendars})=>{
   if(hold&&message.action===stage&&!entered){entered=true;return gate.promise;}
   if(hold&&message.action==='calendars')return calendars('Frischer Zielkalender');
  }});
  await f.ready();hold=true;f.click('enable-sync');await tick();assert.equal(entered,true);
  await f.view.load(true);gate.resolve({connected:true});await tick();
  assert.deepEqual(f.calls.map(message=>message.action),stage==='configure'?['configure','status','calendars']:['configure','connect','status','calendars']);
  const html=f.view.render();assert.match(html,/Frischer Zielkalender/);assert.match(html,/Deine Kalenderkonten/);assert.doesNotMatch(html,/version is not defined|Outlook ist mit Schreibrechten verbunden/);
 });
}

test('a rejected obsolete permission request cannot show an error over the refreshed connection',async t=>{
 const gate=deferred();let hold=false,entered=false;
 const f=fixture(t,{hook:async(message,{calendars})=>{
  if(hold&&message.action==='calendars'&&!entered){entered=true;return gate.promise;}
  if(hold&&message.action==='calendars')return calendars('Verbindlicher Zielkalender');
 }});
 await f.ready();hold=true;f.click('enable-sync');await tick();assert.equal(entered,true);
 await f.view.load(true);gate.reject(new Error('Veraltete Provider-Fehlermeldung'));await tick();
 const html=f.view.render();assert.match(html,/Verbindlicher Zielkalender/);assert.match(html,/Deine Kalenderkonten/);assert.doesNotMatch(html,/Veraltete Provider-Fehlermeldung|Outlook ist mit Schreibrechten verbunden/);
});

test('cancel during OAuth connection stops before status and target-calendar requests',async t=>{
 const gate=deferred();let hold=false,entered=false;
 const f=fixture(t,{hook:async message=>{if(hold&&message.action==='connect'){entered=true;return gate.promise;}}});
 await f.ready();hold=true;f.click('enable-sync');await tick();assert.equal(entered,true);
 const request=f.calls.find(message=>message.action==='connect');f.click('cancel');gate.resolve({connected:true});await tick();
 assert(f.calls.some(message=>message.action==='cancel'&&message.id===request.id));
 assert.equal(f.calls.filter(message=>['status','calendars'].includes(message.action)).length,0);
 const html=f.view.render();assert.match(html,/Einlesen abgebrochen/);assert.doesNotMatch(html,/version is not defined|Outlook ist mit Schreibrechten verbunden/);
});
