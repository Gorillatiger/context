import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformFeed} from '../connectors/platform-feed.mjs';
import {createDesktopNotifications,notificationScopes} from '../desktop/notifications.mjs';
import {readUnifiedFeed,feedCourseScopes} from '../dist/platform-feed.js';
import {parseFeedSnapshot} from '../dist/feed-state.js';
const course={id:'course',name:'Synthetic Course',url:'https://spaces.th-koeln.de/course-w26/'};
const row=(id='one',patch={})=>({id,source:'spaces',title:'Synthetic notice',createdAt:'2026-10-14T12:00:00Z',url:course.url+'post/',revision:'1',...patch});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
const response=(value,headers={})=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json',...headers}});
function fixture(){
  const nonce='synthetic_private_nonce',calls=[];let now=0,postText='Hello &amp; world',commentsFail=false,spacesFail=false,identity='account-a';
  const session={cookies:{get:async()=>[{domain:'spaces.th-koeln.de',path:'/',name:'wordpress_logged_in_test',value:identity,httpOnly:true}]},fetch:async(address,options)=>{
    const url=new URL(address);calls.push({url,options});assert.equal(options.method,'GET');assert.equal(options.credentials,'include');
    if(url.hostname!=='spaces.th-koeln.de')return new Response('',{status:401});
    if(spacesFail)return new Response('',{status:500});
    if(url.href===course.url)return new Response(`<link rel="https://api.w.org/" href="${course.url}wp-json/"><script id="wp-api-request-js-extra">var wpApiSettings = ${JSON.stringify({root:course.url+'wp-json/',nonce})};</script>`,{headers:{'content-type':'text/html'}});
    assert.equal(options.headers['X-WP-Nonce'],nonce);
    if(url.pathname.endsWith('/wp-json/'))return response({routes:{'/wp/v2/posts':{methods:['GET']},'/wp/v2/comments':{methods:['GET']},'/wp/v2/users/me':{methods:['GET']}}});
    if(url.pathname.endsWith('/users/me'))return response({id:7});
    if(url.pathname.endsWith('/posts'))return response([{id:11,status:'publish',link:course.url+'post/',title:{rendered:'Title &amp; text'},content:{rendered:'<p>'+postText+'</p><script>bad()</script>'},date_gmt:'2026-10-14T12:00:00',modified_gmt:'2026-10-14T13:00:00'}]);
    if(url.pathname.endsWith('/comments'))return commentsFail?new Response('',{status:500}):response([{id:22,post:11,status:'approved',author_name:'Author',link:course.url+'post/#comment-22',content:{rendered:'<p>A comment</p>'},date_gmt:'2026-10-14T14:00:00'}]);
    throw Error('Unexpected route');
  }};
  const feed=createDesktopNotifications({providerSession:session,now:()=>now});
  return {feed,calls,nonce,advance(){now+=60000;},change(){identity='account-b';},edit(){postText='Edited';},failComments(){commentsFail=true;},failSpaces(){spacesFail=true;},read:()=>feed.handle({action:'sync',manual:true,courses:[course]})};
}
test('native feed authenticates declared WordPress reads and normalizes posts/comments without leaking credentials',async()=>{
  const f=fixture(),value=await f.read(),source=value.sources.find(s=>s.source==='spaces');
  assert.equal(source.status,'connected');assert.equal(source.complete,true);assert.equal(value.items.length,2);
  assert.equal(value.items[0].content,'Hello & world');assert.equal(value.items[0].title,'Title & text');assert.equal(value.items[0].createdAt,'2026-10-14T12:00:00.000Z');assert.equal(value.items[1].kind,'comment');
  assert(!JSON.stringify(value).includes(f.nonce));assert(!JSON.stringify(value).includes('account-a'));assert.equal(parseFeedSnapshot(value).items.length,2);
  assert(f.calls.every(call=>call.options.method==='GET'));assert(f.calls.every(call=>!call.options.headers?.Authorization));
});
test('edited posts replace their stable identity; partial comment failure preserves only former comments',async()=>{
  const f=fixture(),before=await f.read();f.advance();f.edit();f.failComments();const after=await f.read();
  assert.equal(before.items[0].id,after.items[0].id);assert.notEqual(before.items[0].revision,after.items[0].revision);assert.equal(after.items[0].content,'Edited');assert.equal(after.items[1].stale,true);assert.equal(after.sources.find(s=>s.source==='spaces').complete,false);
});
test('account changes cannot retain prior private posts on provider failure',async()=>{
  const f=fixture(),before=await f.read();f.advance();f.change();f.failSpaces();const after=await f.read();
  assert.equal(after.items.length,0);assert.notEqual(after.sources[0].accountGeneration,before.sources[0].accountGeneration);
  assert.equal(parseFeedSnapshot(after,before.items,before.sources).items.length,0);
});
test('sync coalesces concurrent reads, caches and preserves a failed provider while another succeeds',async()=>{
  let clock=0,calls=0,fail=false;const pending=deferred();
  const adapter={source:'spaces',account:async()=> 'a'.repeat(64),read:async()=>{calls++;if(calls===1)await pending.promise;if(fail)throw Error('offline');return {items:[row()],complete:true};}};
  const feed=createPlatformFeed({adapters:[adapter],now:()=>clock});const one=feed.read(),two=feed.read();pending.resolve();assert.deepEqual(await one,await two);assert.equal(calls,1);
  await feed.read();assert.equal(calls,1);clock=60000;fail=true;const failed=await feed.read();assert.equal(failed.items.length,1);assert.equal(failed.sources[0].status,'error');clock=90000;await feed.read();assert.equal(calls,2);
});
test('invalidation rejects late results and cannot poison another provider',async()=>{
  const pending=deferred();let calls=0;
  const feed=createPlatformFeed({adapters:[{source:'spaces',account:async()=> 'a'.repeat(64),read:async()=>{calls++;await pending.promise;return {items:[row()]};}},{source:'gitlab',account:async()=> 'b'.repeat(64),read:async()=>({items:[]})}]});
  const read=feed.read();await new Promise(r=>setImmediate(r));feed.invalidate('spaces');pending.resolve();const value=await read;
  assert.equal(value.sources.find(s=>s.source==='spaces').status,'login_required');assert.equal(value.sources.find(s=>s.source==='gitlab').status,'connected');assert.equal(value.items.length,0);assert.equal(calls,1);
});
test('unified client chooses live session data over snapshots and token data over a failed browser session',async()=>{
  const base={items:[row('snapshot'),row('token',{source:'gitlab',url:'https://git.coco.study/repo'})],sources:[{source:'spaces',status:'snapshot'},{source:'gitlab',status:'connected'}],courses:[course]};
  let request;const bridge={notifications:async message=>{request=message;return {ok:true,value:{items:[row('api')],sources:[{source:'spaces',status:'connected'},{source:'gitlab',status:'login_required'}]}};}};
  const value=await readUnifiedFeed({fetcher:async()=>response(base),bridge,projects:[]});assert.deepEqual(value.items.map(r=>r.id),['token','api']);assert.deepEqual(request.courses,[course]);
});
test('native session sync remains available if localhost server fails; malformed native data never replaces valid rows',async()=>{
  const bridge={notifications:async()=>({ok:true,value:{items:[row()],sources:[{source:'spaces',status:'connected'}]}})};
  const value=await readUnifiedFeed({fetcher:async()=>{throw Error('offline');},bridge});assert.equal(value.items.length,1);assert.equal(value.sources[0].status,'error');
  bridge.notifications=async()=>({ok:true,value:{items:[row('bad',{url:'javascript:bad'})],sources:[{source:'spaces',status:'connected'}]}});await assert.rejects(readUnifiedFeed({fetcher:async()=>response({items:[],sources:[]}),bridge}));
});
test('scope registry rejects foreign/admin/traversal destinations and excludes archived courses',()=>{
  for(const url of ['https://evil.test/course/','https://spaces.th-koeln.de/course/../wp-admin/','https://spaces.th-koeln.de/course/?nonce=secret'])assert.throws(()=>notificationScopes([{...course,url}]));
  assert.deepEqual(feedCourseScopes([{id:'course',name:course.name,archived:true,links:[{tool:'spaces',url:course.url}]}],[course]),[]);
});
test('unchanged authentication-cookie events do not discard cached feed data or refetch providers',async()=>{
  const f=fixture();const first=await f.read(),calls=f.calls.length;f.feed.invalidate('spaces');await new Promise(r=>setImmediate(r));const second=await f.read();
  assert.deepEqual(second.items,first.items);assert.equal(f.calls.length,calls);
});
test('a failing account or scope adapter cannot prevent unrelated sources from synchronizing',async()=>{
  const feed=createPlatformFeed({adapters:[
    {source:'miro',account:async()=>{throw Error('identity offline');},read:async()=>{throw Error('must not read');}},
    {source:'whatsapp',scope:()=>{throw Error('scope unavailable');},account:async()=> 'known',read:async()=>({items:[]})},
    {source:'spaces',account:async()=> 'known',read:async()=>({items:[row()]})}
  ]});
  const value=await feed.read();assert.equal(value.items.length,1);
  assert.deepEqual(value.sources.map(source=>source.status),['error','error','connected']);
  assert.equal(value.sources[0].itemsAuthoritative,true);feed.dispose();
});
test('failure to verify identity after a read rejects both its new rows and retained old rows',async()=>{
  let calls=0,clock=0,verifyFails=false;
  const feed=createPlatformFeed({now:()=>clock,adapters:[{source:'spaces',account:async()=>{calls++;if(verifyFails&&calls%2===0)throw Error('identity offline');return 'same';},read:async()=>({items:[row()]})}]});
  const before=await feed.read();assert.equal(before.items.length,1);verifyFails=true;clock=61000;
  const after=await feed.read();assert.equal(after.sources[0].status,'error');
  assert.deepEqual(parseFeedSnapshot(after,before.items,before.sources).items,[]);feed.dispose();
});
test('a hanging server or JSON body is bounded and cannot suppress available native notifications',async()=>{
  const never=new Promise(()=>{}),bridge={notifications:async()=>({ok:true,value:{items:[row()],sources:[{source:'spaces',status:'connected'}]}})};
  // Keep the test alive: AbortSignal.timeout deliberately does not keep Node alive.
  const lease=setTimeout(()=>{},1000);
  try{for(const fetcher of [()=>never,async()=>({ok:true,headers:{get:()=> 'application/json'},json:()=>never})]){
    const value=await readUnifiedFeed({fetcher,bridge,serverTimeoutMs:5});assert.equal(value.items.length,1);assert.equal(value.sources[0].status,'error');
  }}finally{clearTimeout(lease);}
});
test('native bridge failures leave independently validated server mail and token results usable',async()=>{
  const base={items:[row('mail',{source:'webmail',url:'https://webmail.th-koeln.de/'}),row('gitlab',{source:'gitlab',url:'https://git.coco.study/course'})],sources:[{source:'webmail',status:'connected'},{source:'gitlab',status:'connected'}]};
  for(const notifications of [async()=>{throw Error('ipc unavailable');},async()=>({ok:false,error:'ipc unavailable'})]){
    const value=await readUnifiedFeed({fetcher:async()=>response(base),bridge:{notifications}});
    assert.deepEqual(value.items.map(item=>item.id),['mail','gitlab']);
    assert.equal(value.sources.find(source=>source.source==='webmail').status,'connected');
    assert.equal(value.sources.find(source=>source.source==='spaces').status,'error');
  }
});
