import test from 'node:test';
import assert from 'node:assert/strict';
import {coursePlatformFindings,currentPlatformFindings,validatePlatformFindings,mergePlatformFindings,PLATFORM_FINDING_LIMITS} from '../dist/platform-links.js';
import {platformCatalog} from '../dist/source-catalog.js';
import {initialState,validateState} from '../dist/core.js';

const courseURL='https://spaces.th-koeln.de/qa-course/',sourceURL=courseURL+'orga/resources/';
const repo='https://git.coco.study/course/robotics',folder='https://th-koeln.sciebo.de/s/Synthetic_share?path=%2FCourse',board='https://miro.com/app/board/synthetic-board/',channel='https://chat.coco.study/students/channels/robotics';
const now='2026-10-14T10:00:00Z',project={id:'course',name:'Synthetic course',links:[{id:'space',tool:'spaces',title:'Course Space',url:courseURL}]};
const workspace=()=>({projects:[structuredClone(project)],tools:[],boardFindings:[],platformFindings:[]});
const offered=(service,url,title='Kursressource',patch={})=>({service,url,title,sourceURL,sourceTitle:'Unterrichtsmaterial',postedBy:'Synthetic link poster',postedAt:'2026-10-13T11:00:00Z',...patch});
const page=(links=[offered('gitlab',repo)],patch={})=>({url:sourceURL,title:'Ressourcen',platformLinks:links,platformLinksMore:false,...patch});
const collect=(value=page(),state=workspace(),time=now)=>coursePlatformFindings(value,{workspace:state,projectId:'course',now:time});

test('read course pages expose only actually offered safe service links and preserve explicit provenance without creator claims',()=>{
  const links=[offered('gitlab',repo),offered('sciebo',folder),offered('miro',board),offered('mattermost',channel),offered('gitlab',repo+'#fragment'),offered('gitlab','https://evil.test/course/robotics'),offered('gitlab',repo+'/-/issues/new'),offered('miro','https://miro.com/app/dashboard/'),offered('whatsapp','https://web.whatsapp.com/')];
  const rows=collect(page(links));assert.equal(rows.length,4);assert.deepEqual(rows.map(row=>row.service),['gitlab','sciebo','miro','mattermost']);
  assert.ok(rows.every(row=>row.projectId==='course'&&row.courseURL===courseURL&&row.sourceURL===sourceURL&&row.postedBy==='Synthetic link poster'&&row.postedAt==='2026-10-13T11:00:00.000Z'&&row.foundAt==='2026-10-14T10:00:00.000Z'));
  assert.deepEqual(Object.keys(rows[0]),['id','projectId','courseURL','url','service','title','sourceURL','sourceTitle','postedBy','postedAt','foundAt']);assert.equal(rows[0].creator,undefined);assert.equal(rows[0].boardCreator,undefined);assert.deepEqual(validatePlatformFindings(rows),rows);
});

test('a foreign/stale course page or forged source URL cannot establish course-linked grants',()=>{
  for(const value of [page(undefined,{url:'https://spaces.th-koeln.de/other-course/'}),page(undefined,{url:'https://evil.test/qa-course/'}),page(undefined,{url:courseURL+'members/'}),page(undefined,{url:courseURL+'?token=SECRET'}),page(undefined,{url:courseURL+'/%252e%252e/private'})])assert.throws(()=>collect(value));
  assert.deepEqual(collect(page([offered('gitlab',repo,'Forged',{sourceURL:courseURL+'other-page/'})])),[]);assert.deepEqual(collect(page([offered('gitlab',repo,'Forged',{sourceURL:'https://spaces.th-koeln.de/other-course/'})])),[]);
  for(const state of [{projects:[]},{projects:[{...project,archived:true}]},{projects:[{...project,links:[]}]},{projects:[{...project,id:'bad\nID'}]}])assert.throws(()=>collect(page(),state));
});

test('login/permission pages and absent legacy metadata never yield links; malformed or overflowing arrays fail instead of inventing full coverage',()=>{
  for(const flag of ['loginRequired','permissionRequired','navigationBlocked'])assert.deepEqual(collect(page(undefined,{[flag]:true})),[]);
  assert.deepEqual(collect({url:sourceURL,title:'Legacy view'}),[]);assert.throws(()=>collect(page(undefined,{platformLinks:{url:repo}})));assert.throws(()=>collect(page(Array(101).fill(offered('gitlab',repo)))));
  assert.equal(PLATFORM_FINDING_LIMITS.pageLinks,100);const rows=collect(page([offered('gitlab',repo)],{platformLinksMore:true}));assert.equal(rows[0].complete,undefined);
});

