import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalendarView} from '../dist/calendar.js';
import {initialState} from '../dist/core.js';
import {validateCalendarEvent} from '../dist/calendar-engine.js';
import {calendarLocalFingerprint} from '../dist/calendar-sync.js';

const tick=async()=>{for(let i=0;i<15;i++)await new Promise(resolve=>setImmediate(resolve));};
const until=async(predicate)=>{const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)throw new Error('Calendar operation did not reach its confirmed result');await new Promise(resolve=>setImmediate(resolve));}};
const event=(id,kind='outlook',patch={})=>validateCalendarEvent({id,title:'Updated source',projectId:'',start:'2026-10-16T08:00:00.000Z',end:'2026-10-16T09:00:00.000Z',readonly:kind!=='local',source:{kind,title:'Synthetic calendar',externalId:id},...patch});
function fixture(t,{target=false,save=true}={}){
  const oldDocument=globalThis.document,oldWindow=globalThis.window,handlers=new Map(),calls=[];let saveCalls=0;
  const workspace=initialState();workspace.calendarEvents=[event('remote-outlook','outlook',{title:'Old source',projectId:'prototyping'}),event('local-a','local')];
  if(target)workspace.calendarSync.target={calendarId:'own',title:'Own calendar'};
  globalThis.document={visibilityState:'visible',addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener(){},getElementById:()=>null};
  globalThis.window={contextDesktop:{calendar:async message=>{
    calls.push(message);let value;
    if(message.action==='cancel')return {ok:true,value:{cancelled:true}};
    if(message.action==='status'){
      value={outlook:{configured:true,connected:true,syncEnabled:true,readOnly:false},google:{configured:true,connected:true}};
      if(message.provider)value=value[message.provider];
    }
    else if(message.action==='calendars')value={calendars:[{id:'own',title:'Own calendar',primary:true,writable:true,canEdit:true}],complete:true};
    else if(message.action==='events')value={events:[event('remote-'+message.provider,message.provider)],complete:true};
    else if(message.action==='sync')value={results:await Promise.all(message.body.events.map(async e=>({id:e.id,status:'created',remoteId:'published-'+e.id,syncedAt:'2026-10-13T19:00:00.000Z',url:'',lastFingerprint:await calendarLocalFingerprint(e),retrySafe:true}))),complete:true,cancelled:false};
    else throw Error('Unexpected action '+message.action);
    return {ok:true,value};
  }}};
  const view=createCalendarView({getContext:()=>({workspace,updates:[]}),onChange(){},onSave:events=>{saveCalls++;if(!save)return false;workspace.calendarEvents=events;return true;},onSyncSave:settings=>{workspace.calendarSync=settings;return true;},onShow(){},onTask(){}});
  t.after(()=>{view.dispose();globalThis.document=oldDocument;globalThis.window=oldWindow;});
  const click=()=>handlers.get('click')({target:{closest:()=>({dataset:{calendar:'sync-now'}})},preventDefault(){}});
  return {view,workspace,calls,click,get saveCalls(){return saveCalls;}};
}
test('one-click refresh immediately saves provider changes, keeps course assignment, and never writes without a selected target',async t=>{
  const f=fixture(t);f.click();f.click();await tick();
  assert.deepEqual(f.calls.map(call=>call.action),['status','calendars','events','calendars','events','status']);
  assert.equal(f.workspace.calendarEvents.length,3);
  assert.equal(f.workspace.calendarEvents.find(e=>e.id==='remote-outlook').projectId,'prototyping');
  assert.equal(f.workspace.calendarEvents.find(e=>e.id==='remote-outlook').title,'Updated source');
  assert.match(f.view.render(),/1 neu · 1 aktualisiert/);assert.match(f.view.render(),/Zuletzt aktualisiert/);
});
test('a selected writable Outlook target publishes only local Context events after a successful read',async t=>{
  const f=fixture(t,{target:true});f.click();await until(()=>f.workspace.calendarSync.records.some(record=>record.id==='local-a'&&record.status==='created'));
  const writes=f.calls.filter(call=>call.action==='sync');assert.equal(writes.length,1);
  assert.equal(writes[0].provider,'outlook');assert.equal(writes[0].body.calendarId,'own');
  assert.deepEqual(writes[0].body.events.map(e=>e.id),['local-a']);
  assert.equal(f.workspace.calendarSync.records[0].status,'created');
});
test('a failed local save leaves the previous calendar intact and prevents the outgoing Outlook step',async t=>{
  const f=fixture(t,{target:true,save:false}),before=JSON.stringify(f.workspace.calendarEvents);
  f.click();await tick();assert.equal(JSON.stringify(f.workspace.calendarEvents),before);
  assert.equal(f.calls.some(call=>call.action==='sync'),false);assert.match(f.view.render(),/nicht lokal gespeichert/);
});

