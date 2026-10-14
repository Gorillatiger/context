import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoardPrioritizer} from '../dist/board-ai.js';

const candidates=[{id:'choice_1',title:'Home',kind:'page',depth:0},{id:'choice_2',title:'Orga und Ressourcen',kind:'section',depth:1}];
const input=(projectId='course')=>({projectId,projectTitle:'Prototyping Things',pageTitle:'Kurs',candidates,visited:1});
const create=options=>createBoardPrioritizer({provider:'local',model:'local-model',...options});

test('accepts only an offered ID order and sends no board metadata or page body',async()=>{
  const steps=[],calls=[];const prioritize=create({onStep:s=>steps.push(s),request:async(...args)=>{calls.push(args);return {content:'{"order":["choice_2","choice_1"]}'};}});
  assert.deepEqual(await prioritize({...input(),url:'https://private.test/',text:'Secret body',postedBy:'Ignored author'}),['choice_2','choice_1']);
  assert.equal(calls.length,1);assert.equal(calls[0][0].model,'local-model');assert.deepEqual(Object.keys(calls[0][0]),['model','messages']);
  const packet=JSON.parse(calls[0][0].messages[1].content);assert.deepEqual(Object.keys(packet),['goal','course','currentPage','visited','candidates']);
  assert.ok(!JSON.stringify(calls).includes('Secret body'));assert.ok(!JSON.stringify(calls).includes('Ignored author'));assert.ok(!JSON.stringify(calls).includes('private.test'));
  assert.deepEqual(steps.map(s=>s.status),['working','ranked']);assert.deepEqual(steps[1].rankedIds,['choice_2','choice_1']);
});

test('redacts secrets and removes URLs from the user goal and all labels',async()=>{
  let packet;const key='ghp_'+('a'.repeat(30));const prioritize=create({goal:`Find boards https://private.test/?token=secret ${key}`,request:async body=>{packet=JSON.parse(body.messages[1].content);return {content:'{"order":["choice_2"]}'};}});
  await prioritize({...input(),projectTitle:'Campus https://spaces.th-koeln.de/course/?password=private',pageTitle:'Orga mailto:person@example.test',candidates:[{...candidates[0],title:'API key: secret'}, {...candidates[1],title:'Board www.miro.com/secret //private.test/hidden spaces.th-koeln.de/details/'}]});
  const serialized=JSON.stringify(packet);assert.ok(!serialized.includes(key));assert.ok(!serialized.includes('secret'));assert.ok(!serialized.includes('password=private'));assert.ok(!serialized.includes('person@example.test'));assert.ok(!serialized.includes('private.test'));assert.ok(!serialized.includes('miro.com'));assert.ok(!serialized.includes('spaces.th-koeln.de'));
});

test('bounds labels, depth, visited count and drops unrecognized candidate fields',async()=>{
  let packet;const prioritize=create({goal:'g'.repeat(500),request:async body=>{packet=JSON.parse(body.messages[1].content);return {content:'{"order":["choice_1"]}'};}});
  await prioritize({...input(),projectTitle:'c'.repeat(500),pageTitle:'p'.repeat(500),visited:999,candidates:[{...candidates[0],depth:99,title:'a'.repeat(500),url:'https://private.test/'},{...candidates[1],kind:'send-mail',depth:-2}]});
  assert.equal(packet.goal.length,240);assert.equal(packet.course.length,160);assert.equal(packet.currentPage.length,160);assert.equal(packet.visited,120);assert.equal(packet.candidates[0].title.length,160);assert.equal(packet.candidates[0].depth,4);assert.equal(packet.candidates[1].depth,0);assert.equal(packet.candidates[1].kind,'page');assert.ok(!Object.hasOwn(packet.candidates[0],'url'));
});

for(const [label,content] of [
  ['invented ID','{"order":["unobserved"]}'],
  ['duplicate IDs','{"order":["choice_1","choice_1"]}'],
  ['extra fields','{"order":["choice_1"],"url":"https://evil.test/"}'],
  ['arbitrary reasoning','{"order":["choice_1"],"reason":"Arbitrary private text"}'],
  ['Markdown wrapper','```json\n{"order":["choice_1"]}\n```'],
  ['numeric ID','{"order":[1]}'],
  ['wrong shape','[{"order":["choice_1"]}]'],
  ['empty answer',''],
  ['too large answer',' '.repeat(4097)],
])test(`invalid ${label} uses an explicit, generic FIFO fallback`,async()=>{
  const steps=[],prioritize=create({onStep:s=>steps.push(s),request:async()=>({content})});assert.deepEqual(await prioritize(input()),[]);assert.equal(steps.at(-1).status,'fallback');if(content)assert.ok(!steps.at(-1).message.includes(content));assert.ok(!Object.hasOwn(steps.at(-1),'reason'));
});

