import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createNangoConnectionsView,nangoConnectionsSnapshot} from '../dist/nango-connections.js';
import {createDesktopNango} from '../desktop/nango.mjs';

const UUID='1cae9a94-71e1-4871-a978-d2d69a1b5b80';
const ids=['outlook','gmail','google-calendar','google-drive'];
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function initial(configured=true){return {configured,baseURL:'https://api.nango.dev',storage:configured?'encrypted':'none',services:ids.map(service=>({service,integrationId:configured?'integration-'+service:'',connectionId:'',connected:false}))};}
function fixture({snapshot=initial(),handler,bridge=true}={}){
  const calls=[],notices=[],opened=[],connectionChanges=[],listeners=new Map();let changes=0,value=structuredClone(snapshot);
  const native={nango:async message=>{
    const copy=structuredClone(message);calls.push(copy);if(handler)return handler(copy,()=>value,next=>{value=next;});
    if(copy.action==='configure'){value={...value,configured:true,baseURL:copy.body.baseURL,storage:'encrypted',services:ids.map(service=>({service,integrationId:copy.body.integrations[service],connectionId:'',connected:false,capabilities:copy.body.capabilities[service]}))};}
    if(copy.action==='connect'){value.services.find(row=>row.service===copy.service).connected=true;value.services.find(row=>row.service===copy.service).connectionId='owned-connection';}
    if(copy.action==='connection'){value.services.find(row=>row.service===copy.service).connected=true;value.services.find(row=>row.service===copy.service).connectionId=copy.body.connectionId;}
    if(copy.action==='disconnect'){const row=value.services.find(row=>row.service===copy.service);row.connected=false;row.connectionId='';}
    if(copy.action==='reset')value=initial(false);
    return {ok:true,value:structuredClone(value)};
  }};
  const document={addEventListener:(name,callback)=>listeners.set(name,callback),removeEventListener:(name,callback)=>{if(listeners.get(name)===callback)listeners.delete(name);},querySelector:()=>null};
  const view=createNangoConnectionsView({bridge:bridge?native:{},document,randomUUID:()=>UUID,onChange:()=>changes++,onNotice:notice=>notices.push(notice),onMail:service=>opened.push(['mail',service]),onCalendar:service=>opened.push(['calendar',service]),onConnectionChange:event=>connectionChanges.push(event)});
  return {view,calls,notices,opened,connectionChanges,listeners,changes:()=>changes,native};
}
const configuredFields=(overrides={})=>({baseURL:'https://api.nango.dev',secretKey:'private-nango-key',integrations:Object.fromEntries(ids.map(id=>[id,'integration-'+id])),...overrides});

