import test from 'node:test';
import assert from 'node:assert/strict';
import {createAIUsage,usageSummary,renderUsagePanel} from '../dist/ai-usage.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const key=(remaining=5)=>({provider:'openrouter',status:'available',checkedAt:'2026-10-14T12:00:00Z',keyBudget:{limit:10,remaining,resetInterval:'monthly'}});

test('USD remaining is distinguished from tokens, unknown and explicitly unset key cap',()=>{
  assert.match(usageSummary({provider:'openrouter',value:key(0)}).text,/0,00 US\$ Restbudget/);
  assert.equal(usageSummary({provider:'openrouter',value:key(0)}).warning,true);
  assert.equal(usageSummary({provider:'openrouter',value:{provider:'openrouter',status:'unknown'}}).text,'Limit unbekannt');
  assert.equal(usageSummary({provider:'openrouter',value:{keyLimitUnset:true}}).text,'Kein Schlüssellimit');
  assert.equal(usageSummary({provider:'local',value:{status:'not_applicable'}}).text,'Kein Cloud-Limit');
});
test('free counter is used only for a selected free variant, effective budget takes precedence for paid models',()=>{
  const value={...key(),effectiveBudget:{limit:50,remaining:3,used:47,resetInterval:'weekly',resetsAt:null},freeRequests:{used:12,limit:50,remaining:38}};
  assert.match(usageSummary({provider:'openrouter',value,model:'model:free'}).text,/38 \/ 50 frei/);
  assert.match(usageSummary({provider:'openrouter',value,model:'paid/model'}).text,/3,00 US\$/);
  assert.match(renderUsagePanel({provider:'openrouter',value}),/Kein|kein Kontoguthaben/);
});
test('unknown and unset limits never get a made-up progress meter',()=>{
  for(const provider of ['kiconnect','local','openrouter'])for(const value of [null,{status:'unknown'},{keyLimitUnset:true}])assert.doesNotMatch(renderUsagePanel({provider,value}),/<meter/);
  const html=renderUsagePanel({provider:'openrouter',value:key(-5)});assert.match(html,/value="0"/);assert.match(html,/0,00 US\$/);
});
test('malformed numbers and metadata cannot create amounts, raw labels or unsafe markup',()=>{
  const html=renderUsagePanel({provider:'openrouter',value:{label:'SECRET',hash:'PRIVATE',keyBudget:{limit:Infinity,remaining:'5'},spend:{daily:NaN},freeRequests:{limit:5,used:1,remaining:9}},error:'<script>x</script>'});
  assert.doesNotMatch(html,/SECRET|PRIVATE|Infinity|NaN|<script>/);assert.match(html,/&lt;script&gt;/);
  assert.equal(usageSummary({provider:'openrouter',value:{keyBudget:{limit:NaN,remaining:0}}}).text,'Limit unbekannt');
});
test('refresh passes only fixed provider, usage and a cancellable signal',async()=>{
  const calls=[];const usage=createAIUsage({provider:'openrouter',request:async(...args)=>{calls.push(args);return key();}});
  await usage.refresh();assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,2),['openrouter','usage']);assert(calls[0][2].signal instanceof AbortSignal);assert.equal(usage.state.loading,false);assert.equal(usage.state.value.keyBudget.remaining,5);
  const html=usage.trigger('paid/model',true);assert.match(html,/aria-expanded="true"/);assert.match(html,/aria-label="Nutzung und Limit:/);assert.match(usage.panel(true),/role="dialog"/);
});
test('A to B to A discards first A response and its late finally',async()=>{
  const calls=[];const usage=createAIUsage({provider:'openrouter',request:(provider,_action,{signal})=>{const row={provider,signal,...deferred()};calls.push(row);return row.promise;}});
  const first=usage.refresh();usage.reset('kiconnect');const second=usage.refresh();usage.reset('openrouter');const third=usage.refresh();
  assert.equal(calls[0].signal.aborted,true);assert.equal(calls[1].signal.aborted,true);
  calls[0].resolve(key(1));await first;assert.equal(usage.state.loading,true);assert.equal(usage.state.value,null);
  calls[2].resolve(key(7));await third;calls[1].reject(new Error('SECRET'));await second;assert.equal(usage.state.loading,false);assert.equal(usage.state.value.keyBudget.remaining,7);assert.equal(usage.state.error,'');
});
test('same provider reconnect invalidates old quota and its pending response',async()=>{
  const waiting=deferred();const usage=createAIUsage({provider:'openrouter',request:()=>waiting.promise});const pending=usage.refresh();usage.reset('openrouter');waiting.resolve(key());await pending;assert.equal(usage.state.value,null);assert.equal(usage.state.loading,false);
});
test('a superseded refresh cannot overwrite newer values or stop its loading state',async()=>{
  const first=deferred(),second=deferred();let calls=0;const usage=createAIUsage({provider:'openrouter',request:()=>++calls===1?first.promise:second.promise});const a=usage.refresh(),b=usage.refresh();first.reject(new Error('failed old request'));await a;assert.equal(usage.state.loading,true);assert.equal(usage.state.error,'');second.resolve(key(9));await b;assert.equal(usage.state.value.keyBudget.remaining,9);
});
test('wrong provider data and errors stay separate from the chat and do not leak provider error bodies',async()=>{
  const usage=createAIUsage({provider:'kiconnect',request:async()=>key()});await usage.refresh();assert.deepEqual(usage.state.value,{provider:'kiconnect',status:'unknown'});
  const failed=createAIUsage({provider:'openrouter',request:async()=>{throw new Error('Authorization: Bearer PRIVATE');}});await failed.refresh();assert.equal(failed.state.value,null);assert.doesNotMatch(failed.state.error,/PRIVATE|Bearer/);assert.equal(usageSummary(failed.state).text,'Limit nicht abrufbar');
});
test('dispose aborts pending work and ignores late values and notifications',async()=>{
  let signal,paints=0;const waiting=deferred(),usage=createAIUsage({provider:'openrouter',onChange:()=>paints++,request:(_provider,_action,options)=>{signal=options.signal;return waiting.promise;}});const pending=usage.refresh();const before=paints;usage.dispose();assert.equal(signal.aborted,true);waiting.resolve(key());await pending;assert.equal(usage.state.value,null);assert.equal(paints,before);await usage.refresh();assert.equal(paints,before);
});
