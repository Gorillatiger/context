import test from 'node:test';
import assert from 'node:assert/strict';
import {createCourseFileFetch} from '../desktop/course-file-fetch.mjs';
import {documentMIMEs,officeFixture} from './document-security-fixtures.mjs';

const REPO='https://git.coco.study/course/robotics',DOC=REPO+'/-/raw/main/assignment.docx',TEXT=REPO+'/-/raw/main/README.md',SHARE='https://th-koeln.sciebo.de/s/Synthetic_share',DOWNLOAD=SHARE+'/download';
function fixture({status=200,mime=documentMIMEs.docx,disposition='',length=null,chunks=[officeFixture('docx')],readHook}={}){
  const f={calls:[],bodyCancels:0,readerCancels:0,releases:0,readerStarts:0,reads:0};let offset=0;
  const reader={read:async()=>{f.reads++;if(readHook)return readHook(f);return offset<chunks.length?{done:false,value:chunks[offset++]}:{done:true};},cancel:async()=>{f.readerCancels++;},releaseLock:()=>f.releases++};
  const response={ok:status>=200&&status<300,status,url:'https://electron.invalid/unreliable-property',headers:{get:name=>name==='content-type'?mime:name==='content-disposition'?disposition:name==='content-length'?length:null},body:{cancel:async()=>f.bodyCancels++,getReader:()=>{f.readerStarts++;return reader;}}};
  f.fetch=createCourseFileFetch({session:{fetch:async(url,options)=>{f.calls.push({url,options});return response;}}});
  f.read=(url=DOC,options={})=>f.fetch(url,{maxBytes:8*1024*1024,service:'gitlab',scope:REPO,...options});return f;
}

test('native document fetch uses only a scoped authenticated GET with redirects forbidden and bounded raw bytes',async()=>{
  const source=officeFixture('docx'),f=fixture({chunks:[source]}),controller=new AbortController(),result=await f.read(DOC,{signal:controller.signal});
  assert.deepEqual(f.calls[0],{url:DOC,options:{method:'GET',redirect:'error',signal:controller.signal,credentials:'include'}});assert.equal(result.fileName,'assignment.docx');assert.equal(result.contentType,documentMIMEs.docx);assert.deepEqual(result.bytes,source);assert.equal(result.url,DOC);assert.equal(result.text,undefined);assert.equal(f.releases,1);assert.ok(f.readerCancels>=1);
});

test('unsafe hosts, another repository, adjacent folders/shares and unsupported files fail before native fetch',async()=>{
  const f=fixture();
  for(const url of ['https://evil.test/assignment.docx',DOC.replace('/course/robotics/','/course/other/'),DOC.replace('assignment.docx','api-key.docx'),DOC.replace('assignment.docx','assignment.docm'),REPO+'/-/raw/main/../../private.docx',DOC+'?token=PRIVATE'])await assert.rejects(f.read(url));
  const scope='https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2FCourse';
  await assert.rejects(f.fetch('https://th-koeln.sciebo.de/index.php/apps/files/ajax/download.php?dir=%2FCourseOther&files=assignment.pdf',{maxBytes:8*1024*1024,service:'sciebo',scope}));
  await assert.rejects(f.fetch('https://th-koeln.sciebo.de/s/Other_share/download?path=%2FCourse&files=assignment.pdf',{maxBytes:8*1024*1024,service:'sciebo',scope:SHARE+'?path=%2FCourse'}));assert.equal(f.calls.length,0);
});

test('HTTP errors and redirect responses are cancelled before any body read or leaked error text',async()=>{
  for(const status of [301,302,307,401,403,404,500]){const f=fixture({status,chunks:[Buffer.from('PRIVATE_ERROR_BODY')]});await assert.rejects(f.read(),error=>!error.message.includes('PRIVATE_'));assert.equal(f.readerStarts,0);assert.equal(f.bodyCancels,1);}
});

test('wrong MIME, oversized or malformed length headers are rejected and cancelled before streaming',async()=>{
  for(const patch of [{mime:'text/html'},{mime:documentMIMEs.xlsx},{mime:'image/png'},{length:String(8*1024*1024+1)},{length:'not-a-number'},{length:'-1'}]){const f=fixture(patch);await assert.rejects(f.read());assert.equal(f.readerStarts,0);assert.equal(f.bodyCancels,1);}
});

