import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarRefreshRange,createCalendarAutoRefresh,CALENDAR_REFRESH_TIMING} from '../dist/calendar-auto-refresh.js';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fakeClock(){
  let now=0,id=0,unrefs=0;const jobs=new Map(),captured=[];
  return {timers:{
    setTimeout(callback,delay){const key={id:id++,unref(){unrefs++;}};jobs.set(key,{callback,due:now+delay});captured.push(callback);return key;},
    clearTimeout(key){jobs.delete(key);},
  },now:()=>now,count:()=>jobs.size,unrefs:()=>unrefs,captured,
  async advance(ms){
    const target=now+ms;let count=0;
    while(true){await flush();const next=[...jobs].filter(([,job])=>job.due<=target).sort((a,b)=>a[1].due-b[1].due||a[0].id-b[0].id)[0];
      if(!next)break;assert(++count<1000,'no immediate timer storm');now=next[1].due;jobs.delete(next[0]);next[1].callback();}
    now=target;await flush();
  }};
}
function fixture({refresh=async()=>({}),visible=true}={}){
  let shown=visible;const clock=fakeClock(),calls=[];
  const scheduler=createCalendarAutoRefresh({timers:clock.timers,isVisible:()=>shown,refresh:()=>{calls.push(clock.now());return refresh();}});
  return {scheduler,clock,calls,visible:value=>{shown=value;}};
}

test('manual calendar range uses Berlin midnight with month-specific DST offsets',()=>{
  assert.deepEqual(calendarRefreshRange('2026-10'),{from:'2026-09-30T22:00:00.000Z',to:'2026-10-31T23:00:00.000Z'});
  assert.deepEqual(calendarRefreshRange('2026-03'),{from:'2026-02-28T23:00:00.000Z',to:'2026-03-31T22:00:00.000Z'});
  assert.deepEqual(calendarRefreshRange('2026-12'),{from:'2026-11-30T23:00:00.000Z',to:'2026-12-31T23:00:00.000Z'});
});

test('automatic range follows today from last month through the next three months even when UI shows history',()=>{
  assert.deepEqual(calendarRefreshRange('2022-01',{automatic:true,today:'2026-10-14'}),{from:'2026-08-31T22:00:00.000Z',to:'2027-01-31T23:00:00.000Z'});
  assert.deepEqual(calendarRefreshRange('2025-08',{automatic:true,today:'2026-01-31'}),{from:'2025-11-30T23:00:00.000Z',to:'2026-04-30T22:00:00.000Z'});
  assert.deepEqual(calendarRefreshRange(undefined,{automatic:true,today:'2024-02-29'}),{from:'2023-12-31T23:00:00.000Z',to:'2024-05-31T22:00:00.000Z'});
});

test('invalid ranges fail instead of silently rolling bad dates into another month',()=>{
  for(const month of [undefined,null,'2026-00','2026-13','2026-1','2026-10-01','0000-10','2026-10\n'])assert.throws(()=>calendarRefreshRange(month));
  for(const today of [undefined,null,'2026-02-30','2026-13-01','2026-10-14T00:00','0000-01-01']){
    if(today===undefined)continue; // undefined intentionally uses the default local day.
    assert.throws(()=>calendarRefreshRange('2026-10',{automatic:true,today}));
  }
  assert.throws(()=>calendarRefreshRange('2026-10',{automatic:'yes'}),TypeError);
});

test('startup is immediate even when hidden, idempotent and returns its initial promise',async()=>{
  const pending=deferred(),f=fixture({visible:false,refresh:()=>pending.promise});
  const first=f.scheduler.start();assert.equal(f.scheduler.start(),first);
  await flush();assert.deepEqual(f.calls,[0]);assert.equal(f.clock.count(),0);
  pending.resolve({failed:false});assert.deepEqual(await first,{failed:false});
  assert.equal(f.scheduler.start(),first);assert.equal(f.clock.count(),1);
  await f.clock.advance(15*60_000);assert.equal(f.calls.length,1);assert.equal(f.clock.count(),0);
  f.scheduler.dispose();
});

