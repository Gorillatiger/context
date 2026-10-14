import test from 'node:test';
import assert from 'node:assert/strict';
import {createFeedRefresh,FEED_REFRESH_INTERVALS} from '../dist/feed-refresh.js';

const ORIGIN=1_700_000_000_000;
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function eventTarget(){
  const listeners=new Map();
  return {
    addEventListener(type,handler){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(handler);},
    removeEventListener(type,handler){listeners.get(type)?.delete(handler);},
    emit(type){for(const handler of [...listeners.get(type)||[]])handler({type});},
    count(type){return listeners.get(type)?.size||0;},
  };
}
function fakeClock(){
  let current=ORIGIN,id=0;const jobs=new Map();
  return {
    now:()=>current,
    timers:{setTimeout(callback,delay){const key=id++;jobs.set(key,{callback,due:current+delay});return key;},clearTimeout(key){jobs.delete(key);}},
    count:()=>jobs.size,
    async advance(ms){
      const target=current+ms;let safety=0;
      while(true){
        await flush();
        const next=[...jobs].filter(([,job])=>job.due<=target).sort((a,b)=>a[1].due-b[1].due||a[0]-b[0])[0];
        if(!next)break;
        assert.ok(++safety<1000,'the scheduler must not create an immediate timer storm');
        current=next[1].due;jobs.delete(next[0]);next[1].callback();
      }
      current=target;await flush();
    },
  };
}
function fixture({refresh=async()=>({ok:true}),connected=true,visible=true,onStatus}={}){
  const clock=fakeClock(),events=eventTarget(),visibilityEvents=eventTarget(),calls=[],statuses=[];
  let currentConnected=connected,currentVisible=visible;
  const scheduler=createFeedRefresh({
    refresh:options=>{calls.push(options);return refresh(options);},
    onStatus:status=>{statuses.push({...status});onStatus?.(status);},
    getVisibility:()=>currentVisible?'visible':'hidden',isConnected:()=>currentConnected,
    now:clock.now,timers:clock.timers,eventTarget:events,visibilityTarget:visibilityEvents,
  });
  return {scheduler,clock,events,visibilityEvents,calls,statuses,
    connected(value){currentConnected=value;},visible(value){currentVisible=value;},
    dispose(){scheduler.dispose();},
  };
}

test('a live feed refreshes every minute measured from completion, without overlap or catch-up',async t=>{
  const pending=deferred();let first=true;
  const f=fixture({refresh:()=>first?(first=false,pending.promise):{ok:true}});t.after(()=>f.dispose());
  const initial=f.scheduler.start();assert.equal(initial.busy,true);assert.equal(initial.lastAttemptAt,ORIGIN);assert.equal(initial.nextDueAt,null);
  await flush();assert.equal(f.calls.length,1);assert.equal(f.calls[0].reason,'startup');assert.equal(f.calls[0].manual,false);
  await f.clock.advance(80_000);assert.equal(f.calls.length,1);assert.equal(f.clock.count(),0);
  pending.resolve({ok:true});await flush();
  assert.equal(f.scheduler.status().lastSuccessAt,ORIGIN+80_000);
  assert.equal(f.scheduler.status().nextDueAt,ORIGIN+140_000);
  await f.clock.advance(59_999);assert.equal(f.calls.length,1);
  await f.clock.advance(1);assert.equal(f.calls.length,2);assert.equal(f.calls[1].reason,'automatic');
  assert.equal(f.scheduler.status().nextDueAt,ORIGIN+200_000);
});

test('snapshot-only sources use a two-minute cadence',async t=>{
  const f=fixture({connected:false});t.after(()=>f.dispose());f.scheduler.start();await flush();
  assert.equal(f.scheduler.status().intervalMs,120_000);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+120_000);
  await f.clock.advance(119_999);assert.equal(f.calls.length,1);
  await f.clock.advance(1);assert.equal(f.calls.length,2);
});

