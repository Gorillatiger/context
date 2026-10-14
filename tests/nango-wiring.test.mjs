import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCalendarRouting} from '../desktop/calendar-routing.mjs';
import {createDesktopCalendar} from '../desktop/calendar.mjs';
import {createDesktopNangoMail} from '../desktop/nango-mail.mjs';
import {createMailAccounts} from '../dist/mail-accounts.js';

function fixture(){
  const integrations=new Set(),bindings=new Map(),revisions=new Map(),calls=[],status=service=>({service,revision:revisions.get(service)||'1:0',integrationId:integrations.has(service)||bindings.has(service)?'configured-'+service:'',connectionId:bindings.get(service)||'',connected:bindings.has(service),capabilities:{calendarRead:true,driveRead:true,mailRead:true}});
  const nango={localStatus:status,hasBinding:service=>bindings.has(service),status:async service=>status(service),disconnect:async service=>{integrations.add(service);bindings.delete(service);return status(service);},
    async proxy(service,options,signal){calls.push({service,...options,signal});if(signal?.aborted)throw Object.assign(new Error('aborted'),{code:'cancelled'});
      let data;
      if(options.path==='/v1.0/me/calendars')data={value:[{id:'calendar-one',name:'Kurse',isDefaultCalendar:true,canEdit:true,canShare:true}]};
      else if(options.path==='/gmail/v1/users/me/profile')data={emailAddress:'student@example.org'};
      else if(options.path==='/gmail/v1/users/me/labels')data={labels:[{id:'INBOX',name:'Posteingang',type:'system'}]};
      else throw new Error('unexpected fixture path '+options.path);
      return {status:200,headers:{"content-type":"application/json"},data};
    }};
  const direct={status:p=>({connected:true,backend:'direct',provider:p}),configure:(p,b)=>({configured:true}),disconnect:p=>({disconnected:p}),calendars:async p=>({calendars:[{id:'direct',title:p}]}),events:async()=>({events:[]}),driveFiles:async()=>({files:[],backend:'direct'}),driveText:async()=>({text:'direct'}),connect:async()=>({connected:true}),sync:async()=>({results:[]})};
  return {nango,integrations,bindings,revisions,calls,direct};
}
test('existing OAuth calendars remain selected until an explicit Nango binding exists',async()=>{
  const f=fixture(),router=createCalendarRouting(f);assert.equal((await router.status('outlook')).backend,'direct');
  f.bindings.set('outlook','connection-one');assert.equal((await router.status('outlook')).backend,'nango');
  const bridge=createDesktopCalendar({providers:router});const result=await bridge({action:'calendars',provider:'outlook',id:randomUUID()});assert.equal(result.calendars[0].id,'calendar-one');assert.equal(f.calls[0].service,'outlook');
  router.configure('outlook',{clientId:'explicit'});assert.equal((await router.status('outlook')).backend,'direct');
  f.bindings.set('outlook','connection-two');assert.equal((await router.status('outlook')).backend,'nango');
});
test('disconnecting a Nango calendar forgets only its own binding',async()=>{
  const f=fixture();f.bindings.set('outlook','connection-one');f.bindings.set('gmail','mail-one');const router=createCalendarRouting(f);await router.disconnect('outlook');assert.equal(f.bindings.has('outlook'),false);assert.equal(f.bindings.get('gmail'),'mail-one');
  const status=await router.status('outlook');assert.equal(status.backend,'nango');assert.equal(status.connected,false);
  await assert.rejects(router.calendars('outlook'),e=>e.code==='reconnect_required');
  await assert.rejects(router.sync('outlook',{}),e=>e.code==='sync_not_enabled');
});
test('configured but unbound Nango calendars never revive dormant direct credentials',async()=>{
  const f=fixture();f.integrations.add('outlook');const router=createCalendarRouting(f);const before=await router.status('outlook');assert.equal(before.backend,'nango');assert.equal(before.connected,false);
  await assert.rejects(router.calendars('outlook'),e=>e.code==='reconnect_required');assert.equal(f.calls.length,0);
  router.configure('outlook',{clientId:'explicit-direct'});assert.equal((await router.status('outlook')).backend,'direct');assert.equal((await router.calendars('outlook')).calendars[0].id,'direct');
  f.bindings.set('outlook','new-explicit-nango-binding');assert.equal((await router.status('outlook')).backend,'nango');
});
test('Drive route does not depend on a Google Calendar binding',async()=>{
  const f=fixture(),router=createCalendarRouting(f);assert.equal((await router.driveText('google',{})).text,'direct');
  f.bindings.set('google-drive','drive-one');await assert.rejects(router.driveText('google',{fileId:'not-listed'}),e=>e.code==='unknown_file');assert.equal((await router.status('google')).backend,'direct');
});
test('disconnected Nango Drive cannot fall back to a dormant direct Drive account',async()=>{
  const f=fixture();f.integrations.add('google-drive');const router=createCalendarRouting(f);
  await assert.rejects(router.driveFiles('google'),e=>e.code==='drive_not_enabled');await assert.rejects(router.driveText('google',{fileId:'not-listed'}),e=>e.code==='drive_not_enabled');
  router.configure('google',{clientId:'explicit-direct',driveEnabled:true});assert.equal((await router.driveText('google',{})).text,'direct');
  f.bindings.set('google-drive','explicit-new-drive-binding');await assert.rejects(router.driveText('google',{fileId:'not-listed'}),e=>e.code==='unknown_file');
  await f.nango.disconnect('google-drive');await assert.rejects(router.driveFiles('google'),e=>e.code==='drive_not_enabled');
});
test('typed native Gmail bridge returns normalized mailbox data and rejects raw proxy actions',async()=>{
  const f=fixture();f.bindings.set('gmail','mail-one');const bridge=createDesktopNangoMail(f);
  const status=await bridge({action:'status',service:'gmail',id:randomUUID()});assert.equal(status.address,'student@example.org');assert.equal(status.smtpReady,false);assert.match(status.accountKey,/^[a-f0-9]{64}$/);
  const folders=await bridge({action:'folders',service:'gmail',id:randomUUID()});assert.equal(folders.folders[0].kind,'inbox');
  for(const message of [{action:'proxy',service:'gmail',id:randomUUID(),body:{path:'https://evil.example'}},{action:'list',service:'gmail',id:randomUUID(),body:{folder:'INBOX',extra:true}},{action:'connection',service:'gmail',id:randomUUID(),body:{password:'forbidden'}},{action:'status',service:'google-drive',id:randomUUID()}])await assert.rejects(bridge(message));
  bridge.dispose();
});
test('native mail cancellation stops in-flight provider request and never exposes result',async()=>{
  const f=fixture();f.bindings.set('gmail','mail-one');let reached;const ready=new Promise(resolve=>{reached=resolve;});
  f.nango.proxy=async(_service,_request,signal)=>new Promise((resolve,reject)=>{reached();signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{code:'cancelled'})),{once:true});});
  const bridge=createDesktopNangoMail(f),id=randomUUID(),pending=bridge({action:'folders',service:'gmail',id});await ready;await bridge({action:'cancel',id});await assert.rejects(pending,e=>e.code==='cancelled');bridge.dispose();
});
test('account picker isolates controller drafts, listeners and native service selection',async()=>{
  const configs={},calls=[],changes=[];
  const accounts=createMailAccounts({onChange:()=>changes.push(true),onConnection:()=>{},bridge:()=>async message=>{calls.push(message);return {ok:true,value:{configured:false}};},createView:options=>{configs[options.service]=options;return {render:()=>options.service,load:async()=>{},open:async()=>{},refreshConnection:()=>calls.push({reset:options.service})};}});
  assert.equal(configs.th.isActive(),true);assert.equal(configs.gmail.isActive(),false);assert.equal(accounts.select('gmail'),true);assert.equal(configs.th.isActive(),false);assert.equal(configs.gmail.isActive(),true);
  await configs.gmail.request('status');assert.equal(calls[0].service,'gmail');assert.match(calls[0].id,/^[a-f0-9-]{36}$/);assert.equal(accounts.select('__proto__'),false);assert.match(accounts.render(),/aria-label="Mailkonto auswählen"/);accounts.refreshCloud();assert.deepEqual(calls.slice(-2),[{reset:'outlook'},{reset:'gmail'}]);
});

test('Drive-only binding is visible without selecting a Google calendar account',async()=>{const f=fixture();f.bindings.set('google-drive','drive-one');const router=createCalendarRouting(f);const value=await router.status('google');assert.equal(value.backend,'direct');assert.equal(value.driveBackend,'nango');assert.equal(value.driveEnabled,true);await f.nango.disconnect('google-drive');assert.equal((await router.status('google')).driveEnabled,false);});

test('same-ID Nango rebind replaces an explicit direct override through its revision',async()=>{const f=fixture();f.bindings.set('outlook','same-id');const router=createCalendarRouting(f);router.configure('outlook',{clientId:'direct'});assert.equal((await router.status('outlook')).backend,'direct');f.revisions.set('outlook','1:1');assert.equal((await router.status('outlook')).backend,'nango');});