test('opaque single-share downloads need a safe positively allowed filename and cancel rejected Content-Disposition',async()=>{
  const cases=['attachment; filename="api-key.pdf"','attachment; filename="api_keys.pdf"','attachment; filename="secrets.pdf"','attachment; filename="../assignment.pdf"','attachment; filename="unsupported.unknown"',"attachment; filename*=UTF-8''%FF","attachment; filename*=UTF-8''%FFapi-key.pdf"];
  for(const disposition of cases){const f=fixture({mime:'application/pdf',disposition,chunks:[Buffer.from('%PDF-1.7\n')]});await assert.rejects(f.read(DOWNLOAD,{service:'sciebo',scope:SHARE}),disposition);assert.equal(f.readerStarts,0);assert.equal(f.bodyCancels,1,disposition);}
  const allowed=fixture({mime:'application/pdf',disposition:"attachment; filename*=UTF-8''Pr%C3%BCfung.pdf",chunks:[Buffer.from('%PDF-1.7\n')]});assert.equal((await allowed.read(DOWNLOAD,{service:'sciebo',scope:SHARE})).fileName,'Prüfung.pdf');
  const inferred=fixture({mime:'application/pdf',chunks:[Buffer.from('%PDF-1.7\n')]});assert.equal((await inferred.read(DOWNLOAD,{service:'sciebo',scope:SHARE})).fileName,'Kursdatei.pdf');
});

test('generic provider binary MIME stays explicit for subsequent magic/format validation, never treated as parsed text',async()=>{
  for(const mime of ['application/octet-stream','application/zip']){const f=fixture({mime});const value=await f.read();assert.equal(value.contentType,mime);assert.equal(value.fileName,'assignment.docx');assert.ok(Buffer.isBuffer(value.bytes));assert.equal(value.text,undefined);}
});

test('a missing or false-small Content-Length cannot bypass the streaming cap; resources are released on failure',async()=>{
  for(const length of [null,'1']){const f=fixture({length,chunks:[Buffer.alloc(60),Buffer.alloc(60)]});await assert.rejects(f.read(DOC,{maxBytes:100}),/groß/);assert.equal(f.reads,2);assert.equal(f.releases,1);assert.ok(f.readerCancels>=1);}
});

test('abort before fetch performs no request; an abort during a stalled stream settles promptly and ignores its eventual bytes',async()=>{
  const early=new AbortController();early.abort();const f=fixture();await assert.rejects(f.read(DOC,{signal:early.signal}),{name:'AbortError'});assert.equal(f.calls.length,0);
  let began,finish;const ready=new Promise(resolve=>began=resolve),pendingRead=new Promise(resolve=>finish=resolve),controller=new AbortController(),stalled=fixture({readHook:()=>{began();return pendingRead;}}),pending=stalled.read(DOC,{signal:controller.signal});await ready;controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(stalled.releases,1);assert.ok(stalled.readerCancels>=1);finish({done:false,value:Buffer.from('PRIVATE_LATE_BODY')});await Promise.resolve();assert.equal(stalled.reads,1);
});

test('invalid/empty body chunks and stream failures still close the reader without returning partial raw bytes',async()=>{
  for(const patch of [{chunks:[]},{chunks:['not bytes']},{readHook:()=>Promise.reject(Error('PRIVATE_STREAM_ERROR'))}]){const f=fixture(patch);await assert.rejects(f.read());assert.equal(f.releases,1);assert.ok(f.readerCancels>=1);}
});

test('ordinary small text responses preserve the established text contract without a document parser',async()=>{
  const f=fixture({mime:'text/markdown; charset=utf-8',chunks:[Buffer.from('# Deutsche Aufgabe\nPrüfe die UI.')]});const value=await f.read(TEXT,{maxBytes:2000000});assert.match(value.text,/Deutsche Aufgabe/);assert.equal(value.bytes,undefined);assert.equal(value.fileName,'README.md');assert.equal(value.contentType,'text/markdown');
});
