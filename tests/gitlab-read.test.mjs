import test from 'node:test';
import assert from 'node:assert/strict';
import {gitlabRead,GitlabReadError,GITLAB_LIMITS} from '../connectors/gitlab-read.mjs';
import {runProjectAgent,validateAgentReply} from '../dist/knowledge.js';

const reply=(status,body,type='application/json')=>({ok:status<300,status,headers:{get:()=>type},body:new Response(typeof body==='string'?body:JSON.stringify(body)).body});
function api(routes){const calls=[];const fetcher=async(url,options)=>{calls.push({url:String(url),headers:options.headers,method:options.method,redirect:options.redirect});const hit=Object.entries(routes).find(([key])=>String(url).includes(key));return hit?(typeof hit[1]==='function'?hit[1]():hit[1]):reply(404,{});};return {fetcher,calls};}

test('projects, tree, file and commits are read with a fixed host, GET only and bounded output',async()=>{
  const {fetcher,calls}=api({'/projects?membership':reply(200,[{id:7,path_with_namespace:'students/ws2627/uusa/pat',name:'pat',web_url:'https://git.coco.study/students/ws2627/uusa/pat',last_activity_at:'2026-10-14T10:00:00Z',forked_from_project:{path_with_namespace:'teachers/uusa'}},{nope:1}]),
    '/repository/tree':reply(200,[{name:'README.md',type:'blob',path:'README.md'},{name:'src',type:'tree',path:'src'}]),
    '/repository/files/README.md/raw':reply(200,'# Abgabe\n- [x] Idee\n- [ ] Prototyp','text/plain'),
    '/repository/commits':reply(200,[{title:'Add idea',author_name:'Pat',created_at:'2026-10-13T09:00:00Z',web_url:'https://git.coco.study/x/-/commit/1'}])});
  const ctx={fetcher,token:'glpat-abc12345'};
  const projects=await gitlabRead('projects',{query:'uusa'},ctx);
  assert.deepEqual(projects.projects,[{id:7,path:'students/ws2627/uusa/pat',name:'pat',description:'',url:'https://git.coco.study/students/ws2627/uusa/pat',lastActivity:'2026-10-14T10:00:00Z',forkedFrom:'teachers/uusa'}]);
  assert.match(calls[0].url,/^https:\/\/git\.coco\.study\/api\/v4\/projects\?membership=true&simple=true/);assert.match(calls[0].url,/search=uusa/);assert.equal(calls[0].headers['PRIVATE-TOKEN'],'glpat-abc12345');assert.equal(calls[0].method,'GET');assert.equal(calls[0].redirect,'error');
  assert.deepEqual((await gitlabRead('tree',{projectId:7},ctx)).entries.map(e=>e.type),['file','folder']);
  const file=await gitlabRead('file',{projectId:'7',path:'README.md'},ctx);assert.match(file.text,/Prototyp/);assert.equal(file.truncated,false);
  assert.equal((await gitlabRead('commits',{projectId:7},ctx)).commits[0].title,'Add idea');
  assert.ok(calls.every(call=>call.url.startsWith('https://git.coco.study/api/v4/')&&call.method==='GET'));
  const long=api({'/raw':reply(200,'x'.repeat(GITLAB_LIMITS.fileChars+500),'text/plain')});
  assert.equal((await gitlabRead('file',{projectId:7,path:'a.md'},{fetcher:long.fetcher})).truncated,true);
});

