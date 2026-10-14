import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {createDesktopPlatform} from '../desktop/platform.mjs';
import {platformCatalog} from '../dist/source-catalog.js';

const REPO='https://git.coco.study/course/robotics',ACCOUNT='b'.repeat(64),RAW=REPO+'/-/raw/main/README.md',CONTENT='d'.repeat(64),hash=value=>createHash('sha256').update(value).digest('hex');
const deferred=()=>{let release,enter;return {promise:new Promise(resolve=>release=resolve),entered:new Promise(resolve=>enter=resolve),release:value=>release(value),enter:()=>enter()};};
const message=(action,sourceId,extra={})=>({action,id:randomUUID(),sourceId,...extra});
function fixture({fingerprintHook,readHook,fileHook}={}){
  const f={views:[],opened:[],events:[],fetches:[],fingerprint:ACCOUNT,loads:[],workspace:{projects:[{id:'course1',name:'Robotik',links:[{tool:'gitlab',url:REPO,title:'Robotikkurs'}]}]}};
  f.sources=()=>platformCatalog(f.workspace);
  const createView=options=>{const wc=new EventEmitter();Object.assign(wc,{url:'about:blank',closed:false,getURL:()=>wc.url,isDestroyed:()=>wc.closed,setWindowOpenHandler:handler=>wc.popup=handler,stop:()=>{},close:()=>{wc.closed=true;wc.emit('destroyed');},loadURL:async url=>{f.loads.push(url);wc.emit('did-start-navigation',{},url,false,true);wc.url=url;wc.emit('did-navigate',{},url,200);},executeJavaScriptInIsolatedWorld:async()=>{await readHook?.(f,wc);return {url:wc.url,title:'Robotik',text:'Aufgabe: Baue einen Roboter.',contentRevision:CONTENT,offset:0,nextOffset:26,totalLength:26,hasMore:false,links:[],items:[],boardLinks:[],fileLinks:[{url:RAW,title:'Aufgabenstellung'}],loginRequired:false};}});const view={webContents:wc,options,setVisible:()=>{}};f.views.push(view);return view;};
  f.api=createDesktopPlatform({nango:{status:async()=>({}),proxy:async()=>{throw new Error('Unverbundener Miro-Testprovider');}},createView,destroyView:view=>view.webContents.close(),openVisible:url=>f.opened.push(url),fetchText:async(url,options)=>{f.fetches.push({url,options});return fileHook?fileHook(url,options,f):{url,text:'# Aufgabe\nEntwickle einen Greifarm.',contentType:'text/markdown'};},getAccountFingerprint:async service=>fingerprintHook?fingerprintHook(service,f):f.fingerprint,emit:detail=>f.events.push(detail)});
  f.register=()=>f.api.service({action:'registry',sources:f.sources()});return f;
}

test('native registry accepts actual catalog IDs/revisions, exposes opaque generations only and coalesces unchanged scopes',async()=>{
  const f=fixture(),first=await f.register(),second=await f.register();assert.equal(first.registered,1);assert.match(first.generation,/^[a-f0-9]{64}$/);assert.equal(first.generation,second.generation);assert.equal(first.accounts.gitlab,ACCOUNT);assert.doesNotMatch(JSON.stringify(first),/cookie|password|token=/);assert.equal(f.views.length,0);f.api.dispose();
});

test('invalid and arbitrary native registries fail atomically without replacing a valid source grant',async()=>{
  const f=fixture(),before=await f.register();const valid=f.sources()[0];
  for(const request of [null,[],{action:'registry',sources:[]}, {action:'registry',sources:[{...valid,url:'https://evil.test/'}]}, {action:'registry',sources:[valid,valid]}, {action:'registry',sources:[valid],code:'arbitrary'}, {action:'registry',sources:[{id:'miro',service:'miro',url:'https://miro.com/app/board/board1234/',projectId:'course1',title:'bad\nsecret',revision:'a'.repeat(32)}]}]){
    if(request?.action==='registry'&&Array.isArray(request.sources)&&request.sources.length===0)continue;
    await assert.rejects(f.api.service(request));assert.equal(f.api.generation(),before.generation);
  }
  const page=await f.api.service(message('read',valid.id));assert.equal(page.sourceId,valid.id);assert.equal(page.accountGeneration,ACCOUNT);assert.equal(page.scopeGeneration,before.generation);f.api.dispose();
});

