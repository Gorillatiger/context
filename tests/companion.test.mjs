import test from 'node:test';
import assert from 'node:assert/strict';
import {localFindings,explicitDate,urgency,reviewPlan,reviewPrompt,parseReview,mergeFindings,fingerprint} from '../dist/companion-engine.js';
import {cleanMemory,encryptMemory,decryptMemory} from '../dist/companion-memory.js';
const source={id:'u:test',kind:'updates',projectId:'prototyping',title:'Kursabgabe',text:'Bitte den Prototyp vorbereiten. Abgabe: 16.10.2026. Die Frist ist verbindlich.',status:'full',url:'https://spaces.th-koeln.de/prototyping-things-w26/'};
const workspace={projects:[{id:'prototyping',name:'Prototyping Things'}],tasks:[]};
const batch={projectId:'prototyping',chunks:[{id:'u:test@0',key:'u:test@0',version:'a'.repeat(64),source,text:source.text,offset:0}]};
const reply=(overrides={})=>JSON.stringify({findings:[{title:'Prototyp für die Abgabe vorbereiten',sourceId:'u:test@0',evidence:source.text,due:'2026-10-16',reason:'Konkrete Kursabgabe.',...overrides}]});
test('local companion finds obligations with actual source and course but skips headers and completed reports',async()=>{
 const findings=await localFindings([source,{...source,id:'header',status:'metadata'},{...source,id:'done',text:'Die Abgabe ist bereits erledigt.'}]);
 assert.ok(findings.length);assert.ok(findings.every(f=>f.projectId==='prototyping'&&f.sourceId==='u:test'&&source.text.includes(f.evidence)));assert.ok(findings.some(f=>f.due==='2026-10-16'));
 assert.equal((await localFindings([{...source,text:'[ ] Dokumentation schreiben'}])).length,1);
});
test('dates are only full explicit calendar dates; relative, ambiguous and invalid dates stay unknown',()=>{
 assert.equal(explicitDate('Abgabe 16.10.2026'),'2026-10-16');assert.equal(explicitDate('Abgabe 2026-10-16'),'2026-10-16');
 for(const text of ['morgen','bis Freitag','16.10.','31.02.2026','Am 12.10.2026 anfangen, bis 16.10.2026 abgeben'])assert.equal(explicitDate(text),'');
 assert.equal(urgency('2026-10-11','2026-10-12'),'overdue');assert.equal(urgency('2026-10-12','2026-10-12'),'today');assert.equal(urgency('2026-10-18','2026-10-12'),'soon');assert.equal(urgency('','2026-10-12'),'undated');
});
test('AI findings require known transmitted sections, literal evidence, explicit dates and a bounded schema',async()=>{
 const [finding]=await parseReview(reply(),batch);assert.equal(finding.projectId,'prototyping');assert.equal(finding.source.url,source.url);
 for(const override of [{sourceId:'u:other@0'},{evidence:'Erfundener Aufgabenbeleg ohne Grundlage'},{due:'2026-10-17'},{projectId:'other'},{title:'x'.repeat(181)}])await assert.rejects(parseReview(reply(override),batch));
 await assert.rejects(parseReview(JSON.stringify({findings:[],tool:'send_mail'}),batch));
 await assert.rejects(parseReview(reply({due:'2026-10-16',evidence:'Bitte den Prototyp vorbereiten.'}),batch));
});
test('incremental review skips unchanged sections, rechecks changed sources and partitions courses',async()=>{
 const documents=[source,{...source,id:'u:other',projectId:'go-public',text:'x'.repeat(7000)}];
 const plan=await reviewPlan(documents);assert.ok(plan.batches.length>=3);assert.ok(plan.batches.every(b=>b.chunks.every(c=>c.source.projectId===b.projectId)));
 const reviewed=Object.fromEntries(plan.batches.flatMap(b=>b.chunks.map(c=>[c.key,c.version])));
 assert.equal((await reviewPlan(documents,reviewed)).totalChunks,0);
 assert.equal((await reviewPlan([{...source,text:source.text+' Neu.'}],reviewed)).totalChunks,1);
 const prompt=reviewPrompt(batch,workspace,'2026-10-12');assert.match(prompt,/untrusted_data/);assert.match(prompt,/Keine Werkzeuge ausführen/);assert.match(prompt,/u:test@0/);
});
test('remembering dismissals and completed tasks prevents repeating the same obligation',async()=>{
 const [finding]=await parseReview(reply(),batch);const previous=[{...finding,status:'dismissed'}];
 const next=mergeFindings(previous,[{...finding,title:'Andere Formulierung',method:'local'}],workspace);assert.equal(next.length,1);assert.equal(next[0].status,'dismissed');assert.equal(next[0].method,'ai');
 const doneWorkspace={...workspace,tasks:[{id:'t',title:finding.title,projectId:'prototyping',status:'done'}]};assert.equal(mergeFindings([], [finding],doneWorkspace).length,0);
});
test('companion memory encrypts evidence, decisions and steps; authentication fails on changed ciphertext',async()=>{
 const [finding]=await parseReview(reply(),batch);const memory=cleanMemory({findings:[finding],log:[{id:'log',at:'2026-10-12T10:00:00Z',label:'Prüfung',detail:'Quelle gelesen',status:'done'}],settings:{mission:'Abgaben im Blick'}});
 const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);assert.equal(key.extractable,false);
 const first=await encryptMemory(memory,key),second=await encryptMemory(memory,key);assert.notDeepEqual(first.iv,second.iv);assert.ok(!new TextDecoder().decode(first.cipher).includes('Prototyp'));
 assert.deepEqual(await decryptMemory(first,key),memory);
 const altered={...first,cipher:new Uint8Array(first.cipher)};altered.cipher[0]^=1;await assert.rejects(decryptMemory(altered,key));
 assert.equal(await fingerprint(memory),await fingerprint(memory));
});
test('memory validates links, drops credentials and retains explicit user settings without enabling AI by default',()=>{
 const memory=cleanMemory({key:'private',cookie:'secret',settings:{mission:'Abgaben',key:'private'}});assert.equal(memory.settings.automaticAI,false);assert.ok(!JSON.stringify(memory).includes('private'));
 assert.throws(()=>cleanMemory({findings:[{id:'a'.repeat(64),status:'new',evidence:'quote',source:{url:'javascript:alert(1)'}}]}));
});
test('changed deadlines reopen an old decision as an explicit update; mission and task changes invalidate reviews',async()=>{
 const [finding]=await parseReview(reply(),batch);const previous={...finding,status:'accepted',taskId:'task-1'};
 const changed={...finding,due:'2026-10-20',evidence:'Abgabe wurde auf 20.10.2026 verschoben.'};const [updated]=mergeFindings([previous],[changed],workspace);assert.equal(updated.status,'new');assert.equal(updated.changed,true);assert.equal(updated.taskId,'task-1');
 const first=await reviewPlan([source],{}, {mission:'Fristen',tasks:[]});const reviewed=Object.fromEntries(first.batches.flatMap(b=>b.chunks.map(c=>[c.key,c.version])));
 assert.equal((await reviewPlan([source],reviewed,{mission:'Fristen',tasks:[]})).totalChunks,0);assert.equal((await reviewPlan([source],reviewed,{mission:'Vorbereitung',tasks:[]})).totalChunks,1);assert.equal((await reviewPlan([source],reviewed,{mission:'Fristen',tasks:[{title:'Prototyp',status:'done',projectId:'prototyping'}]})).totalChunks,1);
});
