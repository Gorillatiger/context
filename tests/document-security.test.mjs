import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {parseOfficeDocument,walkDocumentXML,DOCUMENT_WORKER_LIMITS} from '../desktop/document-worker.mjs';
import {createDocumentReader,validateDocumentResult,DOCUMENT_READER_LIMITS} from '../desktop/document-reader.mjs';
import {documentZip,officeEntries,officeFixture,documentMIMEs,wordXML} from './document-security-fixtures.mjs';

const result=(patch={})=>({status:'ok',text:'Synthetische deutsche Aufgabenstellung.',coverage:'partial',warnings:['Nur Dokumenttext.'],metadata:{format:'docx',engine:'OOXML local',unitsRead:1,unitsTotal:1,ocrUnits:0,truncated:false},...patch});
const request=(format='docx',patch={})=>({bytes:officeFixture(format),mimeType:documentMIMEs[format],fileName:'Synthetische-Aufgabe.'+format,...patch});
function fakeProcess({value=result(),envelope,afterInput,code=0}={}){
  const calls=[],children=[];
  const spawnProcess=(executable,args,options)=>{
    const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:[]});const chunks=[];child.stdin.on('data',bytes=>chunks.push(Buffer.from(bytes)));child.kill=signal=>{child.killed.push(signal);return true;};
    child.stdin.on('finish',()=>{child.input=Buffer.concat(chunks);if(afterInput){afterInput(child);return;}queueMicrotask(()=>{child.stdout.write(JSON.stringify(envelope??{ok:true,value}));child.emit('close',code);});});
    calls.push({executable,args,options});children.push(child);return child;
  };
  return {calls,children,api:createDocumentReader({spawnProcess,platform:'darwin',timeoutMs:1000})};
}
const deferred=()=>{let release;return {promise:new Promise(resolve=>release=resolve),release};};

test('independent stored ZIP fixtures parse real DOCX/PPTX/XLSX text and disclose unread layout',()=>{
  for(const format of ['docx','pptx','xlsx']){
    const document=parseOfficeDocument(officeFixture(format),format);assert.equal(document.status,'ok');assert.match(document.text,/Prüfe die Benutzeroberfläche/);assert.equal(document.metadata.format,format);assert.equal(document.metadata.unitsRead,1);assert.equal(document.metadata.unitsTotal,1);assert.equal(document.coverage,'partial');assert.ok(document.warnings.some(w=>/Bilder|Layout|Diagramme/.test(w)));validateDocumentResult(document);
  }
});

test('valid compressed Office data still parses, while extension/package-type substitutions never do',()=>{
  const compressed=documentZip(officeEntries('docx').map(entry=>({...entry,method:8})));assert.match(parseOfficeDocument(compressed,'docx').text,/Benutzeroberfläche/);
  for(const [bytes,format] of [[officeFixture('xlsx'),'docx'],[officeFixture('docx'),'pptx'],[officeFixture('pptx'),'xlsx'],[officeFixture('docx'),'docm']])assert.throws(()=>parseOfficeDocument(bytes,format));
});

test('ZIP local/central names, methods, CRC and lengths must agree before any text becomes evidence',()=>{
  const entries=officeEntries('docx');
  for(const patch of [{localName:'word/XXXXXXXX.xml'},{localMethod:8},{localCRC:0},{crc:0},{size:10,localSize:10},{compressedSize:10}])assert.throws(()=>parseOfficeDocument(documentZip([entries[0],{...entries[1],...patch}]),'docx'),JSON.stringify(patch));
  assert.throws(()=>parseOfficeDocument(documentZip([...entries,{...entries[1]}]),'docx'));
  const overlap=documentZip(entries),central=overlap.readUInt32LE(overlap.length-6);overlap.writeUInt32LE(0,central+46+Buffer.byteLength(entries[0].name)+42);assert.throws(()=>parseOfficeDocument(overlap,'docx'));
});

test('directory traversal, absolute/backslash paths, encrypted archives, macros and multiple disks are refused',()=>{
  const entries=officeEntries('docx');
  for(const name of ['../PRIVATE_FILE','word/../PRIVATE_FILE','/PRIVATE_FILE','C:/PRIVATE_FILE','word\\PRIVATE_FILE','word//PRIVATE_FILE','word/vbaProject.bin'])assert.throws(()=>parseOfficeDocument(documentZip([...entries,{name,data:'PRIVATE_CONTENT'}]),'docx'),name);
  assert.throws(()=>parseOfficeDocument(documentZip(entries.map(entry=>({...entry,flags:1}))),'docx'));
  assert.throws(()=>parseOfficeDocument(documentZip(entries,{disk:1}),'docx'));
  assert.throws(()=>parseOfficeDocument(documentZip(entries.map(entry=>entry.name==='[Content_Types].xml'?{...entry,data:entry.data.replace('wordprocessingml.document.main','wordprocessingml.document.macroEnabled.main')}:entry)),'docx'));
});

