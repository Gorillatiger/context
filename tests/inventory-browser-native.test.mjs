import test from 'node:test';
import assert from 'node:assert/strict';
import {createInventoryBrowser} from '../desktop/inventory-browser.mjs';

const ROOT='https://inventory.coco.study/';
const attach={type:'inventory',action:'attach'},home={type:'inventory',action:'home'},detach={type:'inventory',action:'detach'};
function fixture({create,navigate}={}){
 const tabs=new Map(),created=[],selected=[],navigated=[];let next=0;
 const make=url=>{let destroyed=false;const tab={id:String(++next),url,view:{webContents:{isDestroyed:()=>destroyed,getURL:()=>tab.url}}};tab.destroy=()=>{destroyed=true;};tabs.set(tab.id,tab);return tab;};
 const api=createInventoryBrowser({getTab:id=>tabs.get(id),createTab:async url=>{created.push(url);return create?create(url,make):make(url);},selectTab:id=>{selected.push(id);},navigateTab:async(id,url)=>{navigated.push({id,url});if(navigate)await navigate(id,url);else tabs.get(id).url=url;}});
 return {api,tabs,created,selected,navigated,make};
}
async function immediateDetach(api){let timer;try{return await Promise.race([api.handle(detach),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('detach waited behind pending work')),250);})]);}finally{clearTimeout(timer);}}

test('the inventory shortcut opens only its fixed root and performs no work before attach',async()=>{
 const f=fixture();assert.deepEqual(f.created,[]);assert.deepEqual(f.selected,[]);
 const result=await f.api.handle(attach);
 assert.deepEqual(f.created,[ROOT]);assert.equal(result.tabId,'1');assert.equal(f.selected.at(-1),'1');assert.deepEqual(f.navigated,[]);
});

test('returning to the inventory preserves the selected item and does not reload it',async()=>{
 const f=fixture(),first=await f.api.handle(attach);
 f.tabs.get(first.tabId).url=ROOT+'items/synthetic-camera';
 const returned=await f.api.handle(attach);
 assert.equal(returned.tabId,first.tabId);assert.equal(f.tabs.get(first.tabId).url,ROOT+'items/synthetic-camera');
 assert.deepEqual(f.created,[ROOT]);assert.deepEqual(f.navigated,[]);
});

test('an authentication redirect keeps the dedicated tab instead of restarting sign-in',async()=>{
 const f=fixture(),first=await f.api.handle(attach);
 f.tabs.get(first.tabId).url='https://auth.coco.study/auth/realms/coco/protocol/openid-connect/auth?state=synthetic';
 const returned=await f.api.handle(attach);
 assert.equal(returned.tabId,first.tabId);assert.equal(f.created.length,1);assert.equal(f.navigated.length,0);
});

test('an unrelated active tab is never adopted as the embedded inventory',async()=>{
 const f=fixture(),other=f.make('https://spaces.th-koeln.de/synthetic-course/');
 const result=await f.api.handle(attach);
 assert.notEqual(result.tabId,other.id);assert.equal(f.tabs.get(other.id).url,'https://spaces.th-koeln.de/synthetic-course/');
 assert.equal(f.tabs.get(result.tabId).url,ROOT);assert.equal(f.created.length,1);
});

test('closing the dedicated tab recreates it once at the fixed inventory root',async()=>{
 const f=fixture(),first=await f.api.handle(attach);f.tabs.delete(first.tabId);
 const next=await f.api.handle(attach),again=await f.api.handle(attach);
 assert.notEqual(next.tabId,first.tabId);assert.equal(again.tabId,next.tabId);assert.deepEqual(f.created,[ROOT,ROOT]);
});

test('a destroyed webContents cannot be reused as a working inventory tab',async()=>{
 const f=fixture(),first=await f.api.handle(attach);f.tabs.get(first.tabId).destroy();
 const next=await f.api.handle(attach);
 assert.notEqual(next.tabId,first.tabId);assert.deepEqual(f.created,[ROOT,ROOT]);
});

test('simultaneous mounting creates one inventory tab while initial creation is pending',async()=>{
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const f=fixture({create:async(url,make)=>{entered();await gate;return make(url);}});
 const pending=Array.from({length:12},()=>f.api.handle(attach));await started;
 assert.equal(f.created.length,1);release();const results=await Promise.all(pending);
 assert.equal(new Set(results.map(result=>result.tabId)).size,1);assert.deepEqual(f.created,[ROOT]);
});

test('failed creation can be retried without a poisoned pending promise',async()=>{
 let broken=true;const f=fixture({create:async(url,make)=>{if(broken)throw new Error('synthetic creation failed');return make(url);}});
 await assert.rejects(f.api.handle(attach),/synthetic creation failed/);broken=false;
 const result=await f.api.handle(attach);assert.equal(f.tabs.get(result.tabId).url,ROOT);assert.equal(f.created.length,2);
});

test('home explicitly navigates the owned tab back to the inventory root',async()=>{
 const f=fixture(),first=await f.api.handle(attach);f.tabs.get(first.tabId).url=ROOT+'items/synthetic-projector';
 const result=await f.api.handle(home);
 assert.equal(result.tabId,first.tabId);assert.deepEqual(f.navigated,[{id:first.tabId,url:ROOT}]);assert.equal(f.created.length,1);
});

