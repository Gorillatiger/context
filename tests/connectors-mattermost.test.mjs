import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {collectNotifications,gitlabNotifications,mailNotifications,mattermostNotifications,readJSON} from '../connectors/notifications.mjs';
import {initialState,notificationCourse,notificationKey} from '../dist/core.js';

const ORIGIN='https://chat.coco.study';
const FETCHED=Date.parse('2026-10-13T12:00:00Z');
const CREATED=Date.parse('2026-10-12T09:00:00Z');
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const team=(index=1)=>({id:'team'+index,name:index===1?'students':'team-'+index,display_name:'Synthetic team '+index});
const channel=(index=1,teamId='team1')=>({id:'channel'+index,team_id:teamId,name:index===1?'cr---how-to-go-public':'course-'+index,display_name:'Synthetic course '+index,type:'O',last_post_at:CREATED+index});
const post=(postId='post1',channelId='channel1',extra={})=>({id:postId,channel_id:channelId,message:'Synthetic course notice',create_at:CREATED,update_at:CREATED,type:'',delete_at:0,...extra});
const list=(posts)=>({order:posts.map(p=>p.id),posts:Object.fromEntries(posts.map(p=>[p.id,p]))});

function fixture({teams=[team()],unreads,channels=[channel()],counts={},posts={},failures={},latency=0}={}){
  const calls=[];let active=0,maxActive=0;
  const fetcher=async(url,options)=>{
    const parsed=new URL(url),path=parsed.pathname.replace('/api/v4','');
    calls.push({url,options});active++;maxActive=Math.max(maxActive,active);
    try{
      if(latency)await delay(latency);
      if(Object.hasOwn(failures,path))return json({message:'PRIVATE_PROVIDER_ERROR_BODY'},failures[path]);
      if(path==='/users/me')return json({id:'user1'});
      if(path==='/users/me/teams')return json(teams);
      if(path==='/users/me/teams/unread')return json(unreads??teams.map(t=>({team_id:t.id,msg_count:5,mention_count:1})));
      const teamMatch=path.match(/^\/users\/user1\/teams\/([^/]+)\/channels$/);
      if(teamMatch)return json(channels.filter(c=>c.team_id===teamMatch[1]));
      const unreadMatch=path.match(/^\/users\/user1\/channels\/([^/]+)\/unread$/);
      if(unreadMatch){const c=channels.find(c=>c.id===unreadMatch[1]);return json(counts[c.id]??{team_id:c.team_id,channel_id:c.id,msg_count:2,mention_count:1});}
      const postsMatch=path.match(/^\/users\/user1\/channels\/([^/]+)\/posts\/unread$/);
      if(postsMatch)return json(posts[postsMatch[1]]??list([post('post-'+postsMatch[1],postsMatch[1])]));
      assert.fail('Unexpected fake endpoint: '+path);
    }finally{active--;}
  };
  return {fetcher,calls,get maxActive(){return maxActive;}};
}
const read=(fake,options={})=>mattermostNotifications('SYNTHETIC_TOKEN',fake.fetcher,{now:()=>FETCHED,...options});

test('channel previews keep their course URL, account-scoped identity and provider time',async()=>{
  const fake=fixture({channels:[channel(),channel(2)],posts:{channel1:list([post()])}});
  const result=await read(fake),item=result.items.find(i=>i.groupId==='channel_channel1');
  assert.equal(notificationCourse({...item,url:item.groupUrl},initialState()),'go-public');
  assert.equal(item.url,ORIGIN+'/students/pl/post1');assert.equal(item.groupUrl,ORIGIN+'/students/channels/cr---how-to-go-public');
  assert.equal(new URL(item.groupUrl).origin,new URL(item.url).origin);
  assert.equal(item.content,'Synthetic course notice');assert.equal(item.contentStatus,'full');
  assert.equal(item.createdAt,'2026-10-12T09:00:00.000Z');assert.equal(item.observedAt,'2026-10-13T12:00:00.000Z');
  assert.match(item.id,/^mattermost_[a-f0-9]{12}_post1$/);assert.equal(result.complete,false);
  assert.match(result.message,/Teilstand/);assert.match(result.message,/Direktnachrichten, Anhänge und Medien/);
  assert.equal(result.items.length,2);assert.equal(result.items[0].source,'mattermost');
});

