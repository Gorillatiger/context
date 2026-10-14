import test from 'node:test';
import assert from 'node:assert/strict';
import {createAIRateGate,renderAIWait} from '../dist/ai-rate-limit.js';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const aborted=()=>new DOMException('Synthetic cancellation','AbortError');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fakeClock(start=0){
  let time=start,serial=0;const scheduled=new Map(),sleeps=[];
  const setTimer=(fn,ms)=>{const id=++serial;scheduled.set(id,{at:time+ms,fn});return id;};
  const clearTimer=id=>scheduled.delete(id);
  const sleep=(ms,signal)=>new Promise((resolve,reject)=>{
    sleeps.push(ms);if(signal?.aborted){reject(aborted());return;}
    const cancel=()=>{clearTimer(id);signal?.removeEventListener('abort',cancel);reject(aborted());};
    const id=setTimer(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);signal?.addEventListener('abort',cancel,{once:true});
  });
  async function advance(ms){const target=time+ms;let count=0;for(;;){await flush();const first=[...scheduled.entries()].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!first)break;assert.ok(++count<10000,'fake clock did not converge');time=first[1].at;scheduled.delete(first[0]);first[1].fn();}time=target;await flush();}
  return {now:()=>time,sleep,setTimer,clearTimer,advance,sleeps,pending:()=>scheduled.size};
}
const gate=(clock,options={})=>createAIRateGate({...clock,...options});
async function fill(limiter,count=10){for(let i=0;i<count;i++)assert.equal(await limiter.run('kiconnect',async()=>i),i);}

test('the first ten campus calls proceed immediately and only the eleventh waits for the rolling window',async()=>{
  const clock=fakeClock(),limiter=gate(clock),notices=[];await fill(limiter);assert.deepEqual(limiter.snapshot(),{used:10,remaining:0,retryAfterMs:60000});let sent=0;
  const next=limiter.run('kiconnect',async()=>{sent++;return 'eleventh';},{onWait:value=>notices.push(value)});await flush();assert.equal(sent,0);assert.equal(notices[0].reason,'rate');assert.equal(notices[0].retryAfterMs,60000);
  await clock.advance(59999);assert.equal(sent,0);assert.equal(limiter.snapshot().retryAfterMs,1);await clock.advance(1);assert.equal(await next,'eleventh');assert.equal(sent,1);assert.deepEqual(limiter.snapshot(),{used:1,remaining:9,retryAfterMs:0});assert.equal(notices.at(-1),null);assert.ok(clock.sleeps.every(ms=>ms>0&&ms<=1000));
});

test('a rolling window releases only the expired reservations, not the whole minute bucket',async()=>{
  const clock=fakeClock(),limiter=gate(clock,{limit:2,windowMs:1000});await limiter.run('kiconnect',async()=>1);await clock.advance(500);await limiter.run('kiconnect',async()=>2);let sent=0;
  const waiting=limiter.run('kiconnect',async()=>{sent++;return 3;});await clock.advance(499);assert.equal(sent,0);await clock.advance(1);assert.equal(await waiting,3);assert.deepEqual(limiter.snapshot(),{used:2,remaining:0,retryAfterMs:500});
});

test('simultaneously waiting callers recheck capacity and cannot reserve the same released slots',async()=>{
  const clock=fakeClock(),limiter=gate(clock,{limit:2,windowMs:1000,maxPending:4}),sent=[];await fill(limiter,2);
  const queued=Array.from({length:4},(_,index)=>limiter.run('kiconnect',async()=>{sent.push({index,at:clock.now()});return index;}));await flush();assert.equal(sent.length,0);await clock.advance(1000);assert.equal(sent.length,2);assert.deepEqual(sent.map(call=>call.at),[1000,1000]);await clock.advance(1000);assert.deepEqual(await Promise.all(queued),[0,1,2,3]);assert.deepEqual(sent.map(call=>call.at),[1000,1000,2000,2000]);assert.equal(limiter.snapshot().used,2);
});

test('the pending bound rejects excess work before dispatch and returns capacity after completion',async()=>{
  const clock=fakeClock(),limiter=gate(clock,{maxPending:1}),first=deferred();let rejectedWork=0;
  const pending=limiter.run('kiconnect',()=>first.promise);await assert.rejects(limiter.run('kiconnect',async()=>rejectedWork++),error=>error.code==='busy');assert.equal(rejectedWork,0);first.resolve('done');assert.equal(await pending,'done');assert.equal(await limiter.run('kiconnect',async()=>'next'),'next');assert.equal(clock.pending(),0);
});

