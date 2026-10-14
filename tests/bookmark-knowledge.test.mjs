import test from 'node:test';
import assert from 'node:assert/strict';
import {buildKnowledge,searchKnowledge,runProjectAgent,DEFAULT_KNOWLEDGE} from '../dist/knowledge.js';
import {cleanChat,encryptChat,decryptChat} from '../dist/chat-archive.js';
import {citationIds,citationsToMarkdown,sourceLabel} from '../dist/citations.js';

const bookmark=(id,projectId,extra={})=>({id,projectId,title:'Rubrik Abgabe',tool:'spaces',url:'https://spaces.th-koeln.de/alpha/rubrik/',note:'Die lokale Notiz beschreibt die Dokumentation.',...extra});
const workspace=()=>({projects:[{id:'alpha',name:'Alpha',links:[]},{id:'beta',name:'Beta',links:[]},{id:'past',name:'Archiv',links:[],archived:true}],notes:[],tasks:[],calendarEvents:[],bookmarks:[bookmark('a','alpha'),bookmark('b','beta',{note:'BETA NOTE'}),bookmark('old','past',{note:'ARCHIVED NOTE'}),bookmark('orphan','deleted',{note:'ORPHAN NOTE'}),bookmark('personal','',{note:'PERSONAL NOTE'})]});

test('saved course bookmarks are searchable local metadata and honor course/category/archive boundaries',()=>{
  const w=workspace(),selected=buildKnowledge(w,[],{projectId:'alpha',enabled:{bookmarks:true}});
  assert.equal(DEFAULT_KNOWLEDGE.bookmarks,true);assert.equal(selected.length,1);assert.equal(selected[0].id,'p:bookmark:a');assert.equal(selected[0].kind,'bookmarks');assert.equal(selected[0].targetId,'a');assert.equal(selected[0].status,'metadata');
  assert.match(selected[0].text,/Lokale Notiz:/);assert.match(selected[0].text,/verlinkte Inhalt wurde nicht gelesen/);assert.equal(searchKnowledge(selected,'Rubrik Dokumentation').length,1);
  assert.ok(!JSON.stringify(selected).includes('BETA NOTE'));assert.ok(!JSON.stringify(selected).includes('PERSONAL NOTE'));
  assert.deepEqual(buildKnowledge(w,[],{enabled:{bookmarks:true}}).map(d=>d.projectId),['alpha','beta','']);
  assert.equal(buildKnowledge(w,[],{projectId:'alpha',enabled:{bookmarks:false}}).length,0);
});

test('bookmark titles, notes and URLs are redacted before becoming a model source or archived link',()=>{
  const secret='ghp_'+'a'.repeat(30),w=workspace();
  w.bookmarks=[bookmark('safe','alpha',{title:'Rubrik '+secret,note:'password: do-not-store\nDie Dokumentation vorbereiten.',url:'https://example.test/rubrik?token=do-not-store'}),bookmark('credentials','alpha',{url:'https://name:do-not-store@example.test/rubrik'}),bookmark('script','alpha',{url:'javascript:alert(1)'})];
  const docs=buildKnowledge(w,[],{projectId:'alpha',enabled:{bookmarks:true}});
  assert.ok(!JSON.stringify(docs).includes(secret));assert.ok(!JSON.stringify(docs).includes('do-not-store'));assert.match(docs[0].url,/ENTFERNT/);assert.equal(docs[1].url,undefined);assert.equal(docs[2].url,undefined);
  assert.ok(docs.every(d=>d.status==='metadata'));assert.match(docs[0].text,/Dokumentation vorbereiten/);
});

test('query credentials stay redacted in source links and note URLs with parentheses, encoded keys and duplicates',()=>{
  const secret='synthetic-credential',w=workspace();
  const queries=['ToKeN='+secret+'&token='+secret,'%61ccess_token='+secret,'api_key='+secret+'&signature='+secret,'password='+secret+'&code='+secret,'x=(draft)&secret='+secret];
  for(const query of queries)for(const path of ['/file','/file(v2)','/file(nested(v2))']){
    const url='https://example.test'+path+'?'+query+'&page=2';
    w.bookmarks=[bookmark('credentials','alpha',{url,title:'Quelle [link]('+url+')',note:'Lokale Referenz: [link]('+url+')\nEine allgemeine Notiz.'})];
    const doc=buildKnowledge(w,[],{projectId:'alpha',enabled:{bookmarks:true}})[0];
    assert.ok(!JSON.stringify(doc).includes(secret),url);assert.equal(new URL(doc.url).protocol,'https:');assert.match(doc.text,/allgemeine Notiz/);assert.match(decodeURIComponent(doc.url),/entfernt/i);
    const archived=cleanChat({version:1,id:'query-test',scope:'alpha',messages:[{role:'assistant',content:'Beleg',sources:[doc],citations:[doc]}]});
    assert.ok(!JSON.stringify(archived).includes(secret));
  }
});