test('startup reads connected calendars without visiting calendar and repeats neither inserts nor saves',async t=>{
  const f=fixture(t,{target:true});
  // The fixture's first update changes an existing source and adds Google.
  await Promise.all([f.view.start(),f.view.start()]);await tick();
  assert.equal(f.workspace.calendarEvents.length,3);
  assert.equal(f.calls.filter(c=>c.action==='events').length,2);
  assert.equal(f.calls.some(c=>c.action==='sync'),false,'saved target alone must never authorize automatic writes');
  const ids=f.workspace.calendarEvents.map(e=>e.id).sort();
  f.click();await tick();
  assert.deepEqual(f.workspace.calendarEvents.map(e=>e.id).sort(),ids);
  assert.match(f.view.render(),/Alle Termine aktuell/);assert.equal(f.saveCalls,1,'unchanged pulls do not save or log another import');
  const read=f.calls.find(c=>c.action==='events');
  const from=new Date(read.body.from),to=new Date(read.body.to);
  assert.ok(to-from>120*86400000,'startup covers several months rather than only the displayed month');
});

test('dispose removes UI handlers and blocks a late provider reply from changing workspace',async t=>{
  const f=fixture(t);let resolve;
  const native=window.contextDesktop.calendar;
  window.contextDesktop.calendar=async message=>{
    if(message.action==='events')await new Promise(r=>{resolve=r;});
    return native(message);
  };
  const before=JSON.stringify(f.workspace.calendarEvents),pending=f.view.start();await tick();
  assert.equal(typeof resolve,'function');f.view.dispose();resolve();await pending;
  assert.equal(JSON.stringify(f.workspace.calendarEvents),before);
});

test('account generation change between the first and last status rejects the entire provider batch',async t=>{
  const f=fixture(t),native=window.contextDesktop.calendar;let statuses=0;
  window.contextDesktop.calendar=async message=>{
    const r=await native(message);
    if(message.action==='status'){statuses++;for(const provider of ['outlook','google'])r.value[provider].generation=String(statuses);}
    return r;
  };
  const before=JSON.stringify(f.workspace.calendarEvents);await f.view.start();
  assert.equal(JSON.stringify(f.workspace.calendarEvents),before);
  assert.match(f.view.render(),/Sync angehalten/);
});

test('workspace replacement invalidates an in-flight pull without inserting its old results',async t=>{
  const f=fixture(t),native=window.contextDesktop.calendar;let resolve;
  window.contextDesktop.calendar=async message=>{if(message.action==='events')await new Promise(r=>{resolve=r;});return native(message);};
  const pending=f.view.start();await tick();f.view.invalidateRefresh();
  f.workspace.calendarEvents=[event('replacement','local')];resolve();await pending;
  assert.deepEqual(f.workspace.calendarEvents.map(e=>e.id),['replacement']);
});

test('one Sync action and one secondary menu are rendered in month, agenda and day',t=>{
  const f=fixture(t);
  const initial=f.view.render();assert.equal((initial.match(/data-calendar="sync-now"/g)||[]).length,1);
  assert.match(initial,/<span>Sync<\/span>/);assert.equal((initial.match(/class="calendar-more-actions"/g)||[]).length,1);
  assert.doesNotMatch(initial,/Jetzt synchronisieren|Eingelesene Termine werden erst nach Importprüfung/);
});


test('partial provider reads are clearly labelled and never claim every event is current',async t=>{
  const f=fixture(t),native=window.contextDesktop.calendar;
  window.contextDesktop.calendar=async message=>{const result=await native(message);if(message.action==='events'){result.value.complete=false;result.value.warnings=['Ein Termin ohne gültige Dauer wurde ausgelassen.'];}return result;};
  await f.view.start();f.click();await tick();
  assert.match(f.view.render(),/Abgleich unvollständig/);assert.match(f.view.render(),/ohne gültige Dauer/);
  assert.doesNotMatch(f.view.render(),/Alle Termine aktuell/);assert.equal(f.workspace.calendarEvents.length,3);
});
