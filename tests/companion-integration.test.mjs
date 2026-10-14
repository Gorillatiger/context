import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scanCourseSpaces} from '../dist/companion-scan.js';
import {cleanMemory,encryptMemory,decryptMemory} from '../dist/companion-memory.js';
import {buildKnowledge,runProjectAgent,validateAgentReply} from '../dist/knowledge.js';
import {cleanChat,recoverChat,encryptChat,decryptChat} from '../dist/chat-archive.js';

const base='https://spaces.th-koeln.de';
const project=(id,extra={})=>({id,name:'Kurs '+id,subtitle:'WS 2026',links:[{tool:'spaces',title:'Kurs-Space',url:`${base}/${id}/`}],...extra});
const workspace=()=>({activeCourse:'alpha',projects:[project('alpha'),project('beta'),project('old',{archived:true}),project('unlinked',{links:[]})],notes:[{id:'a-note',projectId:'alpha',title:'Plan',content:'Skizze vorbereiten.'},{id:'b-note',projectId:'beta',title:'Beta privat',content:'BETA PRIVATE TEXT'}],tasks:[],calendarEvents:[]});
const page=(url,text,extra={})=>({url,title:'Kursbeleg',text,offset:0,links:[],controls:[],hasMore:false,...extra});
const cached=(id,projectId,extra={})=>({id:'live:'+id.repeat(64),kind:'browser',projectId,title:'Kursbeleg '+projectId,url:`${base}/${projectId}/`,text:'Abgabe am 16.10.2026.',status:'full',...extra});
const answer=(text='Prüfung abgeschlossen',citations=[])=>({content:JSON.stringify({type:'answer',text,citations}),totalTokens:1});
const tool=(name,args={})=>({content:JSON.stringify({type:'tool',tool:name,args}),totalTokens:1});
const toolOutput=messages=>JSON.parse(messages.at(-1).content.split('\n')[1]);
const scripted=(replies,inspect=()=>{})=>async messages=>{inspect(messages);assert.ok(replies.length,'unexpected additional model request');return replies.shift();};

test('bounded scan → encrypted memory → selected knowledge → agent retains exact evidence and course attribution',async()=>{
  const w=workspace(),calls=[],credential='sk-'+'a'.repeat(30);
  const scan=await scanCourseSpaces({projects:w.projects.filter(p=>p.id===w.activeCourse),maxPages:2,request:async command=>{
    calls.push(command);
    if(command.command==='start')return page(command.url,'Abgabe am 16.10.2026. '+credential,{controls:[{id:'secondary-swap-menu-label',title:'Orga'}]});
    return page(`${base}/alpha/`,'Dokumentation am 23.10.2026 abgeben.');
  }});
  assert.deepEqual(calls.map(c=>c.command),['start','click']);
  assert.deepEqual(scan.coverage.map(c=>c.projectId),['alpha']);
  const memory=cleanMemory({liveSources:scan.sources,scanCoverage:scan.coverage,settings:{autoProvider:'local'}});
  const key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const sealed=await encryptMemory(memory,key),restored=await decryptMemory(sealed,key);
  assert.ok(!Buffer.from(sealed.cipher).toString().includes('Dokumentation'));
  assert.equal(restored.settings.autoProvider,'local');
  assert.ok(!JSON.stringify(restored).includes(credential));
  const docs=buildKnowledge(w,[],{projectId:'alpha',enabled:{browser:true},browserSources:restored.liveSources});
  assert.equal(docs.length,1);assert.equal(docs[0].projectId,'alpha');
  assert.match(docs[0].text,/Abgabe am 16\.10\.2026/);assert.match(docs[0].text,/Dokumentation am 23\.10\.2026/);
  const result=await runProjectAgent({prompt:'Lies den gespeicherten Kursbeleg.',workspace:w,projectId:'alpha',documents:docs,
    complete:scripted([tool('read_source',{id:docs[0].id}),answer('Dokumentation abgeben',[docs[0].id])],messages=>{
      assert.ok(!JSON.stringify(messages).includes('BETA PRIVATE TEXT'));
    })});
  assert.equal(result.steps[0].status,'done');assert.equal(result.citations.length,1);
  assert.equal(result.citations[0].url,`${base}/alpha/`);assert.equal(result.citations[0].projectId,'alpha');
});

