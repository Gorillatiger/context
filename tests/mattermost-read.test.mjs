import test from 'node:test';
import assert from 'node:assert/strict';
import {mattermostRead,MattermostReadError} from '../connectors/mattermost-read.mjs';
import {runProjectAgent,validateAgentReply} from '../dist/knowledge.js';

const id=c=>c.repeat(26),TEAM=id('t'),CHAN=id('c'),POST=id('p'),USER=id('u');
const reply=(status,body)=>({ok:status<300,status,headers:{get:()=>'application/json'},body:new Response(JSON.stringify(body)).body});
function api(){
  const calls=[];
  const routes=[
    ['/users/me/teams/'+TEAM+'/channels',()=>reply(200,[{id:CHAN,type:'O',display_name:'Ankündigungen',purpose:'Kursinfos',last_post_at:Date.UTC(2026,9,14)},{id:id('d'),type:'D',display_name:'privat'}])],
    ['/users/me/teams',()=>reply(200,[{id:TEAM,name:'uusa',display_name:'Users & Situated Action'}])],
    ['/posts/search',()=>reply(200,{order:[POST,id('s')],posts:{[POST]:{id:POST,channel_id:CHAN,user_id:USER,create_at:Date.UTC(2026,9,13,9),message:'Abgabe der README bis Freitag 18 Uhr im Fork.'},[id('s')]:{id:id('s'),channel_id:CHAN,user_id:USER,type:'system_join_channel',message:'joined'}}})],
    ['/channels/'+CHAN+'/posts',()=>reply(200,{order:[POST],posts:{[POST]:{id:POST,channel_id:CHAN,user_id:USER,create_at:Date.UTC(2026,9,13,9),message:'x'.repeat(900)}}})],
    ['/channels/'+CHAN,()=>reply(200,{id:CHAN,team_id:TEAM,display_name:'Ankündigungen'})],
    ['/teams/'+TEAM,()=>reply(200,{id:TEAM,name:'uusa'})],
    ['/users/ids',()=>reply(200,[{id:USER,username:'prof',first_name:'Ada',last_name:'Lehr'}])],
  ];
  const fetcher=async(url,options)=>{calls.push({url:String(url),method:options.method,headers:options.headers,body:options.body});const hit=routes.find(([key])=>String(url).includes(key));return hit?hit[1]():reply(404,{});};
  return {fetcher,calls};
}

test('teams, search and channel posts are read with names, dates and permalinks; nothing is written',async()=>{
  const {fetcher,calls}=api(),ctx={fetcher,token:'mmtoken-123456'};
  const teams=await mattermostRead('teams',{},ctx);
  assert.deepEqual(teams.teams[0].channels.map(c=>c.name),['Ankündigungen'],'direct messages stay out');
  const found=await mattermostRead('search',{query:'Abgabe README'},ctx);
  assert.equal(found.results.length,1,'system messages are dropped');
  assert.deepEqual(found.results[0],{id:POST,channel:'Ankündigungen',channelId:CHAN,author:'Ada Lehr',date:'2026-10-13T09:00:00.000Z',message:'Abgabe der README bis Freitag 18 Uhr im Fork.',truncated:false,url:'https://chat.coco.study/uusa/pl/'+POST,team:'Users & Situated Action'});
  const search=calls.find(c=>c.url.includes('/posts/search'));assert.equal(search.method,'POST');assert.deepEqual(JSON.parse(search.body),{terms:'Abgabe README',is_or_search:false,include_deleted_channels:false,page:0,per_page:15});assert.equal(search.headers.Authorization,'Bearer mmtoken-123456');
  const channel=await mattermostRead('channel',{channelId:CHAN},ctx);assert.equal(channel.channel,'Ankündigungen');assert.equal(channel.posts[0].truncated,true);assert.equal(channel.posts[0].message.length,700);
  assert.ok(calls.every(c=>c.url.startsWith('https://chat.coco.study/api/v4/')));
  assert.ok(calls.filter(c=>c.method==='POST').every(c=>/\/posts\/search$|\/users\/ids$/.test(c.url)),'only search and name lookup use POST');
});

test('invalid requests never reach Mattermost; refusals are explained',async()=>{
  const {fetcher,calls}=api();
  for(const [op,args] of [['search',{query:'a'}],['search',{query:'abc',teamId:'x'}],['channel',{channelId:'../x'}],['post',{}]])await assert.rejects(mattermostRead(op,args,{fetcher}),error=>error instanceof MattermostReadError&&error.code==='invalid_request');
  assert.equal(calls.length,0);
  await assert.rejects(mattermostRead('teams',{},{fetcher:async()=>reply(401,{})}),{code:'login_required'});
  await assert.rejects(mattermostRead('teams',{},{fetcher:async()=>{throw new TypeError('offline');}}),{code:'unreachable'});
});

test('the assistant searches Mattermost and gets dated, citable messages; tools exist only when connected',async()=>{
  const tool=(name,args)=>JSON.stringify({type:'tool',tool:name,args});
  for(const [name,args] of [['mattermost_teams',{}],['mattermost_search',{query:'Abgabe'}],['mattermost_search',{query:'Abgabe',teamId:TEAM}],['mattermost_channel',{channelId:CHAN}]])assert.equal(validateAgentReply(tool(name,args)).tool,name);
  for(const [name,args] of [['mattermost_search',{query:'a'}],['mattermost_channel',{channelId:'x'}],['mattermost_teams',{x:1}],['mattermost_post',{message:'hi'}]])assert.throws(()=>validateAgentReply(tool(name,args)),undefined,name);
  const ws={projects:[{id:'c',name:'Kurs',links:[]}],notes:[],tasks:[],calendarEvents:[],boardFindings:[],bookmarks:[],tools:[]};
  const mattermost=async()=>({query:'Abgabe',results:[{id:POST,channel:'Ankündigungen',author:'Ada Lehr',date:'2026-10-13T09:00:00.000Z',message:'Abgabe bis Freitag',url:'https://chat.coco.study/uusa/pl/'+POST},{id:id('e'),channel:'x',date:'2024-01-01T00:00:00.000Z',message:'Alte Abgabe',url:'https://evil.test/'}]});
  let seen='',system='';const replies=[tool('mattermost_search',{query:'Abgabe'}),JSON.stringify({type:'answer',text:'Abgabe bis Freitag.',citations:['mattermost:'+POST]})];
  const result=await runProjectAgent({prompt:'Gibt es Ankündigungen zur Abgabe?',workspace:ws,getWorkspace:()=>ws,documents:[],projectId:'c',today:'2026-10-15',platform:async()=>({}),mattermost,complete:async messages=>{system||=messages[0].content;seen=messages.at(-1).content;return {content:replies.shift()};}});
  assert.match(system,/mattermost_search \{query,teamId\?\}/);
  assert.match(seen,/"sem":"WS 2026\/27","age":"aktuell"/);assert.match(seen,/"age":"veraltet"/);
  assert.equal(result.citations[0].url,'https://chat.coco.study/uusa/pl/'+POST);assert.equal(result.citations[0].postedAt,'2026-10-13T09:00:00.000Z');
  assert.ok(result.sources.every(doc=>doc.kind!=='mattermost'||doc.url.startsWith('https://chat.coco.study/')),'foreign links are replaced');
  let bare='';await runProjectAgent({prompt:'Hallo',workspace:ws,getWorkspace:()=>ws,documents:[],projectId:'c',platform:async()=>({}),complete:async messages=>{bare=messages[0].content;return {content:JSON.stringify({type:'answer',text:'ok',citations:[]})};}});
  assert.doesNotMatch(bare,/mattermost_search/);
});
