import test from 'node:test';
import assert from 'node:assert/strict';
import {runProjectAgent,validateAgentReply} from '../dist/knowledge.js';
import {validateChat} from '../connectors/ki.mjs';
import {platformCatalog,platformSourceId} from '../dist/source-catalog.js';
import {coursePlatformFindings,mergePlatformFindings} from '../dist/platform-links.js';

const base='https://spaces.th-koeln.de';
const id=n=>'b:spaces-rest:'+n.toString(16).padStart(64,'0');
const revision='a'.repeat(64);
const state=()=>({projects:[
  {id:'alpha',name:'Interfaces',links:[{tool:'spaces',url:base+'/interfaces/'}]},
  {id:'beta',name:'Coding',links:[{tool:'spaces',url:base+'/coding/'}]},
  {id:'past',name:'Vergangener Kurs',archived:true,links:[{tool:'spaces',url:base+'/past/'}]},
  {id:'unlinked',name:'Ohne Space',links:[]},
],notes:[],tasks:[],calendarEvents:[],bookmarks:[],boardFindings:[],tools:[],activeCourse:'alpha'});
const header=(n=1,extra={})=>({id:id(n),title:'Interfaces beobachten',url:base+'/interfaces/aufgabe-'+n+'/',text:'',status:'metadata',kind:'browser',projectId:'alpha',source:'spaces',...extra});
const read=(n=1,extra={})=>({...header(n),text:'Beobachtet und analysiert zwei alltägliche Interfaces.',status:'full',revision,offset:0,hasMore:false,...extra});
const listing=(items=[header()],extra={})=>({items,page:1,hasMore:false,total:items.length,...extra});
const tool=(name,args)=>({content:JSON.stringify({type:'tool',tool:name,args}),totalTokens:2});
const answer=(text='Fertig',citations=[])=>({content:JSON.stringify({type:'answer',text,citations}),totalTokens:3});
const payload=messages=>JSON.parse(messages.at(-1).content.split('\n')[1]);
const rows=value=>value.items||value.results||[];
function run(replies,options={}){
  const complete=options.complete||(async messages=>{validateChat({model:'synthetic',messages});assert.ok(replies.length,'synthetic replies exhausted');return replies.shift();});
  return runProjectAgent({prompt:'Suche aktuelle Aufgaben direkt in Spaces.',workspace:state(),documents:[],projectId:'alpha',...options,complete});
}

test('direct Spaces tool protocol accepts only typed search and revision-bound read arguments',()=>{
  for(const reply of [tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('search_spaces',{projectId:'alpha',query:'Interfaces',page:2}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),tool('read_spaces_result',{projectId:'alpha',id:id(1),offset:4000,expectedRevision:revision})])assert.equal(validateAgentReply(reply.content).tool,JSON.parse(reply.content).tool);
  for(const args of [{projectId:'alpha',query:'x',url:base},{projectId:'alpha',query:'x',script:'document.cookie'},{projectId:'alpha',query:''},{projectId:'alpha',query:'   '},{projectId:'alpha',query:'x',page:0},{projectId:'alpha',query:'x',page:-1},{projectId:'alpha',query:'x',page:1.5},{projectId:'alpha',query:'x',page:'2'},{projectId:'alpha',query:'x',page:Number.MAX_SAFE_INTEGER+1},{projectId:'',query:'x'}])assert.throws(()=>validateAgentReply(tool('search_spaces',args).content));
  for(const args of [{projectId:'alpha',id:id(1),url:base},{projectId:'alpha',id:id(1),query:'x'},{projectId:'alpha',id:'b:spaces-rest:short'},{projectId:'alpha',id:'n:guessed'},{projectId:'alpha',id:id(1),offset:-1},{projectId:'alpha',id:id(1),offset:1.5},{projectId:'alpha',id:id(1),offset:'1'},{projectId:'alpha',id:id(1),expectedRevision:'wrong'},{projectId:'alpha',id:id(1),expectedRevision:'A'.repeat(64)}])assert.throws(()=>validateAgentReply(tool('read_spaces_result',args).content));
});