test('two posts have distinct direct permalinks and retain the same channel grouping URL',async()=>{
  const fake=fixture({posts:{channel1:list([post('post-one'),post('post-two')])}}),result=await read(fake);
  assert.deepEqual(result.items.map(i=>i.url),[ORIGIN+'/students/pl/post-one',ORIGIN+'/students/pl/post-two']);
  assert.ok(result.items.every(i=>i.groupUrl===ORIGIN+'/students/channels/cr---how-to-go-public'&&i.groupId==='channel_channel1'));
  assert.notEqual(result.items[0].id,result.items[1].id);
  assert.ok(result.items.every(i=>new URL(i.url).origin===new URL(i.groupUrl).origin));
});

test('every Mattermost request is a fixed-host GET without browser credentials or read-state changes',async()=>{
  const fake=fixture();await read(fake);
  assert.equal(fake.calls.length,6);
  for(const {url,options} of fake.calls){
    const parsed=new URL(url);assert.equal(parsed.origin,ORIGIN);assert.equal(parsed.username,'');assert.equal(parsed.password,'');
    assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.body,undefined);
    assert.deepEqual(Object.keys(options.headers).sort(),['Accept','Authorization']);assert.equal(options.headers.Authorization,'Bearer SYNTHETIC_TOKEN');
    assert.ok(!url.includes('SYNTHETIC_TOKEN'));assert.doesNotMatch(parsed.pathname,/\/(view|set_unread|files|users\/user1$)/);
    if(parsed.pathname.endsWith('/posts/unread'))assert.deepEqual(Object.fromEntries(parsed.searchParams),{limit_before:'0',limit_after:'10',skipFetchThreads:'true'});
    else assert.equal(parsed.search,'');
  }
});

test('post read keys remain stable across fetches and change when the remote message changes',async()=>{
  const fake=fixture({posts:{channel1:list([post()])}}),first=(await read(fake)).items[0],second=(await read(fake,{now:()=>FETCHED+1000})).items[0];
  assert.equal(notificationKey(first),notificationKey(second));assert.notEqual(first.observedAt,second.observedAt);
  const edited=(await read(fixture({posts:{channel1:list([post('post1','channel1',{message:'Synthetic edited notice',update_at:CREATED+2000})])}}))).items[0];
  assert.equal(first.id,edited.id);assert.notEqual(first.revision,edited.revision);
});

test('wrong-channel, deleted, system, empty, mismatched and duplicate post entries are excluded',async()=>{
  const response=list([
    post('good','channel1',{metadata:{embeds:[{url:'https://media.invalid/private'}]},file_ids:['file1']}),
    post('wrong','other'),post('deleted','channel1',{delete_at:CREATED}),post('system','channel1',{type:'system_join_channel'}),
    post('empty','channel1',{message:'  \n '}),post('mismatched')
  ]);
  response.posts.mismatched.id='different';response.order.push('good','missing');
  const result=await read(fixture({posts:{channel1:response}}));
  assert.equal(result.items.length,1);assert.match(result.items[0].id,/_good$/);
  assert.ok(!JSON.stringify(result).includes('media.invalid'));assert.ok(!JSON.stringify(result).includes('file1'));
});

test('long post text is marked as an excerpt and an invalid provider timestamp stays unknown',async()=>{
  const result=await read(fixture({posts:{channel1:list([post('long','channel1',{message:'x'.repeat(20050),create_at:'2026-10-12T09:00:00Z'})])}}));
  assert.equal(result.items[0].content.length,20000);assert.equal(result.items[0].contentStatus,'excerpt');assert.equal(result.items[0].createdAt,'');
  assert.equal(result.items[0].observedAt,result.checkedAt);
});