test('metadata is plain bounded text and known secrets disappear; unvalidated relative timestamps remain unknown',()=>{
  const [row]=collect(page([offered('miro',board,'<b>API Key: SECRET_TITLE</b>',{sourceTitle:'authorization: SECRET_SOURCE',postedBy:'password: SECRET_POSTER',postedAt:'vor fünf Minuten',creator:'FAKE_CREATOR',cookies:'PRIVATE_COOKIE',account:{token:'PRIVATE_ACCOUNT'}})]));
  assert.doesNotMatch(JSON.stringify(row),/SECRET_TITLE|SECRET_SOURCE|SECRET_POSTER|FAKE_CREATOR|PRIVATE_COOKIE|PRIVATE_ACCOUNT|<b>/);assert.equal(row.postedAt,'');assert.ok(row.title.length<=200);
  assert.equal(collect(page([offered('gitlab',repo,'Task',{postedAt:'2026-02-30T10:00:00Z'})]))[0].postedAt,'');assert.throws(()=>collect(page(),workspace(),'2026-99-99T10:00:00Z'));
});

test('stable finding IDs distinguish course/source occurrences and repeated reads replace metadata while retaining the first discovery time',()=>{
  const prior=collect(),later=collect(page([offered('gitlab',repo,'Updated task link',{postedBy:'Another link poster'})]),workspace(),'2026-10-15T10:00:00Z');assert.equal(prior[0].id,later[0].id);
  const merged=mergePlatformFindings(prior,later,{workspace:workspace()});assert.equal(merged.length,1);assert.equal(merged[0].title,'Updated task link');assert.equal(merged[0].postedBy,'Another link poster');assert.equal(merged[0].foundAt,prior[0].foundAt);assert.equal(prior[0].title,'Kursressource');
  const otherPage=collect(page([offered('gitlab',repo,'Second occurrence',{sourceURL:courseURL+'second-page/'})],{url:courseURL+'second-page/'}));assert.notEqual(otherPage[0].id,prior[0].id);
  const state=workspace();state.projects.push({...project,id:'other'});const otherCourse=coursePlatformFindings(page(),{workspace:state,projectId:'other',now});assert.notEqual(otherCourse[0].id,prior[0].id);
});

test('archive/delete/relink automatically revoke catalog grants while schema-valid historic provenance remains backup-safe',()=>{
  const state=workspace();state.platformFindings=collect();assert.equal(currentPlatformFindings(state).length,1);assert.equal(platformCatalog(state)[0].projectId,'course');assert.equal(platformCatalog(state)[0].url,repo);
  for(const change of [value=>value.projects[0].archived=true,value=>value.projects=[],value=>value.projects[0].links[0].url='https://spaces.th-koeln.de/new-course/']){
    const changed=structuredClone(state);change(changed);assert.deepEqual(currentPlatformFindings(changed),[]);assert.deepEqual(platformCatalog(changed),[]);assert.deepEqual(validatePlatformFindings(changed.platformFindings),state.platformFindings);assert.throws(()=>mergePlatformFindings([],state.platformFindings,{workspace:changed}),/Kurslink/);
  }
});

test('persisted findings reject fake identities, unsafe sources, metadata additions, duplicates and over-cap writes atomically',()=>{
  const [valid]=collect();for(const patch of [{id:'platform-link:'+'a'.repeat(32)},{projectId:''},{projectId:'missing\ncourse'},{courseURL:'https://spaces.th-koeln.de/'},{sourceURL:'https://evil.test/private/'},{url:'javascript:alert(1)'},{creator:'UNVERIFIED'},{cookies:'PRIVATE_COOKIE'},{postedAt:'Yesterday'},{foundAt:''},{title:'x'.repeat(201)}])assert.throws(()=>validatePlatformFindings([{...valid,...patch}]));
  assert.throws(()=>validatePlatformFindings([valid,valid]));assert.throws(()=>validatePlatformFindings(null));assert.throws(()=>validatePlatformFindings(Array(501).fill(valid)));
  const state=workspace(),previous=[];for(let chunk=0;chunk<5;chunk++)previous.push(...collect(page(Array.from({length:100},(_,n)=>offered('gitlab',repo+'-'+chunk+'-'+n))),state));assert.equal(validatePlatformFindings(previous).length,500);
  const extra=collect(page([offered('gitlab',repo+'-overflow')]),state);assert.throws(()=>mergePlatformFindings(previous,extra,{workspace:state}),/voll/);assert.equal(previous.length,500);
});

test('the real core schema migrates absent optional findings, preserves valid findings, and rejects malformed provenance instead of silently dropping it',()=>{
  const state=initialState();delete state.platformFindings;assert.deepEqual(validateState(state).platformFindings,[]);
  state.projects=[structuredClone(project)];state.platformFindings=collect();const checked=validateState(state);assert.deepEqual(checked.platformFindings,state.platformFindings);assert.equal(checked.platformFindings[0].postedBy,'Synthetic link poster');
  state.projects[0].archived=true;assert.deepEqual(validateState(state).platformFindings,checked.platformFindings);assert.deepEqual(currentPlatformFindings(validateState(state)),[]);
  for(const value of [false,null,{url:repo},[{...state.platformFindings[0],creator:'FAKE'}]])assert.throws(()=>validateState({...state,platformFindings:value}));
});
