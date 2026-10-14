import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createSpacesCrawlView} from '../dist/spaces-crawl-view.js';
import {emptyCrawlState} from '../dist/spaces-crawl.js';
import {buildSearchDocuments} from '../dist/search-documents.js';
import {createSearchIndex} from '../dist/search-index.js';

const root='https://spaces.th-koeln.de/wp/synthetic-course/';
const sourceId='crawl:'+'a'.repeat(64);
const entry={id:sourceId,kind:'browser',projectId:'synthetic-course',url:root,title:'Synthetic course source',text:'Synthetic course content',status:'full',section:[]};
const initial=()=>({version:1,state:emptyCrawlState(),sourceIds:[],lastRun:''});
const state=()=>({version:1,cursor:0,sessions:[{projectId:'synthetic-course',root,queue:[],seen:[{url:root,controls:[],section:[],title:'Synthetic root',offeredBy:'',sourceId,length:entry.text.length,status:'full'}],failed:[],limits:[]}]});
const coverage=[{projectId:'synthetic-course',status:'read',views:1,pending:0,failed:0,limits:[],message:'Synthetic view read.'}];
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
const decode=value=>String(value).replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>','quot':'"','#39':"'"})[key]);
const attrs=value=>Object.fromEntries([...value.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g)].map(m=>[m[1],decode(m[2]??m[3]??m[4]??'')]));
class Node{
  constructor(tag,attributes={},doc){this.tagName=tag.toUpperCase();this.attributes=attributes;this.ownerDocument=doc;this.children=[];this.dataset=Object.fromEntries(Object.entries(attributes).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v]));this.value=attributes.value||'';this.disabled='disabled' in attributes;this.open='open' in attributes;this.listeners=new Map();this.scrollTop=0;}
  get id(){return this.attributes.id||'';}
  get open(){return Object.hasOwn(this.attributes,'open');}
  set open(value){if(value)this.attributes.open='';else delete this.attributes.open;}
  setAttribute(key,value){this.attributes[key]=value;}
  getAttribute(key){return this.attributes[key]??null;}
  contains(node){return node===this||this.children.some(c=>c.contains(node));}
  matches(selector){return selector.split(',').some(part=>{const s=part.trim();if(s.startsWith('#'))return this.id===s.slice(1);if(s.startsWith('.'))return (this.attributes.class||'').split(' ').includes(s.slice(1));const tag=s.match(/^([\w-]+)(?=\[)/);if(tag)return this.tagName===tag[1].toUpperCase()&&this.matches(s.slice(tag[1].length));if(s.startsWith('[')){const attributes=[...s.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];return attributes.length>0&&attributes.every(([,key,value])=>Object.hasOwn(this.attributes,key)&&(value===undefined||this.attributes[key]===value));}return this.tagName===s.toUpperCase();});}
  closest(selector){return this.matches(selector)?this:this.parent?.closest(selector)||null;}
  querySelectorAll(selector){const found=[];for(const child of this.children){if(child.matches(selector))found.push(child);found.push(...child.querySelectorAll(selector));}return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  set innerHTML(value){
    if(this.children.some(c=>c.contains(this.ownerDocument.activeElement)))this.ownerDocument.activeElement=this.ownerDocument.body;
    this.children=[];this._html=value;const stack=[this];
    for(const token of value.match(/<\/?[a-zA-Z][^>]*>|[^<]+/g)||[]){
      if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}
      if(token.startsWith('<')){const match=token.match(/^<([\w-]+)\b([^>]*)>/),node=new Node(match[1],attrs(match[2]),this.ownerDocument);node.parent=stack.at(-1);node.parent.children.push(node);if(!token.endsWith('/>')&&!['INPUT','IMG','PATH','CIRCLE','RECT','BR','HR'].includes(node.tagName))stack.push(node);}
    }
  }
  get innerHTML(){return this._html||'';}
  focus(){this.ownerDocument.activeElement=this;}
  addEventListener(name,handler){this.listeners.set(name,[...(this.listeners.get(name)||[]),handler]);}
  removeEventListener(name,handler){this.listeners.set(name,(this.listeners.get(name)||[]).filter(h=>h!==handler));}
  dispatch(name,event={}){const e={target:this,preventDefault(){},stopPropagation(){},...event};for(const handler of this.listeners.get(name)||[])handler(e);return e;}
  close(){this.open=false;this.dispatch('close');}
}
function fixture(t,{load,save,scan,available=true,otherBusy=false,projects,activeCourse='synthetic-course',onDiscovery=()=>{}}={}){
  const doc={};doc.body=new Node('body',{},doc);const dialog=new Node('dialog',{},doc);dialog.parent=doc.body;doc.body.children.push(dialog);doc.activeElement=doc.body;
  const workspace={activeCourse,projects:projects||[{id:'synthetic-course',name:'Synthetic course',links:[{tool:'spaces',url:root}]}]},calls={load:0,save:[],scan:[],changes:0,search:0,closed:0,request:[],modal:0},documents=new Map();let stored=initial(),revision=0;
  const store={load:async()=>{calls.load++;if(load){const result=await load();stored=structuredClone(result.snapshot);revision=result.revision;documents.clear();for(const source of result.documents)documents.set(source.id,structuredClone(source));return result;}return {snapshot:structuredClone(stored),revision,documents:[...documents.values()]};},save:async(snapshot,expected,options={})=>{calls.save.push({snapshot:structuredClone(snapshot),expected,source:options.source});if(save)await save(snapshot,expected,options);assert.equal(expected,revision);stored=structuredClone(snapshot);if(options.source)documents.set(options.source.id,structuredClone(options.source));for(const id of documents.keys())if(!snapshot.sourceIds.includes(id))documents.delete(id);return ++revision;},close:()=>calls.closed++};
  const view=createSpacesCrawlView({dialog,getWorkspace:()=>workspace,onModal:body=>{calls.modal++;dialog.innerHTML=body;dialog.open=true;},onChange:()=>calls.changes++,onSearch:()=>calls.search++,onDiscovery,store,available:()=>available,isOtherBusy:()=>otherBusy,request:async command=>{calls.request.push(command);throw Error('No real provider in fixture');},scan:async options=>{calls.scan.push(options);if(scan)return await scan(options);await options.onSource(entry);await options.onProgress({state:state(),coverage,views:1,message:'Synthetic source committed.'});return {state:state(),coverage,views:1,interrupted:false};}});
  t.after(()=>view.dispose());
  const node=selector=>dialog.querySelector(selector),action=name=>dialog.querySelectorAll('[data-crawl-action]').find(node=>node.dataset.crawlAction===name),event=(type,target,extra={})=>dialog.dispatch(type,{target,...extra});
  return {doc,dialog,view,calls,workspace,store,node,action,event,async open(){await view.open();await flush();}};
}

