import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createDesktopPlatform} from '../desktop/platform.mjs';
import {createDocumentReader} from '../desktop/document-reader.mjs';
import {createCourseFileFetch} from '../desktop/course-file-fetch.mjs';
import {createSourceHub} from '../dist/source-hub.js';
import {platformCatalog} from '../dist/source-catalog.js';
import {cleanPlatformSources} from '../dist/source-store.js';
import {officeFixture,documentMIMEs} from './document-security-fixtures.mjs';

const REPO='https://git.coco.study/course/robotics',DOC=REPO+'/-/raw/main/assignment.docx',CONTENT='d'.repeat(64),ACCOUNT='b'.repeat(64);
const gate=()=>{let enter,release;return {entered:new Promise(resolve=>enter=resolve),promise:new Promise(resolve=>release=resolve),enter,release};};
const parsed=(text='PRIVATE_LATE_DOCUMENT')=>({status:'ok',text,coverage:'partial',warnings:['Nur Text.'],metadata:{format:'docx',engine:'OOXML local',unitsRead:1,unitsTotal:1,ocrUnits:0,truncated:false}});
function fixture({mime=documentMIMEs.docx,documentHook}={}){
  const f={workspace:{activeCourse:'course',projects:[{id:'course',name:'Robotik',links:[{tool:'gitlab',url:REPO,title:'Kursrepo'}]}]},stored:[],revision:0,calls:[],fetches:[],parses:[],account:ACCOUNT};let listener;
  const documentReader=createDocumentReader();
  const fetch=createCourseFileFetch({session:{fetch:async(url,options)=>{f.fetches.push({url,options});return new Response(officeFixture('docx'),{status:200,headers:{'content-type':mime}});}}});
  const createView=()=>{const wc=new EventEmitter();Object.assign(wc,{url:'about:blank',closed:false,getURL:()=>wc.url,isDestroyed:()=>wc.closed,stop:()=>{},setWindowOpenHandler:()=>{},close:()=>{wc.closed=true;wc.emit('destroyed');},loadURL:async url=>{wc.url=url;wc.emit('did-start-navigation',{},url,false,true);wc.emit('did-navigate',{},url,200);},executeJavaScriptInIsolatedWorld:async()=>({url:wc.url,title:'Kursquellen',text:'Eine Aufgabenstellung ist als Dokument verlinkt.',offset:0,nextOffset:46,totalLength:46,hasMore:false,contentRevision:CONTENT,links:[],items:[],boardLinks:[],fileLinks:[{url:DOC,title:'Aufgabenstellung'}]})});return {webContents:wc,setVisible:()=>{}};};
  f.native=createDesktopPlatform({nango:{status:async()=>({}),proxy:async()=>{throw Error('Synthetic fixture must not contact Miro.');}},createView,destroyView:view=>view.webContents.close(),openVisible:()=>{throw Error('Synthetic fixture must not open a sign-in browser.');},getAccountFingerprint:async()=>f.account,fetchText:fetch,readDocument:async args=>{f.parses.push(args);return documentHook?documentHook(args,f):documentReader.read(args);},emit:detail=>listener?.({type:'context-platform-auth',detail})});
  const bridge={service:async message=>{f.calls.push(message);try{return {ok:true,value:await f.native.service(message)};}catch(error){return {ok:false,error:error.message,code:error.code};}},miro:async()=>({ok:true,value:{connected:false}}),onEvent:callback=>{listener=callback;return ()=>listener=undefined;}};
  const store={load:async()=>({rows:f.stored,revision:f.revision}),save:async(rows,{expectedRevision,assertCurrent,signal})=>{assert.equal(expectedRevision,f.revision);assertCurrent();assert.equal(signal.aborted,false);f.stored=cleanPlatformSources(rows);return ++f.revision;},close:()=>{}};
  f.hub=createSourceHub({getWorkspace:()=>f.workspace,bridge,store});f.source=()=>platformCatalog(f.workspace)[0];f.prepare=async()=>{await f.hub.load();await f.hub.tool('read_platform',{sourceId:f.source().id},undefined,'course');};
  f.read=(patch={},signal)=>f.hub.tool('read_platform_file',{sourceId:f.source().id,url:DOC,expectedRevision:CONTENT,...patch},signal,'course');
  f.dispose=async()=>{await f.hub.dispose();f.native.dispose();documentReader.dispose();};return f;
}