test('invalid requests never reach GitLab; login, missing and broken answers are explained',async()=>{
  const {fetcher,calls}=api({});
  for(const [op,args] of [['file',{projectId:7}],['file',{projectId:7,path:'../x'}],['tree',{projectId:'7/../8'}],['tree',{projectId:-1}],['tree',{projectId:7,path:'a\nb'}],['delete',{projectId:7}],['commits',{}]])
    await assert.rejects(gitlabRead(op,args,{fetcher}),error=>error instanceof GitlabReadError&&error.code==='invalid_request',op+JSON.stringify(args));
  assert.equal(calls.length,0);
  for(const [status,code] of [[401,'login_required'],[403,'login_required'],[404,'not_found'],[500,'provider_error']])
    await assert.rejects(gitlabRead('commits',{projectId:7},{fetcher:api({'/commits':reply(status,{})}).fetcher}),{code});
  await assert.rejects(gitlabRead('projects',{},{fetcher:async()=>{throw new TypeError('offline');}}),{code:'unreachable'});
  await assert.rejects(gitlabRead('projects',{},{fetcher:api({'/projects':reply(200,{not:'a list'})}).fetcher}),{code:'invalid_response'});
  await assert.rejects(gitlabRead('file',{projectId:7,path:'a.bin'},{fetcher:api({'/raw':reply(200,'ab\u0000cd','text/plain')}).fetcher}),{code:'binary'});
});

test('the GitLab tools take only a project number and a path',()=>{
  const tool=(name,args)=>JSON.stringify({type:'tool',tool:name,args});
  assert.equal(validateAgentReply(tool('gitlab_projects',{query:'uusa'})).tool,'gitlab_projects');assert.equal(validateAgentReply(tool('gitlab_projects',{})).tool,'gitlab_projects');
  assert.equal(validateAgentReply(tool('gitlab_file',{projectId:7,path:'README.md'})).tool,'gitlab_file');assert.equal(validateAgentReply(tool('gitlab_tree',{projectId:'7'})).tool,'gitlab_tree');assert.equal(validateAgentReply(tool('gitlab_commits',{projectId:7})).tool,'gitlab_commits');
  for(const [name,args] of [['gitlab_file',{projectId:7}],['gitlab_file',{projectId:7,path:'../x'}],['gitlab_tree',{projectId:'a'}],['gitlab_commits',{projectId:7,path:'x'}],['gitlab_projects',{query:'x'.repeat(101)}],['gitlab_file',{projectId:7,path:'a',url:'https://x'}],['gitlab_delete',{projectId:7}]])
    assert.throws(()=>validateAgentReply(tool(name,args)),undefined,name+JSON.stringify(args));
});

test('the assistant finds the fork, reads the README and cites it; without a connection it has no GitLab tools',async()=>{
  const ws={projects:[{id:'c',name:'Kurs',links:[]}],notes:[],tasks:[],calendarEvents:[],boardFindings:[],bookmarks:[],tools:[]};
  const calls=[],gitlab=async(op,args)=>{calls.push([op,args]);return op==='projects'?{projects:[{id:7,path:'students/uusa/pat'}]}:{path:'README.md',text:'# Abgabe\n- [x] Idee\n- [ ] Prototyp',truncated:false};};
  const replies=[{type:'tool',tool:'gitlab_projects',args:{query:'uusa'}},{type:'tool',tool:'gitlab_file',args:{projectId:7,path:'README.md'}},{type:'answer',text:'Idee erledigt, Prototyp offen.',citations:['gitlab:7:README.md']}].map(value=>({content:JSON.stringify(value),totalTokens:5}));
  let system='';
  const result=await runProjectAgent({prompt:'Wie weit ist meine Abgabe?',workspace:ws,documents:[],projectId:'c',platform:async()=>({}),getWorkspace:()=>ws,gitlab,complete:async messages=>{system||=messages[0].content;return replies.shift();}});
  assert.match(system,/gitlab_projects \{query\?\}/);assert.deepEqual(calls.map(call=>call[0]),['projects','file']);
  assert.deepEqual(result.steps.map(step=>step.label),['GitLab-Projekte finden','GitLab-Datei lesen']);assert.equal(result.citations.length,1);assert.match(result.citations[0].text,/Prototyp/);assert.equal(result.citations[0].service,'gitlab');
  let bare='';const none=await runProjectAgent({prompt:'Hallo',workspace:ws,documents:[],projectId:'c',platform:async()=>({}),getWorkspace:()=>ws,complete:async messages=>{bare=messages[0].content;return {content:JSON.stringify({type:'answer',text:'ok',citations:[]})};}});
  assert.doesNotMatch(bare,/gitlab_projects/);assert.ok(none.content);
});
