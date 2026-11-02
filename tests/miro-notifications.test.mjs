import test from 'node:test';
import assert from 'node:assert/strict';
import {miroBoardMetadata,miroNotifications} from '../connectors/miro-notifications.mjs';
import {parseFeedSnapshot} from '../dist/feed-state.js';
import {createPlatformFeed} from '../connectors/platform-feed.mjs';
const url='https://miro.com/app/board/board1234=/';
const scope=[{url,title:'Course Board',projectId:'course'}];
function fixture(){
 let revision='1:0',modifiedAt='2026-10-14T10:00:00Z',connected=true,failure=0,intercept;
 const calls=[];
 const nango={status:async()=>({connected,integrationId:'miro',connectionId:'private-fixture-connection',revision,capabilities:{boardRead:true}}),proxy:async(service,request)=>{
  calls.push({service,...request});await intercept?.();
  return {status:failure||200,data:{id:'board1234=',name:'Board &amp; title',description:'<p>Metadata only</p>',modifiedAt,createdAt:'2026-10-01T10:00:00Z'}};
 }};
 return {nango,calls,edit:()=>modifiedAt='2026-10-14T11:00:00Z',disconnect:()=>connected=false,change:()=>revision='2:0',fail:status=>failure=status,intercept:fn=>intercept=fn};
}
test('Miro activity fetches only linked board metadata with existing authorization and returns no credentials',async()=>{
 const f=fixture(),value=await miroNotifications({nango:f.nango,scope});assert.equal(value.status,'connected');assert.equal(value.items.length,1);assert.equal(value.items[0].content,'Metadata only');assert.equal(value.items[0].createdAt,'2026-10-14T10:00:00.000Z');assert.equal(value.items[0].projectId,'course');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');assert.equal(f.calls[0].path,'/v2/boards/board1234%3D');assert(!JSON.stringify(value).includes('private-fixture-connection'));
 assert.equal(parseFeedSnapshot({items:value.items,sources:[{source:'miro',status:'connected'}]}).items.length,1);
});
test('Miro IDs stay stable while a modified board changes revision; identical polls do not create new events',async()=>{
 const f=fixture(),before=await miroNotifications({nango:f.nango,scope}),same=await miroNotifications({nango:f.nango,scope});assert.equal(before.items[0].revision,same.items[0].revision);
 f.edit();const after=await miroNotifications({nango:f.nango,scope});assert.equal(before.items[0].id,after.items[0].id);assert.notEqual(before.items[0].revision,after.items[0].revision);
});
test('Miro connection changes during a board GET reject the former account result',async()=>{
 const f=fixture();f.intercept(()=>f.change());await assert.rejects(miroBoardMetadata({nango:f.nango,url}),{code:'connection_changed'});
});
test('permission denial drops former private metadata while network failure preserves a stale prior row',async()=>{
 const f=fixture(),before=await miroNotifications({nango:f.nango,scope});f.fail(403);const denied=await miroNotifications({nango:f.nango,scope,previous:before.items});assert.equal(denied.items.length,0);
 f.fail(500);const failed=await miroNotifications({nango:f.nango,scope,previous:before.items});assert.equal(failed.items.length,1);assert.equal(failed.items[0].stale,true);assert.equal(failed.status,'error');
});
test('denied Miro metadata stays removed through native lifecycle and renderer reconciliation',async()=>{
 const f=fixture();let clock=0;
 const feed=createPlatformFeed({now:()=>clock,adapters:[{source:'miro',account:async()=> 'same-account',read:options=>miroNotifications({nango:f.nango,...options})}]});
 const before=await feed.read({scope});assert.equal(before.items.length,1);clock=61000;f.fail(403);
 const denied=await feed.read({scope});assert.equal(denied.sources[0].itemsAuthoritative,true);
 assert.deepEqual(parseFeedSnapshot(denied,before.items,before.sources).items,[]);feed.dispose();
});
test('disconnected Miro returns only currently linked visitor snapshots and cannot reuse former API metadata',async()=>{
 const f=fixture();f.disconnect();const snapshots=[{url,projectId:'course',title:'Visitor board',basis:'visitor-overview',revision:'a'.repeat(64),fetchedAt:'2026-10-14T11:00:00Z'},{url,projectId:'other',title:'Wrong course',basis:'visitor-overview',revision:'b'.repeat(64),fetchedAt:'2026-10-14T11:00:00Z'},{url,projectId:'course',title:'Former private board',basis:'rest-api-text',revision:'c'.repeat(64),fetchedAt:'2026-10-14T11:00:00Z'}];
 const value=await miroNotifications({nango:f.nango,scope,snapshots});assert.equal(value.status,'snapshot');assert.equal(value.items.length,1);assert.equal(value.items[0].title,'Visitor board');assert.equal(value.items[0].timeKind,'observed');assert.equal(f.calls.length,0);
 assert.equal((await miroNotifications({scope,snapshots:[]})).status,'not_configured');
});
test('unlinked Miro boards are not queried, and the per-read linked-board bound is explicit',async()=>{
 const f=fixture();assert.equal((await miroNotifications({nango:f.nango,scope:[]})).status,'not_configured');assert.equal(f.calls.length,0);
 f.disconnect();const value=await miroNotifications({nango:f.nango,scope:Array.from({length:21},(_,i)=>({url:'https://miro.com/app/board/board'+i+'/',title:'Board '+i,projectId:'course'}))});assert.match(value.warnings[0],/20/);
});
