import test from 'node:test';
import assert from 'node:assert/strict';
import {scanBoardSpaces} from '../dist/board-scan.js';
const base='https://spaces.th-koeln.de',course=(id='course')=>({id,name:id,links:[{tool:'spaces',url:base+'/'+id+'/'}]}),page=(url,extra={})=>({url,title:'Kurs',boardLinks:[],links:[],controls:[],...extra});
test('board crawler retains home and orga links, rejects outsiders, and uses dedicated reusable scanner',async()=>{
 const calls=[],saved=[];const p=course(),result=await scanBoardSpaces({projects:[p],onFindings:f=>saved.push(...f),request:async command=>{
  calls.push(command);assert.equal(command.scan,true);
  if(command.command==='click')return page(base+'/course/',{boardLinks:[{url:'https://miro.com/app/board/orgaaa/',title:'Orga-Board',postedBy:'Anna',postedAt:'2026-10-12T10:00:00Z'}],links:[{url:base+'/course/orga/'}]});
  if(command.url===base+'/course/')return page(command.url,{controls:[{id:'secondary-swap-menu-label',title:'Orga'}],links:[{url:base+'/course/home/'},{url:base+'/elsewhere/'},{url:base+'/course/members/'},{url:'https://evil.test/'}]});
  return page(command.url,{boardLinks:[{url:'https://miro.com/app/board/abcd/',title:'Arbeitsboard'}]});
 }});
 assert.equal(result.coverage[0].status,'read');assert.ok(calls.some(c=>c.url===base+'/course/home/'));assert.ok(calls.some(c=>c.url===base+'/course/orga/'));assert.ok(calls.every(c=>!c.url||c.url.startsWith(base+'/course/')));assert.equal(saved.find(f=>f.title==='Orga-Board').postedBy,'Anna');
});
test('bounded search resumes the actual remaining queue, not the first pages',async()=>{
 const sessions=new Map(),calls=[],request=async c=>{calls.push(c);return page(c.url,c.url===base+'/course/'?{links:[{url:base+'/course/one/'},{url:base+'/course/two/'}]}:{});};
 const first=await scanBoardSpaces({projects:[course()],request,sessions,maxPages:1});assert.equal(first.coverage[0].status,'partial');
 const second=await scanBoardSpaces({projects:[course()],request,sessions,maxPages:1});assert.equal(calls[1].url,base+'/course/one/');assert.equal(second.coverage[0].status,'partial');
 const third=await scanBoardSpaces({projects:[course()],request,sessions,maxPages:1});assert.equal(calls[2].url,base+'/course/two/');assert.equal(third.coverage[0].status,'read');
});
test('cancel, login, legacy app and cross-course redirects leave queue retryable',async()=>{
 const cancelled=new AbortController();cancelled.abort();let called=0;const early=await scanBoardSpaces({projects:[course()],signal:cancelled.signal,request:async()=>called++});assert.equal(called,0);assert.equal(early.interrupted,true);
 for(const [response,status] of [[{loginRequired:true},'login_required'],[{url:base+'/course/',links:[]},'update_required'],[page(base+'/other/'),'error']]){const sessions=new Map(),r=await scanBoardSpaces({projects:[course()],sessions,request:async()=>response});assert.equal(r.coverage[0].status,status);assert.equal(sessions.get('course').queue.length,1);assert.equal(r.findings.length,0);}
});
test('storage failure and abort during request do not lose already queued work',async()=>{
 const sessions=new Map(),r=await scanBoardSpaces({projects:[course()],sessions,onFindings:()=>{throw new Error('Disk full');},request:async c=>page(c.url,{boardLinks:[{url:'https://miro.com/app/board/abcd/'}]})});assert.equal(r.coverage[0].status,'error');assert.equal(sessions.get('course').seen.size,0);assert.equal(r.findings.length,0);
 const abort=new AbortController(),r2=await scanBoardSpaces({projects:[course()],signal:abort.signal,request:async c=>{abort.abort();return page(c.url);}});assert.equal(r2.interrupted,true);assert.equal(r2.findings.length,0);
});
test('unsupported controls and harmful board provenance never get attributed',async()=>{
 const calls=[],r=await scanBoardSpaces({projects:[course()],request:async c=>{calls.push(c);return page(c.url,{controls:[{id:'post-create',title:'Create'}],boardLinks:[{url:'https://miro.com/app/board/abcd/',sourceURL:base+'/another-course/'},{url:'https://evil.test/app/board/abcd/'},{url:'https://miro.com/app/board/goodboard/',sourceURL:base+'/course/'}]});}});assert.equal(calls.length,1);assert.equal(r.findings.length,1);assert.match(r.findings[0].url,/goodboard/);
});
test('nested Orga accordions replay their parent view before reading the child',async()=>{
 let view='home';const calls=[];const request=async c=>{calls.push(c);if(c.command==='start')view='home';else if(c.controlId==='secondary-swap-menu-label')view='orga';else if(c.controlId==='accordion-item-detail')view='detail';
 return page(base+'/course/',view==='home'?{controls:[{id:'secondary-swap-menu-label'}]}:view==='orga'?{controls:[{id:'accordion-item-detail'}]}:{boardLinks:[{url:'https://miro.com/app/board/detailboard/',title:'Detailboard'}]});};
 const r=await scanBoardSpaces({projects:[course()],request});assert.equal(r.coverage[0].status,'read');assert.equal(r.findings.length,1);assert.deepEqual(calls.map(c=>c.command==='click'?c.controlId:c.command),['start','start','secondary-swap-menu-label','start','secondary-swap-menu-label','accordion-item-detail']);
});
test('long permalinks retain their complete source URL through a bounded hashed source identifier',async()=>{const url=base+'/course/'+('long-slug-'.repeat(25))+'/',r=await scanBoardSpaces({projects:[{...course(),links:[{tool:'spaces',url}]}],request:async c=>page(c.url,{boardLinks:[{url:'https://miro.com/app/board/longboard/',sourceURL:url}]})});assert.equal(r.findings.length,1);assert.equal(r.findings[0].sourceURL,url);assert.ok(r.findings[0].sourceId.length<200);});
test('nested-view depth limits are reported as partial coverage, not complete',async()=>{let level=0;const r=await scanBoardSpaces({projects:[course()],request:async c=>{if(c.command==='start')level=0;else level++;return page(base+'/course/',{controls:[{id:'accordion-item-level'+level}]});}});assert.equal(r.coverage[0].status,'partial');assert.match(r.coverage[0].message,/Begrenzung/);});
test('a course with many links cannot consume the other courses scan budget',async()=>{const calls=[],r=await scanBoardSpaces({projects:[course('one'),course('two'),course('three')],maxPages:6,request:async c=>{calls.push(c.url);return page(c.url,{links:Array.from({length:10},(_,i)=>({url:c.url+'detail'+i+'/'}))});}});assert.equal(r.pages,6);assert.deepEqual(r.coverage.map(c=>c.pages),[2,2,2]);assert.ok(calls.includes(base+'/three/'));assert.ok(r.coverage.every(c=>c.status==='partial'));});