test('delayed startup can be manually refreshed immediately and repeated start does not duplicate listeners',async t=>{
  const f=fixture();t.after(()=>f.dispose());f.scheduler.start({immediate:false});f.scheduler.start();await flush();
  assert.equal(f.calls.length,0);assert.equal(f.events.count('focus'),1);assert.equal(f.visibilityEvents.count('visibilitychange'),1);
  const result=await f.scheduler.request(true);
  assert.equal(result.accepted,true);assert.equal(result.ok,true);assert.equal(f.calls[0].manual,true);assert.equal(f.calls[0].reason,'manual');
  assert.equal(f.clock.count(),1);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+60_000);
});

test('visibility pause retains its deadline and an overdue resume triggers exactly one refresh',async t=>{
  const pending=deferred();let first=true;
  const f=fixture({refresh:()=>first?(first=false,{ok:true}):pending.promise});t.after(()=>f.dispose());
  f.scheduler.start();await flush();f.visible(false);f.visibilityEvents.emit('visibilitychange');await flush();
  assert.equal(f.scheduler.status().state,'paused');assert.equal(f.scheduler.status().nextDueAt,ORIGIN+60_000);assert.equal(f.clock.count(),0);
  await f.clock.advance(600_000);assert.equal(f.calls.length,1);
  f.visible(true);f.visibilityEvents.emit('visibilitychange');f.events.emit('focus');f.events.emit('focus');await flush();
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].reason,'visibility');assert.equal(f.scheduler.status().busy,true);
  pending.resolve({ok:true});await flush();assert.equal(f.scheduler.status().nextDueAt,ORIGIN+660_000);
});

test('a fresh visibility/focus resume schedules the remaining interval without a redundant read',async t=>{
  const f=fixture();t.after(()=>f.dispose());f.scheduler.start();await flush();await f.clock.advance(20_000);
  f.visible(false);await f.scheduler.visibilityChanged();await f.clock.advance(10_000);
  f.visible(true);assert.deepEqual(await f.scheduler.resume(),{accepted:false,reason:'fresh'});
  for(let i=0;i<20;i++)f.events.emit('focus');await flush();
  assert.equal(f.calls.length,1);assert.equal(f.clock.count(),1);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+60_000);
  await f.clock.advance(30_000);assert.equal(f.calls.length,2);
});

test('hidden state is checked again by the timer even when a visibility event is missing',async t=>{
  const f=fixture();t.after(()=>f.dispose());f.scheduler.start();await flush();f.visible(false);
  await f.clock.advance(360_000);assert.equal(f.calls.length,1);assert.equal(f.clock.count(),0);assert.equal(f.scheduler.status().state,'paused');
  f.visible(true);await f.scheduler.resume('focus');assert.equal(f.calls.length,2);
});

test('a hidden startup waits for visibility; manual requests remain available while hidden',async t=>{
  const f=fixture({visible:false});t.after(()=>f.dispose());f.scheduler.start();await flush();
  assert.equal(f.calls.length,0);assert.equal(f.scheduler.status().state,'paused');assert.equal(f.clock.count(),0);
  const manual=await f.scheduler.request(true);assert.equal(manual.ok,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].manual,true);
  await f.clock.advance(90_000);assert.equal(f.calls.length,1);
  f.visible(true);await f.scheduler.visibilityChanged();assert.equal(f.calls.length,2);assert.equal(f.calls[1].manual,false);
});

test('automatic errors back off exponentially, are bounded, and focus cannot bypass a retry deadline',async t=>{
  const f=fixture({refresh:()=>({ok:false,error:'Quelle vorübergehend nicht erreichbar.'})});t.after(()=>f.dispose());
  f.scheduler.start();await flush();
  assert.equal(f.scheduler.status().state,'error');assert.equal(f.scheduler.status().lastSuccessAt,null);
  assert.equal(f.scheduler.status().failures,1);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+120_000);
  for(let i=0;i<10;i++)f.events.emit('focus');await flush();assert.equal(f.calls.length,1);
  await f.clock.advance(120_000);assert.equal(f.scheduler.status().failures,2);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+360_000);
  await f.clock.advance(240_000);assert.equal(f.scheduler.status().failures,3);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+660_000);
  await f.clock.advance(300_000);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+960_000);
  assert.equal(f.calls.length,4);assert.equal(f.clock.count(),1);assert.equal(f.scheduler.status().lastError,'Quelle vorübergehend nicht erreichbar.');
});

