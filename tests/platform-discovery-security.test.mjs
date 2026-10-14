import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformDiscovery,pagePlatformDiscovery,discoveryCourse} from '../dist/platform-discovery.js';
import {platformCatalog} from '../dist/source-catalog.js';
const COURSE='https://spaces.th-koeln.de/synthetic-course/',PAGE=COURSE+'orga/resources/',REPO='https://git.coco.study/course/robotics',HASH='a'.repeat(64),NOW='2026-10-14T12:00:00Z';
const workspace=()=>({projects:[{id:'course1',name:'Robotik',links:[{tool:'spaces',url:COURSE}]}],platformFindings:[]});
const page=patch=>({url:PAGE,title:'Material',text:'Ressourcen',contentRevision:HASH,platformLinks:[{service:'gitlab',url:REPO,title:'Aufgabe',sourceURL:PAGE}],platformLinksMore:false,...patch});
function fixture({save,catalog}={}){const f={workspace:workspace(),saves:[],catalogs:0};f.api=createPlatformDiscovery({getWorkspace:()=>f.workspace,now:NOW,onSave:async(rows,context)=>{f.saves.push({rows,context});if(save)return save(rows,context,f);f.workspace={...f.workspace,platformFindings:rows};return true;},onCatalog:async()=>{f.catalogs++;await catalog?.(f);}});return f;}

test('discovery registers a genuine read link only after its provenance save and returns no remote content claim',async()=>{
  const order=[],f=fixture({save:(rows,context,state)=>{order.push('saved');state.workspace={...state.workspace,platformFindings:rows};return true;},catalog:()=>order.push('registry')});const result=await f.api.discover(page(),{projectId:'course1',courseURL:COURSE});assert.deepEqual(order,['saved','registry']);assert.equal(result.sources.length,1);assert.equal(result.sources[0].url,REPO);assert.equal(result.sources[0].projectId,'course1');assert.equal(result.added,1);assert.equal(result.text,undefined);
});

test('standalone global blogs and ambiguous course roots cannot infer a course grant',()=>{
  const state=workspace();assert.equal(discoveryCourse(page({url:'https://spaces.th-koeln.de/blog/global-post/'}),{workspace:state}),null);state.projects.push({...state.projects[0],id:'course2'});assert.equal(discoveryCourse(page(),{workspace:state}),null);assert.throws(()=>discoveryCourse(page(),{workspace:state,projectId:'missing',courseURL:COURSE}));
});

test('blocked pages, missing revisions and untrusted source URLs cannot produce grant persistence or registry work',async()=>{
  for(const patch of [{loginRequired:true},{permissionRequired:true},{accessDenied:true},{navigationBlocked:true},{contentRevision:'invalid'},{url:'https://spaces.th-koeln.de/other-course/'}]){const f=fixture();try{await f.api.discover(page(patch),{projectId:'course1',courseURL:COURSE});}catch{}assert.equal(f.saves.length,0);assert.equal(f.catalogs,0);}
  assert.equal(pagePlatformDiscovery(page({platformLinks:[{service:'gitlab',url:REPO,sourceURL:'https://evil.test/'}]}),{workspace:workspace(),projectId:'course1',courseURL:COURSE}).findings.length,0);
});

test('failed or unconfirmed saves never register native access scopes',async()=>{
  for(const save of [()=>false,()=>true]){const f=fixture({save});await assert.rejects(f.api.discover(page(),{projectId:'course1',courseURL:COURSE}));assert.equal(f.catalogs,0);assert.equal(platformCatalog(f.workspace).length,0);}
});

test('cancellation before a save does no work; cancellation after persistence prevents further registry and source delivery',async()=>{
  const before=new AbortController();before.abort();const first=fixture();await assert.rejects(first.api.discover(page(),{projectId:'course1',signal:before.signal}),error=>error.name==='AbortError');assert.equal(first.saves.length,0);
  const after=new AbortController(),second=fixture({save:(rows,context,state)=>{state.workspace={...state.workspace,platformFindings:rows};after.abort();return true;}});await assert.rejects(second.api.discover(page(),{projectId:'course1',courseURL:COURSE,signal:after.signal}),error=>error.name==='AbortError');assert.equal(second.saves.length,1);assert.equal(second.catalogs,0);
});

test('a relink during persistence revokes the discovered grant before native registration',async()=>{
  const f=fixture({save:(rows,context,state)=>{state.workspace={...state.workspace,platformFindings:rows,projects:[{...state.workspace.projects[0],links:[{tool:'spaces',url:'https://spaces.th-koeln.de/relinked-course/'}]}]};return true;}});await assert.rejects(f.api.discover(page(),{projectId:'course1',courseURL:COURSE}),/gewählten Kurs/);assert.equal(f.catalogs,0);assert.equal(platformCatalog(f.workspace).length,0);
});

test('a relink or archive while native registry is finishing prevents delivery of newly discovered source IDs',async()=>{
  for(const mutate of [state=>state.projects[0].archived=true,state=>state.projects[0].links[0].url='https://spaces.th-koeln.de/new-course/']){const f=fixture({catalog:state=>mutate(state.workspace)});await assert.rejects(f.api.discover(page(),{projectId:'course1',courseURL:COURSE}),/gewählten Kurs/);assert.equal(f.catalogs,1);assert.equal(platformCatalog(f.workspace).length,0);}
});

test('duplicate discovery keeps one grant and first discovery time; reported discovery caps stay explicitly incomplete',async()=>{
  const f=fixture(),first=await f.api.discover(page({platformLinksMore:true}),{projectId:'course1',courseURL:COURSE}),second=await f.api.discover(page(),{projectId:'course1',courseURL:COURSE});assert.equal(first.complete,false);assert.equal(first.added,1);assert.equal(second.added,0);assert.equal(f.workspace.platformFindings.length,1);assert.equal(f.saves.length,1);
});