test('saved browser sources obey course/category selection and exclude deleted, archived and unsafe sources',()=>{
  const w=workspace(),sources=[cached('a','alpha'),cached('b','beta'),cached('c','old'),cached('d','deleted'),
    cached('e','alpha',{url:'https://outside.invalid/private/'}),cached('f','alpha',{url:`${base}/alpha/?action=delete`}),
    cached('1','alpha',{id:'live:invalid'}),cached('2','alpha',{kind:'notes'}),cached('3','alpha',{text:null})];
  const selected=buildKnowledge(w,[],{projectId:'alpha',enabled:{browser:true},browserSources:sources});
  assert.deepEqual(selected.map(d=>d.id),[sources[0].id]);
  const all=buildKnowledge(w,[],{enabled:{browser:true},browserSources:sources});
  assert.deepEqual(all.map(d=>d.projectId),['alpha','beta']);
  const excluded=buildKnowledge(w,[],{projectId:'alpha',enabled:{notes:true,browser:false},browserSources:sources});
  assert.deepEqual(excluded.map(d=>d.kind),['notes']);
  assert.throws(()=>buildKnowledge(w,[],{projectId:'deleted',browserSources:sources}),/Projekt fehlt/);
});

test('browser cache stays bounded across memory validation and subsequent knowledge indexing',()=>{
  const w=workspace();
  const raw=Array.from({length:90},(_,i)=>({...cached('a','alpha'),id:'live:'+i.toString(16).padStart(64,'0'),text:'x'.repeat(21000),extraSecret:'DROP'}));
  const memory=cleanMemory({liveSources:raw});
  assert.equal(memory.liveSources.length,80);assert.equal(memory.liveSources[0].id,raw[10].id);
  assert.ok(memory.liveSources.every(d=>d.text.length===20000&&!Object.hasOwn(d,'extraSecret')));
  const docs=buildKnowledge(w,[],{enabled:{browser:true},browserSources:memory.liveSources});
  assert.equal(docs.length,80);assert.ok(docs.every(d=>d.projectId==='alpha'&&d.text.length===20000));
});

test('course inventory and source status expose only the chosen course and bounded access metadata',async()=>{
  const w=workspace(),docs=buildKnowledge(w,[],{projectId:'alpha',browserSources:[cached('a','alpha',{status:'excerpt'}),cached('b','beta')]});
  const outputs=[];
  const result=await runProjectAgent({prompt:'Welche Kursquellen sind verfügbar?',workspace:w,projectId:'alpha',documents:docs,
    sourceStates:[{source:'spaces',status:'snapshot',message:'PRIVATE CONNECTOR DETAIL',key:'SECRET'},{source:'webmail',status:'connected',content:'PRIVATE MAIL'}],
    browser:async()=>{throw new Error('inventory must not navigate');},
    complete:scripted([tool('list_courses'),tool('source_status'),answer()],messages=>{
      if(messages.length>1)outputs.push(toolOutput(messages));
      assert.ok(!JSON.stringify(messages).includes('PRIVATE CONNECTOR DETAIL'));assert.ok(!JSON.stringify(messages).includes('PRIVATE MAIL'));
    })});
  assert.deepEqual(outputs[0].courses.map(c=>c.id),['alpha']);assert.equal(outputs[0].courses[0].spaces,`${base}/alpha/`);
  assert.equal(outputs[0].courses[0].sources,docs.length);assert.equal(outputs[0].total,1);
  assert.equal(outputs[1].localSources,docs.length);assert.equal(outputs[1].incomplete,1);
  assert.deepEqual(outputs[1].providers,[{source:'spaces',status:'snapshot'},{source:'webmail',status:'connected'}]);
  assert.equal(outputs[1].complete,false);assert.match(outputs[1].mail,/Nicht/);assert.match(outputs[1].whatsapp,/Kein Zugriff/);
  assert.ok(result.steps.every(s=>s.status==='done'));
});

test('all-course inventory is bounded and does not imply every course has been read',async()=>{
  const w={...workspace(),activeCourse:'',projects:Array.from({length:45},(_,i)=>project('p'+i))},outputs=[];
  await runProjectAgent({prompt:'Zeige meine Kurse.',workspace:w,documents:[],complete:scripted([tool('list_courses'),tool('source_status'),answer()],messages=>{
    if(messages.length>1)outputs.push(toolOutput(messages));
  })});
  assert.equal(outputs[0].courses.length,40);assert.equal(outputs[0].total,45);assert.equal(outputs[0].limited,true);
  assert.ok(outputs[0].courses.every(c=>c.sources===0&&c.spaces===''));
  assert.equal(outputs[1].spacesLive,false);assert.equal(outputs[1].complete,false);
});

test('browser_course rejects foreign, archived, missing and unlinked targets before any browser call',async()=>{
  const w=workspace(),calls=[];
  for(const [scope,target] of [['alpha','beta'],['','old'],['','missing'],['','unlinked']]){
    const result=await runProjectAgent({prompt:'Lies diesen Kurs.',workspace:w,projectId:scope,documents:[],
      browser:async(...args)=>{calls.push(args);throw new Error('must never navigate');},
      complete:scripted([tool('browser_course',{projectId:target}),answer()])});
    assert.equal(result.steps[0].status,'error');assert.match(result.steps[0].detail,/freigegebenen Bereich|nicht verknüpft/);
  }
  assert.equal(calls.length,0);
  for(const args of [{projectId:'alpha',url:`${base}/beta/`},{projectId:'alpha',script:'evil'},{projectId:''}]){
    assert.throws(()=>validateAgentReply(tool('browser_course',args).content));
  }
});