test('ZIP entry count, declared expansion and real inflate expansion are independently bounded',()=>{
  const entries=officeEntries('docx'),budget=DOCUMENT_WORKER_LIMITS;
  assert.throws(()=>parseOfficeDocument(documentZip([...entries,...Array.from({length:budget.entries},(_,i)=>({name:'unused/'+i+'.txt',data:''}))]),'docx'));
  assert.throws(()=>parseOfficeDocument(documentZip([entries[0],{...entries[1],size:budget.entryBytes+1}]),'docx'));
  const bomb={name:'unused/oversize.txt',data:'A'.repeat(budget.entryBytes+1),method:8,size:1000,localSize:1000};assert.throws(()=>parseOfficeDocument(documentZip([...entries,bomb]),'docx'));
  const highRatio={name:'unused/compressed.txt',data:'A'.repeat(100000),method:8};assert.throws(()=>parseOfficeDocument(documentZip([...entries,highRatio]),'docx'));
});

test('unselected XML is also inspected for DTD/entity payloads and cannot hide a secondary parser surface',()=>{
  const entries=officeEntries('docx'),evil='<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///PRIVATE_FILE">]><x>&secret;</x>';
  assert.throws(()=>parseOfficeDocument(documentZip([...entries,{name:'docProps/custom.xml',data:evil}]),'docx'));
  for(const xml of [evil,wordXML('&#x110000;'),wordXML('&#xD800;'),wordXML('&#0;'),wordXML('&unknown;'),'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body></w:document>',wordXML('ok')+'<SECOND_ROOT/>'])assert.throws(()=>parseOfficeDocument(officeFixture('docx',{xml}),'docx'));
});

test('OOXML root namespaces must match the claimed format instead of accepting arbitrary XML with matching local names',()=>{
  const fake='<evil:document xmlns:evil="https://evil.invalid/unknown"><evil:body><evil:p><evil:r><evil:t>PRIVATE_FAKE_DOCUMENT</evil:t></evil:r></evil:p></evil:body></evil:document>';
  assert.throws(()=>parseOfficeDocument(officeFixture('docx',{xml:fake}),'docx'));
});

test('the XML tokenizer bounds deep nesting, tokens and attributes, retains German escapes and ignores no external resources',()=>{
  let text='';walkDocumentXML(Buffer.from('<root>Gr&#252;&#223;e &amp; &#x1F9ED;</root>'),{text:value=>text+=value});assert.equal(text,'Grüße & 🧭');
  assert.throws(()=>walkDocumentXML(Buffer.from('<x>'.repeat(130)+'</x>'.repeat(130))));
  assert.throws(()=>walkDocumentXML(Buffer.from('<x '+Array.from({length:129},(_,i)=>'a'+i+'="ok"').join(' ')+'/>')));
  assert.throws(()=>walkDocumentXML(Buffer.from('<x>'+'<y/>'.repeat(100001)+'</x>')));
  assert.throws(()=>walkDocumentXML(Buffer.from([0x3c,0x78,0x3e,0xff,0x3c,0x2f,0x78,0x3e])));
});

test('external Office relationships are never loaded and their omission remains visible',()=>{
  const entries=officeEntries('docx'),rels='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="ignored" Target="file:///PRIVATE_FILE" TargetMode="External"/></Relationships>';
  const parsed=parseOfficeDocument(documentZip([...entries,{name:'word/_rels/document.xml.rels',data:rels}]),'docx');assert.match(parsed.text,/Benutzeroberfläche/);assert.doesNotMatch(parsed.text,/PRIVATE_FILE/);assert.ok(parsed.warnings.some(w=>/Externe/.test(w)));assert.equal(parsed.coverage,'partial');
});

test('MIME, extension and magic mismatches/oversize inputs fail before spawning any parser',async()=>{
  const f=fakeProcess();
  for(const patch of [{mimeType:'application/pdf'},{fileName:'Aufgabe.docm'},{fileName:'../Aufgabe.docx'},{fileName:'Aufgabe.docx\0'},{bytes:Buffer.from('%PDF-1.7\n')},{bytes:Buffer.alloc(DOCUMENT_READER_LIMITS.bytes+1)},{bytes:Buffer.alloc(0)},{token:'PRIVATE'}])await assert.rejects(f.api.read(request('docx',patch)));
  assert.equal(f.calls.length,0);f.api.dispose();
});

test('local parsing uses a fixed executable, no shell, bounded memory, pipe-only bytes and a minimal environment',async()=>{
  const f=fakeProcess(),bytes=officeFixture('docx'),copy=Buffer.from(bytes),document=await f.api.read(request('docx',{bytes}));assert.match(document.text,/Aufgabenstellung/);assert.deepEqual(bytes,copy);
  assert.deepEqual(f.calls[0].args.slice(0,1),['--max-old-space-size=128']);assert.equal(f.calls[0].args.at(-1),'docx');assert.equal(f.calls[0].options.shell,false);assert.deepEqual(f.calls[0].options.stdio,['pipe','pipe','pipe']);assert.equal(f.calls[0].options.env.ELECTRON_RUN_AS_NODE,'1');assert.equal(f.calls[0].options.env.HOME,undefined);assert.equal(f.calls[0].options.env.OPENROUTER_API_KEY,undefined);assert.deepEqual(f.children[0].input,bytes);f.api.dispose();
});

