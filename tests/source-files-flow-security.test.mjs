import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourceHub} from '../dist/source-hub.js';
import {platformCatalog} from '../dist/source-catalog.js';
import {cleanPlatformSources,cleanPlatformDocument} from '../dist/source-store.js';
import {runProjectAgent,buildKnowledge} from '../dist/knowledge.js';
import {renderMarkdown} from '../dist/markdown.js';
import {citationsToMarkdown} from '../dist/citations.js';

const REPO='https://git.coco.study/course/robotics',FILE=REPO+'/-/raw/main/assignment.pdf',NOW='2026-10-14T12:00:00.000Z',SCOPE='a'.repeat(64),ACCOUNT='b'.repeat(64),PAGE='c'.repeat(64),REV='d'.repeat(64);
const event=(action,id,file)=>({target:{closest:()=>({dataset:{platform:action,source:id,...(file?{file}:{})}})}});
const gate=()=>{let enter,release;return {entered:new Promise(resolve=>enter=resolve),promise:new Promise(resolve=>release=resolve),enter,release};};
function fixture({readHook,fileHook,text='Lerne Prototyping und prüfe die Barrierefreiheit.',warnings=['OCR kann Zeichen falsch erkennen.'],files=[{url:FILE,title:'Aufgabenblatt',fileName:'assignment.pdf',type:'pdf'}]}={}){
  const f={workspace:{activeCourse:'course',projects:[{id:'course',name:'Robotik',links:[{tool:'gitlab',url:REPO,title:'Kursmaterial'}]}],tasks:[],notes:[],calendarEvents:[]},stored:[],revision:0,calls:[],notices:[],files,text,warnings,account:ACCOUNT};let listener;
  f.source=()=>platformCatalog(f.workspace)[0];
  const body=(message,source,patch={})=>({sourceId:source.id,projectId:source.projectId,service:source.service,url:message.action==='read-file'?message.url:source.url,title:message.action==='read-file'?'Aufgabenblatt':'Materialien',text:message.action==='read-file'?f.text.slice(message.offset||0,(message.offset||0)+5000):'Angebotene Kursressourcen',contentRevision:message.action==='read-file'?REV:PAGE,offset:message.offset||0,nextOffset:Math.min((message.offset||0)+5000,f.text.length),totalLength:f.text.length,hasMore:message.action==='read-file'&&(message.offset||0)+5000<f.text.length,coverage:message.action==='read-file'?{complete:false,status:'ok',read:1,total:2}: 'rendered-view',warnings:message.action==='read-file'?f.warnings:[],checkedAt:NOW,accountGeneration:f.account,scopeGeneration:SCOPE,links:[],fileLinks:message.action==='read-file'?[]:f.files,...patch});
  const bridge={service:async message=>{f.calls.push(message);if(message.action==='registry')return {ok:true,value:{generation:SCOPE,accounts:{gitlab:f.account}}};if(message.action==='cancel')return {ok:true,value:{cancelled:true}};const source=platformCatalog(f.workspace).find(row=>row.id===message.sourceId);assert.ok(source);const patch=await(message.action==='read-file'?fileHook?.(message,f):readHook?.(message,f));return {ok:true,value:body(message,source,patch||{})};},miro:async()=>({ok:true,value:{connected:false}}),onEvent:handler=>{listener=handler;return ()=>listener=undefined;}};
  f.emit=detail=>listener?.({type:'context-platform-auth',detail});
  const store={load:async()=>({rows:structuredClone(f.stored),revision:f.revision}),save:async(rows,options)=>{options.assertCurrent();assert.equal(options.signal.aborted,false);assert.equal(options.expectedRevision,f.revision);f.stored=cleanPlatformSources(rows);return ++f.revision;},close:()=>{}};
  f.hub=createSourceHub({getWorkspace:()=>f.workspace,bridge,store,onNotice:value=>f.notices.push(value)});f.prepare=async()=>{await f.hub.load();await f.hub.tool('read_platform',{sourceId:f.source().id},undefined,'course');};f.click=()=>f.hub.handle(event('read-file',f.source().id,FILE));return f;
}