test('a cancelled queued call never sends or consumes a reservation and frees its pending slot',async()=>{
  const clock=fakeClock(),limiter=gate(clock,{limit:1,windowMs:1000,maxPending:1}),controller=new AbortController(),notices=[];await fill(limiter,1);let sent=0;
  const pending=limiter.run('kiconnect',async()=>sent++,{signal:controller.signal,onWait:value=>notices.push(value)}),rejected=assert.rejects(pending,{name:'AbortError'});await flush();controller.abort();await rejected;assert.equal(sent,0);assert.equal(limiter.snapshot().used,1);assert.equal(clock.pending(),0);assert.equal(notices.at(-1),null);
  const next=limiter.run('kiconnect',async()=>'replacement');await clock.advance(1000);assert.equal(await next,'replacement');
});

test('already aborted requests cannot dispatch on either campus or other providers',async()=>{
  for(const provider of ['kiconnect','openrouter','local']){const clock=fakeClock(),limiter=gate(clock),controller=new AbortController();controller.abort();let sent=0;await assert.rejects(limiter.run(provider,async()=>sent++,{signal:controller.signal}),{name:'AbortError'});assert.equal(sent,0);assert.equal(limiter.snapshot().used,0);assert.equal(clock.pending(),0);}
});

test('a response arriving after in-flight cancellation is discarded and cannot show a slow hint',async()=>{
  const clock=fakeClock(),limiter=gate(clock),controller=new AbortController(),work=deferred(),notices=[];
  const pending=limiter.run('kiconnect',()=>work.promise,{signal:controller.signal,onWait:value=>notices.push(value)}),rejected=assert.rejects(pending,{name:'AbortError'});controller.abort();await clock.advance(16000);assert.ok(!notices.some(value=>value?.reason==='slow'));work.resolve('LATE_PRIVATE_RESULT');await rejected;assert.equal(notices.at(-1),null);assert.equal(clock.pending(),0);assert.equal(await limiter.run('kiconnect',async()=>'usable'),'usable');
});

test('a slow hint begins at fifteen seconds, does not claim a rate limit, and clears on success',async()=>{
  const clock=fakeClock(),limiter=gate(clock),work=deferred(),notices=[];const pending=limiter.run('kiconnect',()=>work.promise,{onWait:value=>notices.push(value)});await clock.advance(14999);assert.ok(!notices.some(value=>value?.reason==='slow'));await clock.advance(1);
  const slow=notices.find(value=>value?.reason==='slow');assert.deepEqual(slow,{provider:'kiconnect',reason:'slow',retryAfterMs:0,elapsedMs:15000});assert.ok(!notices.some(value=>value?.reason==='rate'));work.resolve('ready');assert.equal(await pending,'ready');assert.equal(notices.at(-1),null);assert.equal(clock.pending(),0);
});

test('the slow threshold is counted from dispatch rather than the rate-wait start',async()=>{
  const clock=fakeClock(),limiter=gate(clock,{limit:1,windowMs:1000,slowMs:500}),work=deferred(),notices=[];await fill(limiter,1);
  const pending=limiter.run('kiconnect',()=>work.promise,{onWait:value=>notices.push(value)});await clock.advance(999);assert.ok(notices.some(value=>value?.reason==='rate'));assert.ok(!notices.some(value=>value?.reason==='slow'));await clock.advance(500);assert.ok(!notices.some(value=>value?.reason==='slow'));await clock.advance(1);assert.equal(notices.find(value=>value?.reason==='slow').elapsedMs,500);work.resolve();await pending;
});

test('a failure cleans its slow timer and wait notice without retrying the submitted request',async()=>{
  const clock=fakeClock(),limiter=gate(clock),notices=[];let sent=0;const failure=new Error('Synthetic upstream failure');
  await assert.rejects(limiter.run('kiconnect',async()=>{sent++;throw failure;},{onWait:value=>notices.push(value)}),error=>error===failure);assert.equal(sent,1);assert.equal(clock.pending(),0);assert.equal(notices.at(-1),null);await clock.advance(20000);assert.ok(!notices.some(value=>value?.reason==='slow'));
});

for(const code of ['provider_limit','local_limit'])test(`${code} sets an authoritative cooldown but never retries a possibly sent request`,async()=>{
  const clock=fakeClock(),limiter=gate(clock),notices=[];let sent=0;const failure=Object.assign(new Error('Synthetic limit'),{code,status:429,retryAfterMs:5000});
  await assert.rejects(limiter.run('kiconnect',async()=>{sent++;throw failure;}),error=>error===failure);assert.equal(sent,1);assert.equal(limiter.snapshot().retryAfterMs,5000);const next=limiter.run('kiconnect',async()=>{sent++;return 'retried by caller';},{onWait:value=>notices.push(value)});await clock.advance(4999);assert.equal(sent,1);await clock.advance(1);assert.equal(await next,'retried by caller');assert.equal(sent,2);assert.ok(notices.some(value=>value?.reason==='rate'));assert.equal(notices.at(-1),null);
});