test('search then read then answer attaches only the delivered live Spaces evidence',async()=>{
  const calls=[],packets=[],doc=read(),replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:doc.id}),answer('Zwei Interfaces untersuchen. ['+doc.id+']',[doc.id])];
  const result=await run(replies,{spaces:async(name,args,signal,scope)=>{calls.push({name,args,scope});return name==='search_spaces'?listing():doc;},complete:async messages=>{validateChat({model:'synthetic',messages});if(messages.length>1)packets.push(payload(messages));return replies.shift();}});
  assert.deepEqual(calls.map(c=>c.name),['search_spaces','read_spaces_result']);assert.ok(calls.every(c=>c.scope==='alpha'&&c.args.projectId==='alpha'));assert.equal(rows(packets[0])[0].id,doc.id);assert.equal(rows(packets[0])[0].text||'','');assert.equal(packets[1].text,doc.text);
  assert.equal(result.citations.length,1);assert.equal(result.citations[0].url,doc.url);assert.equal(result.citations[0].text,packets[1].text);assert.equal(result.unverifiedCitations,false);assert.ok(result.steps.every(step=>step.status==='done'));
});

test('search headers alone are not content citations and cannot smuggle adapter body text',async()=>{
  const replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),answer('Nur ein Suchtreffer. ['+id(1)+']',[id(1)])];
  const result=await run(replies,{spaces:async()=>listing([header(1,{text:'UNREAD_SEARCH_BODY',status:'full'})]),complete:async messages=>{assert.doesNotMatch(JSON.stringify(messages),/UNREAD_SEARCH_BODY/);return replies.shift();}});
  assert.equal(result.citations.length,0);assert.equal(result.unverifiedCitations,true);assert.ok(!result.sources.some(source=>source.id===id(1)));
});

test('search pagination offers a later page before reading its result',async()=>{
  const calls=[],packets=[],replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('search_spaces',{projectId:'alpha',query:'Interfaces',page:2}),tool('read_spaces_result',{projectId:'alpha',id:id(2)}),answer('Aufgabe auf Seite zwei.',[id(2)])];
  const result=await run(replies,{spaces:async(name,args)=>{calls.push({name,args});return name==='read_spaces_result'?read(2):args.page===2?listing([header(2)],{page:2,total:2}):listing([header()],{page:1,hasMore:true,total:2});},complete:async messages=>{validateChat({model:'synthetic',messages});if(messages.length>1)packets.push(payload(messages));return replies.shift();}});
  assert.equal(calls[1].args.page,2);assert.equal(packets[0].hasMore,true);assert.equal(packets[1].page,2);assert.equal(rows(packets[1])[0].id,id(2));assert.equal(result.citations[0].id,id(2));
});

test('an unoffered or guessed result ID is rejected before native read',async()=>{
  const calls=[],replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(999)}),answer('Nicht zugänglich',[id(999)])];
  const result=await run(replies,{spaces:async(name)=>{calls.push(name);return listing();}});assert.deepEqual(calls,['search_spaces']);assert.equal(result.steps[1].status,'error');assert.equal(result.citations.length,0);
});

test('result IDs from a previous run do not grant read access in a later run',async()=>{
  await run([tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),answer()],{spaces:async()=>listing()});let reads=0;
  const result=await run([tool('read_spaces_result',{projectId:'alpha',id:id(1)}),answer()],{spaces:async()=>{reads++;return read();}});assert.equal(reads,0);assert.equal(result.steps[0].status,'error');
});

for(const projectId of ['beta','past','missing','unlinked'])test(`Spaces search rejects unavailable or foreign course ${projectId} before native access`,async()=>{
  let calls=0;const result=await run([tool('search_spaces',{projectId,query:'Aufgabe'}),answer()],{spaces:async()=>{calls++;return listing();}});assert.equal(calls,0);assert.equal(result.steps[0].status,'error');assert.equal(result.sources.length,0);
});