test('a large saved-link collection cannot displace existing deadlines or course updates from the bounded index',()=>{
  const w=workspace();w.tasks=Array.from({length:2000},(_,i)=>({id:'task-'+i,title:'Existing task',projectId:'alpha',status:'todo'}));
  w.bookmarks=Array.from({length:1500},(_,i)=>bookmark('link-'+i,'alpha'));
  w.calendarEvents=[{id:'deadline',title:'Bestehende Abgabe',projectId:'alpha',start:'2026-10-16',end:'2026-10-17',allDay:true,source:{kind:'context',title:'Eigener Termin'}}];
  const docs=buildKnowledge(w,[{id:'update',source:'spaces',projectId:'alpha',title:'Neue Kursinformation',content:'Beleg',contentStatus:'full'}],{projectId:'alpha'});
  assert.equal(docs.length,3000);assert.ok(docs.some(d=>d.id==='c:deadline'));assert.ok(docs.some(d=>d.id==='u:update'));assert.ok(docs.some(d=>d.kind==='bookmarks'));
});

test('bookmark citations use stable collision-free existing IDs and retain safe source links',()=>{
  const w=workspace();w.projects.push({id:'a',name:'Same raw ID',links:[]});w.tasks=[{id:'a',title:'Task',projectId:'alpha',status:'todo'}];
  const docs=buildKnowledge(w,[],{projectId:'alpha'}),source=docs.find(d=>d.kind==='bookmarks');
  assert.equal(new Set(docs.map(d=>d.id)).size,docs.length);assert.deepEqual(citationIds(`[${source.id}]`),[source.id]);
  const markdown=citationsToMarkdown('Lokale Rubrik ['+source.id+']',[source]);assert.match(markdown,/https:\/\/spaces\.th-koeln\.de\/alpha\/rubrik\//);assert.match(sourceLabel(source),/^Ablage-Link/);
});

test('agent can read saved bookmark metadata without any foreign-content fetch or browser capability',async()=>{
  const w=workspace(),docs=buildKnowledge(w,[],{projectId:'alpha',enabled:{bookmarks:true}});let calls=0;
  const replies=[{type:'tool',tool:'read_source',args:{id:docs[0].id}},{type:'answer',text:'Die lokale Notiz nennt die Dokumentation. ['+docs[0].id+']',citations:[docs[0].id]}];
  const result=await runProjectAgent({prompt:'Was steht in meiner gespeicherten Rubriknotiz?',workspace:w,projectId:'alpha',documents:docs,complete:async messages=>{
    calls++;if(calls===2){assert.match(messages.at(-1).content,/verlinkte Inhalt wurde nicht gelesen/);assert.match(messages.at(-1).content,/Dokumentation/);}return {content:JSON.stringify(replies.shift())};
  }});
  assert.equal(calls,2);assert.equal(result.steps[0].status,'done');assert.equal(result.citations[0].url,docs[0].url);assert.equal(result.citations[0].projectId,'alpha');
});

test('new bookmark source kind and the opted-out knowledge preference survive encrypted chat roundtrips',async()=>{
  const source=buildKnowledge(workspace(),[],{projectId:'alpha',enabled:{bookmarks:true}})[0];
  const record=cleanChat({version:1,id:'bookmark-chat',scope:'alpha',enabled:{bookmarks:false},messages:[{role:'assistant',content:'Lokaler Hinweis',citations:[source],sources:[source],steps:[{id:0,label:'Quelle lesen',status:'done',sources:[source]}]}]});
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),restored=await decryptChat(await encryptChat(record,key),key);
  assert.equal(restored.enabled.bookmarks,false);assert.equal(restored.messages[0].citations[0].kind,'bookmarks');assert.equal(restored.messages[0].steps[0].sources[0].url,source.url);
  assert.equal(cleanChat({version:1,id:'legacy-chat',messages:[]}).enabled.bookmarks,true,'older records receive the new default without overriding an explicit opt-out');
});