test('human file actions refuse guessed metadata, refresh real offers before reading, and read only file-revision-bound windows',async()=>{
  const f=fixture({text:'A'.repeat(5000)+'B'.repeat(5000)+'TAIL_EVIDENCE'});try{await f.prepare();const before=f.calls.length;await f.hub.handle(event('read-file',f.source().id,FILE.replace('assignment.pdf','guessed.pdf')));assert.equal(f.calls.length,before);assert.match(f.hub.render(),/nicht in der Quelle angeboten/);
    await f.click();const actions=f.calls.slice(before).filter(c=>c.action!=='registry');assert.deepEqual(actions.map(c=>c.action),['read','read-file','read-file','read-file']);assert.equal(actions[1].expectedRevision,PAGE);assert.deepEqual(actions.slice(1).map(c=>c.offset),[0,5000,10000]);assert.ok(actions.slice(2).every(c=>c.expectedRevision===REV));
    const saved=f.hub.documents().filter(d=>d.url===FILE);assert.equal(saved.length,3);assert.equal(saved.map(d=>d.text).join(''),f.text);assert.ok(saved.every(d=>d.status==='excerpt'));assert.equal(f.notices.at(-1),'OCR kann Zeichen falsch erkennen.');
  }finally{await f.hub.dispose();}
});

test('a file removed by refresh or an authentication-required refreshed page never starts its byte-read action',async()=>{
  for(const mode of ['removed','login']){let refreshed=false;const f=fixture({readHook:()=>refreshed?mode==='removed'?{fileLinks:[]}:{loginRequired:true,text:'PRIVATE_LOGIN_BODY',fileLinks:[]}:undefined});try{await f.prepare();refreshed=true;await f.click();assert.equal(f.calls.filter(c=>c.action==='read-file').length,0);assert.doesNotMatch(JSON.stringify([f.hub.documents(),f.stored]),/PRIVATE_LOGIN_BODY/);assert.doesNotMatch(f.hub.render(),/data-platform="read-file"/);assert.match(f.hub.render(),mode==='removed'?/nicht mehr angeboten/:/Anmeldung erforderlich/);}finally{await f.hub.dispose();}}
});

test('concurrent clicks coalesce while a refreshed offer is pending and account invalidation cancels that refresh without reading the file',async()=>{
  const held=gate();let pause=false;const f=fixture({readHook:async()=>{if(pause){held.enter();await held.promise;}}});try{await f.prepare();pause=true;const first=f.click(),second=f.click();await held.entered;await second;assert.equal(f.hub.isBusy(),true);f.account='e'.repeat(64);f.emit({service:'gitlab'});held.release();await first;await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.filter(c=>c.action==='read-file').length,0);assert.ok(f.calls.some(c=>c.action==='cancel'));assert.equal(f.hub.isBusy(),false);assert.doesNotMatch(f.hub.render(),/data-platform="read-file"/);}finally{held.release();await f.hub.dispose();}
});

