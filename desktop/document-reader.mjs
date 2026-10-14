import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const DOCUMENT_READER_LIMITS=Object.freeze({bytes:8*1024*1024,text:60000,outputBytes:1024*1024,timeoutMs:45000,concurrent:1});
const L=DOCUMENT_READER_LIMITS;
const bundled=name=>fileURLToPath(new URL(name,import.meta.url)).replace(/([/\\])app\.asar([/\\])/,'$1app.asar.unpacked$2');
const MIME=Object.freeze({pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
const messages={inputLimit:'Das Dokument überschreitet 8 MiB.',invalidType:'Dateityp, Name und Dateiinhalt passen nicht zusammen.',invalidArchive:'Das Office-Archiv ist beschädigt.',unsupportedArchive:'Diese Variante des Office-Archivs wird nicht unterstützt.',archiveLimit:'Das Office-Archiv überschreitet die sicheren Größenlimits.',unsafeArchive:'Makros oder unsichere Archivstrukturen werden nicht gelesen.',invalidOffice:'Das Dokument enthält keine gültige Office-Struktur.',invalidXML:'Das Dokument enthält beschädigtes XML.',unsafeXML:'XML mit DTD, externen Entitäten oder Steuerzeichen wird nicht gelesen.',xmlLimit:'Das XML überschreitet die sicheren Strukturgrenzen.',invalidPDF:'Die PDF-Datei ist beschädigt.',lockedPDF:'Die PDF-Datei ist passwortgeschützt.',unsupportedType:'Dieser Dokumenttyp wird lokal noch nicht gelesen.',readFailed:'Das Dokument konnte lokal nicht gelesen werden.'};
const abort=()=>new DOMException('Dokumentlesen abgebrochen.','AbortError');
const failure=(code,message)=>Object.assign(new Error(message||messages[code]||messages.readFailed),{code});
function clean(value,max){return typeof value==='string'&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);}
export function validateDocumentResult(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['status','text','coverage','warnings','metadata'].includes(key))||!['ok','empty','unsupported'].includes(value.status)||!['complete','partial','none'].includes(value.coverage)||!clean(value.text,L.text)||!Array.isArray(value.warnings)||value.warnings.length>12||value.warnings.some(w=>!clean(w,300)||!w.trim()))throw failure('invalidResult');
  const m=value.metadata;if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(key=>!['format','engine','unitsRead','unitsTotal','ocrUnits','truncated'].includes(key))||!Object.hasOwn(MIME,m.format)||!['OOXML local','PDFKit','PDFKit + Apple Vision','unavailable'].includes(m.engine)||!Number.isSafeInteger(m.unitsRead)||m.unitsRead<0||m.unitsRead>100||!Number.isSafeInteger(m.unitsTotal)||m.unitsTotal<0||m.unitsTotal>100000||m.unitsRead>m.unitsTotal||!Number.isSafeInteger(m.ocrUnits)||m.ocrUnits<0||m.ocrUnits>5||m.ocrUnits>m.unitsRead||typeof m.truncated!=='boolean')throw failure('invalidResult');
  if(value.status==='ok'&&!value.text.trim()||value.status!=='ok'&&value.text||value.status==='unsupported'&&value.coverage!=='none'||m.format==='pdf'&&m.unitsRead>20||m.format!=='pdf'&&m.ocrUnits)throw failure('invalidResult');
  if(value.status==='ok'&&value.coverage==='none'||value.coverage==='complete'&&(m.truncated||m.unitsRead!==m.unitsTotal)||value.status==='unsupported'&&(m.engine!=='unavailable'||m.unitsRead||m.unitsTotal||m.ocrUnits||m.truncated)||value.status!=='unsupported'&&(m.engine==='unavailable'||!m.unitsTotal)||m.format==='pdf'&&m.engine==='OOXML local'||m.format!=='pdf'&&!['OOXML local','unavailable'].includes(m.engine)||m.engine==='PDFKit'&&m.ocrUnits||m.engine==='PDFKit + Apple Vision'&&!m.ocrUnits)throw failure('invalidResult');
  return {...value,warnings:[...value.warnings],metadata:{...m}};
}
function input(message){
  if(!message||typeof message!=='object'||Array.isArray(message)||Object.keys(message).some(key=>!['bytes','mimeType','fileName','signal'].includes(key))||typeof message.fileName!=='string'||message.fileName.length>240||/[\\/\x00-\x1f\x7f]/.test(message.fileName)||typeof message.mimeType!=='string')throw failure('invalidType');
  const format=message.fileName.toLowerCase().split('.').at(-1),mime=message.mimeType.toLowerCase().split(';')[0].trim();
  if(!Object.hasOwn(MIME,format)||MIME[format]!==mime||!(Buffer.isBuffer(message.bytes)||message.bytes instanceof Uint8Array||message.bytes instanceof ArrayBuffer))throw failure('invalidType');
  const source=message.bytes instanceof ArrayBuffer?new Uint8Array(message.bytes):message.bytes;if(!source.byteLength||source.byteLength>L.bytes)throw failure('inputLimit');const bytes=Buffer.from(source);
  if(format==='pdf'?!bytes.subarray(0,5).equals(Buffer.from('%PDF-')):bytes.length<22||bytes.readUInt32LE(0)!==0x04034b50){bytes.fill(0);throw failure('invalidType');}
  if(message.signal!==undefined&&(!message.signal||typeof message.signal.aborted!=='boolean'||typeof message.signal.addEventListener!=='function'||typeof message.signal.removeEventListener!=='function')){bytes.fill(0);throw failure('invalidSignal');}
  return {format,bytes,signal:message.signal};
}
export function createDocumentReader({spawnProcess=spawn,helperPath=bundled('./document-helper'),workerPath=bundled('./document-worker.mjs'),nodePath=process.execPath,platform=process.platform,timeoutMs=L.timeoutMs}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>L.timeoutMs)throw failure('invalidConfiguration');let disposed=false;const active=new Set();
  return {
    async read(message){
      if(disposed)throw failure('disposed','Der Dokumentleser wurde beendet.');if(message?.signal?.aborted)throw abort();if(active.size>=L.concurrent)throw failure('busy','Ein Dokument wird bereits lokal gelesen.');const {format,bytes,signal}=input(message);
      if(format==='pdf'&&platform!=='darwin'){bytes.fill(0);return {status:'unsupported',text:'',coverage:'none',warnings:['Lokale PDF-Erkennung ist auf dieser Plattform noch nicht verfügbar. Office-Dateien werden lokal unterstützt.'],metadata:{format,engine:'unavailable',unitsRead:0,unitsTotal:0,ocrUnits:0,truncated:false}};}
      try{return await new Promise((resolve,reject)=>{
        let child,timer,ended=false,output=[],outputBytes=0,diagnosticBytes=0;const operation={cancel:()=>finish(abort())};
        const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',operation.cancel);active.delete(operation);for(const chunk of output)chunk.fill(0);output=[];bytes.fill(0);try{child?.stdin?.destroy();}catch{}if(error){try{child?.kill('SIGKILL');}catch{}reject(error);}else resolve(value);};
        active.add(operation);signal?.addEventListener('abort',operation.cancel,{once:true});
        if(signal?.aborted){finish(abort());return;}
        try{
          const office=format!=='pdf';child=spawnProcess(office?nodePath:helperPath,office?['--max-old-space-size=128',workerPath,format]:[],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{LANG:'de_DE.UTF-8',LC_ALL:'de_DE.UTF-8',...(office?{ELECTRON_RUN_AS_NODE:'1',NODE_NO_WARNINGS:'1'}:{})}});
          timer=setTimeout(()=>finish(failure('timeout','Das lokale Dokumentlesen hat zu lange gebraucht und wurde beendet.')),timeoutMs);
          child.once('error',error=>finish(failure(error.code==='ENOENT'?'unavailable':'readFailed',error.code==='ENOENT'?'Die lokale Dokumentkomponente fehlt. Installiere die aktuelle Context-App.':undefined)));
          child.stderr?.on('error',()=>{});child.stderr?.on('data',chunk=>{diagnosticBytes+=chunk.length;if(!ended&&diagnosticBytes>65536)finish(failure('outputLimit','Die lokale Dokumentkomponente wurde wegen zu vieler Diagnosedaten beendet.'));});
          child.stdout.on('error',()=>finish(failure('readFailed')));child.stdout.on('data',chunk=>{if(ended)return;outputBytes+=chunk.length;if(outputBytes>L.outputBytes){finish(failure('outputLimit','Das lokale Leseergebnis überschreitet die sichere Grenze.'));return;}output.push(Buffer.from(chunk));});
          child.once('close',code=>{if(ended)return;try{const raw=Buffer.concat(output);let result;try{result=JSON.parse(raw.toString('utf8'));}finally{raw.fill(0);}if(!result||typeof result!=='object'||Array.isArray(result)||result.ok!==true||code!==0)throw failure(Object.hasOwn(messages,result?.code)?result.code:'readFailed');if(Object.keys(result).some(key=>!['ok','value'].includes(key)))throw failure('invalidResult');finish(null,validateDocumentResult(result.value));}catch(error){finish(error);}});
          child.stdin.on('error',()=>finish(failure('readFailed')));child.stdin.end(bytes);
        }catch{finish(failure('readFailed'));}
      });}finally{bytes.fill(0);}
    },
    dispose(){if(disposed)return;disposed=true;for(const operation of [...active])operation.cancel();}
  };
}