test('opening only restores local cache and exposes named controls, scope, access limitations and storage disclosure',async t=>{
  const f=fixture(t);await f.open();assert.equal(f.calls.load,1);assert.equal(f.calls.scan.length,0);assert.equal(f.calls.request.length,0);
  assert.equal(f.action('start').disabled,false);assert.equal(f.node('#spaces-crawl-scope').tagName,'SELECT');assert.equal(f.node('#spaces-crawl-budget').tagName,'SELECT');
  const html=f.node('#spaces-crawl-body').innerHTML;assert.match(html,/lokal verschlüsselt|lokale Momentaufnahme/);assert.match(html,/keine KI-Übertragung|keine Schreibaktionen/);assert.match(html,/Dateien, Bilder, Mitgliederbereiche/);assert.match(html,/Kurs öffnen: Synthetic course/);assert.match(html,/rel="noopener noreferrer"/);
});

test('storage/browser/other-task prerequisites gate reads without losing a cache/error result',async t=>{
  const unavailable=fixture(t,{available:false});await unavailable.open();assert.equal(unavailable.action('start').disabled,true);await unavailable.view.start();assert.equal(unavailable.calls.scan.length,0);
  const busy=fixture(t,{otherBusy:true});await busy.open();assert.equal(busy.action('start').disabled,true);await busy.view.start();assert.equal(busy.calls.scan.length,0);
  const broken=fixture(t,{load:async()=>{throw Error('Synthetic storage unavailable <script>');}});await broken.open();assert.equal(broken.view.summary().ready,false);assert.equal(broken.action('start').disabled,true);await broken.view.start();assert.equal(broken.calls.scan.length,0);assert.match(broken.node('#spaces-crawl-body').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(broken.node('#spaces-crawl-body').innerHTML,/<script>/);
});

test('accepted source commits are course-bound and remain searchable after a completed run',async t=>{
  const f=fixture(t);await f.open();await f.view.start();assert.equal(f.calls.scan.length,1);assert.equal(f.calls.scan[0].maxViews,100);assert.equal(f.calls.save[0].source.courseURL,root);assert.equal(f.view.summary().sources,1);assert.equal(f.view.summary().busy,false);
  assert.equal(f.view.sources()[0].id,sourceId+':part0');assert.equal(f.view.sources()[0].text,entry.text);assert.equal(f.calls.request.length,0);
});

test('start/pause retains keyboard focus and disclosure/scroll state across progress rerenders',async t=>{
  const release=deferred();let progress;
  const f=fixture(t,{scan:async options=>{progress=options.onProgress;await release.promise;return {state:emptyCrawlState(),coverage:[],views:0,interrupted:true};}});await f.open();
  const help=f.node('.spaces-crawl-help');help.open=true;f.node('.spaces-crawl-list').scrollTop=120;f.action('start').focus();
  const running=f.view.start();await flush();assert.equal(f.doc.activeElement.dataset.crawlAction,'pause','the focused start control must become the reachable pause control');assert.equal(f.node('.spaces-crawl-help').open,true);assert.equal(f.node('.spaces-crawl-list').scrollTop,120);
  await progress({state:emptyCrawlState(),coverage:[],views:0,message:'Synthetic progress'});assert.equal(f.doc.activeElement.dataset.crawlAction,'pause');assert.equal(f.node('.spaces-crawl-help').open,true);
  f.view.pause();release.resolve();await running;
});

test('closing a running dialog aborts the current lease and keeps confirmed local excerpts',async t=>{
  const release=deferred();let signal;
  const f=fixture(t,{scan:async options=>{signal=options.signal;await options.onSource(entry);await release.promise;return {state:state(),coverage,views:1,interrupted:signal.aborted};}});await f.open();const running=f.view.start();await flush();
  assert.equal(f.view.summary().sources,1);f.dialog.close();assert.equal(signal.aborted,true);release.resolve();await running;assert.equal(f.view.isBusy(),false);assert.equal(f.view.sources()[0].text,entry.text);assert.equal(f.dialog.open,false);
});

test('a failed source save cannot install transient text in knowledge or claim a completed source',async t=>{
  const f=fixture(t,{save:async(_snapshot,_revision,options)=>{if(options.source)throw Error('Synthetic source save failed');}});await f.open();await f.view.start();
  assert.equal(f.view.summary().sources,0);assert.deepEqual(f.view.sources(),[]);assert.match(f.node('#spaces-crawl-body').innerHTML,/Synthetic source save failed/);assert.equal(f.view.isBusy(),false);
});

test('a live root change rejects an old global blog source even when that URL is allowed under either root',async t=>{
  const release=deferred();const f=fixture(t,{scan:async options=>{await release.promise;await options.onSource({...entry,url:'https://spaces.th-koeln.de/blog/synthetic-offered-post/'});return {state:state(),coverage,views:1,interrupted:false};}});await f.open();const running=f.view.start();await flush();f.workspace.projects[0].links[0].url='https://spaces.th-koeln.de/wp/relinked-course/';release.resolve();await running;
  assert.equal(f.view.summary().sources,0);assert.deepEqual(f.view.sources(),[]);assert.equal(f.calls.save.length,0);assert.match(f.node('#spaces-crawl-body').innerHTML,/Kursverbindung wurde geändert/);
});

test('disposed view suppresses late source callbacks and new writes while an already accepted local commit may settle',async t=>{
  const saving=deferred();const f=fixture(t,{save:async(_snapshot,_revision,options)=>{if(options.source)await saving.promise;}});await f.open();const running=f.view.start();await flush();const before=f.calls.changes,saves=f.calls.save.length;
  f.view.dispose();saving.resolve();await running;assert.equal(f.calls.changes,before,'an accepted commit must not notify a disposed view');assert.equal(f.calls.save.length,saves,'dispose must not open new metadata writes after the accepted transaction');assert.equal(f.calls.closed,1);
});

test('cache projection follows archived/relinked course changes and never revives removed texts',async t=>{
  const f=fixture(t);await f.open();await f.view.start();assert.equal(f.view.sources().length,1);f.workspace.projects[0].archived=true;assert.deepEqual(f.view.sources(),[]);f.workspace.projects[0].archived=false;assert.equal(f.view.sources().length,1);f.workspace.projects[0].links[0].url='https://spaces.th-koeln.de/wp/new-course/';assert.deepEqual(f.view.sources(),[]);
});

test('projection invalidation follows the actual eligible Spaces root when an earlier link is unusable',async t=>{
  const f=fixture(t,{projects:[{id:'synthetic-course',name:'Synthetic course',links:[{tool:'spaces',url:'https://foreign.example/unusable-space/'},{tool:'spaces',url:root}]}]});await f.open();await f.view.start();assert.equal(f.view.sources().length,1);
  f.workspace.projects[0].links[1].url='https://spaces.th-koeln.de/wp/relinked-course/';assert.deepEqual(f.view.sources(),[],'the effective root changed even though the first unusable link stayed unchanged');
});

test('an archived active course defaults to available linked courses instead of trapping the scope in an invisible selection',async t=>{
  const f=fixture(t,{activeCourse:'archived',projects:[{id:'archived',archived:true,name:'Archived',links:[{tool:'spaces',url:root}]},{id:'synthetic-course',name:'Current',links:[{tool:'spaces',url:root}]}]});await f.open();await f.view.start();assert.deepEqual(f.calls.scan[0].projects.map(p=>p.id),['synthetic-course']);
});

test('search handoff closes the crawler and invokes only the explicit local search callback',async t=>{
  const f=fixture(t);await f.open();f.event('click',f.action('search'));assert.equal(f.dialog.open,false);assert.equal(f.calls.search,1);assert.equal(f.calls.scan.length,0);assert.equal(f.calls.request.length,0);
});

test('new source text stays out of search/knowledge until local commit; the prior version remains usable meanwhile',async t=>{
  const pending=deferred(),old={...entry,courseURL:root,text:'Older confirmed snapshot'},f=fixture(t,{load:async()=>({snapshot:{...initial(),sourceIds:[sourceId]},revision:1,documents:[old]}),save:async(_snapshot,_revision,options)=>{if(options.source)await pending.promise;}});
  await f.open();const running=f.view.start();await flush();assert.equal(f.view.sources()[0].text,old.text);assert.equal(f.view.summary().sources,1);
  pending.resolve();await running;assert.equal(f.view.sources()[0].text,entry.text);
});

test('actual app collection wiring combines live and saved crawl sources and includes truthful crawler coverage',async t=>{
  const f=fixture(t);await f.open();await f.view.start();const app=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8'),allStart=app.indexOf('function allBrowserSources()'),allEnd=app.indexOf('\n',allStart),searchStart=app.indexOf('function getSearchDocuments()'),searchEnd=app.indexOf('\nfunction openSearch()',searchStart);
  assert.ok(allStart>=0&&allEnd>allStart&&searchStart>=0&&searchEnd>searchStart);
  const live={id:'live:'+'b'.repeat(64),kind:'browser',projectId:'synthetic-course',url:root,title:'Live synthetic source',text:'Live-only marker',status:'full'},context={sourceHub:{documents:()=>[]},companion:{sources:()=>[live]},crawlerView:f.view,searchDirty:true,searchSnapshot:undefined,state:f.workspace,remoteItems:[],kiView:{searchRecords:()=>[]},mailView:{searchSources:()=>[]},sourceStates:[],buildSearchDocuments};
  vm.createContext(context);vm.runInContext(app.slice(allStart,allEnd)+'\n'+app.slice(searchStart,searchEnd),context);
  const combined=vm.runInContext('allBrowserSources()',context);assert.equal(combined.length,2);assert.equal(combined[0].id,live.id);assert.equal(combined[1].id,sourceId+':part0');
  const collection=vm.runInContext('getSearchDocuments()',context),index=createSearchIndex();index.replace(collection.documents);assert.ok(index.search('synthetic course content',{projectId:'synthetic-course'}).some(hit=>hit.id===sourceId+':part0'));assert.match(collection.warnings.join('\n'),/Spaces-Crawler: 1 gespeicherte Ansichten/);
});


test('new platform provenance is handed off only after the encrypted course-source save settles',async t=>{
 const saving=deferred(),handoffs=[];const platform={service:'gitlab',url:'https://git.coco.study/qa/course',title:'Repository',sourceURL:root,sourceTitle:'Synthetic course',postedBy:'Synthetic poster',postedAt:''};
 const f=fixture(t,{save:async(_snapshot,_revision,options)=>{if(options.source)await saving.promise;},onDiscovery:async(source,scope)=>{handoffs.push({source,scope});},scan:async options=>{await options.onSource({...entry,platformLinks:[platform],contentRevision:'a'.repeat(64)});return {state:state(),coverage,views:1,interrupted:false};}});await f.open();const running=f.view.start();await flush();assert.equal(handoffs.length,0);assert.equal(f.view.summary().sources,0);saving.resolve();await running;assert.equal(handoffs.length,1);assert.equal(handoffs[0].scope.courseURL,root);assert.equal(handoffs[0].source.platformLinks[0].postedBy,'Synthetic poster');
});

test('a course relink or pause during source persistence cannot publish newly offered provider grants',async t=>{
 for(const scenario of ['relink','pause']){
  const saving=deferred();let handoffs=0;const platform={service:'gitlab',url:'https://git.coco.study/qa/course',title:'Repository',sourceURL:root,sourceTitle:'Source',postedBy:'',postedAt:''};
  const f=fixture(t,{save:async(_snapshot,_revision,options)=>{if(options.source)await saving.promise;},onDiscovery:()=>handoffs++,scan:async options=>{await options.onSource({...entry,platformLinks:[platform],contentRevision:'a'.repeat(64)});return {state:state(),coverage,views:1,interrupted:false};}});await f.open();const running=f.view.start();await flush();if(scenario==='relink')f.workspace.projects[0].links[0].url='https://spaces.th-koeln.de/changed/';else f.view.pause();saving.resolve();await running;assert.equal(handoffs,0);assert.deepEqual(f.view.sources(),[]);
 }
});