test('configuration alone never marks a provider connected or opens its mail/calendar view',async()=>{
  const f=fixture();await f.view.load();const html=f.view.render();assert.equal((html.match(/Bereit zur Anmeldung/g)||[]).length,4);assert.doesNotMatch(html,/data-nango="mail"/);
  assert.equal(await f.view.click('mail','outlook'),false);assert.equal(await f.view.click('calendar','google-calendar'),false);assert.deepEqual(f.opened,[]);
});
test('failed status attempts stop automatic render retries and remain explicitly retryable',async()=>{
  let requests=0,view;
  view=createNangoConnectionsView({document:undefined,bridge:{nango:async()=>{requests++;return requests===1?{ok:false,error:'Synthetic IPC failure'}:{ok:true,value:initial()};}},onChange:()=>{const state=view.state();if(!state.loaded&&!state.busy)void view.load();}});
  assert.equal(await view.load(),false);await tick();assert.equal(requests,1);assert.equal(view.state().loaded,true);assert.match(view.state().error,/nicht geladen/);assert.equal(view.state().busy,'');
  assert.equal(await view.click('refresh'),true);assert.equal(requests,2);assert.equal(view.state().snapshot.configured,true);assert.equal(view.state().error,'');view.dispose();
});
test('native status sanitizes secrets, raw errors, unknown providers and inconsistent connection flags',()=>{
  const snapshot=nangoConnectionsSnapshot({configured:true,baseURL:'https://api.nango.dev',secretKey:'private-secret',storage:'encrypted',services:[{service:'outlook',label:'private-label',integrationId:'ms',connected:true,connectionId:'',error:'private-raw-error',capabilities:{mailSend:true,driveRead:true}},{service:'google-calendar',integrationId:'gc',connectionId:'own',connected:true,capabilities:{calendarWrite:true}},{service:'evil',connectionId:'private-token'}]});
  assert.equal(snapshot.services.length,5);assert.equal(snapshot.services[0].connected,false);assert.equal(snapshot.services[0].needsAttention,true);assert.equal(snapshot.services[0].capabilities.driveRead,false);assert.equal(snapshot.services[2].capabilities.calendarWrite,false);
  assert.doesNotMatch(JSON.stringify(snapshot),/private-|secretKey|raw-error|evil/);assert.equal(nangoConnectionsSnapshot({configured:true,baseURL:'https://user:private@evil.test'}).configured,false);
});
test('secret input is cleared before the native request and never retained in renderer state or HTML',async()=>{
  const f=fixture({snapshot:initial(false)}),input={value:'private-nango-key'},form={elements:{namedItem:()=>input}};
  const saved=f.view.configure(configuredFields(),form);assert.equal(input.value,'');assert.equal(await saved,true);
  assert.equal(f.calls.find(call=>call.action==='configure').body.secretKey,'private-nango-key');assert.doesNotMatch(JSON.stringify(f.view.state())+f.view.render(),/private-nango-key|"secretKey"/);assert.equal(f.view.state().snapshot.configured,true);assert.equal(f.view.state().snapshot.services.some(service=>service.connected),false);
  await f.view.click('settings');const html=f.view.render();assert.match(html,/name="secretKey" type="password"/);assert.doesNotMatch(html,/name="secretKey"[^>]*value=/);
});
test('blank secret preserves a saved key only on the unchanged server; changing server requires a new key',async()=>{
  const f=fixture();await f.view.load();await f.view.configure(configuredFields({secretKey:''}));assert.equal(Object.hasOwn(f.calls.find(call=>call.action==='configure').body,'secretKey'),false);
  const count=f.calls.length;assert.equal(await f.view.configure(configuredFields({secretKey:'',baseURL:'https://nango.example.test'})),false);assert.equal(f.calls.length,count);assert.match(f.view.state().error,/Schlüssel/);
  assert.equal(await f.view.configure(configuredFields({baseURL:'https://nango.example.test'})),true);assert.equal(f.calls.filter(call=>call.action==='configure').at(-1).body.baseURL,'https://nango.example.test');
});
test('first setup needs a key, one integration and a secure or loopback endpoint',async()=>{
  const f=fixture({snapshot:initial(false)});assert.equal(await f.view.configure(configuredFields({secretKey:''})),false);assert.equal(await f.view.configure(configuredFields({integrations:{}})),false);
  for(const baseURL of ['http://public.example.test','https://user:secret@example.test','https://example.test/?token=secret','https://example.test/nango','javascript:alert(1)'])assert.equal(await f.view.configure(configuredFields({baseURL})),false);
  assert.equal(f.calls.length,0);assert.equal(await f.view.configure(configuredFields({baseURL:'http://127.0.0.1:3003'})),true);
});
test('write and mail-management policy defaults off and is allowed only for supported services',async()=>{
  const f=fixture({snapshot:initial(false)});await f.view.configure(configuredFields());let body=f.calls.find(call=>call.action==='configure').body;
  const allowed={outlook:['mailRead','mailSend','mailModify','calendarRead','calendarWrite'],gmail:['mailRead','mailSend','mailModify'],'google-calendar':['calendarRead'],'google-drive':['driveRead']};
  for(const service of ids){assert.deepEqual(Object.keys(body.capabilities[service]).sort(),allowed[service].sort());for(const field of ['mailSend','mailModify','calendarWrite'].filter(key=>allowed[service].includes(key)))assert.equal(body.capabilities[service][field],false);}
  assert.equal(body.capabilities.outlook.mailRead,true);assert.equal(body.capabilities.outlook.calendarRead,true);assert.equal(body.capabilities['google-drive'].driveRead,true);
  f.view.change('mailSend-outlook',true);f.view.change('mailModify-gmail',true);f.view.change('calendarWrite-outlook',true);f.view.change('calendarWrite-google-calendar',true);f.view.change('mailSend-google-drive',true);
  await f.view.configure(configuredFields({secretKey:''}));body=f.calls.filter(call=>call.action==='configure').at(-1).body;
  assert.equal(body.capabilities.outlook.mailSend,true);assert.equal(body.capabilities.outlook.calendarWrite,true);assert.equal(body.capabilities.gmail.mailModify,true);assert.equal(Object.hasOwn(body.capabilities['google-calendar'],'calendarWrite'),false);assert.equal(Object.hasOwn(body.capabilities['google-drive'],'mailSend'),false);
  await f.view.click('settings');assert.match(f.view.render(),/OAuth-Rechte werden zusätzlich in Nango und beim Anbieter erteilt/);assert.doesNotMatch(f.view.render(),/name="calendarWrite-google-calendar"/);
});
test('host selection exposes Cloud versus own-server processing without claiming fully local OAuth',async()=>{
  const f=fixture();await f.view.load();await f.view.click('settings');assert.match(f.view.render(),/Zugriffstokens bei Nango gespeichert/);assert.match(f.view.render(),/Mail-, Kalender- und Drive-Anfragen laufen über Nango/);
  f.view.change('mode','self');assert.equal(f.view.state().draft.baseURL,'http://127.0.0.1:3003');f.view.change('baseURL','https://nango.example.test');f.view.change('mode','cloud');assert.equal(f.view.state().draft.baseURL,'https://api.nango.dev');f.view.change('mode','self');assert.equal(f.view.state().draft.baseURL,'https://nango.example.test');
});
test('connect uses a UUID, prevents repeated submits and confirms only authoritative status',async()=>{
  let release;const f=fixture({handler:async(message,get,set)=>{if(message.action==='connect')return new Promise(resolve=>{release=()=>{const next=structuredClone(get()),row=next.services.find(service=>service.service===message.service);row.connected=true;row.connectionId='owned';set(next);resolve({ok:true,value:{started:true}});};});return {ok:true,value:structuredClone(get())};}});
  await f.view.load();const connecting=f.view.click('connect','outlook');assert.equal(f.view.state().busy,'connect-outlook');assert.match(f.view.render(),/Warten abbrechen/);assert.equal(await f.view.click('connect','outlook'),false);assert.equal(f.calls.filter(call=>call.action==='connect').length,1);assert.equal(f.calls.at(-1).id,UUID);assert.equal(f.view.state().snapshot.services[0].connected,false);
  release();assert.equal(await connecting,true);assert.equal(f.view.state().snapshot.services[0].connected,true);assert.match(f.view.render(),/Mail öffnen/);assert.match(f.notices.at(-1),/bestätigt/);
});
test('a started login without confirmed native connection remains disconnected',async()=>{
  const f=fixture({handler:async(message,get)=>({ok:true,value:message.action==='connect'?{started:true}:{...get()}})});await f.view.load();await f.view.click('connect','gmail');assert.equal(f.view.state().snapshot.services[1].connected,false);assert.match(f.notices.at(-1),/prüfe anschließend den Status/);assert.doesNotMatch(f.view.render(),/data-nango="mail"/);
});
test('cancelling sends the active UUID and stops waiting without claiming OAuth revocation',async()=>{
  let stop;const f=fixture({handler:async(message,get)=>{if(message.action==='connect')return new Promise(resolve=>{stop=()=>resolve({ok:false,error:'private-native-cancel-detail'});});if(message.action==='cancel'){stop();return {ok:true,value:{cancelled:true}};}return {ok:true,value:get()};}});
  await f.view.load();const connecting=f.view.click('connect','outlook');assert.match(f.view.render(),/Bereits erteilte Freigaben bleiben bestehen/);assert.equal(await f.view.click('cancel-connect'),true);assert.equal(await connecting,false);assert.deepEqual(f.calls.find(call=>call.action==='cancel'),{action:'cancel',id:UUID});assert.equal(f.view.state().busy,'');assert.equal(f.view.state().snapshot.services[0].connected,false);assert.doesNotMatch(f.view.render(),/private-native-cancel-detail/);assert.match(f.view.state().notice,/nicht weiter geprüft/);
});
test('existing connection IDs are submitted for native ownership verification before becoming connected',async()=>{
  const f=fixture();await f.view.load();assert.match(f.view.render(),/Context prüft die Zuordnung/);assert.equal(await f.view.bindConnection('gmail','owned-nango-id'),true);assert.deepEqual(f.calls.find(call=>call.action==='connection'),{action:'connection',service:'gmail',body:{connectionId:'owned-nango-id'}});assert.equal(f.view.state().snapshot.services[1].connected,true);
});
test('unconfirmed connection IDs and raw native errors remain safe and retryable',async()=>{
  const f=fixture({handler:async(message,get)=>message.action==='connection'?{ok:false,error:'PRIVATE SECRET token=credential'}:{ok:true,value:get()}});await f.view.load();assert.equal(await f.view.bindConnection('gmail','other-user-id'),false);assert.equal(f.view.state().snapshot.services[1].connected,false);assert.match(f.view.state().error,/nicht bestätigt/);assert.doesNotMatch(f.view.render()+JSON.stringify(f.view.state())+f.notices.join(' '),/PRIVATE|credential|other-user-id/);
});
test('only confirmed, permitted accounts open the corresponding existing feature',async()=>{
  const f=fixture();await f.view.load();await f.view.click('connect','outlook');await f.view.click('mail','outlook');await f.view.click('calendar','outlook');await f.view.click('connect','google-drive');await f.view.click('calendar','google-drive');assert.deepEqual(f.opened,[['mail','outlook'],['calendar','outlook'],['calendar','google-drive']]);assert.equal(await f.view.click('mail','google-drive'),false);assert.equal(await f.view.click('connect','unknown'),false);
  await f.view.click('disconnect','outlook');assert.equal(await f.view.click('mail','outlook'),false);assert.equal(f.view.state().snapshot.services[0].connected,false);
});
test('reset is an explicit inline confirmation and clears setup only after native success',async()=>{
  const f=fixture();await f.view.load();assert.equal(await f.view.click('confirm-reset'),false);await f.view.click('reset');assert.match(f.view.render(),/Nango-Einrichtung entfernen\?/);assert.equal(f.calls.filter(call=>call.action==='reset').length,0);await f.view.click('cancel-reset');assert.equal(f.view.state().confirmReset,false);await f.view.click('reset');await f.view.click('confirm-reset');assert.equal(f.calls.filter(call=>call.action==='reset').length,1);assert.equal(f.view.state().snapshot.configured,false);assert.equal(f.view.state().editing,true);assert.equal(f.view.state().confirmReset,false);
});
test('unsupported browser mode offers Desktop guidance with disabled connect/configuration controls',async()=>{
  const f=fixture({bridge:false});assert.equal(await f.view.load(),false);assert.match(f.view.render(),/Context-Desktop-App/);assert.match(f.view.render(),/data-nango="connect"[^>]+disabled/);assert.equal(await f.view.configure(configuredFields()),false);assert.equal(f.calls.length,0);
});
test('malicious metadata is escaped while official service labels and bundled logos remain fixed',async()=>{
  const snapshot=initial();snapshot.services[0].integrationId='"><img src=x onerror=bad>';snapshot.services[0].label='<script>private token</script>';const f=fixture({snapshot});await f.view.load();await f.view.click('settings');const html=f.view.render();assert.doesNotMatch(html,/<img src=x|<script>|private token/);assert.match(html,/&quot;&gt;&lt;img/);assert.match(html,/\.\/brands\/outlook\.svg/);assert.match(html,/\.\/brands\/googlecalendar\.svg/);assert.match(html,/\.\/brands\/googledrive\.svg/);assert.match(html,/brand-gmail/);assert.doesNotMatch(html,/favicon|remote-logo/);
});
test('disposing removes listeners, cancels active waiting and rejects late UI updates',async()=>{
  let release;const f=fixture({handler:async(message,get)=>{if(message.action==='connect')return new Promise(resolve=>{release=()=>resolve({ok:true,value:get()});});return {ok:true,value:get()};}});await f.view.load();const connecting=f.view.click('connect','outlook'),changes=f.changes();f.view.dispose();assert.equal(f.listeners.size,0);release();await connecting;assert.equal(f.changes(),changes);assert.equal(f.calls.filter(call=>call.action==='cancel').length,1);assert.equal(await f.view.click('refresh'),false);
});
test('delegated clicks use only typed Nango actions and ignore disabled controls',async()=>{
  const f=fixture();await f.view.load();const button={dataset:{nango:'connect',nangoService:'gmail'},disabled:true};f.listeners.get('click')({target:{closest:()=>button}});await tick();assert.equal(f.calls.filter(call=>call.action==='connect').length,0);button.disabled=false;f.listeners.get('click')({target:{closest:()=>button}});await tick();assert.equal(f.calls.filter(call=>call.action==='connect').length,1);assert.equal(f.view.state().snapshot.services[1].connected,true);
});
test('unblurred non-secret input survives a hosting-mode change while key input is never retained',async()=>{
  const f=fixture();await f.view.load();await f.view.click('settings');
  const integration={name:'integration-gmail',type:'text',value:'typed-google-mail',closest:()=>({})};f.listeners.get('input')({target:integration});
  const secret={name:'secretKey',type:'password',value:'private-unsubmitted-key',closest:()=>({})};f.listeners.get('input')({target:secret});
  f.view.change('mode','self');assert.equal(f.view.state().draft.integrations.gmail,'typed-google-mail');assert.match(f.view.render(),/value="typed-google-mail"/);assert.doesNotMatch(JSON.stringify(f.view.state())+f.view.render(),/private-unsubmitted-key/);
});
test('feature refresh callbacks run after explicit confirmed changes, never status loads or render',async()=>{
  const f=fixture();await f.view.load();await f.view.load();f.view.render();assert.deepEqual(f.connectionChanges,[]);
  await f.view.configure(configuredFields({secretKey:''}));await f.view.click('connect','outlook');await f.view.bindConnection('gmail','owned');await f.view.click('disconnect','outlook');await f.view.click('reset');await f.view.click('confirm-reset');
  assert.deepEqual(f.connectionChanges,[{action:'configure'},{action:'connect',service:'outlook'},{action:'connection',service:'gmail'},{action:'disconnect',service:'outlook'},{action:'reset'}]);
});
test('real native configuration schema accepts UI output without unsupported capability keys',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'context-nango-ui-schema-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const providers={outlook:'microsoft',gmail:'google-mail','google-calendar':'google-calendar','google-drive':'google-drive'};
  const core=createDesktopNango({directory,crypto:{isAsyncEncryptionAvailable:async()=>false},openExternal:()=>assert.fail('OAuth must not be opened'),fetchImpl:async url=>{assert.equal(new URL(url).pathname,'/integrations');return new Response(JSON.stringify({data:ids.map(service=>({unique_key:'integration-'+service,provider:providers[service]}))}),{status:200,headers:{'Content-Type':'application/json'}});}});
  t.after(()=>core.dispose());
  const view=createNangoConnectionsView({document:undefined,bridge:{nango:async message=>{try{return {ok:true,value:await core.handle(message)};}catch(error){return {ok:false,error:error.message,code:error.code};}}}});t.after(()=>view.dispose());
  assert.equal(await view.configure(configuredFields()),true);assert.equal(view.state().snapshot.configured,true);assert.equal(view.state().snapshot.services.some(service=>service.connected),false);assert.equal(view.state().snapshot.storage,'session');
});
test('feature CSS uses Context theme tokens for dark support and single-column narrow layouts',async()=>{
  const css=await readFile(new URL('../dist/nango-connections.css',import.meta.url),'utf8');assert.match(css,/var\(--coco-white\)/);assert.match(css,/var\(--theme-error/);assert.match(css,/@media \(max-width: 720px\)/);assert.match(css,/focus-visible/);assert.doesNotMatch(css,/background:\s*(?:white|#[0-9a-f])/i);
});