test('snapshot failure retries never exceed five minutes and success restores the normal cadence',async t=>{
  let failing=true;const f=fixture({connected:false,refresh:()=>failing?false:undefined});t.after(()=>f.dispose());
  f.scheduler.start();await flush();assert.equal(f.scheduler.status().nextDueAt,ORIGIN+240_000);
  await f.clock.advance(240_000);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+540_000);
  failing=false;await f.clock.advance(300_000);
  assert.equal(f.scheduler.status().failures,0);assert.equal(f.scheduler.status().lastError,'');assert.equal(f.scheduler.status().state,'waiting');
  assert.equal(f.scheduler.status().lastSuccessAt,ORIGIN+540_000);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+660_000);
});

test('manual retry clears prior backoff; a failed manual read starts a new bounded retry sequence',async t=>{
  let failing=true;const f=fixture({refresh:()=>{if(failing)throw new Error('Offline');return {ok:true};}});t.after(()=>f.dispose());
  f.scheduler.start();await flush();await f.clock.advance(120_000);await f.clock.advance(240_000);
  assert.equal(f.scheduler.status().failures,3);
  const failed=await f.scheduler.request(true);assert.equal(failed.ok,false);assert.equal(failed.error,'Offline');assert.equal(f.scheduler.status().failures,1);
  assert.equal(f.scheduler.status().nextDueAt,f.clock.now()+120_000);assert.equal(f.calls.at(-1).manual,true);
  failing=false;const recovered=await f.scheduler.request(true);assert.equal(recovered.ok,true);
  assert.equal(f.scheduler.status().lastError,'');assert.equal(f.scheduler.status().failures,0);assert.equal(f.scheduler.status().nextDueAt,f.clock.now()+60_000);
});

test('manual and connector requests skip a busy refresh without changing its retry outcome',async t=>{
  const pending=deferred();const f=fixture({refresh:()=>pending.promise});t.after(()=>f.dispose());f.scheduler.start();await flush();
  assert.deepEqual(await f.scheduler.request(true),{accepted:false,reason:'busy'});
  assert.deepEqual(await f.scheduler.request(false),{accepted:false,reason:'busy'});
  assert.equal(f.calls.length,1);assert.equal(f.scheduler.status().manual,false);assert.equal(f.scheduler.status().nextDueAt,null);
  pending.resolve({ok:false,error:'Offline'});await flush();assert.equal(f.scheduler.status().failures,1);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+120_000);
});

test('an explicit connector change requests a fresh read even when the last snapshot is fresh',async t=>{
  const f=fixture({connected:false});t.after(()=>f.dispose());f.scheduler.start();await flush();await f.clock.advance(1000);
  f.connected(true);const result=await f.scheduler.request(false);
  assert.equal(result.ok,true);assert.equal(f.calls.length,2);assert.equal(f.calls[1].reason,'requested');assert.equal(f.calls[1].manual,false);
  assert.equal(f.scheduler.status().intervalMs,60_000);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+61_000);
});

test('a hidden connector invalidation is remembered and checked on return even before the old deadline',async t=>{
  const f=fixture();t.after(()=>f.dispose());f.scheduler.start();await flush();await f.clock.advance(1000);
  f.visible(false);assert.deepEqual(await f.scheduler.request(false),{accepted:false,reason:'hidden'});
  assert.equal(f.scheduler.status().nextDueAt,ORIGIN+1000);assert.equal(f.calls.length,1);assert.equal(f.clock.count(),0);
  f.visible(true);await f.scheduler.resume();assert.equal(f.calls.length,2);
});

test('a source that becomes connected while hidden resumes with the shorter live interval',async t=>{
  const f=fixture({connected:false});t.after(()=>f.dispose());f.scheduler.start();await flush();f.visible(false);await f.scheduler.visibilityChanged();
  await f.clock.advance(70_000);f.connected(true);f.visible(true);await f.scheduler.resume();
  assert.equal(f.calls.length,2);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+130_000);
});