test('the 15-minute cadence starts at completion and never overlaps a slow read',async()=>{
  const pending=deferred();let first=true;const f=fixture({refresh:()=>first?(first=false,pending.promise):{}});
  const start=f.scheduler.start();await flush();await f.clock.advance(2*60_000);
  assert.equal(f.calls.length,1);assert.equal(f.clock.count(),0);
  pending.resolve({});await start;
  await f.clock.advance(15*60_000-1);assert.equal(f.calls.length,1);
  await f.clock.advance(1);assert.deepEqual(f.calls,[0,17*60_000]);assert.equal(f.clock.count(),1);
  assert(f.clock.unrefs()>=2);f.scheduler.dispose();
});

test('periodic timers recheck visibility and an overdue return refreshes only once',async()=>{
  const f=fixture();await f.scheduler.start();f.visible(false);
  await f.clock.advance(60*60_000);assert.equal(f.calls.length,1);assert.equal(f.clock.count(),0);
  f.visible(true);const a=f.scheduler.resume(),b=f.scheduler.resume();await Promise.all([a,b]);
  assert.equal(f.calls.length,2);assert.equal(f.clock.count(),1);
  await f.clock.advance(15*60_000);assert.equal(f.calls.length,3);f.scheduler.dispose();
});

test('fresh visibility resumes do not bypass the normal deadline',async()=>{
  const f=fixture();await f.scheduler.start();await f.clock.advance(20_000);
  for(let i=0;i<20;i++)await f.scheduler.resume();
  assert.equal(f.calls.length,1);assert.equal(f.clock.count(),1);
  await f.clock.advance(15*60_000-20_000);assert.equal(f.calls.length,2);f.scheduler.dispose();
});

test('failed results and thrown errors retry at 1, 2, 5, then bounded 15 minutes',async()=>{
  let attempt=0;const f=fixture({refresh:()=>{attempt++;if(attempt%2)throw new Error('synthetic failure');return {failed:true};}});
  assert.deepEqual(await f.scheduler.start(),{failed:true});
  for(const delay of [60_000,120_000,300_000,900_000,900_000]){
    const count=f.calls.length;await f.clock.advance(delay-1);assert.equal(f.calls.length,count);
    await f.clock.advance(1);assert.equal(f.calls.length,count+1);assert.equal(f.clock.count(),1);
  }
  f.scheduler.dispose();
});

test('success resets previous failure backoff to the normal cadence',async()=>{
  let bad=true;const f=fixture({refresh:()=>({failed:bad})});await f.scheduler.start();
  await f.clock.advance(60_000);await f.clock.advance(120_000);bad=false;
  await f.clock.advance(300_000);const good=f.calls.length;
  await f.clock.advance(15*60_000-1);assert.equal(f.calls.length,good);
  await f.clock.advance(1);assert.equal(f.calls.length,good+1);f.scheduler.dispose();
});

test('a busy skip retries after five seconds without an immediate polling loop',async()=>{
  let busy=true;const f=fixture({refresh:()=>busy?{skipped:true}:{}});await f.scheduler.start();
  await f.clock.advance(4999);assert.equal(f.calls.length,1);
  await f.clock.advance(1);assert.equal(f.calls.length,2);busy=false;
  await f.clock.advance(5000);assert.equal(f.calls.length,3);
  await f.clock.advance(15*60_000);assert.equal(f.calls.length,4);f.scheduler.dispose();
});

test('refreshSoon bypasses a fresh deadline and bundles active requests into one rerun',async()=>{
  const pending=deferred();let hold=false;const f=fixture({refresh:()=>hold?pending.promise:{}});
  await f.scheduler.start();await f.clock.advance(1000);hold=true;
  const active=f.scheduler.refreshSoon();await flush();assert.equal(f.calls.length,2);
  for(let i=0;i<30;i++)assert.equal(f.scheduler.refreshSoon(),active);
  hold=false;pending.resolve({});await active;assert.equal(f.clock.count(),1);
  await f.clock.advance(0);assert.equal(f.calls.length,3);assert.equal(f.clock.count(),1);
  await f.clock.advance(15*60_000);assert.equal(f.calls.length,4);f.scheduler.dispose();
});

