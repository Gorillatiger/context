import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalendarProviders} from '../connectors/calendar.mjs';
import {createNangoCalendarProviders} from '../connectors/nango-calendar.mjs';
import {createCalendarRouting} from '../desktop/calendar-routing.mjs';
import {createCalendarSynchronizer, initialCalendarSync} from '../dist/calendar-sync.js';

const range = {calendarId:'synthetic-calendar', from:'2026-10-01T00:00:00Z', to:'2026-11-01T00:00:00Z'};
const remote = (provider, {id='remote-event', title='Original', date='2026-10-15'}={}) => provider === 'google'
  ? {id, summary:title, start:{dateTime:date+'T08:00:00Z'}, end:{dateTime:date+'T09:00:00Z'}}
  : {id, subject:title, isAllDay:false, start:{dateTime:date+'T08:00:00',timeZone:'UTC'}, end:{dateTime:date+'T09:00:00',timeZone:'UTC'}};

function fixtures(provider) {
  let item = remote(provider), now = 0;
  const directCalls = [], cloudCalls = [], urls = [];
  const body = () => provider === 'google' ? {items:[structuredClone(item)]} : {value:[structuredClone(item)]};
  const list = () => provider === 'google'
    ? {items:[{id:range.calendarId,summary:'Synthetic calendar',primary:true}]}
    : {value:[{id:range.calendarId,name:'Synthetic calendar',isDefaultCalendar:true,canEdit:true,canShare:true}]};
  const direct = createCalendarProviders({
    now:() => now,
    callbackFactory:async () => ({redirectURI:'http://127.0.0.1:54321/oauth/callback',result:Promise.resolve('synthetic-code'),close(){}}),
    openExternal:async url => urls.push(new URL(url)),
    fetcher:async (url,options) => {
      directCalls.push({url:new URL(url),options});
      if (url.includes('/token')) return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,token_type:'Bearer',scope:urls.at(-1)?.searchParams.get('scope')});
      return Response.json(url.includes('/calendarList') || new URL(url).pathname === '/v1.0/me/calendars' ? list() : body());
    },
  });
  direct.configure(provider, provider === 'google'
    ? {clientId:'123456789-context.apps.googleusercontent.com',driveEnabled:false}
    : {clientId:'12345678-1234-1234-1234-123456789abc'});
  const bindings = Object.fromEntries(['outlook','google-calendar','google-drive'].map(service => [service,{
    connected:service === (provider === 'google' ? 'google-calendar' : 'outlook'),
    integrationId:service+'-synthetic',connectionId:service+'-synthetic-account',revision:'1:0',
    capabilities:{calendarRead:true,calendarWrite:false,driveRead:false},
  }]));
  const nango = {
    status:async service => structuredClone(bindings[service]),
    localStatus:service => structuredClone(bindings[service]),
    disconnect:async service => {bindings[service].connected=false;bindings[service].connectionId='';bindings[service].revision='1:1';},
    proxy:async (service,request,signal) => {
      assert.equal(signal.aborted,false);
      cloudCalls.push({service,...request});
      return {status:200,headers:{'content-type':'application/json'},data:request.path.endsWith('/calendarList') || request.path === '/v1.0/me/calendars' ? list() : body()};
    },
  };
  const cloud = createNangoCalendarProviders({nango,now:() => now});
  return {direct,cloud,nango,bindings,directCalls,cloudCalls,urls,
    setRemote:patch => {item=remote(provider,patch);}, advance:() => {now=3_700_000;}};
}

for (const provider of ['google','outlook']) {
  test(`${provider}: remote identity survives title/time edits and direct-to-Nango routing`,async () => {
    const f=fixtures(provider);await f.direct.connect(provider);
    await f.direct.calendars(provider);await f.cloud.calendars(provider);
    const first=(await f.direct.events(provider,range)).events[0];
    f.setRemote({title:'Updated meeting',date:'2026-10-18'});
    const direct=(await f.direct.events(provider,range)).events[0];
    const cloud=(await f.cloud.events(provider,range)).events[0];
    assert.equal(first.id,direct.id);assert.equal(first.id,cloud.id);
    assert.equal(direct.title,'Updated meeting');assert.equal(cloud.start,direct.start);
    assert.equal(first.source.externalId,cloud.source.externalId);
    assert(f.directCalls.filter(call=>!call.url.pathname.endsWith('/token')).every(call=>call.options.method==='GET'));
    assert(f.cloudCalls.every(call=>call.method==='GET'));
  });

  test(`${provider}: repeated reads refresh existing authorization without reopening OAuth or publishing`,async () => {
    const f=fixtures(provider);await f.direct.connect(provider);await f.direct.calendars(provider);
    const first=await f.direct.events(provider,range);f.advance();
    const second=await f.direct.events(provider,range);
    assert.equal(f.urls.length,1,'existing refresh authorization must not open an account prompt');
    assert.equal(first.events[0].id,second.events[0].id);
    const refresh=f.directCalls.filter(call=>call.url.pathname.endsWith('/token')).at(-1);
    assert.equal(new URLSearchParams(refresh.options.body).get('grant_type'),'refresh_token');
    assert(f.directCalls.filter(call=>!call.url.pathname.endsWith('/token')).every(call=>call.options.method==='GET'));
    assert(!JSON.stringify(f.direct.status()).includes('synthetic-refresh'));
  });
}

