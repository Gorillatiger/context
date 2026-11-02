import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {EventEmitter,getEventListeners} from 'node:events';
import {readScript,crawlerURL} from '../desktop/reader.mjs';
import {safeSpacesURL} from '../dist/agent-browser.js';
import {readerPlatformLinks} from '../desktop/platform-link-policy.mjs';
import {browserURL} from '../desktop/policy.mjs';

const COURSE='https://spaces.th-koeln.de/synthetic-course/',HASH='a'.repeat(64),NEXT='b'.repeat(64);
const source=readFileSync(new URL('../desktop/main.mjs',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function scanTab()'),source.indexOf('await app.whenReady()'));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(t,{loadHook,readHook,status=200}={}){
 const loads=[],events=[],throttle=[],executed=[],settleDelays=[],settleTimers=new Set(),wc=new EventEmitter();let current=COURSE,revision=HASH,stops=0;
 const schedule=(callback,delay)=>{if(delay!==350)return setTimeout(callback,delay);settleDelays.push(delay);const timer=setTimeout(()=>{settleTimers.delete(timer);callback();},delay);settleTimers.add(timer);return timer;};
 const unschedule=timer=>{settleTimers.delete(timer);clearTimeout(timer);};
 const tab={id:'board-scan',view:{webContents:wc},epoch:0,links:new Set(),controls:new Set(),readAt:''};
 wc.isDestroyed=()=>false;wc.isLoading=()=>false;wc.getURL=()=>current;wc.setBackgroundThrottling=value=>throttle.push(value);wc.stop=()=>{stops++;};
 wc.loadURL=url=>{loads.push(url);current=url;tab.epoch++;tab.links.clear();tab.controls.clear();tab.readAt='';tab.httpURL=url;tab.httpStatus=status;return loadHook?.(url,loads.length)||Promise.resolve();};
 wc.executeJavaScriptInIsolatedWorld=async(_world,scripts)=>{
  const script=scripts[0].code;executed.push(script);
  if(script.startsWith('new Promise(resolve=>{const el=')){revision=NEXT;return;}
  let options={offset:0,linkOffset:0,controlOffset:0};const marker=script.indexOf(')({"offset":');if(marker>=0)options=JSON.parse(script.slice(marker+2,script.indexOf(',function crawlerURL',marker)));
  const page={url:current,title:'Synthetic course',text:'Visible text',offset:options.offset,nextOffset:options.offset+12,totalLength:12,hasMore:false,textTruncated:false,contentRevision:revision,links:[{title:'Observed post',url:COURSE+'post/'}],linkOffset:options.linkOffset,totalLinks:1,linksHasMore:false,controls:[{id:options.controlOffset?'accordion-item-later':'secondary-swap-menu-label',title:'Observed course section'}],controlOffset:options.controlOffset,totalControls:31,controlsMore:!options.controlOffset,boardLinks:[],metadata:{sourceURL:current,postedAt:''}};
  return readHook?.(page,options,executed.length)||page;
 };
 const sandbox={desktopMiroLinks:undefined,boardScanTab:tab,boardScanQueue:Promise.resolve(),activeScanRequest:undefined,crawlLease:undefined,crawlLeaseTimer:undefined,requests:new Map(),tabs:new Map(),active:'',requestsFromFixture:[],safeSpacesURL,browserURL,crawlerURL,readScript,readerPlatformLinks,
  boardFinding:()=>{throw Error('Synthetic legacy has no Miro links');},emit:(type,value)=>events.push({type,...structuredClone(value)}),setTimeout:schedule,clearTimeout:unschedule,AbortController,DOMException,displayURL:URL=>URL,
 };
 vm.createContext(sandbox);vm.runInContext(code,sandbox);t.after(()=>vm.runInContext('clearCrawlLease()',sandbox));
 const call=message=>{sandbox.message=message;return vm.runInContext('agent(message)',sandbox);};
 const crawler=(command,patch={})=>({type:'request',id:randomUUID(),scan:true,crawler:true,jobId:randomUUID(),command,...patch});
 return {tab,wc,sandbox,loads,events,throttle,executed,settleDelays,settleTimers,call,crawler,get stops(){return stops;},setRevision:value=>{revision=value;},navigate:url=>{current=url;tab.epoch++;},reply:id=>events.find(event=>event.id===id)};
}

test('crawler leases isolate every native scan command until release without touching user tabs',async t=>{
 const f=fixture(t),start=f.crawler('start',{url:COURSE,courseURL:COURSE});await f.call(start);assert.equal(f.reply(start.id).contentRevision,HASH);assert.equal(f.reply(start.id).epoch,1);assert.equal(f.sandbox.crawlLease.jobId,start.jobId);
 const board={type:'request',id:randomUUID(),command:'start',scan:true,url:COURSE+'board/'};await f.call(board);assert.match(f.reply(board.id).error,/andere Spaces-Prüfung/);assert.deepEqual(f.loads,[COURSE]);
 const release=f.crawler('release',{jobId:start.jobId});await f.call(release);assert.equal(f.reply(release.id).released,true);assert.equal(f.sandbox.crawlLease,undefined);
 const legacy={...board,id:randomUUID()};await f.call(legacy);assert.equal(f.reply(legacy.id).error,undefined);assert.deepEqual(f.loads,[COURSE,COURSE+'board/']);assert.equal(f.sandbox.tabs.size,0);assert.deepEqual(f.throttle,[false,true,false,true]);
});

test('a different crawler job cannot replace the leased view and cannot release its owner',async t=>{
 const f=fixture(t),start=f.crawler('start',{url:COURSE,courseURL:COURSE});await f.call(start);
 const other=f.crawler('start',{url:COURSE+'second/',courseURL:COURSE});await f.call(other);assert.match(f.reply(other.id).error,/andere Spaces-Prüfung/);assert.deepEqual(f.loads,[COURSE]);
 const release=f.crawler('release',{jobId:other.jobId});await f.call(release);assert.match(f.reply(release.id).error,/andere Spaces-Prüfung/);assert.equal(f.sandbox.crawlLease.jobId,start.jobId);
});

test('revision fencing rejects changed text before returning data or executing an observed control',async t=>{
 const f=fixture(t),start=f.crawler('start',{url:COURSE,courseURL:COURSE});await f.call(start);f.setRevision(NEXT);
 const click=f.crawler('click',{jobId:start.jobId,controlId:'secondary-swap-menu-label',expectedRevision:HASH});await f.call(click);
 assert.match(f.reply(click.id).error,/Kursinhalt hat sich geändert/);assert.ok(!f.executed.some(script=>script.startsWith('new Promise(resolve=>{const el=')));assert.equal(f.sandbox.crawlLease,undefined);
});

test('observed control pages accumulate only within one revision and clicks return the new snapshot',async t=>{
 const f=fixture(t),start=f.crawler('start',{url:COURSE,courseURL:COURSE});await f.call(start);
 const page=f.crawler('read',{jobId:start.jobId,controlOffset:30,expectedRevision:HASH});await f.call(page);assert.ok(f.tab.controls.has('accordion-item-later'));assert.ok(f.tab.controls.has('secondary-swap-menu-label'));
 const click=f.crawler('click',{jobId:start.jobId,controlId:'accordion-item-later',expectedRevision:HASH});await f.call(click);assert.equal(f.reply(click.id).contentRevision,NEXT);assert.equal(f.reply(click.id).error,undefined);
});

test('cancelling an active accepted load stops it and releases the reader before that load promise settles',async t=>{
 const load=deferred(),f=fixture(t,{loadHook:(_url,index)=>index===1?load.promise:undefined}),start=f.crawler('start',{url:COURSE,courseURL:COURSE});
 const pending=f.call(start);await tick();assert.equal(f.loads.length,1);await f.call({type:'cancel',id:start.id});await pending;
 assert.equal(f.stops,1);assert.equal(f.sandbox.requests.size,0);assert.equal(f.sandbox.crawlLease,undefined);assert.equal(f.reply(start.id),undefined);
 const next=f.crawler('start',{url:COURSE+'next/',courseURL:COURSE});await f.call(next);assert.equal(f.reply(next.id).error,undefined);assert.equal(f.loads.length,2);load.resolve();await tick();assert.equal(f.reply(start.id),undefined);
});

test('cancelling a queued command skips its load but never allows a later command to overtake the active scan',async t=>{
 const load=deferred(),f=fixture(t,{loadHook:(_url,index)=>index===1?load.promise:undefined});
 const first={type:'request',id:randomUUID(),scan:true,command:'start',url:COURSE+'first/'},queued=f.crawler('start',{url:COURSE+'cancelled/',courseURL:COURSE}),last={...first,id:randomUUID(),url:COURSE+'last/'};
 const p1=f.call(first);await tick();const p2=f.call(queued);const p3=f.call(last);await f.call({type:'cancel',id:queued.id});await p2;await tick();assert.deepEqual(f.loads,[first.url]);assert.equal(f.stops,0);
 load.resolve();await Promise.all([p1,p3]);assert.deepEqual(f.loads,[first.url,last.url]);assert.equal(f.reply(queued.id),undefined);assert.equal(f.sandbox.requests.size,0);
});

test('a cancelled load-wait removes its listener and timer rather than occupying the worker turn',async t=>{
 const f=fixture(t);f.wc.isLoading=()=>true;const record={id:randomUUID(),controller:new AbortController()};f.sandbox.record=record;
 const pending=vm.runInContext('loaded(boardScanTab,record)',f.sandbox);assert.equal(f.wc.listenerCount('did-stop-loading'),1);record.controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(f.wc.listenerCount('did-stop-loading'),0);
});

test('HTTP403 and HTTP401 return explicit access/login state without reading the page DOM',async t=>{
 for(const status of [403,401]){const f=fixture(t,{status}),start=f.crawler('start',{url:COURSE,courseURL:COURSE});await f.call(start);const page=f.reply(start.id);assert.equal(f.executed.length,0);assert.equal(page.text,'');assert.deepEqual(page.links,[]);assert.equal(status===403?page.permissionRequired:page.loginRequired,true);if(status===403)assert.equal(page.accessDenied,true);}
});

test('epoch changes during an accepted DOM read cannot return stale course text',async t=>{
 const reply=deferred(),f=fixture(t,{readHook:page=>reply.promise}),start=f.crawler('start',{url:COURSE,courseURL:COURSE});const pending=f.call(start);await tick();f.tab.epoch++;reply.resolve({url:COURSE,title:'Synthetic',text:'STALE_BODY',links:[],controls:[],contentRevision:HASH});await pending;
 assert.match(f.reply(start.id).error,/Browserseite hat sich geändert/);assert.doesNotMatch(JSON.stringify(f.reply(start.id)),/STALE_BODY/);assert.equal(f.sandbox.crawlLease,undefined);
});

test('invalid crawler identity, scope or encoded traversal never causes an accepted page load',async t=>{
 const f=fixture(t);await assert.rejects(f.call(f.crawler('start',{scan:false,url:COURSE,courseURL:COURSE})),/Crawler-Auftrag/);await assert.rejects(f.call(f.crawler('start',{jobId:'not-a-job',url:COURSE,courseURL:COURSE})),/Crawler-Auftrag/);
 for(const url of [COURSE+'%252e%252e/other/','https://spaces.th-koeln.de/another-course/','https://spaces.th-koeln.de/']){const start=f.crawler('start',{url,courseURL:COURSE});await f.call(start);assert.ok(f.reply(start.id).error);}
 assert.deepEqual(f.loads,[]);assert.equal(f.sandbox.requests.size,0);
});

test('cancelled request/job IDs can be reused without old cleanup deleting the new lease or request',async t=>{
 const firstLoad=deferred(),secondLoad=deferred(),f=fixture(t,{loadHook:(_url,index)=>index===1?firstLoad.promise:index===2?secondLoad.promise:undefined}),first=f.crawler('start',{url:COURSE,courseURL:COURSE});
 const p1=f.call(first);await tick();await f.call({type:'cancel',id:first.id});const reused={...first,url:COURSE+'reused/'};const p2=f.call(reused);await p1;await tick();
 assert.equal(f.loads.length,2);assert.equal(f.sandbox.requests.size,1);assert.equal(f.sandbox.crawlLease.jobId,first.jobId);secondLoad.resolve();await p2;assert.equal(f.reply(first.id).url,reused.url);assert.equal(f.sandbox.crawlLease.jobId,first.jobId);
 firstLoad.resolve();await tick();assert.equal(f.events.filter(e=>e.id===first.id).length,1);
});

test('native shutdown cancels active and queued reads, clears the idle lease and never executes a queued load',async t=>{
 const load=deferred(),f=fixture(t,{loadHook:()=>load.promise}),first=f.crawler('start',{url:COURSE,courseURL:COURSE}),second=f.crawler('start',{url:COURSE+'never/',courseURL:COURSE});
 const p1=f.call(first);await tick();const p2=f.call(second);vm.runInContext('cancelAgentRequests()',f.sandbox);await Promise.all([p1,p2]);assert.equal(f.sandbox.requests.size,0);assert.equal(f.sandbox.crawlLease,undefined);assert.equal(f.sandbox.crawlLeaseTimer,undefined);assert.deepEqual(f.loads,[COURSE]);assert.equal(f.events.length,0);assert.equal(f.stops,1);
 assert.match(source,/win\.on\('closed',\(\)=>\{cancelAgentRequests\(\)/);assert.match(source,/quitPending=true;cancelAgentRequests\(\)/);load.resolve();await tick();assert.equal(f.events.length,0);
});

test('the initial snapshot waits through DOM hydration until two revisions agree 350ms apart',async t=>{
 let reads=0;const f=fixture(t,{readHook:page=>({...page,contentRevision:++reads===1?HASH:NEXT,text:reads===1?'INITIAL_SHELL':'HYDRATED_COURSE'})}),start=f.crawler('start',{url:COURSE,courseURL:COURSE});
 const pending=f.call(start);await tick();assert.equal(reads,1);assert.equal(f.reply(start.id),undefined);assert.equal(f.tab.links.size,0);assert.equal(f.settleTimers.size,1);
 await pending;assert.equal(reads,3);assert.deepEqual(f.settleDelays,[350,350]);assert.equal(f.settleTimers.size,0);assert.equal(f.reply(start.id).text,'HYDRATED_COURSE');assert.equal(f.reply(start.id).contentRevision,NEXT);assert.doesNotMatch(JSON.stringify(f.events),/INITIAL_SHELL/);
});

test('continuously changing initial content exhausts four bounded waits without publishing a partial or full source',async t=>{
 let reads=0;const f=fixture(t,{readHook:page=>({...page,contentRevision:(++reads).toString(16).padStart(64,'0'),text:'UNSTABLE_COURSE_'+reads})}),start=f.crawler('start',{url:COURSE,courseURL:COURSE});
 await f.call(start);assert.equal(reads,5);assert.deepEqual(f.settleDelays,[350,350,350,350]);assert.equal(f.settleTimers.size,0);assert.match(f.reply(start.id).error,/noch nicht stabil/);assert.equal(f.reply(start.id).text,undefined);assert.equal(f.reply(start.id).contentRevision,undefined);assert.doesNotMatch(JSON.stringify(f.events),/UNSTABLE_COURSE/);assert.equal(f.tab.links.size,0);assert.equal(f.sandbox.crawlLease,undefined);
});

test('cancelling the hydration wait removes its timer and abort listener and immediately releases the native queue',async t=>{
 const f=fixture(t),start=f.crawler('start',{url:COURSE,courseURL:COURSE}),pending=f.call(start);await tick();const record=f.sandbox.requests.get(start.id);
 assert.equal(f.executed.length,1);assert.equal(f.settleTimers.size,1);assert.equal(getEventListeners(record.controller.signal,'abort').length,1);
 await f.call({type:'cancel',id:start.id});await pending;assert.equal(f.settleTimers.size,0);assert.equal(getEventListeners(record.controller.signal,'abort').length,0);assert.equal(f.reply(start.id),undefined);assert.equal(f.sandbox.requests.size,0);assert.equal(f.sandbox.crawlLease,undefined);assert.equal(f.stops,1);
 const next={type:'request',id:randomUUID(),scan:true,command:'start',url:COURSE+'legacy/'};await f.call(next);assert.equal(f.reply(next.id).error,undefined);assert.equal(f.executed.length,2);assert.deepEqual(f.loads,[COURSE,next.url]);assert.equal(f.settleDelays.length,1);
});

test('epoch or URL changes during the hydration wait reject before another DOM snapshot can be read',async t=>{
 for(const change of ['epoch','url']){const f=fixture(t),start=f.crawler('start',{url:COURSE,courseURL:COURSE}),pending=f.call(start);await tick();if(change==='epoch')f.tab.epoch++;else f.wc.getURL=()=>COURSE+'changed/';await pending;
  assert.match(f.reply(start.id).error,/Browserseite hat sich geändert/);assert.equal(f.executed.length,1);assert.equal(f.reply(start.id).text,undefined);assert.equal(f.settleTimers.size,0);assert.equal(f.sandbox.crawlLease,undefined);
 }
});

test('revision-fenced follow-up reads, nonzero paging cursors and legacy reads do not wait for DOM settling',async t=>{
 const f=fixture(t),start=f.crawler('start',{url:COURSE,courseURL:COURSE});await f.call(start);const initialWaits=f.settleDelays.length;
 for(const patch of [{expectedRevision:HASH},{offset:5000},{linkOffset:45},{controlOffset:30}]){const read=f.crawler('read',{jobId:start.jobId,...patch}),before=f.executed.length;await f.call(read);assert.equal(f.reply(read.id).error,undefined);assert.equal(f.executed.length,before+1);assert.equal(f.settleDelays.length,initialWaits);}
 const release=f.crawler('release',{jobId:start.jobId});await f.call(release);const legacy={type:'request',id:randomUUID(),command:'read',scan:true};await f.call(legacy);assert.equal(f.reply(legacy.id).error,undefined);assert.equal(f.settleDelays.length,initialWaits);
});

test('an HTML login or access-denied snapshot bypasses revision and settling guards while returning no protected body',async t=>{
 for(const flags of [{loginRequired:true},{permissionRequired:true,accessDenied:true}])for(const appearsAfterFirst of [false,true]){
  let reads=0;const f=fixture(t,{readHook:page=>++reads===1&&appearsAfterFirst?page:{...flags,url:'https://spaces.th-koeln.de/',text:'PRIVATE_LOGIN_BODY',title:'PRIVATE_LOGIN_TITLE',links:[{url:COURSE+'hidden/'}],controls:[{id:'secondary-swap-menu-label'}]}}),start=f.crawler('start',{url:COURSE,courseURL:COURSE});await f.call(start);const reply=f.reply(start.id);
  assert.equal(reply.error,undefined);assert.equal(reply.url,COURSE);assert.equal(reply.text,'');assert.deepEqual(reply.links,[]);assert.deepEqual(reply.controls,[]);assert.equal(reply.loginRequired,flags.loginRequired===true);assert.equal(reply.permissionRequired,flags.permissionRequired===true);assert.equal(reply.contentRevision,undefined);assert.equal(reads,appearsAfterFirst?2:1);assert.equal(f.settleDelays.length,appearsAfterFirst?1:0);assert.equal(f.tab.readAt,'');assert.equal(f.tab.links.size,0);assert.doesNotMatch(JSON.stringify(reply),/PRIVATE_LOGIN|hidden/);
 }
});