test('actual Office bytes cross native fetch → real stdin parser → validated source hub → durable text-only projection',async()=>{
  const f=fixture();try{await f.prepare();const result=await f.read();assert.equal(f.fetches.length,1);assert.equal(f.fetches[0].url,DOC);assert.equal(f.fetches[0].options.redirect,'error');assert.equal(f.parses.length,1);assert.ok(f.parses[0].bytes instanceof Uint8Array);assert.ok(f.parses[0].signal instanceof AbortSignal);assert.equal(f.parses[0].fileName,'assignment.docx');
    const doc=result.documents[0];assert.match(doc.text,/Prüfe die Benutzeroberfläche/);assert.equal(doc.url,DOC);assert.equal(doc.projectId,'course');assert.equal(doc.status,'excerpt');assert.equal(doc.accountGeneration,ACCOUNT);assert.equal(doc.trust,'untrusted-source');assert.ok(f.hub.documents().some(row=>row.url===DOC));assert.ok(f.stored[0].documents.some(row=>row.url===DOC));assert.doesNotMatch(JSON.stringify([result,f.stored]),/"bytes":|"type":"Buffer"|Content_Types|<w:document/);
  }finally{await f.dispose();}
});

test('explicitly accepted generic provider binary MIME still reaches real Office parsing without weakening package checks',async()=>{
  for(const mime of ['application/octet-stream','application/zip']){const f=fixture({mime});try{await f.prepare();const result=await f.read();assert.match(result.documents[0].text,/Benutzeroberfläche/);assert.equal(result.documents[0].status,'excerpt');assert.equal(f.parses.length,1);}finally{await f.dispose();}}
});

test('a guessed unoffered file is rejected before authenticated fetch or local parser invocation',async()=>{
  const f=fixture();try{await f.prepare();await assert.rejects(f.read({url:DOC.replace('assignment.docx','guessed.docx')}),/angebotene/);assert.equal(f.fetches.length,0);assert.equal(f.parses.length,0);assert.ok(f.stored[0].documents.every(row=>row.url!==DOC));}finally{await f.dispose();}
});

test('individual abort during document processing prevents late text publication while preserving earlier legitimate page text',async()=>{
  const held=gate(),f=fixture({documentHook:async()=>{held.enter();await held.promise;return parsed();}}),controller=new AbortController();try{await f.prepare();const pending=f.read({},controller.signal);await held.entered;controller.abort();await assert.rejects(pending,{name:'AbortError'});held.release();await new Promise(resolve=>setImmediate(resolve));assert.doesNotMatch(JSON.stringify([f.hub.documents(),f.stored]),/PRIVATE_LATE_DOCUMENT/);assert.ok(f.hub.documents().every(row=>row.url!==DOC));assert.equal(f.parses[0].signal.aborted,true);}finally{held.release();await f.dispose();}
});

test('course unlink or account invalidation during document processing revokes the pending source before its text can be committed',async()=>{
  for(const kind of ['unlink','account']){const held=gate(),f=fixture({documentHook:async()=>{held.enter();await held.promise;return parsed();}});try{await f.prepare();const pending=f.read();await held.entered;if(kind==='unlink'){f.workspace.projects[0].links=[];await f.hub.sync();}else{f.account='c'.repeat(64);f.native.invalidate('gitlab');}await assert.rejects(pending);held.release();await new Promise(resolve=>setImmediate(resolve));assert.doesNotMatch(JSON.stringify([f.hub.documents(),f.stored]),/PRIVATE_LATE_DOCUMENT/);assert.ok(f.hub.documents().every(row=>row.url!==DOC));assert.equal(f.parses[0].signal.aborted,true);}finally{held.release();await f.dispose();}}
});

test('an account replacement without a cookie event is still detected after parsing and never returns old-account file text',async()=>{
  const f=fixture({documentHook:async(_args,state)=>{state.account='c'.repeat(64);return parsed();}});try{await f.prepare();await assert.rejects(f.read(),error=>error.name==='AbortError'||/Quellenfreigabe|Anmeldung|Quelle/.test(error.message));assert.doesNotMatch(JSON.stringify([f.hub.documents(),f.stored]),/PRIVATE_LATE_DOCUMENT/);assert.ok(f.hub.documents().every(row=>row.url!==DOC));}finally{await f.dispose();}
});