test('an all-course chat can explicitly search and read a linked active second course',async()=>{
  const calls=[],meta=header(2,{projectId:'beta',url:base+'/coding/aufgabe/'}),replies=[tool('search_spaces',{projectId:'beta',query:'Programmieren'}),tool('read_spaces_result',{projectId:'beta',id:id(2)}),answer('Coding-Aufgabe',[id(2)])];
  const result=await run(replies,{projectId:'',spaces:async(name,args,signal,scope)=>{calls.push({name,args,scope});return name==='search_spaces'?listing([meta]):{...meta,text:'Programmiere ein Interface.',status:'full',revision,offset:0,hasMore:false};}});
  assert.ok(calls.every(c=>c.scope===''&&c.args.projectId==='beta'));assert.equal(result.citations[0].projectId,'beta');
});

test('the same offered ID cannot be read under a different course in an all-course chat',async()=>{
  const calls=[],result=await run([tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'beta',id:id(1)}),answer()],{projectId:'',spaces:async name=>{calls.push(name);return listing();}});assert.deepEqual(calls,['search_spaces']);assert.equal(result.steps[1].status,'error');
});

test('direct Spaces tools remain unavailable when the callback is disabled',async()=>{const result=await run([tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),answer()]);assert.equal(result.steps[0].status,'error');assert.equal(result.sources.length,0);});

test('foreign and unsafe adapter search headers cannot become offered IDs or model context',async()=>{
  const replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(2)}),answer()],calls=[];
  const result=await run(replies,{spaces:async name=>{calls.push(name);return listing([header(),header(2,{projectId:'beta',title:'FOREIGN_HEADER',url:base+'/coding/private/'}),header(3,{title:'UNSAFE_HEADER',url:'https://evil.test/private/'})]);},complete:async messages=>{assert.doesNotMatch(JSON.stringify(messages),/FOREIGN_HEADER|UNSAFE_HEADER/);return replies.shift();}});
  assert.deepEqual(calls,['search_spaces']);assert.equal(result.steps[1].status,'error');
});

test('course URLs without a trailing slash cannot authorize a lookalike course prefix',async()=>{
  const workspace=state();workspace.projects[0].links[0].url=base+'/interfaces';const replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(2)}),answer()],calls=[];
  const result=await run(replies,{workspace,spaces:async name=>{calls.push(name);return listing([header(2,{url:base+'/interfaces-other/private/',title:'LOOKALIKE_FOREIGN_COURSE'})]);},complete:async messages=>{assert.doesNotMatch(JSON.stringify(messages),/LOOKALIKE_FOREIGN_COURSE/);return replies.shift();}});assert.deepEqual(calls,['search_spaces']);assert.equal(result.steps[1].status,'error');
});

test('search results omitted by the output budget do not grant reads by their undisclosed IDs',async()=>{
  const calls=[],items=Array.from({length:5},(_,index)=>header(index+1,{title:'T'.repeat(500),url:base+'/interfaces/'+('x'.repeat(1800))+index+'/'})),replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(5)}),answer()];let shown;
  const result=await run(replies,{spaces:async name=>{calls.push(name);return listing(items);},complete:async messages=>{validateChat({model:'synthetic',messages});if(messages.length===3)shown=payload(messages);return replies.shift();}});assert.ok(!rows(shown).some(item=>item.id===id(5)));assert.deepEqual(calls,['search_spaces']);assert.equal(result.steps[1].status,'error');
});

for(const [label,change] of [['different ID',doc=>({...doc,id:id(2)})],['foreign course',doc=>({...doc,projectId:'beta'})],['changed URL',doc=>({...doc,url:base+'/interfaces/other/'})],['unsafe URL',doc=>({...doc,url:'https://evil.test/'})]])test(`read result with ${label} cannot supply text evidence`,async()=>{
  const replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),answer('Keine Quelle',[id(1)])];
  const result=await run(replies,{spaces:async name=>name==='search_spaces'?listing():change(read(1,{text:'MISMATCHED_PRIVATE_BODY'})),complete:async messages=>{assert.doesNotMatch(JSON.stringify(messages),/MISMATCHED_PRIVATE_BODY/);return replies.shift();}});assert.equal(result.steps[1].status,'error');assert.equal(result.citations.length,0);assert.equal(result.sources.length,0);
});

