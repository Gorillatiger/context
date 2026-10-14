import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNotifications, gitlabNotifications, mattermostNotifications, mailNotifications, providerURL, readJSON } from '../connectors/notifications.mjs';

const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
test('unconfigured sources never claim connection and never invoke a provider',async()=>{
  let calls=0;const result=await collectNotifications({},{fetcher:async()=>{calls++;throw Error('Must not run');}});
  assert.equal(calls,0);assert.equal(result.items.length,0);assert.ok(result.sources.every(s=>s.status==='not_configured'));
});
test('one failed source does not hide another source and credentials never appear in results',async()=>{
  const secret='TEST_SECRET_VALUE';const calls=[];
  const fetcher=async(url,options)=>{calls.push({url,options});if(url.includes('chat.coco.study'))return new Response('',{status:401});if(url.endsWith('/user'))return json({id:12});return json([{id:2,body:'Review',target:{title:'Change'},target_url:'https://git.coco.study/group/project/-/issues/1',created_at:'2026-10-12T00:00:00Z'}]);};
  const result=await collectNotifications({GITLAB_TOKEN:secret,MATTERMOST_TOKEN:secret},{fetcher});
  assert.equal(result.sources.find(s=>s.source==='gitlab').status,'connected');assert.equal(result.sources.find(s=>s.source==='mattermost').status,'error');assert.equal(result.items.length,1);assert.ok(!JSON.stringify(result).includes(secret));assert.ok(calls.every(c=>c.options.method==='GET'&&c.options.redirect==='error'));assert.ok(calls.every(c=>!c.url.includes(secret)));
});
test('GitLab limits notifications and refuses links to unrelated hosts',async()=>{
  const ns=await gitlabNotifications('token',async url=>url.endsWith('/user')?json({id:8}):json([{id:1,target:{title:'Test'},target_url:'https://evil.example/secret',created_at:'2026-01-01'}]));
  assert.equal(ns[0].url,'https://git.coco.study');assert.equal(providerURL('javascript:alert(1)','https://git.coco.study'),'https://git.coco.study');
});
test('Mattermost exposes bounded channel post previews using only read endpoints',async()=>{
  const result=await mattermostNotifications('token',async url=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/users/me'))return json({id:'user1'});
    if(path.endsWith('/teams'))return json([{id:'t1',name:'students',display_name:'Students'}]);
    if(path.endsWith('/teams/unread'))return json([{team_id:'t1',msg_count:4,mention_count:2},{team_id:'t2',msg_count:0,mention_count:0}]);
    if(path.endsWith('/channels'))return json([{id:'channel1',team_id:'t1',name:'course-a',display_name:'Course A',type:'O'}]);
    if(path.endsWith('/posts/unread'))return json({order:['post1'],posts:{post1:{id:'post1',channel_id:'channel1',message:'Synthetic course notice',create_at:1791799200000}}});
    return json({team_id:'t1',channel_id:'channel1',msg_count:4,mention_count:2});
  });
  assert.equal(result.items.length,1);assert.equal(result.items[0].content,'Synthetic course notice');assert.equal(result.items[0].url,'https://chat.coco.study/students/pl/post1');assert.equal(result.items[0].groupUrl,'https://chat.coco.study/students/channels/course-a');assert.equal(result.items[0].groupId,'channel_channel1');assert.equal(result.complete,false);
});
test('mail credentials stay in child process environment and notifications contain no body',async()=>{
  const ns=await mailNotifications('campus','secret',async(command,args,options)=>{
    assert.equal(command,'python3');assert.ok(!args.join(' ').includes('secret'));assert.equal(options.env.TH_MAIL_PASSWORD,'secret');assert.equal(options.timeout,20000);
    return {stdout:JSON.stringify({uidValidity:'100',items:[{uid:'4',subject:'[THspaces] Kurs',sender:'TH-Spaces',date:'2026-10-12'}]})};
  });
  assert.equal(ns[0].relatedTool,'spaces');assert.ok(!JSON.stringify(ns).includes('secret'));assert.equal(ns[0].source,'webmail');
});
test('provider response validation rejects HTML, HTTP failures and oversized responses',async()=>{
  await assert.rejects(()=>readJSON('https://git.coco.study',{},async()=>new Response('html')));
  await assert.rejects(()=>readJSON('https://git.coco.study',{},async()=>new Response('{}',{status:403})));
  await assert.rejects(()=>readJSON('https://git.coco.study',{},async()=>new Response('x'.repeat(1500001),{headers:{'Content-Type':'application/json'}})));
});
