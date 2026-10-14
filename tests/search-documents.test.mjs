import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../dist/core.js';
import {buildSearchDocuments} from '../dist/search-documents.js';
import {buildKnowledge} from '../dist/knowledge.js';
import {createSearchClient} from '../dist/search-client.js';
import {createSearchIndex,cleanSearchDocument} from '../dist/search-index.js';
import {cleanChat} from '../dist/chat-archive.js';

const course='prototyping',other='go-public';
function workspace(){const state=initialState();state.activeCourse=course;state.projects.push({id:'archived',name:'Archived synthetic course',archived:true,links:[],note:''});return state;}
const note=(id,projectId=course)=>({id,projectId,title:'Synthetic '+id,content:'Observable '+id+' material.',updatedAt:'2026-10-13T12:00:00Z'});
const chat=(patch={})=>cleanChat({version:1,id:'saved-chat',scope:course,projectName:'Synthetic course',title:'Saved synthetic chat',createdAt:'2026-10-13T11:00:00Z',updatedAt:'2026-10-13T12:00:00Z',draft:'DRAFT_ONLY_NEVER_INDEX',messages:[{id:'answer-one',role:'assistant',content:'Antwort mit Polymerkristall.',citations:[{id:'citation',kind:'notes',title:'Synthetic citation',text:'Zitierter Kalibrierlaser.',status:'full'}],sources:[{id:'source',kind:'browser',title:'Saved source',text:'Gelesener Schwingungssensor.',url:'https://spaces.th-koeln.de/prototyping-things-w26/'}],steps:[{id:1,label:'Werkzeugprüfung',detail:'Fehlerdiagnose Quantenkreisel',status:'done',sources:[{id:'step-source',kind:'notes',title:'Step evidence',text:'Schrittnachweis Lichtschranke.'}]}]}],...patch});
function index(collection){const value=createSearchIndex();value.replace(collection.documents);return value;}

test('human collection keeps active courses and local typed routes while excluding an archived course',()=>{
  const state=workspace();state.notes=[note('active-note'),{...note('other-note',other),content:'FOREIGNCOURSEUNIQUE'},note('archived-note','archived')];state.tasks=[{id:'task-one',projectId:course,title:'Synthetic deadline',status:'todo',due:'2026-10-16'}];
  const collection=buildSearchDocuments({workspace:state}),engine=index(collection);
  assert.equal(collection.complete,false);assert.ok(collection.documents.some(d=>d.kind==='tools'));
  const active=engine.search('Observable active', {projectId:course})[0];assert.equal(active.route.type,'note');assert.equal(active.route.id,'active-note');
  assert.ok(engine.search('FOREIGNCOURSEUNIQUE',{projectId:other}).some(d=>d.route.id==='other-note'));assert.equal(engine.search('FOREIGNCOURSEUNIQUE',{projectId:course}).length,0);
  assert.ok(!collection.documents.some(d=>d.projectId==='archived'));assert.ok(!JSON.stringify(collection.documents).includes('Observable archived-note'));
  assert.equal(collection.targets.get('t:task-one').type,'task');assert.equal(collection.targets.get('p:'+course).type,'project');
});

test('bookmarks, course links and pasted credential URLs are redacted before indexing or opening',()=>{
  const state=workspace(),token='ghp_'+'a'.repeat(32),secret='SYNTHETIC_QUERY_SECRET';
  state.notes=[{...note('redacted'),content:'Visible content\n'+token+'\npassword: SYNTHETIC_PASSWORD\nhttps://user:pass@example.test/private'}];
  state.bookmarks=[{id:'bookmark-one',projectId:course,tool:'gitlab',title:'Synthetic repository',note:'Link metadata',url:'https://git.coco.study/group/repo?token='+secret+'&view=one'}];
  state.projects[0].links.push({id:'linked-repo',title:'Course repository',tool:'gitlab',url:'https://git.coco.study/group/repo?key='+secret});
  const collection=buildSearchDocuments({workspace:state}),serialized=JSON.stringify(collection.documents);
  assert.doesNotMatch(serialized,/SYNTHETIC_QUERY_SECRET|SYNTHETIC_PASSWORD|user:pass/);assert.ok(!serialized.includes(token));
  const bookmark=collection.documents.find(d=>d.id==='p:bookmark:bookmark-one');assert.equal(bookmark.route.type,'link');assert.equal(bookmark.route.id,'bookmark-one');assert.match(bookmark.url,/token=ENTFERNT/);assert.match(bookmark.url,/view=one/);
  assert.equal(collection.targets.get('link:'+course+':linked-repo').type,'link');assert.match(collection.documents.find(d=>d.id==='link:'+course+':linked-repo').url,/key=ENTFERNT/);
  assert.match(bookmark.text,/verlinkte Inhalt wurde nicht gelesen/);
});

