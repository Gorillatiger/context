import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chatFilterScript,createDesktopChatFilter,namedChatId} from '../desktop/chat-filter.mjs';
import {runtimeFixture} from './support/chat-filter-runtime-fixture.mjs';

const selected={id:namedChatId('CoCo Team'),title:'CoCo Team'};
function barrier(){let release,entered;return {wait:new Promise(resolve=>{release=resolve;}),at:new Promise(resolve=>{entered=resolve;}),release:()=>release(),entered:()=>entered()};}

test('cleanup cancels an overlay click before its asynchronous title check completes',async t=>{
 const fixture=runtimeFixture(t,chatFilterScript);
 await fixture.execute({op:'configure',enabled:true,selected:[selected]});
 const gate=barrier();fixture.setDigestHook(()=>{gate.entered();return gate.wait;});
 const pending=Promise.resolve(fixture.buttons()[0].click()).catch(()=>{});
 await gate.at;await fixture.execute({op:'cleanup'});gate.release();await pending;
 assert.deepEqual(fixture.clicks,[],'closing CoCo focus must prevent the old overlay from opening any chat');
 assert.equal(fixture.overlay(),undefined);
 assert(fixture.observers.every(observer=>observer.disconnected));
 assert.equal(fixture.listeners.size,0);
});

test('cleanup cancels a pending isolated-world open request, not only its status update',async t=>{
 const fixture=runtimeFixture(t,chatFilterScript);
 await fixture.execute({op:'configure',enabled:true,selected:[selected]});
 const gate=barrier();fixture.setDigestHook(()=>{gate.entered();return gate.wait;});
 const pending=fixture.execute({op:'open',id:selected.id}).catch(()=>({opened:false}));
 await gate.at;await fixture.execute({op:'cleanup'});gate.release();const result=await pending;
 assert.deepEqual(fixture.clicks,[],'cleanup must fence the actual click after an awaited DOM check');
 assert.equal(result.opened,false);
});

test('cancelling a pending lookup permits a later opening without an old click or stale busy flag',async t=>{
 const fixture=runtimeFixture(t,chatFilterScript);
 await fixture.execute({op:'configure',enabled:true,selected:[selected],lease:'first-session'});
 const gate=barrier();fixture.setDigestHook(()=>{gate.entered();return gate.wait;});
 const pending=fixture.execute({op:'open',id:selected.id,lease:'first-session'}).catch(()=>({opened:false}));
 await gate.at;await fixture.execute({op:'cancel'});
 fixture.setDigestHook(undefined);
 await fixture.execute({op:'configure',enabled:true,selected:[selected],lease:'second-session'});
 const next=await fixture.execute({op:'open',id:selected.id,lease:'second-session'});
 assert.equal(next.opened,true,'a cancelled lookup cannot permanently block the next session');
 assert.deepEqual(fixture.clicks,['CoCo Team']);
 gate.release();const previous=await pending;
 assert.equal(previous.opened,false,'the first session remains cancelled after a later opening');
 assert.deepEqual(fixture.clicks,['CoCo Team'],'the released old request cannot click a second time');
 assert.equal(fixture.buttons()[0].disabled,false);
});

test('tab changes cancel pending native opening without waiting behind its operation queue',async t=>{
 const fixture=runtimeFixture(t,chatFilterScript),directory=await mkdtemp(path.join(os.tmpdir(),'context-filter-race-'));
 let gate;
 const webContents={isDestroyed:()=>false,insertCSS:async()=> 'test-css',removeInsertedCSS:async()=>{},executeJavaScriptInIsolatedWorld:async(_world,scripts)=>{
  const code=scripts[0].code,command=JSON.parse(code.slice(code.lastIndexOf(')(')+2,-1));
  if(command.op==='open'&&gate)fixture.setDigestHook(()=>{gate.entered();return gate.wait;});
  return fixture.runScript(code);
 }};
 let active={id:'one',epoch:1,url:'https://web.whatsapp.com/',webContents};
 const filter=createDesktopChatFilter({directory,crypto:{isAsyncEncryptionAvailable:async()=>false},getActive:()=>active,platform:'darwin'});
 t.after(async()=>{await filter.dispose();await rm(directory,{recursive:true,force:true});});
 await filter.handle({op:'discover'});await filter.handle({op:'set',enabled:true,selected:[selected]});
 gate=barrier();
 const pending=filter.handle({op:'open',id:selected.id}).catch(()=>({opened:false}));
 await gate.at;active={...active,id:'two',epoch:2,url:'https://example.invalid/'};filter.schedule();
 // schedule's regular refresh is delayed; cancellation has to be immediate.
 await new Promise(resolve=>setTimeout(resolve,140));gate.release();await pending;
 assert.deepEqual(fixture.clicks,[],'switching away must cancel the prior tab before the queued refresh runs');
 await filter.flush();
});

test('rapid native picker open-close cancels a lookup and reactivates a usable selection',async t=>{
 const fixture=runtimeFixture(t,chatFilterScript),directory=await mkdtemp(path.join(os.tmpdir(),'context-filter-picker-race-'));
 let gate;
 const webContents={isDestroyed:()=>false,insertCSS:async()=> 'test-css',removeInsertedCSS:async()=>{},executeJavaScriptInIsolatedWorld:async(_world,scripts)=>{
  const code=scripts[0].code,command=JSON.parse(code.slice(code.lastIndexOf(')(')+2,-1));
  if(command.op==='open'&&gate)fixture.setDigestHook(()=>{gate.entered();return gate.wait;});
  return fixture.runScript(code);
 }};
 const active={id:'one',epoch:1,url:'https://web.whatsapp.com/',webContents};
 const filter=createDesktopChatFilter({directory,crypto:{isAsyncEncryptionAvailable:async()=>false},getActive:()=>active,platform:'darwin'});
 t.after(async()=>{await filter.dispose();await rm(directory,{recursive:true,force:true});});
 await filter.handle({op:'discover'});await filter.handle({op:'set',enabled:true,selected:[selected]});
 gate=barrier();const pending=filter.handle({op:'open',id:selected.id}).catch(()=>({opened:false}));
 await gate.at;
 const showing=filter.handle({op:'picker',open:true}),closing=filter.handle({op:'picker',open:false});
 gate.release();const cancelled=await pending;gate=undefined;fixture.setDigestHook(undefined);
 await showing;const closed=await closing;
 assert.equal(cancelled.opened,false);assert.deepEqual(fixture.clicks,[]);
 assert.equal(closed.enabled,true);assert.equal(closed.pickerOpen,false);assert(fixture.overlay());
 const opened=await filter.handle({op:'open',id:selected.id});
 assert.equal(opened.opened,true);assert.deepEqual(fixture.clicks,['CoCo Team']);
 assert.equal(fixture.buttons()[0].disabled,false,'the new overlay remains usable after the interrupted queue');
});
