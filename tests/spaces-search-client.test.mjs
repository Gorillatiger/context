import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpacesSearchClient} from '../dist/spaces-search-client.js';
import {spacesSearchCourseURL} from '../dist/spaces-search-policy.js';
import {createSpacesSearchIPC} from '../desktop/spaces-search-ipc.mjs';

const root='https://spaces.th-koeln.de/course/',id='b:spaces-rest:'+'a'.repeat(64),revision='b'.repeat(64);
const project={id:'course',name:'Kurs',links:[{tool:'spaces',url:root}]};
const item={id,title:'Miro',url:root+'board/',projectId:'course',status:'metadata',text:''};
const search={items:[item],page:1,hasMore:false,total:1,totalPages:1};
function setup(transport){const state={projects:[project]};return {state,client:createSpacesSearchClient({getWorkspace:()=>state,transport})};}
test('query calls direct transport, does not need an index and cannot pass secrets to UI',async()=>{
  const calls=[],{client}=setup(async m=>{calls.push(m);return {...search,nonce:'secret',items:[{...item,nonce:'secret'}]};});
  const result=await client.search({query:'Miro'});assert.equal(result.items.length,1);assert.equal(calls[0].op,'search');assert.equal(calls[0].courseURL,root);assert(!JSON.stringify(result).includes('secret'));client.dispose();
});
test('read requires current offered ID, URL and matching revision',async()=>{
  let changed=false;const {client}=setup(async m=>m.op==='search'?search:{...item,text:'Aufgabe',status:'full',revision:changed?'c'.repeat(64):revision,offset:0,hasMore:false,nextOffset:null});
  await assert.rejects(client.read({projectId:'course',id}),/zuerst/);await client.searchCourse({projectId:'course',query:'Miro'});assert.equal((await client.read({projectId:'course',id})).text,'Aufgabe');changed=true;await assert.rejects(client.read({projectId:'course',id,expectedRevision:revision}),/sicher/);client.dispose();
});
test('course archive and auth invalidation remove old read authority',async()=>{
  const {client,state}=setup(async()=>search);await client.searchCourse({projectId:'course',query:'Miro'});client.invalidate();await assert.rejects(client.read({projectId:'course',id}),/zuerst/);state.projects=[{...project,archived:true}];await assert.rejects(client.searchCourse({projectId:'course',query:'Miro'}),/freigegeben/);client.dispose();
});
test('federated failures remain visible, with successful courses and honest hasMore',async()=>{
  const {client,state}=setup(async m=>{if(m.projectId==='other')throw new Error('Anmeldung nötig');return {...search,hasMore:true};});state.projects.push({...project,id:'other',name:'Anderer Kurs',links:[{tool:'spaces',url:'https://spaces.th-koeln.de/other/'}]});
  const r=await client.search({query:'Miro'});assert.equal(r.items.length,1);assert.equal(r.hasMore,true);assert.equal(r.courses[1].status,'error');assert.match(r.warnings[0],/Anmeldung/);client.dispose();
});
test('spaces roots reject query/hash/admin/foreign roots and normalize pathname only',()=>{
  assert.equal(spacesSearchCourseURL(root.slice(0,-1)),root);
  for(const value of [root+'?paged=2',root+'#section','https://evil.test/course/','https://spaces.th-koeln.de/wp-admin/'])assert.throws(()=>spacesSearchCourseURL(value));
});
test('native cancellation aborts the right job and late results are discarded',async()=>{
  let finish,signal;const service={handle:async(_m,o)=>{signal=o.signal;return new Promise(r=>finish=r);},invalidate(){},dispose(){}};const ipc=createSpacesSearchIPC(service),requestId=crypto.randomUUID();
  const pending=ipc.handle({op:'search',requestId,query:'Miro'});await ipc.handle({op:'cancel',requestId});assert(signal.aborted);finish(search);await assert.rejects(pending,{name:'AbortError'});ipc.dispose();
});
test('native boundary rejects absent UUID, duplicate jobs and extra cancel fields',async()=>{
  const ipc=createSpacesSearchIPC({handle:async()=>search,invalidate(){},dispose(){}});
  await assert.rejects(ipc.handle({op:'search'}));await assert.rejects(ipc.handle({op:'cancel',requestId:crypto.randomUUID(),cookie:'x'}));ipc.dispose();await assert.rejects(ipc.handle({op:'search',requestId:crypto.randomUUID()}));
});
test('read preserves only observed, revision-bound platform links from the offered post',async()=>{
  const link={service:'miro',url:'https://miro.com/app/board/uXjVTest=/',title:'Workshop',sourceURL:item.url,postedBy:'Dozentin',postedAt:'2026-10-14T08:00:00Z'};
  const {client}=setup(async m=>m.op==='search'?search:{...item,text:'Aufgabe',status:'full',revision,contentRevision:revision,offset:0,hasMore:false,platformLinks:[link,{...link,sourceURL:root+'foreign/'},{...link,url:'https://evil.test/private/',nonce:'secret'}]});
  await client.searchCourse({projectId:'course',query:'Miro'});const d=await client.read({projectId:'course',id});assert.equal(d.courseURL,root);assert.equal(d.contentRevision,revision);assert.equal(d.platformLinks.length,1);assert.equal(d.platformLinks[0].postedBy,'Dozentin');assert(!JSON.stringify(d).includes('secret'));client.dispose();
});
test('link metadata without the confirmed read revision cannot register new sources',async()=>{
  const {client}=setup(async m=>m.op==='search'?search:{...item,text:'Aufgabe',status:'full',revision,contentRevision:'c'.repeat(64),offset:0,hasMore:false,platformLinks:[{service:'miro',url:'https://miro.com/app/board/uXjVTest=/',sourceURL:item.url}]});await client.searchCourse({projectId:'course',query:'Miro'});const d=await client.read({projectId:'course',id});assert.equal(d.platformLinks,undefined);client.dispose();
});