test('AI can reorder only opaque observed jobs and receives no URL, body or control ID',async()=>{
 const calls=[],packets=[],request=async c=>{calls.push(c);return page(c.url,c.url===base+'/course/'?{text:'A private course body',links:[{url:base+'/course/one/',title:'Aktuelles'},{url:base+'/course/two/',title:'Ressourcen'}]}:{});};
 const r=await scanBoardSpaces({projects:[course()],maxPages:2,request,prioritize:async packet=>{packets.push(packet);return ['v1','v0'];}});
 assert.equal(r.pages,2);assert.equal(calls[1].url,base+'/course/two/');assert.deepEqual(Object.keys(packets[0]),['projectId','projectTitle','pageTitle','visited','candidates']);
 assert.deepEqual(packets[0].candidates.map(c=>c.id),['v0','v1']);assert.ok(!JSON.stringify(packets).includes(base));assert.ok(!JSON.stringify(packets).includes('A private course body'));assert.ok(packets[0].candidates.every(c=>!Object.hasOwn(c,'url')&&!Object.hasOwn(c,'controls')));
});

for(const [label,reply] of [['invented ID',['v1','unobserved']],['injected URL',['https://evil.test/']],['injected control',['post-create']],['duplicated ranking',['v1','v1']],['new command',{command:'start',url:'https://evil.test/'}]])test(`AI ${label} cannot change or expand the queue`,async()=>{
 const calls=[],r=await scanBoardSpaces({projects:[course()],maxPages:2,prioritize:async()=>reply,request:async c=>{calls.push(c);return page(c.url,c.url===base+'/course/'?{links:[{url:base+'/course/one/'},{url:base+'/course/two/'}]}:{});}});
 assert.equal(r.pages,2);assert.equal(calls[1].url,base+'/course/one/');assert.ok(calls.every(c=>c.command==='start'&&c.url.startsWith(base+'/course/')));
});

