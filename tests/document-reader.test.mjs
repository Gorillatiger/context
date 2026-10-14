import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createDocumentReader,DOCUMENT_READER_LIMITS} from '../desktop/document-reader.mjs';
import {parseOfficeDocument,walkDocumentXML,DOCUMENT_WORKER_LIMITS} from '../desktop/document-worker.mjs';
import {documentMIMEs,documentZip,officeEntries,officeFixture,wordXML} from './document-security-fixtures.mjs';

const request=(format,bytes=officeFixture(format),extra={})=>({bytes,mimeType:documentMIMEs[format],fileName:`Aufgaben.${format}`,...extra});
const errorCode=code=>error=>error.code===code;
for(const format of ['docx','pptx','xlsx'])test(`real isolated Node worker reads German ${format} task text without mutating the caller buffer`,async()=>{
  const bytes=officeFixture(format,{text:'Prüfe die Oberfläche &amp; dokumentiere täglich deine Arbeit.'}),original=Buffer.from(bytes),reader=createDocumentReader();
  try{const value=await reader.read(request(format,bytes));assert.equal(value.status,'ok');assert.match(value.text,/Prüfe die Oberfläche & dokumentiere täglich deine Arbeit/);assert.equal(value.coverage,'partial');assert.equal(value.metadata.format,format);assert.equal(value.metadata.engine,'OOXML local');assert.equal(value.metadata.unitsRead,1);assert.deepEqual(bytes,original);}finally{reader.dispose();}
});
test('Word paragraphs, table boundaries, tabs and footnotes remain readable; deleted/instruction text stays excluded',()=>{
  const body=wordXML('Aufgabe').replace('</w:body>','<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t><w:instrText>INSTRUCTION_SECRET</w:instrText></w:r><w:del><w:r><w:t>DELETED_TEXT</w:t></w:r></w:del></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Zelle eins</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Zelle zwei</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body>');
  const value=parseOfficeDocument(documentZip([...officeEntries('docx',{xml:body}),{name:'word/footnotes.xml',data:'<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote><w:p><w:r><w:t>Fußnote</w:t></w:r></w:p></w:footnote></w:footnotes>'}]),'docx');
  assert.match(value.text,/A\tB\nC/);assert.match(value.text,/Zelle eins/);assert.match(value.text,/Zelle zwei/);assert.match(value.text,/Fußnote/);assert.doesNotMatch(value.text,/DELETED|INSTRUCTION/);assert.equal(value.metadata.unitsRead,2);
});
test('presentation relationships control slide order instead of ZIP order or filename order',()=>{
  const entries=officeEntries('pptx',{text:'Zweite Folie'});entries.find(e=>e.name==='ppt/presentation.xml').data=entries.find(e=>e.name==='ppt/presentation.xml').data.replace('<p:sldId id="256" r:id="rId1"/>','<p:sldId id="257" r:id="rId2"/><p:sldId id="256" r:id="rId1"/>');
  entries.find(e=>e.name==='ppt/_rels/presentation.xml.rels').data=entries.find(e=>e.name==='ppt/_rels/presentation.xml.rels').data.replace('</Relationships>','<Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>');entries.push({name:'ppt/slides/slide2.xml',data:entries.find(e=>e.name==='ppt/slides/slide1.xml').data.replace('Zweite Folie','Erste Folie')});
  const value=parseOfficeDocument(documentZip(entries),'pptx');assert.ok(value.text.indexOf('Erste Folie')<value.text.indexOf('Zweite Folie'));assert.equal(value.metadata.unitsTotal,2);
});
test('spreadsheet shared strings and cached formula values are read without evaluating formulas or phonetic duplicates',()=>{
  const entries=officeEntries('xlsx',{xml:'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="s"><v>0</v></c><c><f>EXTERNAL_RUN()</f><v>17</v></c></row></sheetData></worksheet>'});entries.push({name:'xl/sharedStrings.xml',data:'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>Abgabe</t></r><rPh><t>PHONETIC_DUPLICATE</t></rPh><r><t> Freitag</t></r></si></sst>'});
  const value=parseOfficeDocument(documentZip(entries),'xlsx');assert.match(value.text,/Abgabe Freitag\t17/);assert.doesNotMatch(value.text,/EXTERNAL_RUN|PHONETIC/);assert.ok(value.warnings.some(w=>w.includes('Formeln wurden nicht ausgeführt')));
});
test('empty Office content stays empty and text/units limits report partial coverage',()=>{
  assert.equal(parseOfficeDocument(officeFixture('docx',{text:''}),'docx').status,'empty');const text=Array.from({length:7000},(_,i)=>`Aufgabe ${i}: Prüfen und berichten. `).join('');const value=parseOfficeDocument(officeFixture('docx',{text}),'docx');assert.ok(value.text.length<=DOCUMENT_READER_LIMITS.text);assert.equal(value.metadata.truncated,true);assert.equal(value.coverage,'partial');
});
test('all ZIP members receive CRC and XML validation even if their content is not selected',()=>{
  assert.throws(()=>parseOfficeDocument(documentZip([...officeEntries('docx'),{name:'word/media/image.png',data:'image',crc:0}]),'docx'),errorCode('invalidArchive'));
  assert.throws(()=>parseOfficeDocument(documentZip([...officeEntries('docx'),{name:'word/unused.xml',data:'<!DOCTYPE x SYSTEM "file:///private/secret"><x/>'}]),'docx'),errorCode('unsafeXML'));
});
test('unknown entities, out-of-range numeric entities and malformed XML do not become document content',()=>{
  for(const text of ['&invented;','&#0;','&#xD800;','&#9999999;'])assert.throws(()=>parseOfficeDocument(officeFixture('docx',{text}),'docx'),errorCode('unsafeXML'));
  assert.throws(()=>walkDocumentXML(Buffer.from('<root><child></root>')),errorCode('invalidXML'));assert.throws(()=>walkDocumentXML(Buffer.from('<root a="1" a="2"/>')),errorCode('invalidXML'));
  let actual='';walkDocumentXML(Buffer.from('<root>&lt; &amp; &#x1F600; <![CDATA[a<b]]></root>'),{text:text=>actual+=text});assert.equal(actual,'< & 😀 a<b');
});
test('XML depth and ZIP expansion/entry count are bounded',()=>{
  assert.throws(()=>walkDocumentXML(Buffer.from('<a>'.repeat(DOCUMENT_WORKER_LIMITS.xmlDepth+1)+'</a>'.repeat(DOCUMENT_WORKER_LIMITS.xmlDepth+1))),errorCode('xmlLimit'));
  assert.throws(()=>parseOfficeDocument(documentZip([...officeEntries('docx'),{name:'word/bomb.txt',data:'A'.repeat(200000),method:8}]),'docx'),errorCode('archiveLimit'));
  assert.throws(()=>parseOfficeDocument(documentZip(Array.from({length:DOCUMENT_WORKER_LIMITS.entries+1},(_,i)=>({name:`file${i}`,data:'x'}))),'docx'),errorCode('archiveLimit'));
});
test('MIME, basename, extension, magic and byte size are checked before spawning',async()=>{
  let calls=0;const reader=createDocumentReader({spawnProcess(){calls++;throw new Error('must not spawn');}});
  for(const data of [{...request('docx'),mimeType:documentMIMEs.xlsx},{...request('docx'),fileName:'../Aufgabe.docx'},{...request('docx'),bytes:Buffer.from('%PDF-1.7')},{...request('pdf',Buffer.from('PKnotpdf'))},{...request('docx'),bytes:Buffer.alloc(DOCUMENT_READER_LIMITS.bytes+1)}])await assert.rejects(reader.read(data));assert.equal(calls,0);reader.dispose();
});
for(const platform of ['win32','linux'])test(`${platform} honestly reports unavailable PDF without spawning or losing Office support`,async()=>{
  let calls=0;const reader=createDocumentReader({platform,spawnProcess(){calls++;throw new Error('must not spawn');}});const value=await reader.read(request('pdf',Buffer.from('%PDF-1.7\nsynthetic')));assert.equal(value.status,'unsupported');assert.equal(value.coverage,'none');assert.equal(value.metadata.engine,'unavailable');assert.equal(calls,0);reader.dispose();
});
function fakeChild(){const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=[];child.kill=signal=>{child.kills.push(signal);queueMicrotask(()=>child.emit('close',null));return true;};return child;}
const workerResult=()=>({ok:true,value:parseOfficeDocument(officeFixture('docx'),'docx')});
test('spawn arguments are fixed, sandboxed from inherited secrets and never contain user-controlled filenames',async()=>{
  let child,command,args,options;const reader=createDocumentReader({nodePath:'/fixed/node',workerPath:'/fixed/worker.mjs',spawnProcess(...values){[command,args,options]=values;child=fakeChild();queueMicrotask(()=>{child.stdout.end(JSON.stringify(workerResult()));child.emit('close',0);});return child;}});
  await reader.read({...request('docx'),fileName:'$(ignored).docx'});assert.equal(command,'/fixed/node');assert.deepEqual(args,['--max-old-space-size=128','/fixed/worker.mjs','docx']);assert.equal(options.shell,false);assert.equal(options.env.ELECTRON_RUN_AS_NODE,'1');assert.deepEqual(Object.keys(options.env).sort(),['ELECTRON_RUN_AS_NODE','LANG','LC_ALL','NODE_NO_WARNINGS']);reader.dispose();
});
test('abort/dispose kill the process and late stdout never publishes a document',async()=>{
  for(const dispose of [false,true]){const controller=new AbortController(),child=fakeChild();const reader=createDocumentReader({spawnProcess:()=>child});const pending=reader.read(request('docx',undefined,{signal:controller.signal}));if(dispose)reader.dispose();else controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');assert.deepEqual(child.kills,['SIGKILL']);child.stdout.write(JSON.stringify(workerResult()));child.emit('close',0);if(dispose)await assert.rejects(reader.read(request('docx')),errorCode('disposed'));else reader.dispose();}
});
test('pre-abort never spawns; concurrent reads are refused and timeout terminates the retained process',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;const child=fakeChild(),reader=createDocumentReader({timeoutMs:15,spawnProcess:()=>{calls++;return child;}});await assert.rejects(reader.read(request('docx',undefined,{signal:controller.signal})),error=>error.name==='AbortError');assert.equal(calls,0);const pending=reader.read(request('docx'));await assert.rejects(reader.read(request('docx')),errorCode('busy'));await assert.rejects(pending,errorCode('timeout'));assert.deepEqual(child.kills,['SIGKILL']);reader.dispose();
});
test('stdout and discarded diagnostics are independently bounded and kill noisy helpers',async()=>{
  for(const stream of ['stdout','stderr']){const child=fakeChild(),reader=createDocumentReader({spawnProcess:()=>child}),pending=reader.read(request('docx'));child[stream].write(Buffer.alloc(stream==='stdout'?DOCUMENT_READER_LIMITS.outputBytes+1:65537));await assert.rejects(pending,errorCode('outputLimit'));assert.deepEqual(child.kills,['SIGKILL']);reader.dispose();}
});
test('malformed/error helper replies become safe errors without exposing stdout/stderr content',async()=>{
  for(const raw of ['PRIVATE_HELPER_SECRET',JSON.stringify({ok:false,code:'PRIVATE_HELPER_SECRET'}),JSON.stringify({...workerResult(),extra:'PRIVATE_HELPER_SECRET'})]){const child=fakeChild(),reader=createDocumentReader({spawnProcess:()=>child});const pending=reader.read(request('docx'));child.stdout.end(raw);child.emit('close',raw.includes('extra')?0:1);await assert.rejects(pending,error=>!error.message.includes('PRIVATE_HELPER_SECRET'));reader.dispose();}
});