test('continued read windows retain their revision and cite only delivered fragments',async()=>{
  const calls=[],replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),tool('read_spaces_result',{projectId:'alpha',id:id(1),offset:4000,expectedRevision:revision}),answer('Zwei gelesene Abschnitte',[id(1)])];
  const result=await run(replies,{spaces:async(name,args)=>{calls.push({name,args});if(name==='search_spaces')return listing();return args.offset?read(1,{text:'SECOND_DELIVERED_WINDOW',offset:4000}):read(1,{text:'FIRST_DELIVERED_WINDOW',hasMore:true,nextOffset:4000});}});
  assert.equal(calls[2].args.expectedRevision,revision);assert.equal(calls[2].args.offset,4000);assert.match(result.citations[0].text,/FIRST_DELIVERED_WINDOW/);assert.match(result.citations[0].text,/SECOND_DELIVERED_WINDOW/);
});

test('a changed read revision cannot deliver a later text window as the earlier snapshot',async()=>{
  const replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),tool('read_spaces_result',{projectId:'alpha',id:id(1),offset:4000,expectedRevision:revision}),answer('Nur erster Abschnitt',[id(1)])];
  const result=await run(replies,{spaces:async(name,args)=>name==='search_spaces'?listing():args.offset?read(1,{text:'NEW_REVISION_PRIVATE_BODY',offset:4000,revision:'b'.repeat(64)}):read(1,{text:'FIRST_SNAPSHOT',hasMore:true,nextOffset:4000}),complete:async messages=>{assert.doesNotMatch(JSON.stringify(messages),/NEW_REVISION_PRIVATE_BODY/);return replies.shift();}});assert.equal(result.steps[2].status,'error');assert.match(result.citations[0].text,/FIRST_SNAPSHOT/);
});

test('bounded tool output cannot turn an unread adapter tail into a source or citation',async()=>{
  let delivered;const replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),answer('Gelesener Auszug',[id(1)])];
  const result=await run(replies,{spaces:async name=>name==='search_spaces'?listing():read(1,{text:'Aufgabe '.repeat(1800)+'UNREAD_ADAPTER_TAIL'}),complete:async messages=>{validateChat({model:'synthetic',messages});if(messages.length===5)delivered=payload(messages);return replies.shift();}});
  if(delivered.error){assert.equal(result.steps[1].status,'error');assert.equal(result.citations.length,0);assert.equal(result.sources.length,0);}
  else{assert.ok(delivered.text.length<15000);assert.doesNotMatch(delivered.text,/UNREAD_ADAPTER_TAIL/);assert.equal(result.citations[0].text,delivered.text);}
  assert.doesNotMatch(JSON.stringify(result.steps),/UNREAD_ADAPTER_TAIL/);assert.doesNotMatch(JSON.stringify(result.sources),/UNREAD_ADAPTER_TAIL/);
});

for(const [label,mutate] of [['archived',w=>{w.projects[0].archived=true;}],['deleted',w=>{w.projects=w.projects.filter(p=>p.id!=='alpha');}],['relinked',w=>{w.projects[0].links[0].url=base+'/replacement/';}]])test(`a course ${label} during pending search aborts before another model turn`,async()=>{
  const workspace=state();let completeCalls=0;
  await assert.rejects(run([], {workspace,getWorkspace:()=>workspace,spaces:async()=>{mutate(workspace);return listing([header(1,{title:'LATE_SCOPE_HEADER'})]);},complete:async messages=>{completeCalls++;assert.doesNotMatch(JSON.stringify(messages),/LATE_SCOPE_HEADER/);return completeCalls===1?tool('search_spaces',{projectId:'alpha',query:'Interfaces'}):answer();}}),{name:'AbortError'});assert.equal(completeCalls,1);
});