test('saved chat content, citations, source excerpts and work steps are searchable while private fields are ignored',()=>{
  const state=workspace(),record=chat();
  Object.defineProperties(record,{apiKey:{get(){throw Error('Private key must not be read');}},attachments:{get(){throw Error('Chat attachment must not be read');}},account:{get(){throw Error('Account must not be read');}}});
  const collection=buildSearchDocuments({workspace:state,chatRecords:[record,chat({id:'archived-chat',scope:'archived'})]}),engine=index(collection);
  for(const query of ['Polymerkristall','Kalibrierlaser','Schwingungssensor','Quantenkreisel','Lichtschranke']){
    const found=engine.search(query,{kinds:['chats']});assert.equal(found.length,1,query);assert.deepEqual(found[0].route,{type:'chat',id:'saved-chat'});assert.equal(collection.targets.get(found[0].id).messageId,'answer-one');
  }
  assert.equal(engine.search('DRAFT_ONLY_NEVER_INDEX').length,0);assert.ok(!collection.documents.some(d=>d.route.id==='archived-chat'));
  assert.ok(!JSON.stringify(collection.documents).includes('DRAFT_ONLY_NEVER_INDEX'));
});

test('the actual engine finds a saved source tail after chunking and keeps the same message target',()=>{
  const state=workspace(),record=chat({messages:[{id:'long-message',role:'assistant',content:'Werkstatt '.repeat(1800),sources:[{id:'long-source',kind:'browser',title:'Long already-read source',text:'Messdaten '.repeat(7000),status:'full'}],steps:[{id:1,label:'Prüfung',detail:'TAIL_NANOKRISTALL_SENSOR',status:'done'}]}]});
  const collection=buildSearchDocuments({workspace:state,chatRecords:[record]}),chunks=collection.documents.filter(d=>d.kind==='chats');
  assert.ok(chunks.length>1);assert.ok(chunks.every(d=>d.text.length<=60000));assert.ok(collection.warnings.some(w=>/große gespeicherte Chatquellen/.test(w)));
  const found=index(collection).search('TAIL_NANOKRISTALL_SENSOR',{kinds:['chats']});assert.ok(found.length);assert.match(found[0].id,/:part\d+$/);assert.ok(found[0].offset>0);
  assert.equal(collection.targets.get(found[0].id).messageId,'long-message');assert.deepEqual(found[0].route,{type:'chat',id:'saved-chat'});
});

test('daily diary matches retain the exact day only in the UI routing target',()=>{
  const state=workspace();state.devDiaries=[{id:'diary-one',projectId:course,courseName:'Synthetic course',title:'Synthetic Dev Diary',startDate:'2026-10-13',endDate:'2026-10-20',courseUrl:'https://spaces.th-koeln.de/prototyping-things-w26/',entries:[{date:'2026-10-14',done:'Prototyp gefräst.',learned:'Kalibrierlaser justiert.',problems:'Sensorrauschen.',next:'Lichtschranke testen.'},{date:'2026-10-15',done:'',learned:'',problems:'',next:''}],remote:{url:'https://spaces.th-koeln.de/prototyping-things-w26/dev-diary/'}}];
  const collection=buildSearchDocuments({workspace:state}),found=index(collection).search('Sensorrauschen',{kinds:['diaries']})[0];
  assert.deepEqual(found.route,{type:'diary',id:'diary-one'});assert.equal(collection.targets.get(found.id).date,'2026-10-14');assert.ok(!collection.documents.some(d=>d.id==='diary:diary-one:2026-10-15'));
  assert.equal(found.date,undefined);assert.equal(collection.documents.filter(d=>d.id.startsWith('n:diary:')).length,0);
});

