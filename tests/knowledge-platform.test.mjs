import test from 'node:test';
import assert from 'node:assert/strict';
import {buildKnowledge,runProjectAgent,validateAgentReply,DEFAULT_KNOWLEDGE} from '../dist/knowledge.js';
import {platformCatalog} from '../dist/source-catalog.js';
import {cleanPlatformSources} from '../dist/source-store.js';
import {citationIds,citationsToMarkdown} from '../dist/citations.js';
import {renderMarkdown} from '../dist/markdown.js';
import {buildSearchDocuments} from '../dist/search-documents.js';
import {createSearchIndex} from '../dist/search-index.js';
import {cleanChat,recoverChat} from '../dist/chat-archive.js';
import {validateChat} from '../connectors/ki.mjs';

const boardA='https://miro.com/app/board/uXjVTestBoardA=/',boardB='https://miro.com/app/board/uXjVTestBoardB=/';
const workspace=()=>({projects:[{id:'courseA',name:'Kurs A',links:[{id:'boardA',tool:'miro',url:boardA,title:'Kursboard A'},{id:'repoA',tool:'gitlab',url:'https://git.coco.study/course/repoA',title:'Repository A'}]},{id:'courseB',name:'Kurs B',links:[{id:'boardB',tool:'miro',url:boardB,title:'Kursboard B'}]}],notes:[],tasks:[],calendarEvents:[],boardFindings:[],bookmarks:[],tools:[]});
function sourceDoc(state,{course='courseA',index=1,text='Analysiere ein barrierefreies Interface.',title='Aufgabenstellung',...rest}={}){
  const source=platformCatalog(state).find(row=>row.service==='miro'&&row.projectId===course),itemId=String(1000+index),id='miro:'+index.toString(16).padStart(64,'0')+':part0';
  return {id,kind:'miro',service:'miro',source:'Miro',sourceId:source.id,projectId:course,boardURL:source.url,boardId:new URL(source.url).pathname.split('/')[3],itemId,url:source.url+'?moveToWidget='+itemId,title,text,status:'full',accountGeneration:'b'.repeat(64),fetchedAt:'2026-10-14T15:00:00Z',...rest};
}
const answer=(text='Fertig',citations=[])=>({content:JSON.stringify({type:'answer',text,citations}),totalTokens:10});
const tool=(name,args)=>({content:JSON.stringify({type:'tool',tool:name,args}),totalTokens:20});
const packets=docs=>docs.map(doc=>({id:doc.id,title:doc.title,text:doc.text,status:doc.status,url:doc.url}));
const payload=messages=>JSON.parse(messages.at(-1).content.split('\n')[1]);

