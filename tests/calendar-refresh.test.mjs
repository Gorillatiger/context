import test from 'node:test';
import assert from 'node:assert/strict';
import {readConnectedCalendarEvents} from '../dist/calendar-refresh.js';

const range = {from:'2026-09-30T22:00:00.000Z',to:'2026-10-31T23:00:00.000Z'};
test('one manual refresh reads all connected calendars, preserving the exact month and filtering self-synced copies', async () => {
  const calls = [];
  const result = await readConnectedCalendarEvents({...range,connections:{outlook:{connected:true},google:{connected:true}},
    request:async (action,options) => {
      calls.push({action,...options});
      if (action === 'calendars') return {calendars:[{id:options.provider+'-primary'},{id:options.provider+'-other'}],complete:true};
      assert.deepEqual([options.body.from,options.body.to],[range.from,range.to]);
      return {events:[{id:options.body.calendarId},{id:'self-copy'}],complete:true};
    },filterEvents:events=>events.filter(e=>e.id!=='self-copy')});
  assert.deepEqual(result.events.map(e=>e.id),['outlook-primary','outlook-other','google-primary','google-other']);
  assert.deepEqual(result.providers,['outlook','google']); assert.equal(calls.filter(c=>c.action==='events').length,4);
  assert.ok(calls.every(c=>['calendars','events'].includes(c.action)),'refresh must never write to a provider');
});
test('incomplete provider pages stay visibly incomplete rather than claiming a full sync', async () => {
  const result=await readConnectedCalendarEvents({...range,connections:{google:{connected:true}},request:async action=>action==='calendars'?{calendars:[{id:'a',title:'A'}],complete:false}:{events:[],truncated:true}});
  assert.equal(result.warnings.length,2); assert.match(result.warnings.join(' '),/unvollständig|teilweise/);
});
test('cancellation prevents further calendar reads and no partial refresh is returned for local saving', async () => {
  const controller=new AbortController(),calls=[];
  await assert.rejects(readConnectedCalendarEvents({...range,signal:controller.signal,connections:{outlook:{connected:true}},request:async action=>{
    calls.push(action);if(action==='calendars')return {calendars:[{id:'a'},{id:'b'}]};controller.abort();return {events:[{id:'private'}]};
  }}),error=>error.name==='AbortError');
  assert.deepEqual(calls,['calendars','events']);
});
test('a failed provider read cannot return a partial success that overwrites the previous local calendar', async () => {
  await assert.rejects(readConnectedCalendarEvents({...range,connections:{outlook:{connected:true},google:{connected:true}},request:async(action,{provider})=>{
    if(provider==='google')throw Error('Offline');return action==='calendars'?{calendars:[{id:'a'}]}:{events:[{id:'a'}]};
  }}),/Offline/);
});
test('disconnected accounts and duplicate calendar IDs cannot cause private requests', async () => {
  const calls=[];
  await assert.rejects(readConnectedCalendarEvents({...range,connections:{outlook:{connected:false}},request:async()=>calls.push('private')}),/Verbinde/);
  assert.equal(calls.length,0);
  await assert.rejects(readConnectedCalendarEvents({...range,connections:{google:{connected:true}},request:async action=>action==='calendars'?{calendars:[{id:'a'},{id:'a'}]}:{events:[]}}),/ungültige Kalenderzuordnung/);
});
test('a provider read exceeds no local calendar bound and fails before returning partial data', async () => {
  const calls = [];
  await assert.rejects(readConnectedCalendarEvents({...range,connections:{google:{connected:true}},request:async(action,options)=>{
    calls.push(action);
    return action === 'calendars'
      ? {calendars:[{id:'one'},{id:'two'},{id:'never-read'}]}
      : {events:Array.from({length:1001},(_,i)=>({id:options.body.calendarId+'-'+i}))};
  }}),/höchstens 2\.000/);
  assert.deepEqual(calls,['calendars','events','events']);
});
test('aborting before the first calendar request does not touch connected accounts', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(readConnectedCalendarEvents({...range,connections:{google:{connected:true}},signal:controller.signal,request:async()=>{calls++;}}),error=>error.name==='AbortError');
  assert.equal(calls,0);
});