test('an interrupted AI ranking keeps observed findings and resumes unread jobs',async()=>{
 const sessions=new Map(),calls=[],saved=[],request=async c=>{calls.push(c.url);return page(c.url,c.url===base+'/course/'?{boardLinks:[{url:'https://miro.com/app/board/rootboard/'}],links:[{url:base+'/course/one/'},{url:base+'/course/two/'}]}:{});};
 const first=await scanBoardSpaces({projects:[course()],sessions,request,onFindings:rows=>saved.push(...rows),prioritize:async()=>{throw new DOMException('Provider changed','AbortError');}});
 assert.equal(first.interrupted,true);assert.equal(saved.length,1);assert.equal(first.findings.length,1);assert.equal(sessions.get('course').seen.size,1);assert.equal(sessions.get('course').queue[0].url,base+'/course/one/');
 const second=await scanBoardSpaces({projects:[course()],sessions,request});assert.equal(second.coverage[0].status,'read');assert.deepEqual(calls,[base+'/course/',base+'/course/one/',base+'/course/two/']);
});

test('provider-change interruption stops all later courses without spending their browser budget',async()=>{
 const calls=[],r=await scanBoardSpaces({projects:[course('one'),course('two')],request:async c=>{calls.push(c.url);return page(c.url,{links:[{url:c.url+'details/'},{url:c.url+'orga/'}]});},prioritize:async()=>{throw new DOMException('Provider changed','AbortError');}});
 assert.equal(r.interrupted,true);assert.equal(calls.length,1);assert.equal(r.coverage[1].pages,0);
});

test('nested Orga resources are read before a long post archive within a small course quota',async()=>{
 let view='home';const calls=[],posts=Array.from({length:50},(_,i)=>({url:base+'/course/post'+i+'/',title:'Beitrag '+i}));
 const r=await scanBoardSpaces({projects:[course()],maxPages:3,request:async c=>{calls.push(c);if(c.command==='start')view='home';else if(c.controlId==='secondary-swap-menu-label')view='orga';else if(c.controlId==='accordion-item-resources')view='resources';
  return page(base+'/course/',view==='home'?{controls:[{id:'secondary-swap-menu-label',title:'Orga'}],links:posts.slice(0,45)}:view==='orga'?{controls:[{id:'accordion-item-resources',title:'Ressourcen'}]}:{boardLinks:[{url:'https://miro.com/app/board/resourceboard/',title:'Workshop-Board'}]});},prioritize:async({candidates})=>candidates.filter(c=>c.kind==='section').map(c=>c.id)});
 assert.equal(r.pages,3);assert.equal(r.findings.length,1);assert.equal(r.findings[0].title,'Workshop-Board');assert.equal(r.coverage[0].status,'partial');assert.ok(calls.every(c=>!c.url||c.url===base+'/course/'));assert.deepEqual(calls.filter(c=>c.command==='click').map(c=>c.controlId),['secondary-swap-menu-label','secondary-swap-menu-label','accordion-item-resources']);
});