test('an empty valid order is reported as a normal-search fallback',async()=>{const steps=[],prioritize=create({onStep:s=>steps.push(s),request:async()=>({content:'{"order":[]}'})});assert.deepEqual(await prioritize(input()),[]);assert.equal(steps.at(-1).status,'fallback');});

test('a provider failure cannot expose its message or trigger another provider',async()=>{let calls=0;const steps=[],prioritize=create({onStep:s=>steps.push(s),request:async()=>{calls++;throw new Error('Authorization: secret-token https://private.test/');}});assert.deepEqual(await prioritize(input()),[]);assert.equal(calls,1);assert.equal(steps.at(-1).status,'fallback');assert.ok(!JSON.stringify(steps).includes('secret-token'));assert.ok(!JSON.stringify(steps).includes('private.test'));});

test('only one attempt per course leaves capacity for other courses, including after invalid responses',async()=>{let calls=0;const prioritize=create({request:async()=>{calls++;return {content:'malformed'};}});await prioritize(input());await prioritize(input());await prioritize(input('another'));assert.equal(calls,2);});

test('global budget is bounded and each excluded course receives only one limit notice',async()=>{let calls=0;const steps=[],prioritize=create({maxCalls:2,onStep:s=>steps.push(s),request:async()=>{calls++;return {content:'{"order":["choice_2"]}'};}});for(const id of ['one','two','three','three','four'])await prioritize(input(id));assert.equal(calls,2);assert.deepEqual(steps.filter(s=>s.status==='limited').map(s=>s.projectId),['three','four']);});

test('a course with one candidate does not spend its later ranking allowance',async()=>{let calls=0;const prioritize=create({request:async()=>{calls++;return {content:'{"order":["choice_1"]}'};}});assert.deepEqual(await prioritize({...input(),candidates:[candidates[0]]}),[]);await prioritize(input());assert.equal(calls,1);});

test('invalid or too many candidate IDs never enter an AI request',async()=>{let calls=0;const prioritize=create({request:async()=>{calls++;return {content:'{"order":[]}'};}});for(const rows of [[{id:'https://evil.test/'},candidates[0]],[{id:'a'.repeat(41)},candidates[0]],[candidates[0],candidates[0]],Array.from({length:21},(_,i)=>({id:'id_'+i}))])assert.deepEqual(await prioritize({...input(),candidates:rows}),[]);assert.equal(calls,0);});

test('already aborted search cannot call the provider',async()=>{let calls=0;const controller=new AbortController();controller.abort();const prioritize=create({signal:controller.signal,request:async()=>{calls++;}});await assert.rejects(prioritize(input()),{name:'AbortError'});assert.equal(calls,0);});

test('cancelling an in-flight search discards the returned ranking',async()=>{const controller=new AbortController(),steps=[];const prioritize=create({signal:controller.signal,onStep:s=>steps.push(s),request:async()=>{controller.abort();return {content:'{"order":["choice_1"]}'};}});await assert.rejects(prioritize(input()),{name:'AbortError'});assert.deepEqual(steps.map(s=>s.status),['working']);});

test('a changed provider or model throws before and after the request instead of silently continuing',async()=>{let current=false,calls=0;const before=create({isCurrent:()=>current,request:async()=>{calls++;}});await assert.rejects(before(input()),{name:'AbortError'});assert.equal(calls,0);current=true;const steps=[],after=create({isCurrent:()=>current,onStep:s=>steps.push(s),request:async()=>{current=false;return {content:'{"order":["choice_1"]}'};}});await assert.rejects(after(input()),{name:'AbortError'});assert.deepEqual(steps.map(s=>s.status),['working']);});

test('provider aborts are rethrown as a safe interruption rather than a fallback',async()=>{const steps=[],prioritize=create({onStep:s=>steps.push(s),request:async()=>{throw new DOMException('secret-token','AbortError');}});await assert.rejects(prioritize(input()),e=>e.name==='AbortError'&&!e.message.includes('secret-token'));assert.deepEqual(steps.map(s=>s.status),['working']);});

test('constructor rejects invalid provider, model, request and unsafe call budgets',()=>{for(const options of [{provider:'other'},{model:''},{model:'a'.repeat(241)},{request:1},{maxCalls:-1},{maxCalls:9},{maxCalls:1.5}])assert.throws(()=>create(options));});

test('zero budget explicitly disables AI without sending labels',async()=>{let calls=0;const steps=[],prioritize=create({maxCalls:0,onStep:s=>steps.push(s),request:async()=>calls++});assert.deepEqual(await prioritize(input()),[]);assert.equal(calls,0);assert.equal(steps[0].status,'limited');});