test('opaque mail routing identities stay in targets and never cross the real worker-client projection',async()=>{
  const state=workspace(),mailTarget={service:'outlook',folder:'OPAQUE_FOLDER_MARKER',uid:'OPAQUE_UID_MARKER',uidValidity:'OPAQUE_BINDING_MARKER'};
  const collection=buildSearchDocuments({workspace:state,mailSources:[{service:'outlook',identity:'OPAQUE_ACCOUNT_MARKER',title:'Synthetic private header',text:'Already opened mail with MAIL_SEARCH_MARKER.',status:'full',target:mailTarget}]});
  const doc=collection.documents.find(d=>d.kind==='mail');assert.deepEqual(collection.targets.get(doc.id).mailTarget,mailTarget);
  for(const serialized of [JSON.stringify(collection.documents),JSON.stringify(cleanSearchDocument(doc))])assert.doesNotMatch(serialized,/OPAQUE_(?:FOLDER|UID|BINDING|ACCOUNT)_MARKER/);
  const client=createSearchClient();try{await client.replace(collection.documents);const found=await client.search('MAIL_SEARCH_MARKER',{kinds:['mail']});assert.equal(found.length,1);assert.deepEqual(found[0].route,{type:'mail',id:collection.targets.get(doc.id).id});assert.doesNotMatch(JSON.stringify(found),/OPAQUE_(?:FOLDER|UID|BINDING|ACCOUNT)_MARKER/);}finally{client.dispose();}
});

test('already-loaded mail suppresses a duplicate unread header and unloaded headers remain metadata only',()=>{
  const state=workspace(),target={folder:'INBOX',uidValidity:'123',uid:'100'};
  const updates=[{id:'header-loaded',source:'webmail',title:'Loaded header',summary:'Synthetic sender',content:'Unexpected inbox preview body',createdAt:'',url:'https://webmail.th-koeln.de/',mailTarget:target},{id:'header-unloaded',source:'webmail',title:'Unloaded header',summary:'Unloaded synthetic sender',content:'SHOULD_NOT_FETCH_UNOPENED_BODY',createdAt:'',url:'https://webmail.th-koeln.de/',mailTarget:{...target,uid:'101'}},{id:'wa',source:'whatsapp',title:'Unloaded WhatsApp',content:'WHATSAPP_CHAT_NOT_FETCHED'},{id:'signal',source:'signal',title:'Unloaded Signal',content:'SIGNAL_CHAT_NOT_FETCHED'}];
  const collection=buildSearchDocuments({workspace:state,updates,mailSources:[{service:'th',identity:'loaded-100',target,title:'Loaded header',text:'OPENED_MAIL_BODY',status:'full'}]});
  assert.equal(collection.documents.filter(d=>d.kind==='mail').length,2);assert.ok(!collection.documents.some(d=>d.id==='mail-header:header-loaded'));
  const header=collection.documents.find(d=>d.id==='mail-header:header-unloaded');assert.equal(header.status,'metadata');assert.match(header.text,/Unloaded synthetic sender/);
  assert.doesNotMatch(JSON.stringify(collection.documents),/SHOULD_NOT_FETCH_UNOPENED_BODY|WHATSAPP_CHAT_NOT_FETCHED|SIGNAL_CHAT_NOT_FETCHED/);
});

test('private human search records do not become automatic KI knowledge',()=>{
  const state=workspace(),record=chat({messages:[{id:'private-message',role:'assistant',content:'CONFIRMED_CHAT_HUMAN_SEARCH_ONLY'}]});
  const updates=[{id:'private-mail',source:'webmail',title:'MAIL_HEADER_HUMAN_SEARCH_ONLY',content:'MAIL_BODY_NOT_AUTOMATIC_AI',summary:'Header sender',url:'https://webmail.th-koeln.de/',createdAt:'',mailTarget:{folder:'INBOX',uidValidity:'1',uid:'1'}}];
  const human=buildSearchDocuments({workspace:state,updates,chatRecords:[record],mailSources:[{service:'th',identity:'mail',title:'MAIL_HEADER_HUMAN_SEARCH_ONLY',text:'MAIL_BODY_NOT_AUTOMATIC_AI',status:'full',target:{folder:'INBOX',uidValidity:'1',uid:'1'}}]});
  assert.match(JSON.stringify(human.documents),/CONFIRMED_CHAT_HUMAN_SEARCH_ONLY/);assert.match(JSON.stringify(human.documents),/MAIL_BODY_NOT_AUTOMATIC_AI/);
  assert.doesNotMatch(JSON.stringify(buildKnowledge(state,updates)),/CONFIRMED_CHAT_HUMAN_SEARCH_ONLY|MAIL_HEADER_HUMAN_SEARCH_ONLY|MAIL_BODY_NOT_AUTOMATIC_AI/);
  assert.ok(human.warnings.some(w=>/nicht automatisch KI-Wissen/.test(w)));
});