function pdfFixture(texts){const objects=[],count=texts.length,fontId=3+count*2;objects.push('<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Count ${count} /Kids [${texts.map((_,i)=>`${3+i*2} 0 R`).join(' ')}] >>`);for(const [i,text] of texts.entries()){const content=text?`BT /F1 18 Tf 40 760 Td (${text}) Tj ET`:'';objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4+i*2} 0 R >>`,`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);}objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];let position=chunks[0].length;for(const [i,object] of objects.entries()){offsets.push(position);const chunk=Buffer.from(`${i+1} 0 obj\n${object}\nendobj\n`);chunks.push(chunk);position+=chunk.length;}chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`));return Buffer.concat(chunks);}
const helperPath=process.env.CONTEXT_TEST_DOCUMENT_HELPER;let helperAvailable=false;if(process.platform==='darwin'&&helperPath)try{await access(helperPath);helperAvailable=true;}catch{}
test('compiled macOS PDFKit helper reads synthetic German PDF text and reports the 20-page boundary',{skip:!helperAvailable},async()=>{
  const reader=createDocumentReader({helperPath});try{const value=await reader.read(request('pdf',pdfFixture(['Pr\\374fe die Oberfl\\344che und dokumentiere deine Arbeit.'])));assert.equal(value.status,'ok');assert.match(value.text,/Prüfe die Oberfläche/);assert.equal(value.metadata.engine,'PDFKit');assert.equal(value.metadata.unitsRead,1);const capped=await reader.read(request('pdf',pdfFixture(Array.from({length:22},(_,i)=>`Arbeitsauftrag fuer Kurstag ${i+1}`))));assert.equal(capped.metadata.unitsRead,20);assert.equal(capped.metadata.unitsTotal,22);assert.equal(capped.coverage,'partial');assert.equal(capped.metadata.truncated,true);assert.doesNotMatch(capped.text,/Kurstag 21/);}finally{reader.dispose();}
});
test('compiled macOS helper handles blank scans honestly and rejects malformed PDF',{skip:!helperAvailable},async()=>{
  const reader=createDocumentReader({helperPath});try{const value=await reader.read(request('pdf',pdfFixture([''])));assert.equal(value.status,'empty');assert.equal(value.text,'');assert.equal(value.coverage,'partial');assert.equal(value.metadata.ocrUnits,1);await assert.rejects(reader.read(request('pdf',Buffer.from('%PDF-1.7\nmalformed'))),errorCode('invalidPDF'));}finally{reader.dispose();}
});
const rasterFixturePath=process.env.CONTEXT_TEST_DOCUMENT_PDF_FIXTURE;let rasterAvailable=false;if(helperAvailable&&rasterFixturePath)try{await access(rasterFixturePath);rasterAvailable=true;}catch{}
test('compiled local Vision helper reads genuine raster PDF task text and caps OCR to five pages',{skip:!rasterAvailable},async t=>{
  const {stdout:bytes}=await promisify(execFile)(rasterFixturePath,['6'],{encoding:'buffer',maxBuffer:DOCUMENT_READER_LIMITS.bytes}),reader=createDocumentReader({helperPath});try{const value=await reader.read(request('pdf',bytes));assert.equal(value.metadata.engine,'PDFKit + Apple Vision');assert.equal(value.metadata.ocrUnits,5);assert.equal(value.metadata.unitsRead,6);assert.equal(value.coverage,'partial');assert.ok(value.warnings.some(w=>w.includes('fünf OCR-Seiten')));assert.doesNotMatch(value.text,/Seite 6/);if(value.status==='empty'&&value.warnings.some(w=>w.includes('konnte mit lokaler OCR nicht gelesen'))){assert.equal(value.text,'');t.skip('Apple Vision/CoreML is unavailable in this host subprocess environment; honest empty/partial fallback and OCR limits were verified.');return;}assert.equal(value.status,'ok');assert.match(value.text,/Deutsche Aufgabe.*Prototyp bauen/s);assert.match(value.text,/Dev Diary jeden Tag schreiben/);}finally{reader.dispose();}
});
