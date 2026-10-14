import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequestHandler} from '../server.mjs';
import {createMailClient} from '../connectors/mail.mjs';
import {collectNotifications} from '../connectors/notifications.mjs';
import {parseFeedSnapshot} from '../dist/feed-state.js';
import {createFeedRefresh} from '../dist/feed-refresh.js';
import {notificationKey} from '../dist/core.js';

const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const notice=(id,source='webmail')=>({id,source,title:'Synthetic private subject',summary:'Synthetic sender',url:source==='webmail'?'https://webmail.th-koeln.de/':'https://git.coco.study/course',createdAt:'2026-10-14T12:00:00Z',revision:'1'});
function events(){
  const handlers=new Map();
  return {addEventListener(type,handler){if(!handlers.has(type))handlers.set(type,new Set());handlers.get(type).add(handler);},removeEventListener(type,handler){handlers.get(type)?.delete(handler);},emit(type,detail={}){for(const handler of [...handlers.get(type)||[]])handler({type,...detail});}};
}
const source=()=>readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');

test('disconnect during collection cannot publish/cache the previous mail account as an error snapshot',async()=>{
  const pending=deferred();
  const mail=createMailClient({env:{TH_MAIL_USER:'synthetic-a',TH_MAIL_PASSWORD:'synthetic-only'},runner:async payload=>{
    assert.equal(payload.action,'list');return pending.promise;
  }});
  const port=4346,handler=createRequestHandler(()=>port,()=>collectNotifications({},{mailClient:mail}),undefined,mail);
  async function request(url='/',{cookie='',body}={}){
    const method=body===undefined?'GET':'POST',headers={host:'127.0.0.1:'+port,cookie,...(body===undefined?{}:{origin:'http://127.0.0.1:'+port,'content-type':'application/json','x-context-request':'mail-request'})};
    const req={url,method,headers,async *[Symbol.asyncIterator](){if(body!==undefined)yield Buffer.from(JSON.stringify(body));}};
    const res={status:0,headers:{},body:'',writeHead(status,headers={}){this.status=status;this.headers=headers;},end(body=''){this.body=String(body);}};
    await handler(req,res);return res;
  }
  const cookie=(await request()).headers['Set-Cookie'].split(';')[0];
  const beforeDisconnect=request('/api/notifications',{cookie});await flush();
  assert.equal((await request('/api/mail/connection',{cookie,body:{disconnect:true}})).status,200);
  assert.equal(mail.status().configured,false);
  const afterDisconnect=request('/api/notifications?refresh=1',{cookie});await flush();
  pending.resolve({folder:'SU5CT1g',uidValidity:'1',items:[{uid:'1',subject:'Synthetic private subject',sender:'Synthetic sender',date:'2026-10-14T12:00:00Z'}]});
  await beforeDisconnect;
  const response=await afterDisconnect;assert.equal(response.status,200);
  const feed=JSON.parse(response.body);
  assert.equal(feed.sources.find(row=>row.source==='webmail').status,'not_configured','the disconnected account must override a stale failed collection');
  assert.deepEqual(parseFeedSnapshot(feed,[notice('webmail_previous')]).items,[],'previous private headers must disappear after disconnect');
  const cached=JSON.parse((await request('/api/notifications',{cookie})).body);
  assert.equal(cached.sources.find(row=>row.source==='webmail').status,'not_configured');
});

test('the actual app lifecycle restores feed refresh after a persisted pagehide/pageshow roundtrip',async t=>{
  const app=source(),start=app.indexOf('feedRefresh=createFeedRefresh('),end=app.indexOf('\nif(!storageAvailable)',start);
  assert.ok(start>=0&&end>start,'the fixture must execute the actual feed lifecycle wiring');
  const window=events(),timers={setTimeout(){return 0;},clearTimeout(){}};let calls=0;
  const calendarLifecycle=[];
  const context={window,calendarView:{pause:()=>calendarLifecycle.push('pause'),resume:()=>calendarLifecycle.push('resume'),dispose:()=>calendarLifecycle.push('dispose')},feedRefresh:undefined,feedRefreshStatus:{},hasLocalConnector:true,sourceStates:[{source:'gitlab',status:'connected'}],view:'today',modal:{open:false},searchModal:{open:false},invalidateSearch:()=>{},readFeed:async()=>{calls++;return {ok:true};},createFeedRefresh:options=>createFeedRefresh({...options,eventTarget:window,visibilityTarget:events(),getVisibility:()=>true,timers,now:()=>1000})};
  t.after(()=>context.feedRefresh?.dispose());
  vm.createContext(context);vm.runInContext(app.slice(start,end),context);await flush();assert.equal(calls,1);
  window.emit('pagehide',{persisted:true});window.emit('pageshow',{persisted:true});await flush();
  const beforeManual=calls;
  const result=await context.feedRefresh.request(true);
  assert.equal(result.accepted,true,'a restored cached page must keep manual and automatic refresh usable');
  assert.equal(calls,beforeManual+1);
  assert.deepEqual(calendarLifecycle,['pause','resume']);
  window.emit('pagehide',{persisted:false});assert.deepEqual(calendarLifecycle,['pause','resume','dispose']);
});

