import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMiroBoardClient,miroPlainText,safeMiroBoard} from '../connectors/miro.mjs';
import {createDesktopMiro} from '../desktop/miro.mjs';
import {miroBoardSources,requestMiro} from '../dist/miro-knowledge.js';
import {coursePlatformFindings} from '../dist/platform-links.js';

const url='https://miro.com/app/board/uXjVBoardTest=/';
const boardId='uXjVBoardTest=';
const fixtureItem=(id='345876001',type='sticky_note',content='<p>Analysiere ein Interface.</p>')=>({id,type,data:{content},createdBy:{id:'123',name:'Anna Lehrerin'},createdAt:'2026-10-14T10:00:00Z',modifiedAt:'2026-10-14T12:00:00Z'});
function fixture({pages=[{data:[fixtureItem()]}],intercept}={}){
  const calls=[],state={status:{integrationId:'miro-read',connectionId:'connection-one',revision:'1:0',connected:true,capabilities:{boardRead:true}},pages,statusCalls:0};
  const nango={status:async service=>{assert.equal(service,'miro');state.statusCalls++;return structuredClone(state.status);},proxy:async(service,request,signal)=>{
    calls.push(request);assert.equal(service,'miro');assert.equal(request.method,'GET');assert.equal(request.identity.connectionId,'connection-one');assert.deepEqual(request.identity.capabilities,{boardRead:true});
    const special=await intercept?.(request,state,signal);if(special!==undefined)return special;
    const data=request.path.endsWith('/items')?state.pages.shift():{id:boardId,name:'User Interaction – Aufgaben',description:'<p>Woche 1</p>',createdBy:{id:'123',name:'Anna Lehrerin'},createdAt:'2026-10-01T11:00:00Z'};
    return {status:200,data};
  }};
  return {client:createMiroBoardClient({nango,now:()=> '2026-10-14T15:00:00.000Z'}),nango,calls,state};
}
test('Miro uses authenticated read-only board/items with cursor pagination and original item links',async()=>{
  const item=fixtureItem();item.parent={id:'999'};
  const f=fixture({pages:[{data:[item],cursor:'next==cursor'},{data:[{id:'999',type:'frame',data:{title:'Aufgaben Woche 1'}}]}]});
  const result=await f.client.board({url:url+'?share_link_id=private#unsafe'});
  assert.deepEqual(f.calls.map(r=>r.path),['/v2/boards/uXjVBoardTest%3D','/v2/boards/uXjVBoardTest%3D/items','/v2/boards/uXjVBoardTest%3D/items']);
  assert.deepEqual(f.calls[1].params,{limit:50});assert.deepEqual(f.calls[2].params,{limit:50,cursor:'next==cursor'});
  assert.equal(result.board.title,'User Interaction – Aufgaben');assert.equal(result.board.createdBy.name,'Anna Lehrerin');
  assert.equal(result.coverage.complete,true);assert.equal(result.coverage.pages,2);assert.equal(result.items[0].createdAt,'2026-10-14T10:00:00.000Z');
  assert.match(result.documents[0].id,/^miro:[a-f0-9]{64}$/);assert.match(result.documents.find(d=>d.itemId===item.id).text,/Bereich: Aufgaben Woche 1/);
  assert.equal(result.items[0].url,url+'?moveToWidget=345876001');assert.doesNotMatch(JSON.stringify(result),/share_link_id|private|connection-one|miro-read/);
});
test('stable item documents survive title/content edits and keep creator distinct from found-link poster',async()=>{
  const a=await fixture().client.board({url});const changed=fixtureItem();changed.data.content='Neue Aufgabe';changed.createdBy={id:'456'};
  const b=await fixture({pages:[{data:[changed]}]}).client.board({url});
  const old=a.documents.find(doc=>doc.itemId===changed.id),fresh=b.documents.find(doc=>doc.itemId===changed.id);
  assert.equal(old.id,fresh.id);assert.notEqual(old.text,fresh.text);assert.equal(b.items[0].createdBy.name,'');
  assert.doesNotMatch(fresh.text,/Erstellt von:/);assert.equal(b.coverage.complete,true);
});
test('unknown/image/PDF/embed items are metadata-only and explicitly partial without fetching external URLs',async()=>{
  const rows=['image','document','embed','future_item'].map((type,index)=>({...fixtureItem(String(index+1),type),data:{title:'Aufgabenblatt '+index,url:'http://127.0.0.1/private',content:'Bildinhalt darf nicht als gelesen gelten'}}));
  const f=fixture({pages:[{data:rows}]}),result=await f.client.board({url});
  assert.equal(result.coverage.complete,false);assert.equal(result.coverage.unsupportedItems,4);assert.equal(result.coverage.readableItems,0);assert.equal(f.calls.length,2);
  assert.equal(result.documents.filter(doc=>doc.itemId).length,4);assert.ok(result.documents.filter(doc=>doc.itemId).every(doc=>doc.status==='excerpt'&&doc.text.includes('Nur Metadaten')));assert.doesNotMatch(JSON.stringify(result),/127\.0\.0\.1|Bildinhalt darf/);
});
test('structured Miro docs read explicit text blocks; absent structured content stays partial',async()=>{
  const result=await fixture({pages:[{data:[{id:'1',type:'doc_format',data:{title:'Hausaufgabe',content:{blocks:[{text:'Erste Aufgabe'},{content:[{text:'Zweite Aufgabe'}]}],style:{text:'kein Inhalt'}}}},{id:'2',type:'doc_format',data:{title:'Dokument ohne Textzugriff'}}]}]}).client.board({url});
  assert.match(result.items[0].text,/Erste Aufgabe\nZweite Aufgabe/);assert.doesNotMatch(result.items[0].text,/kein Inhalt/);assert.equal(result.coverage.unsupportedItems,1);assert.equal(result.documents.find(doc=>doc.itemId==='2').status,'excerpt');
});
test('unknown structured document/table payloads are not mistaken for fully read text',async()=>{
  const result=await fixture({pages:[{data:[{id:'1',type:'doc_format',data:{title:'Aufgaben als Dokument',content:{opaque:'UNREAD_DOCUMENT_BODY'}}},{id:'2',type:'data_table_format',data:{title:'Aufgabentabelle',content:{cells:[{value:'UNREAD_TABLE_BODY'}]}}}]}]}).client.board({url});
  assert.equal(result.coverage.complete,false);assert.equal(result.coverage.unsupportedItems,2);assert.doesNotMatch(JSON.stringify(result),/UNREAD_DOCUMENT_BODY|UNREAD_TABLE_BODY/);assert.ok(result.documents.filter(doc=>doc.itemId).every(doc=>doc.status==='excerpt'));
});
test('HTML is converted to inert German text; script, iframe, SVG and controls do not become knowledge',()=>{
  assert.equal(miroPlainText('<p>&Auml;nderung &amp; &#xFC;ben</p><script>fetch("secret")</script><iframe src="https://evil.test">sensitive</iframe><svg><text>do not index</text></svg><p>Zwei&nbsp;Zeilen<br>ja\0</p>'),'Änderung & üben\n\nZwei Zeilen\nja');
  assert.equal(miroPlainText('Komplexität < O(n)'),'Komplexität < O(n)');
});
test('malformed HTML remains inert and repeated unmatched hidden tags stay bounded',()=>{
  assert.equal(miroPlainText('Aufgabe<script>private hidden'),'Aufgabe');
  assert.equal(miroPlainText('Aufgabe<script attr="unterminated>private hidden'),'Aufgabe');
  const before=performance.now();assert.equal(miroPlainText('Aufgabe'+('<script>hidden'.repeat(10000))),'Aufgabe');assert.ok(performance.now()-before<1000);
});
test('safe Miro URLs reject credential/host/path confusion and strip share tokens',()=>{
  assert.deepEqual(safeMiroBoard(url+'?share_link_id=x'),{url,id:boardId});
  for(const input of ['http://miro.com/app/board/uXjVBoardTest=/','https://miro.com.evil.test/app/board/uXjVBoardTest=/','https://user:password@miro.com/app/board/uXjVBoardTest=/','https://miro.com:443/app/board/uXjVBoardTest=/../other','https://miro.com/app/board/uXjV%2FBoardTest=/','https://miro.com/app/board/uXjVBoardTest=/%252f../../private','https://miro.com/\napp/board/uXjVBoardTest=/'])assert.throws(()=>safeMiroBoard(input),{code:'invalid_request'});
});
test('unconfigured/disconnected or non-reading Miro cannot issue provider requests',async()=>{
  for(const patch of [{connected:false},{integrationId:''},{revision:'not-revision'},{capabilities:{boardRead:false}}]){const f=fixture();Object.assign(f.state.status,patch);await assert.rejects(f.client.board({url}));assert.equal(f.calls.length,0);}
  const f=fixture();f.state.status={};const status=await f.client.status();assert.equal(status.configured,false);assert.equal(status.connected,false);assert.equal(status.generation,'');
});
test('malformed pages, duplicate item IDs, repeated cursors and empty continuing pages fail atomically',async()=>{
  for(const pages of [[{data:'bad'}],[{data:[fixtureItem(),fixtureItem()]}],[{data:[fixtureItem()],cursor:'repeat'},{data:[fixtureItem('other')],cursor:'repeat'}],[{data:[],cursor:'more'}],[{data:[fixtureItem()],cursor:'secret\nheader'}],[{data:Array.from({length:51},(_,i)=>fixtureItem(String(i)))}]])await assert.rejects(fixture({pages}).client.board({url}),{code:'invalid_response'});
});
test('wrong-board metadata and overlarge provider pages fail before returning sources',async()=>{
  const bad=fixture({intercept:request=>request.path.endsWith('/items')?undefined:{status:200,data:{id:'otherBoard',name:'Wrong'}}});await assert.rejects(bad.client.board({url}),{code:'invalid_response'});assert.equal(bad.calls.length,1);
  const huge=fixture({pages:[{data:[{...fixtureItem(),padding:'x'.repeat(4000000)}]}]});await assert.rejects(huge.client.board({url}),{code:'invalid_response'});
});
test('unknown/malformed timestamps remain unknown instead of being inferred',async()=>{
  const row=fixtureItem();row.createdAt='2026-02-31T10:00:00Z';row.modifiedAt='yesterday';const result=await fixture({pages:[{data:[row]}]}).client.board({url});assert.equal(result.items[0].createdAt,'');assert.equal(result.items[0].modifiedAt,'');
});
test('individual text truncation remains visible but does not stop reading later items/pages',async()=>{
  const f=fixture({pages:[{data:[fixtureItem('first','text','A'.repeat(20000))],cursor:'next'},{data:[fixtureItem('last','text','Letzte Aufgabe')]}]});const result=await f.client.board({url});
  assert.equal(result.coverage.truncated,true);assert.equal(result.items.length,2);assert.equal(result.items[0].text.length,12000);assert.equal(result.documents.find(doc=>doc.itemId==='first').status,'excerpt');assert.match(result.documents.find(doc=>doc.itemId==='last').text,/Letzte Aufgabe/);
});
test('board limit is bounded at 40 pages/2000 items and discloses incomplete coverage',async()=>{
  const pages=Array.from({length:40},(_,page)=>({data:Array.from({length:50},(_,index)=>fixtureItem(String(page*50+index))),cursor:'page-'+page}));
  const f=fixture({pages}),result=await f.client.board({url});assert.equal(result.items.length,2000);assert.equal(result.coverage.pages,40);assert.equal(result.coverage.complete,false);assert.equal(f.calls.length,41);assert.match(result.warnings[0],/Lesegrenze/);
});
test('account rebinding during a board read discards the whole result',async()=>{
  const f=fixture({intercept:(request,state)=>{if(request.path.endsWith('/items'))state.status.revision='1:1';}});await assert.rejects(f.client.board({url}),{code:'connection_changed'});
});
test('cancellation interrupts a pending provider read and returns no transcript/source',async()=>{
  let reached;const ready=new Promise(resolve=>reached=resolve),controller=new AbortController();
  const f=fixture({intercept:(request,_state,signal)=>request.path.endsWith('/items')?new Promise((_resolve,reject)=>{reached();signal.addEventListener('abort',()=>reject(Error('secret provider data')),{once:true});}):undefined});
  const pending=f.client.board({url},controller.signal);await ready;controller.abort();await assert.rejects(pending,error=>error.code==='cancelled'&&!error.message.includes('secret'));
});
test('provider errors never expose the private response body in frontend errors',async()=>{
  const f=fixture({intercept:()=>{throw Object.assign(new Error('Bearer private-provider-token'),{code:'provider_error'});}});await assert.rejects(f.client.board({url}),error=>error.code==='provider_error'&&!error.message.includes('private'));
});
test('native bridge requires a known course-board pair and refuses arbitrary tool/proxy bodies',async()=>{
  const f=fixture(),bridge=createDesktopMiro({nango:f.nango,getAllowedBoards:()=>[{url,projectId:'course-one'}],getGeneration:()=>7});
  for(const message of [{action:'board',id:randomUUID(),body:{url,projectId:'other-course'}},{action:'board',id:randomUUID(),body:{url,projectId:'course-one',token:'secret'}},{action:'proxy',id:randomUUID(),body:{url,projectId:'course-one'}},{action:'board',id:'notUUID',body:{url,projectId:'course-one'}}])await assert.rejects(bridge(message));
  assert.equal(f.calls.length,0);const result=await bridge({action:'board',id:randomUUID(),body:{url,projectId:'course-one'}});assert.equal(result.projectId,'course-one');assert.equal(result.scopeGeneration,7);bridge.dispose();await assert.rejects(bridge({action:'status',id:randomUUID()}),{code:'closed'});
});
test('native registry opt-in is mandatory; unconnected status remains usable',async()=>{
  const f=fixture(),bridge=createDesktopMiro({nango:f.nango});await assert.rejects(bridge({action:'board',id:randomUUID(),body:{url,projectId:'course-one'}}),{code:'board_not_allowed'});assert.equal(f.calls.length,0);assert.equal((await bridge({action:'status',id:randomUUID()})).connected,true);bridge.dispose();
});
test('native scope/archive changes between read and commit prevent source publication',async()=>{
  let generation=1;const f=fixture({intercept:request=>{if(request.path.endsWith('/items'))generation++;}}),bridge=createDesktopMiro({nango:f.nango,getAllowedBoards:()=>[{url,projectId:'course-one'}],getGeneration:()=>generation});
  await assert.rejects(bridge({action:'board',id:randomUUID(),body:{url,projectId:'course-one'}}),{code:'scope_changed'});bridge.dispose();
});
test('native cancel/dispose aborts in-flight board work and rejects duplicate request ids',async()=>{
  for(const dispose of [false,true]){let reached;const ready=new Promise(resolve=>reached=resolve),f=fixture({intercept:(_request,_state,signal)=>new Promise((_resolve,reject)=>{reached();signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})});
    const bridge=createDesktopMiro({nango:f.nango,getAllowedBoards:()=>[{url,projectId:'course-one'}]}),id=randomUUID(),message={action:'board',id,body:{url,projectId:'course-one'}},pending=bridge(message);await ready;await assert.rejects(bridge(message),{code:'invalid_request'});if(dispose)bridge.dispose();else await bridge({action:'cancel',id});await assert.rejects(pending,{code:'cancelled'});bridge.dispose();
  }
});
test('renderer sources are bound to active known board/course and have safe exact deep links',async()=>{
  const snapshot={...await fixture().client.board({url}),projectId:'course-one'},workspace={projects:[{id:'course-one',links:[{tool:'miro',url}]}],boardFindings:[]};
  const sources=miroBoardSources(snapshot,{workspace,projectId:'course-one'});assert.equal(sources.length,2);assert.equal(sources[0].kind,'miro');assert.match(sources[0].id,/:part0$/);assert.equal(sources[0].projectId,'course-one');
  for(const options of [{workspace:{projects:[{id:'course-one',archived:true,links:[{tool:'miro',url}]}]},projectId:'course-one'},{workspace:{projects:[{id:'course-one',links:[]}]},projectId:'course-one'},{workspace,projectId:'other'}])assert.throws(()=>miroBoardSources(snapshot,options));
  const tampered=structuredClone(snapshot);tampered.documents[0].url='https://evil.test';assert.throws(()=>miroBoardSources(tampered,{workspace,projectId:'course-one'}));
  const extra=structuredClone(snapshot);extra.documents[0].accessToken='forbidden';assert.throws(()=>miroBoardSources(extra,{workspace,projectId:'course-one'}));
});
test('renderer chunks corrected document text without overlap or lost words',async()=>{
  const snapshot={...await fixture({pages:[{data:[fixtureItem('long','text','Wort '.repeat(2400))]}]}).client.board({url}),projectId:'course-one'},workspace={projects:[{id:'course-one',links:[{tool:'miro',url}]}]};
  const sources=miroBoardSources(snapshot,{workspace,projectId:'course-one'}).filter(doc=>doc.itemId==='long');assert.equal(sources.length,2);assert.equal(sources.map(doc=>doc.text).join(''),snapshot.documents.find(doc=>doc.itemId==='long').text);assert.ok(sources.every(doc=>doc.text.length<=12000));
});