test('scope changes after a read starts cannot release late body text or citations',async()=>{
  const workspace=state();let completeCalls=0;const replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),answer()];
  await assert.rejects(run(replies,{workspace,getWorkspace:()=>workspace,spaces:async name=>{if(name==='search_spaces')return listing();workspace.projects[0].archived=true;return read(1,{text:'LATE_REVOKED_READ_BODY'});},complete:async messages=>{completeCalls++;assert.doesNotMatch(JSON.stringify(messages),/LATE_REVOKED_READ_BODY/);return replies.shift();}}),{name:'AbortError'});assert.equal(completeCalls,2);
});

test('aborting before a run prevents both provider and direct Spaces access',async()=>{const controller=new AbortController();controller.abort();let calls=0;await assert.rejects(run([],{signal:controller.signal,spaces:async()=>calls++,complete:async()=>{calls++;return answer();}}),{name:'AbortError'});assert.equal(calls,0);});

test('aborting a pending direct Spaces read prevents late evidence and another model turn',async()=>{
  const controller=new AbortController(),replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)})];let modelCalls=0;
  await assert.rejects(run(replies,{signal:controller.signal,spaces:async name=>{if(name==='search_spaces')return listing();controller.abort();return read(1,{text:'LATE_ABORTED_BODY'});},complete:async messages=>{modelCalls++;assert.doesNotMatch(JSON.stringify(messages),/LATE_ABORTED_BODY/);return replies.shift();}}),{name:'AbortError'});assert.equal(modelCalls,2);
});

const quote='Workshop am 16.10.2026 von 09:00 bis 10:00 Uhr.';
const calendarArgs=()=>({projectId:'alpha',events:[{title:'Workshop',start:'2026-10-16T09:00:00+02:00',end:'2026-10-16T10:00:00+02:00',allDay:false,sourceId:id(1),excerpt:quote}]});
test('metadata-only search results cannot authorize calendar writes even when their title contains a date',async()=>{
  let writes=0;const replies=[tool('search_spaces',{projectId:'alpha',query:'Workshop'}),tool('create_calendar',calendarArgs()),answer()];
  const result=await run(replies,{prompt:'Erstelle die Termine in meinem Kalender.',allowCalendarActions:true,spaces:async()=>listing([header(1,{title:quote})]),execute:async()=>{writes++;return {saved:true};}});assert.equal(writes,0);assert.equal(result.proposals.length,0);assert.equal(result.steps[1].status,'error');
});