test('cooldown hints clamp unsafe retry durations to a bounded one-second to one-minute interval',async()=>{
  for(const [retryAfterMs,expected] of [[-1,1000],[0,1000],[500,1000],[5000,5000],[120000,60000],[undefined,60000],[NaN,60000],[Infinity,60000]]){
    const clock=fakeClock(),limiter=gate(clock),failure=Object.assign(new Error('Synthetic limit'),{code:'provider_limit',retryAfterMs});await assert.rejects(limiter.run('kiconnect',async()=>{throw failure;}));assert.equal(limiter.snapshot().retryAfterMs,expected);assert.equal(failure.retryAfterMs,expected);
  }
});

test('a backend busy 429 does not become a minute-rate cooldown',async()=>{
  const clock=fakeClock(),limiter=gate(clock),notices=[],failure=Object.assign(new Error('One request is active'),{code:'busy',status:429,retryAfterMs:60000});
  await assert.rejects(limiter.run('kiconnect',async()=>{throw failure;},{onWait:value=>notices.push(value)}),error=>error===failure);assert.equal(limiter.snapshot().retryAfterMs,0);assert.equal(await limiter.run('kiconnect',async()=>'immediate'),'immediate');assert.ok(!notices.some(value=>value?.reason==='rate'));
});

test('other providers bypass the campus window, cooldown, pending bound and slow timer',async()=>{
  const clock=fakeClock(),limiter=gate(clock,{limit:1,windowMs:1000,maxPending:1}),controller=new AbortController(),notices=[];await fill(limiter,1);
  const waiting=limiter.run('kiconnect',async()=>'blocked',{signal:controller.signal}),rejected=assert.rejects(waiting,{name:'AbortError'});const before=limiter.snapshot();
  for(const provider of ['openrouter','local'])assert.equal(await limiter.run(provider,async()=>provider,{onWait:value=>notices.push(value)}),provider);assert.deepEqual(limiter.snapshot(),before);assert.deepEqual(notices,[]);controller.abort();await rejected;assert.equal(clock.pending(),0);
});

test('other-provider responses that arrive after cancellation are also discarded',async()=>{
  const clock=fakeClock(),limiter=gate(clock),controller=new AbortController(),work=deferred();const pending=limiter.run('openrouter',()=>work.promise,{signal:controller.signal}),rejected=assert.rejects(pending,{name:'AbortError'});controller.abort();work.resolve('LATE_RESULT');await rejected;assert.equal(limiter.snapshot().used,0);assert.equal(clock.pending(),0);
});

test('snapshots are independent metadata and cannot mutate the reservation history',async()=>{const clock=fakeClock(),limiter=gate(clock);await fill(limiter,1);const first=limiter.snapshot();first.used=999;first.remaining=999;first.retryAfterMs=999;assert.deepEqual(limiter.snapshot(),{used:1,remaining:9,retryAfterMs:0});});

test('rate markup shows an explicit OpenRouter switch with cost and data disclosure',()=>{
  const html=renderAIWait({provider:'kiconnect',reason:'rate',retryAfterMs:1500,elapsedMs:0},{busy:true});assert.match(html,/role="status"/);assert.match(html,/etwa 2 s/);assert.match(html,/data-ki-action="switch-openrouter"/);assert.match(html,/Kein automatischer Versand/);assert.match(html,/freigegebenen Kontext/);assert.match(html,/Kosten sind möglich/);assert.doesNotMatch(html,/<script|onclick=|automatic-submit/);
});

test('slow markup states the cause is unknown and does not claim a minute limit',()=>{const html=renderAIWait({provider:'kiconnect',reason:'slow',elapsedMs:15000});assert.match(html,/15 Sekunden/);assert.match(html,/Ursache ist noch unbekannt/);assert.doesNotMatch(html,/Minutenlimit|10.*Minute/);assert.match(html,/switch-openrouter/);});

test('unsupported notices render nothing and untrusted notice fields cannot inject markup',()=>{
  for(const notice of [null,{}, {provider:'openrouter',reason:'rate'},{provider:'local',reason:'slow'},{provider:'kiconnect',reason:'<script>payload</script>'},{provider:'kiconnect<img src=x>',reason:'rate'}])assert.equal(renderAIWait(notice),'');
  const html=renderAIWait({provider:'kiconnect',reason:'rate',retryAfterMs:'<img src=x onerror=payload()>',elapsedMs:'<script>payload</script>',message:'<script>PRIVATE_UNTRUSTED</script>'},{busy:true});assert.doesNotMatch(html,/<img|<script|onerror=|PRIVATE_UNTRUSTED/);assert.ok((html.match(/<button /g)||[]).length===1);
});