test('platform knowledge opt-in contains only valid active course-board evidence, never mere links or other courses',()=>{
  const state=workspace(),a=sourceDoc(state),b=sourceDoc(state,{course:'courseB',index:2,text:'PRIVATE_OTHER_COURSE'});
  const docs=buildKnowledge(state,[],{projectId:'courseA',enabled:{platforms:true},platformSources:[a,b,{...a,id:'miro:'+'c'.repeat(64),url:boardB}]});
  assert.deepEqual(docs.map(doc=>doc.id),[a.id]);assert.doesNotMatch(JSON.stringify(docs),/PRIVATE_OTHER_COURSE/);
  assert.deepEqual(buildKnowledge(state,[],{projectId:'courseA',enabled:{platforms:false},platformSources:[a]}),[]);
  assert.equal(DEFAULT_KNOWLEDGE.platforms,true);
  state.projects[0].archived=true;assert.deepEqual(buildKnowledge(state,[],{enabled:{platforms:true},platformSources:[a]}),[]);
});
test('platform source validation checks source identity, board/item URL, kind, text budget and credential redaction',()=>{
  const state=workspace(),good=sourceDoc(state,{text:'API key: PRIVATE_SECRET\nAufgabe korrekt'}),bad=[{...good,sourceId:'platform:'+'a'.repeat(32)},{...good,projectId:'courseB'},{...good,kind:'service'},{...good,url:'https://evil.test'},{...good,text:'x'.repeat(20001)}];
  const docs=buildKnowledge(state,[],{enabled:{platforms:true},platformSources:[good,...bad]});assert.equal(docs.length,1);assert.doesNotMatch(docs[0].text,/PRIVATE_SECRET/);assert.match(docs[0].text,/Aufgabe korrekt/);
  state.projects[0].links=state.projects[0].links.filter(link=>link.tool!=='miro');assert.equal(buildKnowledge(state,[],{enabled:{platforms:true},platformSources:[good]}).length,0);
});
test('the documented maximum Miro board can persist and remain discoverable including its description',()=>{
  const state=workspace(),source=platformCatalog(state).find(row=>row.service==='miro'&&row.projectId==='courseA'),docs=Array.from({length:2001},(_,index)=>sourceDoc(state,{index:index+1,text:index===2000?'MAXIMUM_BOARD_DESCRIPTION_MARKER':'Kurze Aufgabe'})),record={sourceId:source.id,revision:source.revision,projectId:source.projectId,service:source.service,url:source.url,title:source.title,documents:docs,coverage:{complete:true,items:2000},warnings:[],fetchedAt:'2026-10-14T15:00:00Z',accountGeneration:'b'.repeat(64)};
  docs.at(-1).itemId='';docs.at(-1).url=source.url;
  const rows=cleanPlatformSources([record]);assert.equal(rows[0].documents.length,2001);
  const knowledge=buildKnowledge(state,[],{enabled:{platforms:true},platformSources:rows[0].documents,maxDocuments:5000});assert.equal(knowledge.length,2001);assert.match(knowledge.at(-1).text,/MAXIMUM_BOARD_DESCRIPTION_MARKER/);
});
test('platform tool protocol permits only typed reads and strict arguments',()=>{
  for(const entry of [tool('list_platform_sources',{}),tool('read_platform',{sourceId:'platform:'+'a'.repeat(32)}),tool('search_platform',{sourceId:'platform:'+'a'.repeat(32),query:'Aufgabe'}),tool('read_platform_file',{sourceId:'platform:'+'a'.repeat(32),url:'https://git.coco.study/course/repoA/-/raw/main/README.md',expectedRevision:'a'.repeat(64),offset:0})])assert.equal(validateAgentReply(entry.content).type,'tool');
  for(const entry of [tool('list_platform_sources',{url:boardA}),tool('read_platform',{sourceId:'platform:one',script:'document.cookie'}),tool('read_platform',{sourceId:'platform:one',offset:60001}),tool('open_platform',{sourceId:'platform:one',url:boardA}),tool('search_platform',{sourceId:'platform:one',query:'x'.repeat(201)}),tool('write_platform',{sourceId:'platform:one'})])assert.throws(()=>validateAgentReply(entry.content));
});
test('disabled platform access cannot contact a provider or inherit source knowledge from a result',async()=>{
  const state=workspace(),id=platformCatalog(state)[0].id,replies=[tool('read_platform',{sourceId:id}),answer()];let calls=0;
  const result=await runProjectAgent({prompt:'Prüfe Aufgaben',workspace:state,documents:[],projectId:'courseA',complete:async()=>replies.shift()});
  assert.equal(calls,0);assert.equal(result.sources.length,0);assert.equal(result.steps[0].status,'error');
});
test('platform runtime rejects guessed source IDs and cross-course source IDs before the callback',async()=>{
  const state=workspace(),foreign=platformCatalog(state).find(row=>row.projectId==='courseB'),replies=[tool('read_platform',{sourceId:'platform:'+'c'.repeat(32)}),tool('read_platform',{sourceId:foreign.id}),answer()];let calls=0;
  const result=await runProjectAgent({prompt:'Prüfe Aufgaben',workspace:state,documents:[],projectId:'courseA',platform:async()=>{calls++;return {documents:[],result:{}};},complete:async()=>replies.shift()});
  assert.equal(calls,0);assert.ok(result.steps.every(step=>step.status==='error'));
});
test('source metadata listing is paged from the current catalog and cannot inject adapter-supplied foreign sources',async()=>{
  const state=workspace();state.projects[0].links=Array.from({length:25},(_,index)=>({tool:'miro',id:'board-'+index,url:'https://miro.com/app/board/uXjVCatalog'+index+'=/',title:'Board '+index}));
  const replies=[tool('list_platform_sources',{}),tool('list_platform_sources',{offset:20}),answer()];let first,second;
  await runProjectAgent({prompt:'Liste Kursquellen',workspace:state,documents:[],projectId:'courseA',platform:async()=>({documents:[],result:{sources:[{id:'foreign',title:'PRIVATE_FOREIGN_CATALOG'}]}}),complete:async messages=>{if(messages.length===3)first=payload(messages);if(messages.length===5)second=payload(messages);assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_FOREIGN_CATALOG/);return replies.shift();}});
  assert.equal(first.sources.length,20);assert.equal(first.total,25);assert.equal(first.hasMore,true);assert.equal(first.nextOffset,20);assert.equal(second.sources.length,5);assert.equal(second.hasMore,false);assert.ok([...first.sources,...second.sources].every(source=>source.projectId==='courseA'));
});
test('platform list exposes only current scope and a bounded native read supplies searchable evidence',async()=>{
  const state=workspace(),a=sourceDoc(state),source=platformCatalog(state).find(row=>row.id===a.sourceId),replies=[tool('list_platform_sources',{}),tool('read_platform',{sourceId:source.id}),tool('search_knowledge',{query:'barrierefreies Interface'}),answer('Belegt ['+a.id+']',[a.id])],calls=[];
  const result=await runProjectAgent({prompt:'Prüfe Aufgaben',workspace:state,documents:[],projectId:'courseA',platform:async(name,args,signal,scope)=>{calls.push({name,args,scope});return name==='list_platform_sources'?{documents:[],result:{sources:[source],complete:false}}:{documents:[a],result:{results:packets([a]),coverage:'partial'}};},complete:async messages=>{validateChat({model:'synthetic',messages});return replies.shift();}});
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.scope==='courseA'));assert.equal(result.citations.length,1);assert.equal(result.citations[0].url,a.url);assert.equal(result.steps[1].status,'done');assert.equal(result.unverifiedCitations,false);
});
test('discarded out-of-scope platform documents cannot leak through raw result packets',async()=>{
  const state=workspace(),a=sourceDoc(state),b=sourceDoc(state,{course:'courseB',index:2,text:'PRIVATE_SCOPE_LEAK'}),replies=[tool('read_platform',{sourceId:a.sourceId}),answer()];
  const result=await runProjectAgent({prompt:'Prüfe Aufgaben',workspace:state,documents:[],projectId:'courseA',platform:async()=>({documents:[a,b],result:{results:packets([a,b])}}),complete:async messages=>{assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_SCOPE_LEAK/);return replies.shift();}});
  assert.ok(!result.sources.some(doc=>doc.id===b.id));
});
test('a read from one provider cannot inject evidence belonging to another provider in the same course',async()=>{
  const state=workspace(),a=sourceDoc(state,{text:'PRIVATE_DIFFERENT_PROVIDER'}),git=platformCatalog(state).find(row=>row.service==='gitlab'),replies=[tool('read_platform',{sourceId:git.id}),answer()];
  const result=await runProjectAgent({prompt:'Prüfe Repository',workspace:state,documents:[],projectId:'courseA',platform:async()=>({documents:[a],result:{results:packets([a])}}),complete:async messages=>{assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_DIFFERENT_PROVIDER/);return replies.shift();}});assert.equal(result.sources.length,0);
});
test('platform result navigation links must remain in the grant, not just share its host',async()=>{
  const state=workspace(),git=platformCatalog(state).find(row=>row.service==='gitlab'),replies=[tool('read_platform',{sourceId:git.id}),answer()];let output;
  await runProjectAgent({prompt:'Prüfe Repository',workspace:state,documents:[],projectId:'courseA',platform:async()=>({documents:[],result:{links:[{url:'https://git.coco.study/private/elsewhere/-/issues',title:'PRIVATE_NAV_MARKER'}],fileLinks:[{url:'https://git.coco.study/private/elsewhere/-/raw/main/README.md',title:'PRIVATE_FILE_MARKER'}]}}),complete:async messages=>{if(messages.length>1)output=payload(messages);return replies.shift();}});
  assert.deepEqual(output.links,[]);assert.deepEqual(output.fileLinks,[]);
});
test('login/permission failures carry no body/documents and do not become searchable agent evidence',async()=>{
  for(const flag of ['loginRequired','permissionRequired']){const state=workspace(),a=sourceDoc(state,{text:'PRIVATE_DENIED_BODY'}),replies=[tool('read_platform',{sourceId:a.sourceId}),answer()];
    const result=await runProjectAgent({prompt:'Prüfe Aufgaben',workspace:state,documents:[],projectId:'courseA',platform:async()=>({documents:[a],result:{[flag]:true,results:packets([a]),text:'PRIVATE_DENIED_BODY'}}),complete:async messages=>{assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_DENIED_BODY/);return replies.shift();}});assert.equal(result.sources.length,0);
  }
});
test('login/permission denial prevents repeat reads of that source within the same agent run',async()=>{
  for(const flag of ['loginRequired','permissionRequired']){const state=workspace(),a=sourceDoc(state),replies=[tool('read_platform',{sourceId:a.sourceId}),tool('search_platform',{sourceId:a.sourceId,query:'Aufgabe'}),answer()];let reads=0;
    const result=await runProjectAgent({prompt:'Prüfe Aufgaben',workspace:state,documents:[],projectId:'courseA',platform:async()=>{reads++;return {documents:[],result:{[flag]:true}};},complete:async()=>replies.shift()});assert.equal(reads,1);assert.equal(result.sources.length,0);
  }
});
test('citations and step sources contain exactly the delivered text sections rather than unread tails',async()=>{
  const state=workspace(),a=sourceDoc(state,{text:'Aufgabe '.repeat(2000)+'UNREAD_PRIVATE_TAIL'}),replies=[tool('read_platform',{sourceId:a.sourceId}),answer('Quelle',[''+a.id])];let delivered;
  const result=await runProjectAgent({prompt:'Prüfe Aufgaben',workspace:state,documents:[],projectId:'courseA',platform:async()=>({documents:[a],result:{results:packets([a])}}),complete:async messages=>{if(messages.length>1)delivered=payload(messages).results[0];return replies.shift();}});
  assert.ok(delivered.text.length<a.text.length);assert.equal(result.citations[0].text,delivered.text);assert.doesNotMatch(JSON.stringify(result.sources),/UNREAD_PRIVATE_TAIL/);assert.doesNotMatch(JSON.stringify(result.steps),/UNREAD_PRIVATE_TAIL/);
});
test('a citation to a bounded snippet is labelled as an excerpt even when its indexed source is complete',async()=>{
  const state=workspace(),a=sourceDoc(state,{text:'Aufgabenstellung '.repeat(1000)}),documents=buildKnowledge(state,[],{enabled:{platforms:true},platformSources:[a]});
  const result=await runProjectAgent({prompt:'Aufgabenstellung',workspace:state,documents,projectId:'courseA',complete:async()=>answer('Belegt ['+a.id+']',[a.id])});
  assert.equal(result.citations.length,1);assert.ok(result.citations[0].text.length<a.text.length);assert.equal(result.citations[0].status,'excerpt');assert.equal(documents[0].status,'full','index completeness remains independent of model-snippet completeness');
});
test('platform results omitted by the output budget cannot remain verified citations',async()=>{
  const state=workspace(),docs=Array.from({length:40},(_,index)=>sourceDoc(state,{index:index+1,title:'T'.repeat(220),text:'X'.repeat(12000)})),last=docs.at(-1),replies=[tool('read_platform',{sourceId:docs[0].sourceId}),answer('Unbelegt ['+last.id+']',[last.id])];let delivered;
  const result=await runProjectAgent({prompt:'Prüfe Aufgaben',workspace:state,documents:[],projectId:'courseA',platform:async()=>({documents:docs,result:{results:packets(docs)}}),complete:async messages=>{validateChat({model:'synthetic',messages});if(messages.length>1)delivered=payload(messages);return replies.shift();}});
  assert.ok(!delivered.results.some(doc=>doc.id===last.id));assert.equal(result.citations.length,0);assert.equal(result.unverifiedCitations,true);assert.ok(!result.sources.some(doc=>doc.id===last.id));
});
test('aborted platform work cannot contribute late evidence or request another model turn',async()=>{
  const state=workspace(),a=sourceDoc(state),controller=new AbortController();let calls=0;
  await assert.rejects(runProjectAgent({prompt:'Prüfe Aufgaben',workspace:state,documents:[],projectId:'courseA',signal:controller.signal,platform:async()=>{controller.abort();return {documents:[a],result:{results:packets([a])}};},complete:async()=>{calls++;return tool('read_platform',{sourceId:a.sourceId});}}),{name:'AbortError'});assert.equal(calls,1);
});
test('platform/tool output and full conversation remain bounded through the maximum read step budget',async()=>{
  const state=workspace(),a=sourceDoc(state,{text:'A'.repeat(20000)});let calls=0,reads=0;
  await assert.rejects(runProjectAgent({prompt:'Prüfe Aufgaben',workspace:state,documents:[],projectId:'courseA',platform:async()=>{reads++;return {documents:[a],result:{results:packets([a])}};},complete:async messages=>{calls++;validateChat({model:'synthetic',messages});assert.ok(messages.length<=21);return tool('read_platform',{sourceId:a.sourceId});}}),/Schrittgrenze/);assert.equal(calls,11);assert.equal(reads,10);
});
test('full 6000-character prompts with both live tool sets fit existing provider message limits',async()=>{
  const state=workspace();for(const length of [5500,6000]){let calls=0;
    await runProjectAgent({prompt:'Z'.repeat(length),workspace:state,documents:[],platform:async()=>({}),browser:async()=>({}),complete:async messages=>{calls++;validateChat({model:'synthetic',messages});assert.ok(messages[0].content.length<=12000);return answer();}});assert.equal(calls,1);
  }
  let calls=0;await assert.rejects(runProjectAgent({prompt:'Z'.repeat(6001),workspace:state,documents:[],complete:async()=>{calls++;return answer();}}),/6.000/);assert.equal(calls,0);
});
test('long observed file URLs and repeated rich read outputs respect the connector total-conversation budget',async()=>{
  const state=workspace(),grant=platformCatalog(state).find(row=>row.service==='gitlab'),base=grant.url+'/-/raw/main/'+Array.from({length:20},()=> 'x'.repeat(74)).join('/')+'/',docs=Array.from({length:5},(_,index)=>({id:'service:'+String(index+1).padStart(64,'0')+':part0',kind:'service',service:'gitlab',source:'gitlab',sourceId:grant.id,projectId:'courseA',title:'T'.repeat(200),text:'Aufgabe '.repeat(2000),status:'full',url:base+'README'+index+'.txt'}));let calls=0,reads=0;
  await assert.rejects(runProjectAgent({prompt:'Prüfe alle angebotenen Kursdateien und lies die Aufgabenstellungen.',workspace:state,documents:[],projectId:'courseA',platform:async()=>{reads++;return {documents:docs,result:{results:packets(docs),contentRevision:'a'.repeat(64)}};},complete:async messages=>{calls++;validateChat({model:'synthetic',messages});return tool('read_platform_file',{sourceId:grant.id,url:docs[0].url,expectedRevision:'a'.repeat(64)});}}),/Schrittgrenze|Kontextbudget/);
  assert.ok(calls<=11&&calls>0);assert.ok(reads<=10&&reads>0);
});
test('Miro/service citations render original element links and stay inert in labels, code and exported notes',()=>{
  const state=workspace(),a=sourceDoc(state,{title:'<script>unsafe</script> **Aufgabe**'}),service={id:'service:'+'a'.repeat(64)+':part0',kind:'service',source:'gitlab',title:'README',url:'https://git.coco.study/course/repoA/-/blob/main/README.md'};
  const content='Aufgabe ['+a.id+'] und README ['+service.id+']';assert.deepEqual(citationIds(content),[a.id,service.id]);
  const html=renderMarkdown(content,[],{sources:[a,service]});assert.equal((html.match(/class="ki-citation"/g)||[]).length,2);assert.match(html,/moveToWidget=1001/);assert.match(html,/GitLab · README/);assert.doesNotMatch(html,/<script>|<strong>Aufgabe/);
  const exported=citationsToMarkdown(content,[a,service]);assert.match(exported,/moveToWidget=1001/);assert.doesNotMatch(exported,/\[miro:|\[service:/);assert.deepEqual(citationIds('`['+a.id+']`\n```\n['+service.id+']\n```'),[]);
});
test('human search shares the validated platform index and routes to exact sources without indexing unlinked boards',()=>{
  const state=workspace(),a=sourceDoc(state,{text:'MIRO_DISCOVERY_MARKER Aufgabe'}),bad={...a,id:'miro:'+'f'.repeat(64),url:boardB};
  const collection=buildSearchDocuments({workspace:state,platformSources:[a,bad]}),index=createSearchIndex();index.replace(collection.documents);
  const matches=index.search('MIRO_DISCOVERY_MARKER');assert.equal(matches.length,1);assert.deepEqual(matches[0].route,{type:'source',id:a.id});assert.equal(collection.targets.get(a.id).document.url,a.url);assert.ok(!collection.documents.some(doc=>doc.id===bad.id));
});
test('local chat archives preserve platform opt-out and actual cited original links without native credentials',()=>{
  const state=workspace(),a=sourceDoc(state),record={version:1,id:'synthetic-chat',scope:'courseA',projectName:'Kurs A',createdAt:'2026-10-14T10:00:00Z',updatedAt:'2026-10-14T11:00:00Z',draft:'',enabled:{platforms:false},browserEnabled:true,messages:[{id:'a1',role:'assistant',content:'Belegt ['+a.id+']',citations:[a],sources:[a]}],steps:[],attachments:[]};
  const recovered=recoverChat(cleanChat(record));assert.equal(recovered.enabled.platforms,false);assert.equal(recovered.messages[0].citations[0].url,a.url);assert.doesNotMatch(JSON.stringify(recovered),/accountGeneration|connectionId|accessToken/);
});