test('a previously delivered read excerpt can support a grounded calendar import',async()=>{
  const actions=[],replies=[tool('search_spaces',{projectId:'alpha',query:'Workshop'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),tool('create_calendar',calendarArgs()),answer()];
  const result=await run(replies,{prompt:'Erstelle die Termine in meinem Kalender.',allowCalendarActions:true,spaces:async name=>name==='search_spaces'?listing():read(1,{text:quote}),execute:async action=>{actions.push(action);return {saved:true,id:action.id,eventIds:['local-calendar-test']};}});assert.equal(actions.length,1);assert.equal(actions[0].sources[0].text,quote);assert.equal(result.steps[2].status,'done');assert.equal(result.proposals.length,0);
});

const boardURL='https://miro.com/app/board/uXjVSpacesRestBoard=/';
const boardSource=()=>platformSourceId({service:'miro',url:boardURL,projectId:'alpha'});
const boardDoc=()=>({id:'miro:'+'c'.repeat(64)+':part0',kind:'miro',service:'miro',source:'Miro',sourceId:boardSource(),projectId:'alpha',boardURL,boardId:'uXjVSpacesRestBoard=',itemId:'1001',url:boardURL+'?moveToWidget=1001',title:'Beobachtungsaufgabe',text:'READ_MIRO_CONTENT: Dokumentiert drei unterschiedliche Interfaces.',status:'full',accountGeneration:'b'.repeat(64),fetchedAt:'2026-10-14T12:00:00Z'});
const linkedRead=(extra={})=>read(1,{contentRevision:revision,platformLinks:[{service:'miro',url:boardURL,title:'Arbeitsboard',sourceURL:header().url,sourceTitle:header().title}],platformLinksMore:false,...extra});
function persistObserved(workspace,doc){workspace.platformFindings=mergePlatformFindings(workspace.platformFindings||[],coursePlatformFindings(doc,{workspace,projectId:'alpha',now:'2026-10-14T12:00:00Z'}),{workspace});}

test('direct Spaces read offers current observed Miro catalogue IDs and permits a separate grounded board read',async()=>{
  const workspace=state(),doc=linkedRead(),miro=boardDoc(),calls=[],replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),tool('read_platform',{sourceId:boardSource()}),answer('Drei Interfaces dokumentieren. ['+miro.id+']',[miro.id])];let offered;
  const result=await run(replies,{workspace,getWorkspace:()=>workspace,spaces:async name=>{if(name==='search_spaces')return listing();persistObserved(workspace,doc);return doc;},platform:async(name,args,signal,scope)=>{calls.push({name,args,scope});return {documents:[miro],result:{results:[{id:miro.id,text:miro.text}]}};},complete:async messages=>{validateChat({model:'synthetic',messages});if(messages.length===5){offered=payload(messages);assert.doesNotMatch(JSON.stringify(messages),/READ_MIRO_CONTENT/);}return replies.shift();}});
  assert.equal(offered.platformSources.length,1);assert.equal(offered.platformSources[0].id,boardSource());assert.equal(offered.platformSources[0].projectId,'alpha');assert.equal(offered.platformSources[0].service,'miro');assert.equal(offered.platformSources[0].state,'link-found-content-unread');assert.ok(!Object.hasOwn(offered.platformSources[0],'text'));
  assert.equal(calls.length,1);assert.equal(calls[0].scope,'alpha');assert.equal(calls[0].args.sourceId,boardSource());assert.equal(result.citations[0].id,miro.id);assert.match(result.citations[0].text,/READ_MIRO_CONTENT/);assert.equal(result.unverifiedCitations,false);
});

test('an observed Miro link from a direct read does not itself provide board-content evidence',async()=>{
  const workspace=state(),doc=linkedRead(),miro=boardDoc(),replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),answer('Board noch ungelesen',[miro.id])];let platformCalls=0,offered;
  const result=await run(replies,{workspace,getWorkspace:()=>workspace,spaces:async name=>{if(name==='search_spaces')return listing();persistObserved(workspace,doc);return doc;},platform:async()=>{platformCalls++;return {};},complete:async messages=>{if(messages.length===5)offered=payload(messages);assert.doesNotMatch(JSON.stringify(messages),/READ_MIRO_CONTENT/);return replies.shift();}});
  assert.equal(offered.platformSources[0].state,'link-found-content-unread');assert.equal(platformCalls,0);assert.equal(result.citations.length,0);assert.equal(result.unverifiedCitations,true);assert.ok(!result.sources.some(source=>source.kind==='miro'));
});

test('search metadata cannot inject discovered platform source offers before a direct read',async()=>{
  const replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),answer()];let shown;
  const result=await run(replies,{spaces:async()=>listing([{...header(),platformLinks:linkedRead().platformLinks,platformSources:[{id:boardSource(),projectId:'alpha',service:'miro',title:'INJECTED_SEARCH_PLATFORM'}]}],{platformSources:[{id:boardSource(),title:'INJECTED_SEARCH_PLATFORM'}]}),platform:async()=>({}),complete:async messages=>{if(messages.length===3)shown=payload(messages);assert.doesNotMatch(JSON.stringify(messages),/INJECTED_SEARCH_PLATFORM/);return replies.shift();}});
  assert.ok(!shown.platformSources?.length);assert.ok(!rows(shown).some(item=>item.platformSources?.length));assert.equal(result.sources.length,0);
});