test('navigation failure does not orphan the existing inventory tab or create another on return',async()=>{
 const f=fixture({navigate:async()=>{throw new Error('synthetic navigation failed');}}),first=await f.api.handle(attach);
 f.tabs.get(first.tabId).url=ROOT+'items/synthetic-projector';
 await assert.rejects(f.api.handle(home),/synthetic navigation failed/);
 const next=await f.api.handle(attach);assert.equal(next.tabId,first.tabId);assert.equal(f.created.length,1);
});

test('concurrent attach and explicit home share one dedicated tab',async()=>{
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const f=fixture({create:async(url,make)=>{entered();await gate;return make(url);}});
 const first=f.api.handle(attach),second=f.api.handle(home);await started;release();
 const [a,b]=await Promise.all([first,second]);assert.equal(a.tabId,b.tabId);assert.deepEqual(f.created,[ROOT]);
 assert(f.navigated.every(entry=>entry.id===a.tabId&&entry.url===ROOT));
});

test('detach cancels a pending attach immediately and a later return reuses its created tab',async()=>{
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const f=fixture({create:async(url,make)=>{entered();await gate;return make(url);}});
 const pending=f.api.handle(attach);await started;
 let timer;
 try{
  const detached=await Promise.race([f.api.handle(detach),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('detach waited behind pending creation')),250);})]);
  assert.equal(detached.detached,true);assert.deepEqual(f.selected,[]);
 }finally{clearTimeout(timer);release();}
 const cancelled=await pending;
 assert.equal(cancelled.detached,true);assert.deepEqual(f.selected,[],'a hidden inventory cannot select itself after creation resolves');
 const returned=await f.api.handle(attach);
 assert.equal(returned.tabId,cancelled.tabId);assert.equal(f.created.length,1);assert.equal(f.selected.at(-1),returned.tabId);
});

test('detach invalidates already queued attach and home intents before they select or navigate',async()=>{
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const f=fixture({create:async(url,make)=>{entered();await gate;return make(url);}});
 const creating=f.api.handle(attach);await started;
 const queuedAttach=f.api.handle(attach),queuedHome=f.api.handle(home);
 try{await immediateDetach(f.api);}finally{release();}
 const cancelled=await Promise.all([creating,queuedAttach,queuedHome]);
 assert(cancelled.every(result=>result.detached===true));assert.deepEqual(f.selected,[]);assert.deepEqual(f.navigated,[]);
 const returned=await f.api.handle(attach);assert.equal(f.selected.at(-1),returned.tabId);assert.equal(f.created.length,1);
});

test('detaching during an explicit home load prevents a late selection after navigation completes',async()=>{
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const f=fixture({navigate:async()=>{entered();await gate;}}),first=await f.api.handle(attach);
 const pending=f.api.handle(home);await started;const selectionsBeforeDetach=f.selected.length;
 try{await immediateDetach(f.api);}finally{release();}
 const cancelled=await pending;
 assert.equal(cancelled.tabId,first.tabId);assert.equal(cancelled.detached,true);assert.equal(f.selected.length,selectionsBeforeDetach);
 const returned=await f.api.handle(attach);assert.equal(returned.tabId,first.tabId);assert.equal(f.created.length,1);
});

test('typed inventory requests reject URL, ID and unknown fields before performing any browser action',async()=>{
 const f=fixture();
 for(const value of [null,[],{},'attach',{type:'browser',action:'attach'},{type:'inventory',action:'delete'},{type:'inventory',action:'attach',url:'https://evil.test/'},{type:'inventory',action:'attach',id:'other-tab'},{type:'inventory',action:'home',force:true},{type:'inventory',action:'detach',id:'other-tab'}]){
  await assert.rejects(async()=>f.api.handle(value));
 }
 assert.deepEqual(f.created,[]);assert.deepEqual(f.selected,[]);assert.deepEqual(f.navigated,[]);
});

test('surface ownership rejects other tabs, detached frames and a previous generation after return',async()=>{
 const f=fixture(),first=await f.api.handle(attach);
 const frame={owner:'inventory',id:first.tabId,surfaceToken:first.surfaceToken};
 assert.equal(f.api.owns(first.tabId),true);assert.equal(f.api.owns('another-tab'),false);
 assert.equal(f.api.acceptsFrame(frame,first.tabId),true);
 assert.equal(f.api.acceptsFrame({...frame,owner:'browser'},first.tabId),false);
 assert.equal(f.api.acceptsFrame({...frame,id:'another-tab'},first.tabId),false);
 assert.equal(f.api.acceptsFrame(frame,'another-tab'),false);
 await f.api.handle(detach);assert.equal(f.api.acceptsFrame(frame,first.tabId),false);
 const returned=await f.api.handle(attach);assert.equal(returned.tabId,first.tabId);assert.notEqual(returned.surfaceToken,first.surfaceToken);
 assert.equal(f.api.acceptsFrame(frame,first.tabId),false);
 assert.equal(f.api.acceptsFrame({...frame,surfaceToken:returned.surfaceToken},returned.tabId),true);
 f.tabs.get(returned.tabId).destroy();assert.equal(f.api.owns(returned.tabId),false);assert.equal(f.api.acceptsFrame({...frame,surfaceToken:returned.surfaceToken},returned.tabId),false);
});
