// Synthetic-only local document benchmark. No user files, network or raw
// document persistence. Helper bytes enter through stdin; only metrics are saved.
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {release} from 'node:os';
import {documentZip,officeEntries,wordXML} from './document-security-fixtures.mjs';
import {validateDocumentResult,DOCUMENT_READER_LIMITS} from '../desktop/document-reader.mjs';
import {DOCUMENT_WORKER_LIMITS} from '../desktop/document-worker.mjs';

const root=new URL('../',import.meta.url),workerPath=process.argv[5]||fileURLToPath(new URL('desktop/document-worker.mjs',root));
const rssWrapperPath=fileURLToPath(new URL('./document-rss-wrapper.py',import.meta.url));
const helperPath=process.argv[2]||fileURLToPath(new URL('desktop/document-helper',root)),outputPath=process.argv[3]||fileURLToPath(new URL('document-benchmark.json',root));
const nodePath=process.argv[4]||process.execPath;
if(process.platform!=='darwin')throw new Error('This benchmark measures the real macOS helper RSS with POSIX wait4.');
if(process.argv.length>6)throw new Error('Usage: node tests/bench-documents.mjs [pdf-helper] [metrics-output] [node-or-electron-executable] [worker-path]');
const xml=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const sentence='Synthetische deutsche Aufgabe: Prüfe den Prototyp, beschreibe Barrieren und schreibe täglich ein Dev Diary.';
function fixtures(){
  const paragraphs=Array.from({length:120},(_,i)=>`<w:p><w:r><w:t>${xml(`Tag ${i+1}. ${sentence}`)}</w:t></w:r></w:p>`).join('');
  const word=officeEntries('docx',{xml:wordXML('').replace('<w:p><w:r><w:t></w:t></w:r></w:p>',paragraphs)});
  const presentation=officeEntries('pptx');const slideTemplate=presentation.find(row=>row.name==='ppt/slides/slide1.xml').data;
  presentation.find(row=>row.name==='ppt/presentation.xml').data=presentation.find(row=>row.name==='ppt/presentation.xml').data.replace('<p:sldId id="256" r:id="rId1"/>',Array.from({length:12},(_,i)=>`<p:sldId id="${256+i}" r:id="rId${i+1}"/>`).join(''));
  presentation.find(row=>row.name==='ppt/_rels/presentation.xml.rels').data='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+Array.from({length:12},(_,i)=>`<Relationship Id="rId${i+1}" Target="slides/slide${i+1}.xml"/>`).join('')+'</Relationships>';
  presentation.splice(presentation.findIndex(row=>row.name==='ppt/slides/slide1.xml'),1);
  for(let i=0;i<12;i++)presentation.push({name:`ppt/slides/slide${i+1}.xml`,data:slideTemplate.replace('Prüfe die Benutzeroberfläche.',xml(`Folie ${i+1}. ${sentence} Stelle deine Beobachtungen in der Gruppe vor.`))});
  const rows=Array.from({length:250},(_,i)=>'<row>'+[`Tag ${i+1}`,'Synthetischer Kurs',sentence,'In Arbeit','Originalquelle prüfen'].map((value,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`).join('')+'</row>').join('');
  const spreadsheet=officeEntries('xlsx',{xml:`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`});
  return [
    {format:'docx',description:'120 deutsche Aufgaben-/Tagebuchabsätze; 1 Haupttext',units:1,bytes:documentZip(word.map(row=>({...row,method:8})))},
    {format:'pptx',description:'12 Folien mit deutschen Aufgaben und Gruppenhinweisen',units:12,bytes:documentZip(presentation.map(row=>({...row,method:8})))},
    {format:'xlsx',description:'250 Aufgabenzeilen mit jeweils fünf Textzellen',units:1,bytes:documentZip(spreadsheet.map(row=>({...row,method:8})))},
    {format:'pdf',description:'12 Seiten mit echter deutscher PDF-Textlage; keine Raster-/OCR-Seiten',units:12,bytes:pdfFixture()}
  ];
}
function pdfEscape(value){return String(value).replace(/[\\()äöüÄÖÜß]/g,char=>({'ä':'\\344','ö':'\\366','ü':'\\374','Ä':'\\304','Ö':'\\326','Ü':'\\334','ß':'\\337','\\':'\\\\','(':'\\(',')':'\\)'}[char]));}
function pdfFixture(){
  const count=12,objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Count ${count} /Kids [${Array.from({length:count},(_,i)=>`${3+i*2} 0 R`).join(' ')}] >>`],fontId=3+count*2;
  for(let i=0;i<count;i++){
    const lines=[`Synthetischer deutscher Arbeitsauftrag, Seite ${i+1}`,...Array.from({length:10},(_,j)=>`Schritt ${j+1}: Prüfe Barrieren. Schreibe täglich ein Dev Diary.`)];
    const content='BT /F1 14 Tf 18 TL 40 790 Td '+lines.map((line,index)=>(index?'T* ':'')+`(${pdfEscape(line)}) Tj`).join(' ')+' ET';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4+i*2} 0 R >>`,`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[];let position=chunks[0].length;for(let i=0;i<objects.length;i++){offsets.push(position);const part=Buffer.from(`${i+1} 0 obj\n${objects[i]}\nendobj\n`);chunks.push(part);position+=part.length;}
  chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`));return Buffer.concat(chunks);
}
function timedRead(fixture){return new Promise((resolve,reject)=>{
  const command=fixture.format==='pdf'?helperPath:nodePath,args=fixture.format==='pdf'?[]:['--max-old-space-size=128',workerPath,fixture.format];
  const start=performance.now(),child=spawn('/usr/bin/python3',['-B',rssWrapperPath,command,...args],{shell:false,windowsHide:true,detached:true,stdio:['pipe','pipe','pipe'],env:{LANG:'de_DE.UTF-8',LC_ALL:'de_DE.UTF-8',...(fixture.format==='pdf'?{}:{ELECTRON_RUN_AS_NODE:'1',NODE_NO_WARNINGS:'1'})}});
  let out=[],err=[],outBytes=0,errBytes=0,ended=false;
  const kill=()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
  const timer=setTimeout(()=>{if(!ended){ended=true;kill();reject(new Error('Synthetic helper benchmark exceeded the 45-second parser limit.'));}},DOCUMENT_READER_LIMITS.timeoutMs);
  const fail=()=>{if(!ended){ended=true;clearTimeout(timer);kill();reject(new Error('Synthetic helper benchmark failed before metrics were verified.'));}};
  child.once('error',fail);child.stdin.on('error',fail);
  child.stdout.on('data',chunk=>{outBytes+=chunk.length;if(outBytes>DOCUMENT_READER_LIMITS.outputBytes)return fail();out.push(Buffer.from(chunk));});
  child.stderr.on('data',chunk=>{errBytes+=chunk.length;if(errBytes>65536)return fail();err.push(Buffer.from(chunk));});
  child.once('close',code=>{if(ended)return;ended=true;clearTimeout(timer);try{if(code!==0)throw new Error('Helper rejected a synthetic fixture.');const raw=Buffer.concat(out),diagnostics=Buffer.concat(err),packet=JSON.parse(raw.toString('utf8'));if(packet?.ok!==true)throw new Error('Invalid helper result.');const value=validateDocumentResult(packet.value),peak=/^CONTEXT_DOCUMENT_RUSAGE (\{[^\n]+\})\s*$/m.exec(diagnostics.toString('utf8')),measurement=peak&&JSON.parse(peak[1]),rss=measurement?.helperPeakRSSBytes;if(!Number.isSafeInteger(rss)||rss<=0||value.status!=='ok'||value.metadata.unitsRead!==fixture.units||!value.text.includes('Prüfe')||value.metadata.ocrUnits!==0)throw new Error('Checks: '+JSON.stringify({format:fixture.format,rssFound:!!peak,status:value.status,unitsRead:value.metadata.unitsRead,expectedUnits:fixture.units,germanFound:value.text.includes('Prüfe'),ocrUnits:value.metadata.ocrUnits}));resolve({wallMs:Number((performance.now()-start).toFixed(2)),helperPeakRSSBytes:rss,helperWallMs:measurement.helperWallMs,textCharacters:value.text.length,coverage:value.coverage,metadata:value.metadata});raw.fill(0);diagnostics.fill(0);out.forEach(chunk=>chunk.fill(0));err.forEach(chunk=>chunk.fill(0));}catch(error){reject(new Error('Synthetic '+fixture.format+' benchmark verification failed: '+(error.message.startsWith('Checks:')?error.message:'helper/result/RSS contract')+'; raw content and diagnostics were discarded.'));}});
  child.stdin.end(fixture.bytes);
});}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={schemaVersion:1,generatedAt:new Date().toISOString(),syntheticOnly:true,platform:{os:process.platform,architecture:process.arch,osRelease:release(),measurementScriptNodeVersion:process.version},artifacts:{officeRuntimePath:nodePath,officeRuntimeSHA256:digest(await readFile(nodePath)),workerPath,workerSHA256:digest(await readFile(workerPath)),pdfHelperPath:helperPath,pdfHelperSHA256:digest(await readFile(helperPath)),swiftSourceSHA256:digest(await readFile(new URL('desktop/document-helper.swift',root)))},method:{iterations:3,wallTime:'End-to-end local measurement-wrapper and helper start, stdin transmission, parsing, bounded JSON receipt and exit. The Python standard-library wrapper start is included. helperWallMs separately measures only posix_spawn through wait4, excluding wrapper startup. First iteration is not a guaranteed cold cache.',rss:'POSIX wait4 ru_maxrss of only the spawned helper, in macOS bytes. Not Context-app RSS, not measurement-wrapper RSS, not total system/framework-service memory and not a hardcap. BSD time -l was unusable due to the sandbox denying its unrelated kern.clockrate sysctl.',privacy:'Entirely synthetic fixtures; no user documents, network or raw document/text persistence. PDF has a genuine text layer; OCR success was not measured. These text-only fixtures do not establish worst-case parser memory or throughput.'},limits:{reader:DOCUMENT_READER_LIMITS,officeWorker:DOCUMENT_WORKER_LIMITS,pdfPages:20,pdfOCRPages:5,pdfRSSHardcap:false},formats:[]};
for(const fixture of fixtures()){
  const trials=[],record={format:fixture.format,syntheticDescription:fixture.description,inputBytes:fixture.bytes.length,expectedUnits:fixture.units};try{for(let i=0;i<3;i++)trials.push(await timedRead(fixture));const times=trials.map(trial=>trial.wallMs).sort((a,b)=>a-b),rss=trials.map(trial=>trial.helperPeakRSSBytes),helperTimes=trials.map(trial=>trial.helperWallMs).sort((a,b)=>a-b);
    report.formats.push({...record,status:'measured',firstIterationMs:trials[0].wallMs,medianWallMs:times[1],medianHelperWallMs:helperTimes[1],minWallMs:times[0],maxWallMs:times[2],maximumHelperPeakRSSBytes:Math.max(...rss),maximumHelperPeakRSSMiB:Number((Math.max(...rss)/1024/1024).toFixed(2)),trials});
  }catch(error){report.formats.push({...record,status:'failed',error:String(error.message).slice(0,500),trials});}finally{fixture.bytes.fill(0);}
}
await writeFile(outputPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output:outputPath,syntheticOnly:true,formats:report.formats.map(({format,status,error,medianWallMs,medianHelperWallMs,maximumHelperPeakRSSMiB,inputBytes})=>({format,status,...(error?{error}:{}),medianWallMs,medianHelperWallMs,maximumHelperPeakRSSMiB,inputBytes})),ocrMeasured:false}));