test('a selected disconnected Nango calendar does not fall back to a dormant direct account',async () => {
  const f=fixtures('outlook');await f.direct.connect('outlook');
  const route=createCalendarRouting({nango:f.nango,direct:f.direct});
  assert.equal((await route.status('outlook')).backend,'nango');
  await route.disconnect('outlook');
  assert.equal((await route.status('outlook')).connected,false);
  assert.equal((await route.status('outlook')).backend,'nango');
  f.directCalls.length=0;
  await assert.rejects(route.calendars('outlook'),{code:'reconnect_required'});
  assert.equal(f.directCalls.length,0);
});

test('a startup trigger with a saved Outlook target cannot activate publication when automatic is false',async () => {
  const sync={...initialCalendarSync(),target:{calendarId:range.calendarId,title:'Synthetic calendar'}};
  const calls=[];
  const synchronizer=createCalendarSynchronizer({
    getWorkspace:() => ({calendarSync:sync,projects:[],calendarEvents:[]}),
    saveSettings:() => {throw new Error('No state mutation is expected');},
    request:async (action,options) => {calls.push({action,options});throw new Error('No provider access is expected');},
  });
  assert.equal((await synchronizer.run({manual:false})).skipped,true);
  assert.equal(calls.length,0);
});

test('routing exposes an opaque generation that survives token refresh and changes on same-registration reconnection',async () => {
  const f=fixtures('outlook'),route=createCalendarRouting({nango:f.nango,direct:f.direct});
  route.configure('outlook',{clientId:'12345678-1234-1234-1234-123456789abc'});
  await route.connect('outlook');await route.calendars('outlook');
  const original=(await route.status('outlook')).generation;
  assert.match(original,/^[a-f0-9]{64}$/);
  f.advance();await route.events('outlook',range);
  assert.equal((await route.status('outlook')).generation,original,'access-token rotation is not a different account binding');
  await route.connect('outlook');
  const next=await route.status('outlook');
  assert.notEqual(next.generation,original);
  assert.equal(next.clientId,'12345678-1234-1234-1234-123456789abc');
  assert(!next.generation.includes('synthetic'));
});

test('Nango binding generations distinguish same-ID rebinds while unrelated Drive updates leave calendar identity stable',async () => {
  const f=fixtures('google'),route=createCalendarRouting({nango:f.nango,direct:f.direct});
  const original=await route.status('google');
  assert.match(original.generation,/^[a-f0-9]{64}$/);
  f.bindings['google-drive'].revision='1:1';
  assert.equal((await route.status('google')).generation,original.generation);
  f.bindings['google-calendar'].revision='1:1';
  const next=await route.status('google');
  assert.notEqual(next.generation,original.generation);
  assert.equal(next.backend,'nango');
  assert(!Object.hasOwn(next,'connectionId'));
  assert(!Object.hasOwn(next,'integrationId'));
});

test('a route change while reading status rejects the obsolete status instead of returning its identity',async () => {
  const f=fixtures('outlook');let complete;const gate=new Promise(resolve=>{complete=resolve;});
  const old=f.nango.status;
  f.nango.status=async service => {const snapshot=await old(service);if(service==='outlook')await gate;return snapshot;};
  const route=createCalendarRouting({nango:f.nango,direct:f.direct}),pending=route.status('outlook');
  route.configure('outlook',{clientId:'12345678-1234-1234-1234-123456789abc'});
  complete();await assert.rejects(pending,{code:'cancelled'});
  assert.equal((await route.status('outlook')).backend,'direct');
});

test('independent native startup instances cannot accidentally reuse a direct binding generation',async () => {
  const first=fixtures('outlook'),second=fixtures('outlook');
  first.bindings.outlook.integrationId='';second.bindings.outlook.integrationId='';
  const a=createCalendarRouting({nango:first.nango,direct:first.direct});
  const b=createCalendarRouting({nango:second.nango,direct:second.direct});
  assert.notEqual((await a.status('outlook')).generation,(await b.status('outlook')).generation);
});
