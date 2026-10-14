import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformDiscovery,pagePlatformDiscovery,discoveryCourse} from '../dist/platform-discovery.js';
import {platformCatalog} from '../dist/source-catalog.js';
import {runProjectAgent} from '../dist/knowledge.js';
import {readerPlatformLinks} from '../desktop/platform-link-policy.mjs';

const root='https://spaces.th-koeln.de/discovery-course/',repo='https://git.coco.study/teaching/interface';
const state=()=>({projects:[{id:'course',name:'Interface',links:[{tool:'spaces',url:root}]}],platformFindings:[],notes:[],tasks:[],bookmarks:[],boardFindings:[],tools:[],calendarEvents:[]});
const page=(url=root+'resources/',extra={})=>({url,title:'Workshopmaterial',text:'Die Aufgabe steht im Repository.',offset:0,hasMore:false,links:[],controls:[],contentRevision:'a'.repeat(64),platformLinks:[{service:'gitlab',url:repo,title:'Workshop',sourceURL:url,sourceTitle:'Workshopmaterial',postedBy:'Synthetic Lehrperson',postedAt:'2026-10-14T09:00:00Z'}],...extra});
const payload=messages=>JSON.parse(messages.at(-1).content.split('\n')[1]);
const tool=(tool,args)=>({content:JSON.stringify({type:'tool',tool,args})});
const answer=(citations=[])=>({content:JSON.stringify({type:'answer',text:'Zusammenfassung',citations})});

test('native provenance policy rejects nonoffered origins, login/write URLs and unknown fields before registration',()=>{
  const input=page();input.platformLinks.push({...input.platformLinks[0],url:repo+'/-/issues/new'}, {...input.platformLinks[0],url:repo+'2',sourceURL:root+'other/'}, {...input.platformLinks[0],url:'https://evil.test/repo'}, {...input.platformLinks[0],service:'unknown'}, {...input.platformLinks[0],cookies:'PRIVATE_COOKIE',creator:'FAKE_CREATOR'});
  const result=readerPlatformLinks(input);assert.equal(result.length,1);assert.equal(result[0].sourceURL,input.url);assert.equal(result[0].postedBy,'Synthetic Lehrperson');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_COOKIE|FAKE_CREATOR/);
  assert.deepEqual(readerPlatformLinks({...input,permissionRequired:true}),[]);assert.deepEqual(readerPlatformLinks({...input,loginRequired:true}),[]);
});

test('a current page without course selection can infer only one exact course subtree, never a global blog or ambiguous binding',()=>{
  const workspace=state();assert.equal(discoveryCourse(page(),{workspace}).projectId,'course');
  assert.equal(discoveryCourse(page('https://spaces.th-koeln.de/blog/shared-post/'),{workspace}),null);
  workspace.projects.push({...workspace.projects[0],id:'duplicate'});assert.equal(discoveryCourse(page(),{workspace}),null);
  assert.equal(discoveryCourse(page(),{workspace,projectId:'course'}).projectId,'course');
});

test('durable findings precede registration, repeat reads deduplicate and the original posting metadata is retained',async()=>{
  let workspace=state(),saves=0,registrations=0;
  const discovery=createPlatformDiscovery({getWorkspace:()=>workspace,onSave:rows=>{saves++;assert.equal(registrations,0);workspace={...workspace,platformFindings:rows};return true;},onCatalog:()=>{registrations++;assert.equal(workspace.platformFindings.length,1);}});
  const first=await discovery.discover(page(),{projectId:'course',courseURL:root});assert.equal(first.added,1);assert.equal(first.sources[0].url,repo);
  const second=await discovery.discover(page(),{projectId:'course',courseURL:root});assert.equal(second.added,0);assert.equal(saves,1);assert.equal(registrations,2);assert.equal(workspace.platformFindings[0].postedBy,'Synthetic Lehrperson');
});

test('failed persistence, stale course binding and pre-abort cannot register any provider scope',async()=>{
  for(const scenario of ['failed-save','relinked','aborted']){
    const workspace=state(),controller=new AbortController();let registrations=0,saves=0;
    if(scenario==='relinked')workspace.projects[0].links[0].url='https://spaces.th-koeln.de/relinked/';if(scenario==='aborted')controller.abort();
    const discovery=createPlatformDiscovery({getWorkspace:()=>workspace,onSave:()=>{saves++;return false;},onCatalog:()=>registrations++});
    await assert.rejects(discovery.discover(page(),{projectId:'course',courseURL:root,signal:controller.signal}));assert.equal(registrations,0);assert.equal(saves,scenario==='failed-save'?1:0);assert.deepEqual(platformCatalog(workspace),[]);
  }
});