test('direct read does not advertise platform reading capabilities when the platform callback is disabled',async()=>{
  const replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),tool('read_platform',{sourceId:boardSource()}),answer()];let shown;
  const result=await run(replies,{spaces:async name=>name==='search_spaces'?listing():linkedRead(),complete:async messages=>{if(messages.length===5)shown=payload(messages);return replies.shift();}});assert.ok(!shown.platformSources?.length);assert.equal(result.steps[2].status,'error');assert.ok(!result.sources.some(source=>source.kind==='miro'));
});

test('direct read platform offers use current exact course and URL catalogue rows instead of injected entries',async()=>{
  const workspace=state(),foreignURL='https://miro.com/app/board/uXjVForeignRestBoard=/',foreignID=platformSourceId({service:'miro',url:foreignURL,projectId:'beta'});workspace.projects[0].links.push({tool:'miro',url:boardURL,title:'Registriertes Arbeitsboard'});workspace.projects[1].links.push({tool:'miro',url:foreignURL,title:'FOREIGN_CATALOGUE_TITLE'});
  const doc=linkedRead({platformLinks:[...linkedRead().platformLinks,{service:'miro',url:foreignURL,title:'FOREIGN_OBSERVED_LINK',sourceURL:header().url}],platformSources:[{id:foreignID,projectId:'alpha',service:'miro',title:'INJECTED_FOREIGN_ID'},{id:'platform:'+'f'.repeat(32),projectId:'alpha',service:'miro',title:'INJECTED_UNREGISTERED_ID'}]}),replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),answer()];let shown;
  await run(replies,{workspace,getWorkspace:()=>workspace,spaces:async name=>name==='search_spaces'?listing():doc,platform:async()=>({}),complete:async messages=>{if(messages.length===5)shown=payload(messages);assert.doesNotMatch(JSON.stringify(messages),/INJECTED_FOREIGN_ID|INJECTED_UNREGISTERED_ID|FOREIGN_CATALOGUE_TITLE/);return replies.shift();}});
  assert.deepEqual(shown.platformSources.map(source=>source.id),[boardSource()]);assert.ok(shown.platformSources.every(source=>source.projectId==='alpha'&&source.service==='miro'));assert.equal(platformCatalog(workspace).find(source=>source.id===foreignID).projectId,'beta');
});

test('a catalogue entry removed during pending Spaces read cannot be offered or subsequently read',async()=>{
  const workspace=state();workspace.projects[0].links.push({tool:'miro',url:boardURL,title:'Arbeitsboard'});const replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),tool('read_platform',{sourceId:boardSource()}),answer()];let shown,platformCalls=0;
  const result=await run(replies,{workspace,getWorkspace:()=>workspace,spaces:async name=>{if(name==='search_spaces')return listing();workspace.projects[0].links=workspace.projects[0].links.filter(link=>link.tool!=='miro');return linkedRead();},platform:async()=>{platformCalls++;return {};},complete:async messages=>{if(messages.length===5)shown=payload(messages);return replies.shift();}});
  assert.ok(!shown.platformSources?.some(source=>source.id===boardSource()));assert.equal(platformCalls,0);assert.equal(result.steps[2].status,'error');
});

test('direct Spaces platform offers cap the delivered catalogue and explicitly mark remaining links',async()=>{
  const workspace=state(),links=Array.from({length:15},(_,index)=>({service:'miro',url:'https://miro.com/app/board/uXjVRestCapacity'+index+'=/',title:'Arbeitsboard '+index,sourceURL:header().url}));workspace.projects[0].links.push(...links.map(link=>({tool:'miro',url:link.url,title:link.title})));const replies=[tool('search_spaces',{projectId:'alpha',query:'Interfaces'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),answer()];let shown;
  await run(replies,{workspace,getWorkspace:()=>workspace,spaces:async name=>name==='search_spaces'?listing():linkedRead({platformLinks:links}),platform:async()=>({}),complete:async messages=>{validateChat({model:'synthetic',messages});if(messages.length===5)shown=payload(messages);return replies.shift();}});assert.equal(shown.platformSources.length,12);assert.equal(shown.totalPlatformSources,15);assert.equal(shown.platformLinksMore,true);assert.ok(shown.platformSources.every(source=>source.state==='link-found-content-unread'));
});