function readerFixture({fetch,previous=[notice('before')],notifications=true}={}){
  const app=source(),start=app.indexOf('async function readFeed('),end=app.indexOf('\nasync function toggleDesktopNotifications(',start);
  assert.ok(start>=0&&end>start);
  const changeStart=app.indexOf('function mailConnectionChanged('),changeEnd=app.indexOf('\nfunction inboxSyncStatus(',changeStart);
  assert.ok(changeStart>=0&&changeEnd>changeStart);
  const effects={renders:0,search:0,companion:0,toasts:[],notifications:[],timers:[],refreshRequests:0};
  function Notification(title,options){effects.notifications.push({title,...options});}Notification.permission='granted';
  const context={fetch,AbortSignal,DOMException,parseFeedSnapshot,notificationKey,feedBusy:false,feedEpoch:0,feedNeedsRefresh:false,remoteItems:previous,sourceStates:[{source:'webmail',status:'connected'},{source:'gitlab',status:'connected'}],hasLocalConnector:true,feedLastError:'',feedCheckedAt:'',view:'inbox',modal:{open:false},searchModal:{open:false},state:{projects:[],notificationSettings:{desktop:notifications}},seenRemoteIds:new Set(previous.map(notificationKey)),initialFeed:false,Notification,window:{Notification},render:()=>effects.renders++,invalidateSearch:()=>effects.search++,companion:{update:()=>effects.companion++},toast:value=>effects.toasts.push(value),setTimeout:callback=>effects.timers.push(callback),refreshFeed:()=>effects.refreshRequests++};
  vm.createContext(context);vm.runInContext(app.slice(changeStart,changeEnd)+'\n'+app.slice(start,end),context);
  return {read:options=>context.readFeed(options),change:(service,detail)=>context.mailConnectionChanged(service,detail),context,effects};
}
const response=data=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>data});

test('actual readFeed keeps failed rows, replaces successful rows, and OS notices contain no private content',async()=>{
  const f=readerFixture({previous:[notice('failed_old'),notice('success_old','gitlab')],fetch:async()=>response({items:[notice('success_new','gitlab')],sources:[{source:'webmail',status:'error'},{source:'gitlab',status:'connected'}],checkedAt:'2026-10-14T12:00:00Z'})});
  const result=await f.read({manual:true});assert.equal(result.ok,false);
  assert.deepEqual(Array.from(f.context.remoteItems,row=>row.id),['success_new','failed_old']);
  assert.equal(f.effects.notifications.length,1);assert.equal(f.effects.notifications[0].title,'Context');
  assert.doesNotMatch(JSON.stringify(f.effects.notifications),/Synthetic private subject|Synthetic sender|success_new|failed_old/);
  assert.equal(f.effects.search,1);assert.equal(f.effects.companion,1);
});

test('actual readFeed validates a complete response before importing course metadata or replacing visible rows',async()=>{
  const f=readerFixture({fetch:async()=>response({items:[{...notice('malformed'),url:'javascript:alert(1)'}],sources:[{source:'webmail',status:'connected'}],courses:[{id:'should-not-import',name:'Synthetic Course',url:'https://spaces.th-koeln.de/s/synthetic'}]})});
  const result=await f.read();assert.equal(result.ok,false);assert.equal(f.context.remoteItems[0].id,'before');assert.equal(f.context.state.projects.length,0);assert.equal(f.effects.notifications.length,0);
});