test('all-course browsing attributes live evidence to the requested valid course without giving the model a URL capability',async()=>{
  const w=workspace(),calls=[],outputs=[];
  const result=await runProjectAgent({prompt:'Prüfe beide Kurse.',workspace:w,documents:[],
    browser:async(name,args)=>{calls.push({name,args});const p=w.projects.find(p=>p.id===args.projectId);return page(p.links[0].url,'Beleg für '+p.id);},
    complete:async messages=>{
      if(messages.length>1)outputs.push(toolOutput(messages));
      if(calls.length===0)return tool('browser_course',{projectId:'alpha'});
      if(calls.length===1)return tool('browser_course',{projectId:'beta'});
      return answer('Kurs beta',[outputs.at(-1).id]);
    }});
  assert.deepEqual(calls,[{name:'browser_course',args:{projectId:'alpha'}},{name:'browser_course',args:{projectId:'beta'}}]);
  assert.equal(result.citations[0].projectId,'beta');assert.equal(result.citations[0].url,`${base}/beta/`);
  assert.deepEqual(result.sources.filter(d=>d.kind==='browser').map(d=>d.projectId),['alpha','beta']);
});

test('a stopped scan produces reusable safe evidence, never a complete scan claim',async()=>{
  const w=workspace(),controller=new AbortController(),calls=[];
  const result=await scanCourseSpaces({projects:w.projects.filter(p=>['alpha','beta'].includes(p.id)),signal:controller.signal,request:async command=>{
    calls.push(command);
    if(command.command==='start')return page(command.url,'Bereits gelesener Kursbeleg.',{hasMore:true});
    controller.abort();throw new DOMException('Abgebrochen','AbortError');
  }});
  const memory=cleanMemory({liveSources:result.sources,scanCoverage:result.coverage});
  assert.equal(calls.length,2);assert.equal(result.interrupted,true);
  assert.deepEqual(memory.scanCoverage.map(c=>c.status),['partial','not_scanned']);
  const docs=buildKnowledge(w,[],{projectId:'alpha',enabled:{browser:true},browserSources:memory.liveSources});
  assert.equal(docs.length,1);assert.equal(docs[0].status,'excerpt');assert.equal(docs[0].text,'Bereits gelesener Kursbeleg.');
});

test('an unoffered global permalink returned by a course start is rejected before being cached under that course',async()=>{
  const w=workspace();
  const result=await scanCourseSpaces({projects:[w.projects[0]],request:async command=>{
    assert.equal(command.url,`${base}/alpha/`);
    return page(`${base}/wp/blog/beta-private/`,'UNRELATED BETA PAGE');
  }});
  assert.equal(result.coverage[0].status,'error');
  assert.equal(result.sources.length,0);
  const memory=cleanMemory({liveSources:result.sources,scanCoverage:result.coverage});
  const docs=buildKnowledge(w,[],{projectId:'alpha',enabled:{browser:true},browserSources:memory.liveSources});
  assert.equal(docs.length,0);assert.ok(!JSON.stringify(result).includes('UNRELATED BETA PAGE'));
});

test('local-provider chat and companion preferences survive encrypted roundtrips including browser category choice',async()=>{
  const source=cached('a','alpha');
  const original=cleanChat({version:1,id:'local-session',provider:'local',model:'llama-local',scope:'alpha',draft:'Nächste lokale Frage',enabled:{browser:false,notes:true},
    messages:[{id:'a1',role:'assistant',content:'Lokaler Beleg',provider:'local',model:'llama-local',citations:[source],steps:[{id:1,tool:'read_source',label:'Quelle lesen',status:'done',sources:[source]}]}]});
  const key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const restored=recoverChat(await decryptChat(await encryptChat(original,key,webcrypto),key,webcrypto));
  assert.equal(restored.provider,'local');assert.equal(restored.messages[0].provider,'local');assert.equal(restored.model,'llama-local');
  assert.equal(restored.enabled.browser,false);assert.equal(restored.messages[0].steps[0].sources[0].projectId,'alpha');
  assert.equal(restored.draft,original.draft);assert.equal(restored.messages.length,1);
  const memory=cleanMemory({settings:{autoProvider:'local',automaticAI:true},liveSources:[source]});
  const roundtrip=await decryptMemory(await encryptMemory(memory,key),key);
  assert.equal(roundtrip.settings.autoProvider,'local');assert.equal(roundtrip.settings.automaticAI,true);
});