test('worker result validation rejects impossible coverage claims, mixed engines, hidden metadata and overlong text',()=>{
  const base=result();
  for(const patch of [{text:'x'.repeat(60001)},{coverage:'none'},{status:'unsupported',coverage:'partial',text:''},{token:'PRIVATE'}, {metadata:{...base.metadata,truncated:true},coverage:'complete'},{metadata:{...base.metadata,unitsRead:1,unitsTotal:2},coverage:'complete'},{metadata:{...base.metadata,format:'pdf',engine:'OOXML local'}},{metadata:{...base.metadata,ocrUnits:1}},{metadata:{...base.metadata,unitsRead:2,unitsTotal:1}}])assert.throws(()=>validateDocumentResult({...base,...patch}),JSON.stringify(patch).slice(0,160));
});

test('helper error envelopes never expose private document content, stderr or raw exception messages',async()=>{
  const f=fakeProcess({envelope:{ok:false,code:'PRIVATE_DOC_BODY',text:'PRIVATE_TEXT'},code:1});await assert.rejects(f.api.read(request()),error=>!/(PRIVATE_|PRIVATE_TEXT)/.test(error.message));f.api.dispose();
});

test('abort and dispose kill only their parser, reject promptly and ignore late successful output',async()=>{
  for(const kind of ['abort','dispose']){
    const gate=deferred(),f=fakeProcess({afterInput:child=>gate.release(child)}),controller=new AbortController(),pending=f.api.read(request('docx',{signal:controller.signal})),child=await gate.promise;
    if(kind==='abort')controller.abort();else f.api.dispose();await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(child.killed,['SIGKILL']);
    child.stdout.emit('data',Buffer.from(JSON.stringify({ok:true,value:result({text:'PRIVATE_LATE_CONTENT'})})));child.emit('close',0);assert.deepEqual(child.killed,['SIGKILL']);
    if(kind==='dispose')await assert.rejects(f.api.read(request()),/beendet/);f.api.dispose();
  }
});

test('concurrency and output limits prevent multiple parsers or excessive child output from occupying the app',async()=>{
  const gate=deferred(),f=fakeProcess({afterInput:child=>gate.release(child)}),pending=f.api.read(request()),child=await gate.promise;
  await assert.rejects(f.api.read(request()),error=>error.code==='busy');assert.equal(f.calls.length,1);
  child.stdout.emit('data',Buffer.alloc(DOCUMENT_READER_LIMITS.outputBytes+1,65));await assert.rejects(pending,error=>error.code==='outputLimit');assert.deepEqual(child.killed,['SIGKILL']);f.api.dispose();
});

test('excessive helper diagnostics are bounded without exposing stderr content',async()=>{
  const gate=deferred(),f=fakeProcess({afterInput:child=>gate.release(child)}),pending=f.api.read(request()),child=await gate.promise;
  child.stderr.emit('data',Buffer.from('PRIVATE_DIAGNOSTIC'.repeat(4000)));await assert.rejects(pending,error=>error.code==='outputLimit'&&!error.message.includes('PRIVATE_'));assert.deepEqual(child.killed,['SIGKILL']);f.api.dispose();
});

test('a never-finishing helper times out, is killed, and frees the parser slot for a later attempt',async()=>{
  const children=[];const api=createDocumentReader({timeoutMs:5,spawnProcess:()=>{const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:signal=>{child.signal=signal;}});children.push(child);child.stdin.resume();if(children.length===2)child.stdin.once('finish',()=>queueMicrotask(()=>{child.stdout.write(JSON.stringify({ok:true,value:result()}));child.emit('close',0);}));return child;}});
  await assert.rejects(api.read(request()),error=>error.code==='timeout');assert.equal(children[0].signal,'SIGKILL');assert.match((await api.read(request())).text,/Aufgabenstellung/);assert.equal(children.length,2);api.dispose();
});

test('actual Node helper reads all three Office formats from stdin on this OS without creating raw document files',async()=>{
  const api=createDocumentReader();try{for(const format of ['docx','pptx','xlsx']){const parsed=await api.read(request(format));assert.equal(parsed.metadata.engine,'OOXML local');assert.match(parsed.text,/Prüfe die Benutzeroberfläche/);assert.equal(parsed.coverage,'partial');}}finally{api.dispose();}
});

test('non-macOS PDF reads explicitly remain unsupported and do not launch another process',async()=>{
  let calls=0;const api=createDocumentReader({platform:'linux',spawnProcess:()=>{calls++;throw Error('must not spawn');}}),parsed=await api.read({bytes:Buffer.from('%PDF-1.7\n'),mimeType:'application/pdf',fileName:'Synthetic.pdf'});
  assert.equal(parsed.status,'unsupported');assert.equal(parsed.coverage,'none');assert.equal(parsed.text,'');assert.equal(parsed.metadata.engine,'unavailable');assert.equal(calls,0);api.dispose();
});