test('read limits cap teams, channels, previews and posts and disclose omitted scope',async()=>{
  const teams=Array.from({length:7},(_,i)=>team(i+1));
  const channels=teams.flatMap((t,tIndex)=>Array.from({length:8},(_,i)=>channel(tIndex*8+i+1,t.id)));
  const posts=Object.fromEntries(channels.map(c=>[c.id,{...list(Array.from({length:15},(_,i)=>post(c.id+'-post'+i,c.id))),has_next:true,next_post_id:'not-followed'}]));
  const fake=fixture({teams,channels,posts,latency:1}),result=await read(fake);
  assert.equal(fake.calls.filter(c=>new URL(c.url).pathname.match(/\/teams\/[^/]+\/channels$/)).length,5);
  assert.equal(fake.calls.filter(c=>new URL(c.url).pathname.endsWith('/unread')&&!c.url.includes('/teams/unread')&&!c.url.includes('/posts/unread')).length,20);
  assert.equal(fake.calls.filter(c=>new URL(c.url).pathname.endsWith('/posts/unread')).length,10);
  assert.equal(result.items.filter(i=>i.kind!=='summary').length,100);assert.equal(result.items.filter(i=>i.kind==='summary').length,10);
  assert.ok(fake.calls.length<=40);assert.ok(fake.maxActive<=3);assert.equal(result.limits.requests,40);assert.equal(result.limits.posts,100);
  assert.equal(result.complete,false);assert.equal(result.truncated,true);assert.ok(result.warnings.length>=4);assert.match(result.message,/Einige Hinweise fehlen/);
  assert.ok(result.items.filter(i=>i.kind==='summary').every(i=>i.createdAt===''&&i.observedAt===result.checkedAt&&i.url.includes('/channels/')));
});

test('zero-unread teams are filtered before the team limit and malformed channels are never requested',async()=>{
  const teams=Array.from({length:7},(_,i)=>team(i+1)),selected=channel(7,'team7');
  const invalid=[{...channel(1,'team7'),id:'../bad'},{...channel(2,'team7'),name:'bad/name'},{...channel(3,'team7'),type:'D'},{...channel(4,'team7'),type:'G'},{...channel(5,'team7'),delete_at:CREATED}];
  const fake=fixture({teams,unreads:teams.map(t=>({team_id:t.id,msg_count:t.id==='team7'?1:0,mention_count:0})),channels:[selected,...invalid]});
  const result=await read(fake);assert.equal(result.items.length,1);assert.equal(result.items[0].groupId,'channel_channel7');
  assert.equal(fake.calls.filter(c=>c.url.includes('/teams/team7/channels')).length,1);assert.ok(!fake.calls.some(c=>c.url.includes('/teams/team1/channels')));
  assert.equal(fake.calls.filter(c=>c.url.includes('/posts/unread')).length,1);
});