test('an abort during JSON decoding leaves messages, imported courses, toasts, and downstream consumers untouched',async()=>{
  const data=deferred(),controller=new AbortController();
  const f=readerFixture({fetch:async()=>({ok:true,headers:{get:()=> 'application/json'},json:()=>data.promise})});
  const read=f.read({signal:controller.signal,manual:true});await flush();controller.abort();
  data.resolve({items:[notice('late')],sources:[{source:'webmail',status:'connected'}],courses:[{id:'late-course',name:'Late course',url:'https://spaces.th-koeln.de/s/late'}]});
  await read;assert.equal(f.context.remoteItems[0].id,'before');assert.equal(f.context.state.projects.length,0);
  assert.equal(f.context.feedBusy,false);assert.equal(f.effects.notifications.length,0);assert.equal(f.effects.toasts.length,0);assert.equal(f.effects.search,0);assert.equal(f.effects.companion,0);
  assert.equal(f.effects.renders,1,'only the initial busy render may occur before abort');
});

test('actual connection invalidation removes old mail headers immediately and rejects a late decoded feed',async()=>{
  const data=deferred();
  const f=readerFixture({previous:[notice('old_mail'),notice('kept_gitlab','gitlab')],fetch:async()=>({ok:true,headers:{get:()=> 'application/json'},json:()=>data.promise})});
  const read=f.read();await flush();f.change('th',{action:'connection',configured:false});
  assert.deepEqual(Array.from(f.context.remoteItems,row=>row.id),['kept_gitlab']);
  assert.equal(f.context.sourceStates.find(row=>row.source==='webmail').status,'not_configured');
  data.resolve({items:[notice('late_old_mail')],sources:[{source:'webmail',status:'connected'}],courses:[{id:'stale-course',name:'Stale course',url:'https://spaces.th-koeln.de/s/stale'}]});
  await read;
  assert.deepEqual(Array.from(f.context.remoteItems,row=>row.id),['kept_gitlab']);assert.equal(f.context.state.projects.length,0);assert.equal(f.effects.notifications.length,0);assert.equal(f.context.feedLastError,'');
  assert.equal(f.effects.timers.length,1,'the new account must get a deferred refresh when the old request settles');
  assert.equal(f.effects.refreshRequests,0);f.effects.timers[0]();assert.equal(f.effects.refreshRequests,1);
});

test('a late request failure cannot relabel the newly disconnected mail account or unrelated connected sources',async()=>{
  const pending=deferred();const f=readerFixture({previous:[notice('old_mail'),notice('kept_gitlab','gitlab')],fetch:()=>pending.promise});
  const read=f.read({manual:true});await flush();f.change('th',{action:'connection',configured:false});pending.reject(new Error('Old account unavailable'));await read;
  assert.equal(f.context.sourceStates.find(row=>row.source==='webmail').status,'not_configured');assert.equal(f.context.sourceStates.find(row=>row.source==='gitlab').status,'connected');
  assert.equal(f.context.feedLastError,'');assert.deepEqual(f.effects.toasts,[]);assert.equal(f.effects.notifications.length,0);
});

test('flag/send invalidation preserves useful headers and changes in other mail accounts do not invalidate TH feed',async()=>{
  const f=readerFixture({fetch:async()=>response({items:[],sources:[]})});
  f.change('outlook',{action:'connection'});assert.equal(f.context.feedEpoch,0);assert.equal(f.context.remoteItems.length,1);assert.equal(f.effects.refreshRequests,0);
  f.change('th',{action:'flag'});assert.equal(f.context.remoteItems.length,1);assert.equal(f.context.sourceStates[0].status,'connected');assert.equal(f.effects.refreshRequests,1);
  f.change('th',{action:'send'});assert.equal(f.context.remoteItems.length,1);assert.equal(f.effects.refreshRequests,2);
});

test('persisted pagehide preserves search while a terminal pagehide disposes it',()=>{
  const app=source(),hook=app.split('\n').find(line=>line.includes("window.addEventListener('pagehide'")&&line.includes('searchView.dispose'));
  assert.ok(hook,'the fixture must exercise the actual search cleanup hook');
  const window=events();let disposed=0,spacesDisposed=0,crawlDisposed=0,crawlPaused=0;const context={window,sourceHub:{dispose:()=>{}},spacesSearch:{dispose:()=>spacesDisposed++},searchView:{dispose:()=>disposed++},crawlerView:{dispose:()=>crawlDisposed++,pause:()=>crawlPaused++}};vm.createContext(context);vm.runInContext(hook,context);
  window.emit('pagehide',{persisted:true});assert.equal(disposed,0);assert.equal(spacesDisposed,0);assert.equal(crawlDisposed,0);assert.equal(crawlPaused,1);window.emit('pagehide',{persisted:false});assert.equal(disposed,1);assert.equal(spacesDisposed,1);assert.equal(crawlDisposed,1);assert.equal(crawlPaused,1);
});