test('permission/login pages and missing page revisions cannot become new read grants',async()=>{
  for(const flag of ['loginRequired','permissionRequired','accessDenied','navigationBlocked'])assert.deepEqual(pagePlatformDiscovery(page(root,{[flag]:true}),{workspace:state(),projectId:'course'}).findings,[]);
  assert.throws(()=>pagePlatformDiscovery(page(root,{contentRevision:''}),{workspace:state(),projectId:'course'}),/bestätigte/);
  assert.throws(()=>pagePlatformDiscovery(page(root,{platformLinks:Array(101).fill(page().platformLinks[0])}),{workspace:state(),projectId:'course'}));
});

test('a late registration result after relink or abort cannot report usable discovered sources',async()=>{
  for(const scenario of ['relink','abort']){
    let workspace=state();const controller=new AbortController();let writes=0;
    const discovery=createPlatformDiscovery({getWorkspace:()=>workspace,onSave:rows=>{workspace={...workspace,platformFindings:rows};writes++;return true;},onCatalog:()=>{if(scenario==='relink')workspace.projects[0].links[0].url='https://spaces.th-koeln.de/new-course/';else controller.abort();}});
    await assert.rejects(discovery.discover(page(),{projectId:'course',courseURL:root,signal:controller.signal}));assert.equal(writes,1);
    if(scenario==='relink')assert.deepEqual(platformCatalog(workspace),[]);
  }
});

test('agent follows a Spaces subpage, discovers its repository and reads/cites the assignment in the same run',async()=>{
  let workspace=state(),turn=0,reads=0;const storedOriginal=workspace;
  const discovery=createPlatformDiscovery({getWorkspace:()=>workspace,onSave:rows=>{workspace={...workspace,platformFindings:rows};return true;}});
  const docId='service:'+'b'.repeat(64)+':part0';
  const result=await runProjectAgent({workspace:storedOriginal,projectId:'course',documents:[],prompt:'Lies die Aufgabe aus dem Kursmaterial.',browser:async(name,args,signal,scope)=>{
    assert.equal(scope.projectId,'course');assert.equal(scope.courseURL,root);
    const view=name==='browser_course'?page(root,{text:'Kursstart',platformLinks:[],links:[{title:'Resources',url:root+'resources/'}]}):page();
    await discovery.discover(view,{...scope,signal});return view;
  },platform:async(name,args)=>{
    assert.equal(name,'read_platform');reads++;const source=platformCatalog(workspace).find(row=>row.id===args.sourceId);assert.ok(source);
    const document={id:docId,kind:'service',service:'gitlab',source:'gitlab',sourceId:source.id,projectId:'course',title:'Aufgabe',url:repo+'/-/issues/7',text:'Baue einen Prototyp mit barrierefreier Bedienung.',status:'excerpt'};
    return {documents:[document],result:{results:[document]}};
  },complete:async messages=>{
    turn++;if(turn===1)return tool('browser_course',{projectId:'course'});if(turn===2)return tool('browser_open',{url:root+'resources/'});
    if(turn===3){const found=payload(messages).platformSources;assert.equal(found.length,1);assert.equal(found[0].state,'link-found-content-unread');return tool('read_platform',{sourceId:found[0].id});}
    assert.match(JSON.stringify(messages),/Baue einen Prototyp mit barrierefreier Bedienung/);return answer([docId]);
  }});
  assert.equal(reads,1);assert.equal(result.citations[0].url,repo+'/-/issues/7');assert.equal(result.unverifiedCitations,false);assert.equal(workspace.platformFindings.length,1);assert.deepEqual(storedOriginal.platformFindings,[],'a run must not mutate the caller/shared workspace snapshot');
});

test('failed browser-discovery persistence cannot authorize a guessed repository read in that run',async()=>{
  const workspace=state(),source=platformCatalog({...workspace,platformFindings:pagePlatformDiscovery(page(),{workspace,projectId:'course'}).findings})[0];let turn=0,reads=0;
  const discovery=createPlatformDiscovery({getWorkspace:()=>workspace,onSave:()=>false});
  const result=await runProjectAgent({workspace,projectId:'course',documents:[],prompt:'Lies die Aufgabe.',browser:async(_name,_args,signal,scope)=>{const value=page();await discovery.discover(value,{...scope,signal});return value;},platform:async()=>{reads++;return {};},complete:async()=>++turn===1?tool('browser_course',{projectId:'course'}):turn===2?tool('read_platform',{sourceId:source.id}):answer()});
  assert.equal(reads,0);assert.equal(result.sources.length,0);assert.ok(result.steps.every(step=>step.status==='error'));assert.equal(workspace.platformFindings.length,0);
});