test('team channel failure returns an observed summary without an invented message date',async()=>{
  const fake=fixture({unreads:[{team_id:'team1',msg_count:5,mention_count:'INVALID_PRIVATE_COUNT'}],failures:{'/users/user1/teams/team1/channels':403}}),result=await read(fake),item=result.items[0];
  assert.equal(result.items.length,1);assert.equal(item.kind,'summary');assert.equal(item.createdAt,'');assert.equal(item.observedAt,result.checkedAt);assert.equal(item.timeKind,'observed');
  assert.equal(item.url,ORIGIN+'/students');assert.equal(item.groupUrl,undefined);assert.equal(notificationCourse(item,initialState()),'');assert.equal(result.truncated,true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_ERROR_BODY'));assert.ok(!JSON.stringify(result).includes('INVALID_PRIVATE_COUNT'));
});

test('one unavailable preview preserves readable channel posts and source partial-state metadata',async()=>{
  const fake=fixture({channels:[channel(),channel(2)],failures:{'/users/user1/channels/channel2/posts/unread':404}});
  const result=await collectNotifications({MATTERMOST_TOKEN:'SYNTHETIC_TOKEN'},{fetcher:fake.fetcher});
  const source=result.sources.find(s=>s.source==='mattermost');assert.equal(source.status,'connected');assert.equal(source.complete,false);assert.equal(source.truncated,true);
  assert.ok(source.warnings.length>0);assert.equal(source.limits.previewChannels,10);assert.match(source.message,/Teilstand/);
  assert.equal(result.items.filter(i=>i.contentStatus==='full').length,1);const summary=result.items.find(i=>i.kind==='summary');
  assert.equal(summary.url,ORIGIN+'/students/channels/course-2');assert.equal(summary.groupUrl,undefined);assert.equal(summary.createdAt,'');assert.equal(summary.contentStatus,'summary');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_ERROR_BODY'));assert.ok(!JSON.stringify(result).includes('SYNTHETIC_TOKEN'));
});

test('a channel unread mismatch is omitted and explicitly makes the source partial',async()=>{
  const fake=fixture({counts:{channel1:{team_id:'foreign-team',channel_id:'channel1',msg_count:1,mention_count:0}}}),result=await read(fake);
  assert.equal(result.items.length,0);assert.equal(result.complete,false);assert.equal(result.truncated,true);assert.ok(result.warnings.length>0);
  assert.ok(!fake.calls.some(c=>c.url.includes('/posts/unread')));
});

test('authorization failure remains a source error and never returns raw provider details',async()=>{
  const fake=fixture({failures:{'/users/user1/channels/channel1/posts/unread':401}});
  const result=await collectNotifications({MATTERMOST_TOKEN:'SYNTHETIC_TOKEN'},{fetcher:fake.fetcher}),source=result.sources.find(s=>s.source==='mattermost');
  assert.equal(source.status,'error');assert.equal(result.items.length,0);assert.equal(source.message,'Zugriff abgelehnt. Verbindung prüfen.');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_ERROR_BODY'));assert.ok(!JSON.stringify(result).includes('SYNTHETIC_TOKEN'));
});

test('GitLab and mail preserve unknown timestamps instead of assigning fetch time',async()=>{
  const values=[undefined,null,'','bad','0','2026-02-30','2026-10-12T09:00:00','2026-10-12T09:00:00Z','2026-10-12'];
  const gitlab=await gitlabNotifications('SYNTHETIC_TOKEN',async url=>new URL(url).pathname.endsWith('/user')?json({id:1}):json(values.map((date,i)=>({id:i+1,created_at:date}))));
  const mail=await mailNotifications('synthetic-user','SYNTHETIC_PASSWORD',async()=>({stdout:JSON.stringify({uidValidity:'1',items:values.map((date,i)=>({uid:String(i+1),date}))})}));
  for(const items of [gitlab,mail]){
    assert.ok(items.slice(0,7).every(i=>i.createdAt===''));assert.equal(items[7].createdAt,'2026-10-12T09:00:00.000Z');assert.equal(items[8].createdAt,'2026-10-12T00:00:00.000Z');
  }
});

test('a pre-cancelled provider read never invokes fetch',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(()=>readJSON(ORIGIN,{},async()=>{calls++;return json({});},{signal:controller.signal}),/cancelled/);assert.equal(calls,0);
});

test('abort cancels an unfinished JSON response stream rather than waiting for the full body',async()=>{
  const controller=new AbortController();let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}});
  const reading=readJSON(ORIGIN,{},async()=>new Response(stream,{headers:{'Content-Type':'application/json'}}),{signal:controller.signal});
  await delay(5);controller.abort();await assert.rejects(()=>reading,/cancelled/);assert.equal(cancelled,true);
});