test('stop aborts a pending read, detaches events, and ignores its late error/status data',async()=>{
  const pending=deferred();const f=fixture({refresh:()=>pending.promise});f.scheduler.start();await flush();
  const signal=f.calls[0].signal;const stopped=f.scheduler.stop();assert.equal(signal.aborted,true);assert.equal(stopped.state,'stopped');assert.equal(stopped.nextDueAt,null);
  assert.equal(f.events.count('focus'),0);assert.equal(f.visibilityEvents.count('visibilitychange'),0);
  f.events.emit('focus');f.visibilityEvents.emit('visibilitychange');await f.clock.advance(600_000);assert.equal(f.calls.length,1);
  pending.reject(new Error('Stale provider error'));await flush();
  assert.equal(f.scheduler.status().state,'stopped');assert.equal(f.scheduler.status().busy,false);assert.equal(f.scheduler.status().lastError,'');assert.equal(f.scheduler.status().lastSuccessAt,null);
  assert.deepEqual(await f.scheduler.request(true),{accepted:false,reason:'stopped'});f.dispose();
});

test('stop/start cannot overlap an old request even when refresh ignores its abort signal',async t=>{
  const pending=deferred();let first=true;const f=fixture({refresh:()=>first?(first=false,pending.promise):{ok:true}});t.after(()=>f.dispose());
  f.scheduler.start();await flush();f.scheduler.stop();f.scheduler.start();await flush();
  assert.equal(f.calls.length,1);assert.equal(f.scheduler.status().busy,true);
  await f.clock.advance(600_000);assert.equal(f.calls.length,1);assert.equal(f.clock.count(),0);
  pending.resolve({ok:true});await flush();
  assert.equal(f.calls.length,2);assert.equal(f.scheduler.status().lastSuccessAt,ORIGIN+600_000);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+660_000);
});

test('disposing a pending refresh aborts it and prohibits all later callbacks and restarts',async()=>{
  const pending=deferred();const f=fixture({refresh:()=>pending.promise});f.scheduler.start();await flush();
  const count=f.statuses.length;f.dispose();assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.scheduler.status().state,'disposed');
  pending.resolve({ok:false,error:'Late error'});await flush();await f.clock.advance(600_000);
  f.scheduler.start();f.events.emit('focus');await f.scheduler.resume();await f.scheduler.request(true);
  assert.equal(f.statuses.length,count);assert.equal(f.calls.length,1);assert.equal(f.scheduler.status().lastError,'');assert.equal(f.clock.count(),0);
});

test('stop before the initial microtask prevents the refresh callback altogether',async()=>{
  const f=fixture();f.scheduler.start();f.scheduler.stop();await flush();assert.equal(f.calls.length,0);assert.equal(f.scheduler.status().busy,false);f.dispose();
});

test('renderer errors do not break refresh scheduling and error messages are bounded',async t=>{
  const f=fixture({refresh:()=>Promise.reject(new Error('x'.repeat(2000))),onStatus:()=>{throw new Error('Renderer unavailable');}});t.after(()=>f.dispose());
  f.scheduler.start();await flush();assert.equal(f.scheduler.status().lastError.length,500);assert.equal(f.scheduler.status().nextDueAt,ORIGIN+120_000);
  await f.clock.advance(120_000);assert.equal(f.calls.length,2);
});

test('invalid scheduler callbacks fail early and invalid manual flags do not dispatch',async t=>{
  assert.throws(()=>createFeedRefresh(),TypeError);assert.throws(()=>createFeedRefresh({refresh:()=>{},timers:{setTimeout(){}}}),TypeError);
  const f=fixture();t.after(()=>f.dispose());f.scheduler.start({immediate:false});
  await assert.rejects(f.scheduler.request('manual'),TypeError);assert.equal(f.calls.length,0);
  assert.equal(FEED_REFRESH_INTERVALS.maximumRetry,300_000);
});
