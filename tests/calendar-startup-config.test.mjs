import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalendarView} from '../dist/calendar.js';
import {initialState} from '../dist/core.js';

const clientId='12345678-1234-1234-1234-123456789abc';
const draftId='87654321-4321-4321-4321-cba987654321';
const tick=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(t,{outlookConnected=true,googleConnected=false}={}){
  const previousDocument=globalThis.document,previousWindow=globalThis.window,handlers=new Map(),calls=[],workspace=initialState();
  let write=false;
  workspace.calendarEvents=[];
  const status=()=>({outlook:{configured:true,connected:outlookConnected,backend:'direct',generation:'synthetic-outlook-binding',clientId,tenant:'common',syncEnabled:write,readOnly:!write},google:{configured:googleConnected,connected:googleConnected,backend:'direct',generation:'synthetic-google-binding'}});
  globalThis.document={visibilityState:'visible',addEventListener:(key,handler)=>handlers.set(key,handler),removeEventListener:(key,handler)=>{if(handlers.get(key)===handler)handlers.delete(key);},getElementById:()=>null};
  globalThis.window={contextDesktop:{calendar:async message=>{
    calls.push(message);
    if(message.action==='configure'){write=message.body.syncEnabled===true;return {ok:true,value:{configured:true}};}
    if(message.action==='connect')return {ok:true,value:{connected:true}};
    if(message.action==='status')return {ok:true,value:message.provider?status()[message.provider]:status()};
    if(message.action==='calendars')return {ok:true,value:{calendars:[{id:'own',title:'Synthetic own calendar',primary:true,writable:write,canEdit:true}],complete:true}};
    if(message.action==='events')return {ok:true,value:{events:[],complete:true}};
    if(message.action==='cancel')return {ok:true,value:{cancelled:true}};
    throw new Error('Unexpected synthetic operation');
  }}};
  const view=createCalendarView({getContext:()=>({workspace,updates:[]}),onChange(){},onSave:()=>true,onSyncSave:()=>true,onShow(){},onTask(){}});
  t.after(()=>{view.dispose();globalThis.document=previousDocument;globalThis.window=previousWindow;});
  return {view,calls,
    click:calendar=>handlers.get('click')({target:{closest:()=>({dataset:{calendar}})},preventDefault(){}}),
    edit:(name,value,type='text')=>handlers.get('input')({target:{name,value,type,checked:value,closest:()=>({id:'provider-form',dataset:{provider:'outlook'},classList:{contains:selector=>selector==='calendar-provider-form'}})}}),
  };
}

test('startup remembers the existing direct read-only Outlook registration for an explicit write-permission flow',async t=>{
  const f=fixture(t);await f.view.start();
  f.click('connections');await tick();f.click('enable-sync');await tick();
  const configured=f.calls.find(call=>call.action==='configure');
  assert(configured,'the explicit action must use the registration found during startup');
  assert.equal(configured.provider,'outlook');assert.equal(configured.body.clientId,clientId);
  assert.equal(configured.body.tenant,'common');assert.equal(configured.body.syncEnabled,true);
  assert.deepEqual(f.calls.slice(f.calls.indexOf(configured)).map(call=>call.action),['configure','connect','status','calendars']);
  assert.match(f.view.render(),/Outlook ist mit Schreibrechten verbunden/);
  assert.doesNotMatch(f.view.render(),/Trage zuerst die Client-ID/);
});

test('a read-only startup refresh preserves an unfinished provider configuration draft',async t=>{
  const f=fixture(t,{outlookConnected:false,googleConnected:true});
  await f.view.load();f.click('connections');await tick();
  f.edit('clientId',draftId);f.edit('tenant','organizations');f.edit('syncEnabled',true,'checkbox');
  await f.view.start();await tick();
  const html=f.view.render();
  assert.match(html,new RegExp('value="'+draftId+'"'));
  assert.match(html,/name="tenant"[^>]*value="organizations"/);
  assert.match(html,/name="syncEnabled" checked/);
  assert.equal(f.calls.filter(call=>call.action==='events').length,1,'the connected Google calendar still refreshes');
  assert.equal(f.calls.some(call=>['configure','connect','sync'].includes(call.action)),false,'reading cannot submit an unfinished draft or obtain permissions');
});