test('a hidden refreshSoon is deferred until visible and preserves no extra native work',async()=>{
  const f=fixture();await f.scheduler.start();f.visible(false);
  assert.deepEqual(await f.scheduler.refreshSoon(),{skipped:true,hidden:true});
  assert.equal(f.calls.length,1);assert.equal(f.clock.count(),0);
  await f.clock.advance(60*60_000);assert.equal(f.calls.length,1);
  f.visible(true);await f.scheduler.resume();assert.equal(f.calls.length,2);f.scheduler.dispose();
});

test('pause stops timers and a later resume runs immediately once',async()=>{
  const f=fixture();await f.scheduler.start();f.scheduler.pause();
  await f.clock.advance(60*60_000);await f.scheduler.refreshSoon();
  assert.equal(f.calls.length,1);assert.equal(f.clock.count(),0);
  await f.scheduler.resume();assert.equal(f.calls.length,2);await f.scheduler.resume();assert.equal(f.calls.length,2);
  f.scheduler.dispose();
});

test('pause/resume cannot overlap an active native request that ignores cancellation',async()=>{
  const pending=deferred();let first=true;const f=fixture({refresh:()=>first?(first=false,pending.promise):{}});
  const initial=f.scheduler.start();await flush();f.scheduler.pause();f.scheduler.resume();f.scheduler.resume();
  await f.clock.advance(60*60_000);assert.equal(f.calls.length,1);assert.equal(f.clock.count(),0);
  pending.resolve({failed:true});await initial;await f.clock.advance(0);
  assert.equal(f.calls.length,2);assert.equal(f.clock.count(),1);f.scheduler.dispose();
});

test('pause or dispose prevents late completions from arming timers',async()=>{
  for(const method of ['pause','dispose']){
    const pending=deferred(),f=fixture({refresh:()=>pending.promise});
    const initial=f.scheduler.start();await flush();f.scheduler.refreshSoon();f.scheduler[method]();
    pending.reject(new Error('late failure'));await initial;await f.clock.advance(60*60_000);
    assert.equal(f.clock.count(),0);assert.equal(f.calls.length,1);f.scheduler.dispose();
  }
});

test('dispose before the startup microtask prevents even the initial callback and all restarts',async()=>{
  const f=fixture();const initial=f.scheduler.start();f.scheduler.dispose();
  assert.deepEqual(await initial,{skipped:true,disposed:true});
  await f.scheduler.start();await f.scheduler.resume();await f.scheduler.refreshSoon();
  await f.clock.advance(60*60_000);assert.equal(f.calls.length,0);assert.equal(f.clock.count(),0);
});

test('a cleared timer delivered late cannot restart a paused or disposed scheduler',async()=>{
  const f=fixture();await f.scheduler.start();const callback=f.clock.captured.at(-1);
  f.scheduler.pause();callback();await flush();assert.equal(f.calls.length,1);assert.equal(f.clock.count(),0);
  await f.scheduler.resume();const newest=f.clock.captured.at(-1);
  f.scheduler.dispose();newest();await flush();assert.equal(f.calls.length,2);assert.equal(f.clock.count(),0);
});

test('a late pre-pause timer cannot lose the handle for the newer resumed timer',async()=>{
  const f=fixture();await f.scheduler.start();const old=f.clock.captured.at(-1);
  f.scheduler.pause();await f.scheduler.resume();assert.equal(f.clock.count(),1);
  old();await flush();assert.equal(f.clock.count(),1);assert.equal(f.calls.length,2);
  f.scheduler.dispose();assert.equal(f.clock.count(),0);
});

test('construction validates callbacks, accepts browser numeric timer handles and freezes timing limits',async()=>{
  assert.throws(()=>createCalendarAutoRefresh(),TypeError);
  assert.throws(()=>createCalendarAutoRefresh({refresh(){},isVisible:'visible'}),TypeError);
  assert.throws(()=>createCalendarAutoRefresh({refresh(){},timers:{setTimeout(){}}}),TypeError);
  let cleared=0;const scheduler=createCalendarAutoRefresh({refresh(){},timers:{setTimeout:()=>0,clearTimeout:id=>{assert.equal(id,0);cleared++;}}});
  await scheduler.start();scheduler.dispose();assert.equal(cleared,1);
  assert(Object.isFrozen(CALENDAR_REFRESH_TIMING));assert(Object.isFrozen(CALENDAR_REFRESH_TIMING.retries));
});