test('native read-file honors observed-link leases before delegating a bounded abortable GET',async()=>{
  const f=fixture();await f.register();const id=f.sources()[0].id,page=await f.api.service(message('read',id));
  await assert.rejects(f.api.service(message('read-file',id,{url:RAW.replace('README.md','unknown.md'),expectedRevision:page.contentRevision})),error=>error.code==='LINK_NOT_OFFERED');assert.equal(f.fetches.length,0);
  const doc=await f.api.service(message('read-file',id,{url:RAW,expectedRevision:page.contentRevision}));assert.match(doc.text,/Greifarm/);assert.equal(doc.accountGeneration,ACCOUNT);assert.equal(f.fetches.length,1);assert.equal(f.fetches[0].options.maxBytes,2000000);assert.ok(f.fetches[0].options.signal instanceof AbortSignal);f.api.dispose();
});

test('a cookie/account invalidation during native reading cancels processing and emits only a service identifier',async()=>{
  const gate=deferred(),f=fixture({readHook:async()=>{gate.enter();await gate.promise;}});await f.register();const pending=f.api.service(message('read',f.sources()[0].id));await gate.entered;f.api.invalidate('gitlab');await assert.rejects(pending,error=>error.name==='AbortError');assert.deepEqual(f.events,[{service:'gitlab'}]);gate.release();f.api.dispose();
});

test('account replacement without an event is detected after the request and prevents stale source delivery',async()=>{
  let changes=0;const f=fixture({fingerprintHook:()=>++changes<3?ACCOUNT:hash('other-account')});await f.register();await assert.rejects(f.api.service(message('read',f.sources()[0].id)),error=>error.code==='SOURCE_CHANGED');assert.deepEqual(f.events,[{service:'gitlab'}]);f.api.dispose();
});

test('an invalidation during asynchronous fingerprint lookup cannot re-establish the removed account fingerprint',async()=>{
  const gate=deferred();let held=false;const f=fixture({fingerprintHook:async(service,state)=>{if(held){gate.enter();await gate.promise;}return state.fingerprint;}});await f.register();held=true;const pending=f.register();await gate.entered;f.api.invalidate('gitlab');gate.release();await assert.rejects(pending,error=>error.code==='ACCOUNT_CHANGED');assert.equal(f.events.length,1);f.api.dispose();
});

test('overlapping registries reject an older asynchronous reply after a source relink',async()=>{
  const gate=deferred();let calls=0;const f=fixture({fingerprintHook:async()=>{if(++calls===1){gate.enter();await gate.promise;}return ACCOUNT;}}),first=f.register();await gate.entered;f.workspace.projects[0].links[0].url='https://git.coco.study/course/new-course';const second=await f.register();gate.release();await assert.rejects(first,error=>error.code==='SOURCE_CHANGED');assert.equal(f.api.generation(),second.generation);assert.equal(f.views.length,0);f.api.dispose();
});

test('an unlink followed by re-link cannot reuse an earlier native scope generation',async()=>{
  const f=fixture(),initial=await f.register(),link=f.workspace.projects[0].links[0];f.workspace.projects[0].links=[];await f.register();f.workspace.projects[0].links=[link];const returned=await f.register();assert.notEqual(returned.generation,initial.generation);f.api.dispose();
});

test('Miro account invalidation advances scope generation and reports a cache invalidation even with unchanged board links',async()=>{
  const f=fixture(),initial=await f.register();f.api.invalidate('miro');assert.notEqual(f.api.generation(),initial.generation);assert.deepEqual(f.events,[{service:'miro'}]);const next=await f.register();assert.notEqual(next.generation,initial.generation);f.api.dispose();
});

test('visible sign-in handoff opens only a source root; arbitrary login automation fields are rejected',async()=>{
  const f=fixture();await f.register();const id=f.sources()[0].id;await assert.rejects(f.api.service(message('open-login',id,{password:'PRIVATE'})));assert.equal(f.opened.length,0);const result=await f.api.service(message('open-login',id));assert.equal(result.loginRequired,true);assert.equal(result.opened,true);assert.deepEqual(f.opened,[REPO]);assert.equal(f.views.length,0);f.api.dispose();
});

test('disposal rejects later registries and native reads and closes its retained renderer',async()=>{
  const f=fixture();await f.register();await f.api.service(message('read',f.sources()[0].id));f.api.dispose();assert.equal(f.views[0].webContents.closed,true);await assert.rejects(f.register(),error=>error.code==='DISPOSED');await assert.rejects(f.api.service(message('read','unknown')),error=>error.code==='DISPOSED');
});