test('file controls and OCR notices stay inert with hostile Markdown/HTML titles, and never offer another repository or secret file',async()=>{
  const f=fixture({files:[{url:FILE,title:'<img src=x onerror="bad()"> [link](javascript:bad())'},{url:'https://git.coco.study/private/other/-/raw/main/assignment.pdf',title:'PRIVATE_FOREIGN_FILE'},{url:REPO+'/-/raw/main/api-key.pdf',title:'PRIVATE_SECRET_FILE'}],warnings:['<script>bad()</script> OCR bleibt unsicher.']});try{await f.prepare();let html=f.hub.render();assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img src=x|PRIVATE_FOREIGN_FILE|PRIVATE_SECRET_FILE|data-file="javascript:/);await f.click();html=f.hub.render();assert.doesNotMatch(html,/<script>bad/);assert.match(html,/&lt;script&gt;bad/);}finally{await f.hub.dispose();}
});

test('a non-advancing file cursor fails instead of re-reading the same window until the loop budget',async()=>{
  const f=fixture({text:'A'.repeat(15000),warnings:[],fileHook:()=>({nextOffset:5000,hasMore:true})});try{await f.prepare();await f.click();assert.ok(f.calls.filter(c=>c.action==='read-file').length<=2);assert.match(f.hub.render(),/Fortschritt|weiter|Grenze|geändert/i);assert.notEqual(f.notices.at(-1),'Datei lokal gelesen');}finally{await f.hub.dispose();}
});

test('the 12-window human budget remains bounded and makes unresolved remaining file coverage explicit',async()=>{
  const f=fixture({text:'A'.repeat(65000),warnings:[]});try{await f.prepare();await f.click();assert.equal(f.calls.filter(c=>c.action==='read-file').length,12);assert.ok(f.hub.documents().filter(d=>d.url===FILE).length<=12);assert.match(f.notices.at(-1)||f.hub.render(),/teil|Grenze|weiter/i);}finally{await f.hub.dispose();}
});

test('an agent receives original file text, partial page coverage and bounded redacted OCR warnings, then cites exactly the delivered excerpt',async()=>{
  const f=fixture({text:'Aufgabe: Entwickle einen barrierefreien Prototyp. '+('Weitere Dokumentation. '.repeat(1000)),warnings:['OCR kann falsche Zeichen liefern.','API key: PRIVATE_WARNING_SECRET','Nur erste Seiten gelesen.','PRIVATE_OMITTED_WARNING']});try{await f.prepare();let replies=0,packet,docId;
    const output=await runProjectAgent({prompt:'Lies die PDF-Aufgabe und zeige, was ich machen soll.',workspace:f.workspace,documents:[],projectId:'course',platform:(...args)=>f.hub.tool(...args),complete:async messages=>{
      if(replies++===0)return {content:JSON.stringify({type:'tool',tool:'read_platform_file',args:{sourceId:f.source().id,url:FILE,expectedRevision:PAGE,offset:0}})};
      packet=JSON.parse(messages.at(-1).content.split('\n')[1]);docId=packet.results[0].id;assert.equal(packet.complete,false);assert.equal(packet.coverage.complete,false);assert.equal(packet.coverage.read,1);assert.equal(packet.coverage.total,2);assert.equal(packet.warnings.length,3);assert.match(packet.warnings[0],/OCR/);assert.doesNotMatch(JSON.stringify(packet),/PRIVATE_WARNING_SECRET|PRIVATE_OMITTED_WARNING/);assert.equal(packet.results[0].url,FILE);assert.match(packet.results[0].text,/barrierefreien Prototyp/);assert.ok(packet.results[0].text.length<=1500);
      return {content:JSON.stringify({type:'answer',text:'Aufgabe aus der PDF ['+docId+']',citations:[docId]})};
    }});assert.equal(output.citations.length,1);assert.equal(output.citations[0].url,FILE);assert.equal(output.citations[0].text,packet.results[0].text);assert.equal(output.citations[0].status,'excerpt');assert.equal(output.unverifiedCitations,false);assert.ok(renderMarkdown(citationsToMarkdown(output.content,output.sources)).includes(FILE));
  }finally{await f.hub.dispose();}
});

test('metadata-only unsupported file output does not become verified evidence for the agent',async()=>{
  const workspace={projects:[{id:'course',name:'Robotik',links:[{tool:'gitlab',url:REPO,title:'Material'}]}],tasks:[],notes:[],calendarEvents:[]},source=platformCatalog(workspace)[0];let round=0,delivered;
  const result=await runProjectAgent({prompt:'Prüfe Datei',workspace,documents:[],projectId:'course',platform:async()=>({documents:[],result:{warnings:['OCR konnte keinen Text lesen.'],coverage:{complete:false,status:'empty',read:1,total:2},results:[{id:'service:'+'f'.repeat(64)+':part0',text:'PRIVATE_UNVERIFIED_FILE_BODY',url:FILE}]}}),complete:async messages=>{
    if(round++===0)return {content:JSON.stringify({type:'tool',tool:'read_platform_file',args:{sourceId:source.id,url:FILE,expectedRevision:PAGE}})};
    delivered=JSON.parse(messages.at(-1).content.split('\n')[1]);return {content:JSON.stringify({type:'answer',text:'Keine verifizierte Aufgabenstellung verfügbar.',citations:[]})};
  }});assert.deepEqual(delivered.results,[]);assert.match(delivered.warnings[0],/keinen Text/);assert.equal(delivered.coverage.complete,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_UNVERIFIED_FILE_BODY/);assert.equal(result.citations.length,0);assert.equal(result.sources.length,0);
});

test('cached OCR evidence retains its per-file warning and extraction status after a later page refresh and reaches a new agent without another provider read',async()=>{
  const f=fixture({text:'Aufgabe: Barrierefreiheit im Prototyp prüfen.',warnings:['OCR kann Zeichen falsch erkennen.'],fileHook:()=>({coverage:{complete:false,status:'ok',method:'PDFKit + Apple Vision',read:1,total:2,truncated:true}})});try{await f.prepare();await f.click();await f.hub.tool('read_platform',{sourceId:f.source().id},undefined,'course');
    const cached=f.hub.documents().find(d=>d.url===FILE);assert.ok(cached);assert.match(cached.warnings[0],/OCR/);assert.equal(cached.extraction.complete,false);assert.equal(cached.extraction.method,'PDFKit + Apple Vision');assert.equal(cached.extraction.truncated,true);assert.match(f.stored[0].warnings[0],/OCR/);
    const documents=buildKnowledge(f.workspace,[],{projectId:'course',enabled:{platforms:true},platformSources:f.hub.documents()});let id,initial;const before=f.calls.length;
    const output=await runProjectAgent({prompt:'Welche Aufgabe zur Barrierefreiheit steht in der PDF?',workspace:f.workspace,documents,projectId:'course',complete:async messages=>{initial=JSON.parse(messages[0].content.split('KONTEXT (Daten):\n')[1].split('\nAKTUELLER NUTZERAUFTRAG:')[0]);const packet=initial.knowledge.find(d=>d.id===cached.id);assert.ok(packet);assert.match(packet.warnings[0],/OCR/);assert.equal(packet.extraction.complete,false);assert.equal(packet.extraction.method,'PDFKit + Apple Vision');id=packet.id;return {content:JSON.stringify({type:'answer',text:'Aufgabe aus der Quelle ['+id+']',citations:[id]})};}});
    assert.equal(f.calls.length,before);assert.equal(output.citations[0].url,FILE);assert.match(output.citations[0].warnings[0],/OCR/);assert.equal(output.citations[0].extraction.complete,false);
  }finally{await f.hub.dispose();}
});

test('per-file extraction metadata and warnings are projected and redacted while invalid warning shapes are rejected atomically',async()=>{
  const f=fixture();try{await f.prepare();await f.click();const doc=f.hub.documents().find(d=>d.url===FILE),source=f.source();
    const clean=cleanPlatformDocument({...doc,warnings:['API key: PRIVATE_WARNING_VALUE'],extraction:{complete:false,status:'ok',method:'Authorization: PRIVATE_ENGINE_VALUE',read:1,total:2,credentials:'PRIVATE_NESTED_METADATA'}},source);
    assert.doesNotMatch(JSON.stringify(clean),/PRIVATE_WARNING_VALUE|PRIVATE_ENGINE_VALUE|PRIVATE_NESTED_METADATA/);assert.equal(clean.extraction.complete,false);assert.equal(clean.extraction.read,1);assert.equal(clean.extraction.total,2);
    for(const warnings of [{text:'bad'},[{}],Array(11).fill('too many'),['x'.repeat(301)]])assert.throws(()=>cleanPlatformDocument({...doc,warnings},source));
    for(const extraction of [false,[],{complete:'true'},{read:-1}])assert.throws(()=>cleanPlatformDocument({...doc,extraction},source));
  }finally{await f.hub.dispose();}
});
