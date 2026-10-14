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

test('who am I, my open tasks and search work like a read-only plugin',async()=>{
  const {fetcher,calls}=api({'/api/v4/user':()=>reply(200,{id:3,username:'pat',name:'Pat Doe',web_url:'https://git.coco.study/pat'}),
    '/issues?scope=assigned_to_me':()=>reply(200,[{title:'README ergänzen',state:'opened',due_date:'2026-10-17',labels:['Abgabe'],project_id:7,web_url:'https://git.coco.study/a/-/issues/1'}]),
    '/merge_requests?scope=assigned_to_me':()=>reply(200,[]),'/todos?state=pending':()=>reply(200,[{action_name:'mentioned',target:{title:'Feedback'},project:{path_with_namespace:'a/b'},target_url:'https://git.coco.study/a/b/-/issues/2'}]),
    '/projects/7/search?scope=blobs':()=>reply(200,[{path:'README.md',startline:3,data:'## Status\n- [ ] Prototyp',project_id:7}]),
    '/search?scope=projects':()=>reply(200,[{id:7,path_with_namespace:'students/pat/uusa'}])});
  const ctx={fetcher,token:'t0k3n-123456'};
  assert.deepEqual(await gitlabRead('me',{},ctx),{username:'pat',name:'Pat Doe',url:'https://git.coco.study/pat'});
  const tasks=await gitlabRead('tasks',{},ctx);assert.equal(tasks.issues[0].due,'2026-10-17');assert.deepEqual(tasks.issues[0].labels,['Abgabe']);assert.equal(tasks.todos[0].title,'Feedback');
  const projectTasks=await gitlabRead('tasks',{projectId:7},ctx);assert.deepEqual(projectTasks.todos,[]);assert.ok(calls.some(call=>call.url.includes('/api/v4/projects/7/issues?scope=assigned_to_me')));
  assert.equal((await gitlabRead('search',{query:'Status',projectId:7},ctx)).results[0].snippet,'## Status\n- [ ] Prototyp');
  assert.equal((await gitlabRead('search',{query:'uusa'},ctx)).results[0].path,'students/pat/uusa');
  for(const args of [{query:'x'},{query:'uusa',scope:'blobs'},{query:'uusa',projectId:7,scope:'users'}])await assert.rejects(gitlabRead('search',args,ctx),{code:'invalid_request'},JSON.stringify(args));
  assert.ok(calls.every(call=>call.method==='GET'&&call.url.startsWith('https://git.coco.study/api/v4/')));
  const tool=(name,args)=>JSON.stringify({type:'tool',tool:name,args});
  for(const [name,args] of [['gitlab_me',{}],['gitlab_tasks',{}],['gitlab_tasks',{projectId:7}],['gitlab_search',{query:'README',scope:'blobs',projectId:7}]])assert.equal(validateAgentReply(tool(name,args)).tool,name);
  for(const [name,args] of [['gitlab_me',{x:1}],['gitlab_search',{query:'a'}],['gitlab_search',{query:'abc',scope:'users'}],['gitlab_tasks',{projectId:'x'}]])assert.throws(()=>validateAgentReply(tool(name,args)),undefined,name);
});

test('an answer that ends with a question brings clickable suggestions; bad suggestions are dropped, never the answer',async()=>{
  const ok=validateAgentReply(JSON.stringify({type:'answer',text:'Welches Repo ist deine Abgabe?',citations:[],options:['students/pat/uusa','students/pat/uusa-alt','students/pat/uusa'],multiple:false}));
  assert.deepEqual(ok.options,['students/pat/uusa','students/pat/uusa-alt']);
  const bad=validateAgentReply(JSON.stringify({type:'answer',text:'Fertig.',citations:[],options:['nur eine']}));assert.equal(bad.options,undefined);assert.equal(bad.text,'Fertig.');
  const ws={projects:[],notes:[],tasks:[],calendarEvents:[],boardFindings:[],bookmarks:[],tools:[]};
  const result=await runProjectAgent({prompt:'Prüfe meine Abgabe',workspace:ws,documents:[],complete:async()=>({content:JSON.stringify({type:'answer',text:'Ich habe zwei Forks gefunden. Welcher ist deine Abgabe?',citations:[],options:['uusa (aktuell)','uusa-alt']})})});
  assert.deepEqual(result.clarification,{question:'Welcher ist deine Abgabe?',options:['uusa (aktuell)','uusa-alt'],multiple:false,answer:''});
});