test('Miro content discovered on a current Spaces subpage is accepted, then revoked on course relink/archive/delete',async()=>{
  const courseURL='https://spaces.th-koeln.de/course-one/',sourceURL=courseURL+'orga/resources/';
  const workspace={projects:[{id:'course-one',links:[{tool:'spaces',url:courseURL}]}],boardFindings:[],platformFindings:[]};
  workspace.platformFindings=coursePlatformFindings({url:sourceURL,platformLinks:[{service:'miro',url,title:'Aufgabenboard',sourceURL}]},{workspace,projectId:'course-one',now:'2026-10-14T10:00:00Z'});
  const snapshot={...await fixture().client.board({url}),projectId:'course-one'};assert.equal(miroBoardSources(snapshot,{workspace,projectId:'course-one'}).length,2);
  for(const change of [state=>state.projects[0].links[0].url='https://spaces.th-koeln.de/relinked/',state=>state.projects[0].archived=true,state=>state.projects=[]]){
    const changed=structuredClone(workspace);change(changed);assert.throws(()=>miroBoardSources(snapshot,{workspace:changed,projectId:'course-one'}),/Kurszuordnung/);
  }
});

test('Miro renderer course identity follows a current manual board reassignment, never the stale original course',async()=>{
  const snapshot={...await fixture().client.board({url}),projectId:'course-two'},workspace={projects:[{id:'course-one',links:[]},{id:'course-two',links:[]}],boardFindings:[{url,projectId:'course-one',assignedProjectId:'course-two',title:'Reassigned board'}]};
  assert.equal(miroBoardSources(snapshot,{workspace,projectId:'course-two'}).length,2);assert.throws(()=>miroBoardSources({...snapshot,projectId:'course-one'},{workspace,projectId:'course-one'}),/Kurszuordnung/);
  workspace.boardFindings[0].assignedProjectId='';assert.throws(()=>miroBoardSources(snapshot,{workspace,projectId:'course-two'}),/Kurszuordnung/);
});
test('renderer abort before dispatch does not start a board read; in-flight abort issues native cancellation',async t=>{
  const previous=globalThis.window;t.after(()=>{globalThis.window=previous;});const calls=[];
  globalThis.window={contextDesktop:{miro:async message=>{calls.push(message);if(message.action==='cancel')return {ok:true};return new Promise(()=>{});}}};
  const pre=new AbortController();pre.abort();await assert.rejects(requestMiro('board',{url,projectId:'course-one'},{signal:pre.signal}),{name:'AbortError'});await Promise.resolve();assert.deepEqual(calls.map(call=>call.action),['cancel']);
  calls.length=0;const controller=new AbortController(),pending=requestMiro('board',{url,projectId:'course-one'},{signal:controller.signal});await Promise.resolve();controller.abort();await assert.rejects(pending,{name:'AbortError'});await Promise.resolve();assert.deepEqual(calls.map(call=>call.action),['board','cancel']);
});
test('renderer preserves safe native error string/code and successful responses',async t=>{
  const previous=globalThis.window;t.after(()=>{globalThis.window=previous;});
  globalThis.window={contextDesktop:{miro:async()=>({ok:false,error:'Dieses Board ist noch nicht freigegeben.',code:'permission_denied'})}};
  await assert.rejects(requestMiro('status'),error=>error.code==='permission_denied'&&error.message==='Dieses Board ist noch nicht freigegeben.');
  window.contextDesktop.miro=async()=>({ok:true,value:{connected:false}});assert.deepEqual(await requestMiro('status'),{connected:false});
});
