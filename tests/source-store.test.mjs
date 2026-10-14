import test from 'node:test';
import assert from 'node:assert/strict';
import {platformCatalog} from '../dist/source-catalog.js';
import {createPlatformSourceStore,cleanPlatformSources,cleanPlatformDocument,platformDocumentAllowed,PLATFORM_STORAGE_LIMITS} from '../dist/source-store.js';
const failure=message=>new Error(message||'Synthetic IndexedDB failure');
const repo='https://git.coco.study/course/robotics',board='https://miro.com/app/board/synthetic-board/';
const workspace={projects:[{id:'course',links:[{tool:'gitlab',url:repo,title:'Course repo'},{tool:'miro',url:board,title:'Course board'}]}]};
const catalog=platformCatalog(workspace),git=catalog.find(row=>row.service==='gitlab'),miro=catalog.find(row=>row.service==='miro');
const doc=(n=1,patch={})=>({id:'service:'+Number(n).toString(16).padStart(64,'0')+':part0',sourceId:git.id,projectId:git.projectId,service:'gitlab',source:'gitlab',kind:'service',title:'Synthetic task',text:'SYNTHETIC PRIVATE SOURCE',url:repo+'/-/issues/'+n,status:'excerpt',contentRevision:'a'.repeat(64),checkedAt:'2026-10-14T10:00:00Z',...patch});
const row=(patch={})=>({sourceId:git.id,revision:git.revision,service:git.service,projectId:git.projectId,url:git.url,title:'Course repo',documents:[doc()],coverage:'partial',warnings:[],fetchedAt:'2026-10-14T10:00:00Z',accountGeneration:'b'.repeat(64),...patch});
const miroDoc=(patch={})=>({id:'miro:'+'c'.repeat(64)+':part0',sourceId:miro.id,projectId:miro.projectId,service:'miro',kind:'miro',source:'Miro',title:'Board assignment',text:'Build an accessible prototype.',url:board+'?moveToWidget=synthetic-item',boardURL:board,boardId:'synthetic-board',itemId:'synthetic-item',status:'full',accountGeneration:'b'.repeat(64),...patch});
const miroRow=(patch={})=>row({sourceId:miro.id,revision:miro.revision,service:'miro',url:board,title:'Actual board title',documents:[miroDoc()],coverage:{complete:false,basis:'rest-api-text',pages:1,unsupportedItems:1},...patch});
function fakeIndexedDB(){
  const stores=new Map(),calls=[],connections=[],queue=[];let created=false,busy=false,nextFault,operationHook;
  function drain(){
    if(busy||!queue.length)return;busy=true;const tx=queue[0];tx.active=true;
    tx.data=new Map(tx.names.map(name=>[name,new Map([...stores.get(name)||[]].map(([key,value])=>[key,structuredClone(value)]))]));
    pump(tx);
  }
  function finish(tx,abort=false){
    if(tx.done)return;tx.done=true;
    if(!abort&&tx.mode==='readwrite')for(const [name,data] of tx.data)stores.set(name,data);
    queue.shift();busy=false;
    queueMicrotask(()=>{if(abort)tx.onabort?.({target:tx});else tx.oncomplete?.({target:tx});drain();});
  }
  function pump(tx){
    if(tx.done||!tx.active||tx.scheduled)return;tx.scheduled=true;
    queueMicrotask(()=>{
      tx.scheduled=false;if(tx.done)return;
      if(!tx.ops.length){finish(tx);return;}
      const {request,operation,name,key,value}=tx.ops.shift();
      try{
        if(nextFault&&(!nextFault.operation||nextFault.operation===operation)&&(!nextFault.name||nextFault.name===name)){
          const error=nextFault.error;nextFault=undefined;throw error;
        }
        const store=tx.data.get(name);if(!store)throw failure('Missing object store');
        if(operation==='get')request.result=structuredClone(store.get(key));
        else if(operation==='getAllKeys')request.result=[...store.keys()];
        else if(operation==='delete'){store.delete(key);request.result=undefined;}
        else {if(operation==='add'&&store.has(key))throw failure('ConstraintError');store.set(key,structuredClone(value));request.result=key;}
        operationHook?.({operation,name,key});request.onsuccess?.({target:request});pump(tx);
      }catch(error){request.error=tx.error=error;request.onerror?.({target:request});tx.onerror?.({target:tx});finish(tx,true);}
    });
  }
  function transaction(names,mode='readonly'){
    const tx={names:Array.isArray(names)?names:[names],mode,ops:[],active:false,done:false,scheduled:false,
      objectStore(name){return Object.fromEntries(['get','getAllKeys','add','put','delete'].map(operation=>[operation,(value,key)=>{
        if(tx.done)throw failure('TransactionInactiveError');
        const request={};tx.ops.push({request,operation,name,key:operation==='get'||operation==='delete'?value:key,value});if(tx.active)pump(tx);return request;
      }]));},
      abort(){if(tx.done)return;tx.error=failure('AbortError');finish(tx,true);},
    };
    calls.push(['transaction',tx.names,mode]);queue.push(tx);queueMicrotask(drain);return tx;
  }
  return {stores,calls,onOperation:handler=>{operationHook=handler;},
    failNext({operation,name,error=failure()}={}){nextFault={operation,name,error};},
    open(name,version){
      calls.push(['open',name,version]);const request={};
      queueMicrotask(()=>{
        const db={closed:false,createObjectStore(name){if(stores.has(name))throw failure('Duplicate store');stores.set(name,new Map());},transaction(names,mode){if(this.closed)throw failure('Database closed');return transaction(names,mode);},close(){this.closed=true;}};
        connections.push(db);request.result=db;if(!created){created=true;request.onupgradeneeded?.({target:request});}request.onsuccess?.({target:request});
      });return request;
    },
    versionChange(){for(const db of connections)if(!db.closed)db.onversionchange?.({target:db});},
  };
}

test('the knowledge scope guard verifies course/source/service IDs and exact Miro board/widget association',()=>{
  assert.equal(platformDocumentAllowed(doc(),git),true);assert.equal(platformDocumentAllowed(miroDoc(),miro),true);
  for(const patch of [{sourceId:'platform:'+'f'.repeat(32)},{projectId:'other'},{service:'mattermost'},{kind:'browser'},{url:repo+'-other/-/issues/1'},{url:repo+'/-/blob/main/.env'},{text:'x'.repeat(20001)},{id:'live:'+'a'.repeat(64)},{status:'complete'}])assert.equal(platformDocumentAllowed(doc(1,patch),git),false,JSON.stringify(patch).slice(0,200));
  for(const patch of [{boardURL:board+'other'},{boardId:'other-board'},{itemId:'other-item'},{url:board+'?moveToWidget=foreign'},{url:board+'?moveToWidget=synthetic-item&token=private'},{projectId:'other'}])assert.equal(platformDocumentAllowed(miroDoc(patch),miro),false);
  assert.equal(platformDocumentAllowed(doc(),{...git,id:'platform:'+'f'.repeat(32)}),false);
});

test('clean source rows project away credentials, raw HTML/audio/accounts and redact supported text metadata while retaining bounded actual board titles',()=>{
  const [clean]=cleanPlatformSources([row({password:'RAW_PASSWORD',cookies:'RAW_COOKIE',audio:'RAW_AUDIO',account:{token:'RAW_ACCOUNT'},title:'API Key: SECRET_TITLE',warnings:['authorization: SECRET_WARNING'],coverage:{complete:false,basis:'rest-api-text',account:'SECRET_COVERAGE'},documents:[doc(1,{title:'password: SECRET_DOC_TITLE',text:'API Key: SECRET_BODY\nhttps://example.test/?token=SECRET_QUERY&view=calendar',rawHTML:'RAW_HTML',audio:'RAW_AUDIO',account:{key:'RAW_KEY'}})]})]);
  assert.doesNotMatch(JSON.stringify(clean),/RAW_PASSWORD|RAW_COOKIE|RAW_AUDIO|RAW_ACCOUNT|SECRET_TITLE|SECRET_WARNING|SECRET_COVERAGE|SECRET_DOC_TITLE|SECRET_BODY|SECRET_QUERY|RAW_HTML|RAW_KEY/);assert.match(clean.documents[0].text,/token=ENTFERNT/);assert.equal(clean.documents[0].trust,'untrusted-source');
  assert.equal(cleanPlatformSources([miroRow()])[0].title,'Actual board title');assert.equal(cleanPlatformDocument(miroDoc(),miro).source,'Miro');
});

test('cache limits count every row and text character, reject duplicate sources/documents and never silently clip the accepted corpus',()=>{
  assert.throws(()=>cleanPlatformSources([row(),row()]),/Quellenstand/);assert.throws(()=>cleanPlatformSources([row({documents:[doc(),doc()]})]),/Doppelte/);
  const docs=Array.from({length:251},(_,i)=>doc(i+1,{text:'x'.repeat(20000)}));assert.throws(()=>cleanPlatformSources([row({documents:docs})]),/Textgrenze/);
  assert.throws(()=>cleanPlatformSources([row({documents:Array.from({length:5001},(_,i)=>doc(i+1,{text:''}))})]),/Quellenstand|Textgrenze/);
  assert.throws(()=>cleanPlatformSources(Array(101).fill(row())),/Zu viele/);
  for(const patch of [{revision:'stale'},{accountGeneration:'access-token-SECRET'},{fetchedAt:'2026-99-99T10:00:00Z'},{warnings:['x'.repeat(601)]},{coverage:{complete:'yes'}}])assert.throws(()=>cleanPlatformSources([row(patch)]));
  assert.equal(PLATFORM_STORAGE_LIMITS.characters,5000000);
  assert.equal(cleanPlatformSources([row({documents:Array.from({length:2001},(_,i)=>doc(i+1,{text:'Kleine Board-Aufgabe'}))})])[0].documents.length,2001,'Board description plus 2000 items fits the bounded cache');
});

test('persistence stays unopened until needed and retains only ciphertext plus one nonextractable AES-GCM-256 key across restart',async t=>{
  const database=fakeIndexedDB(),store=createPlatformSourceStore({indexedDB:database});t.after(()=>store.close());assert.deepEqual(database.calls,[]);assert.deepEqual(await store.load(),{rows:[],revision:0});
  assert.equal(await store.save([row(),miroRow()],{expectedRevision:0}),1);const key=database.stores.get('keys').get('aes'),meta=database.stores.get('meta').get('state');
  assert.equal(key.extractable,false);assert.equal(key.algorithm.name,'AES-GCM');assert.equal(key.algorithm.length,256);await assert.rejects(crypto.subtle.exportKey('raw',key));
  assert.deepEqual(Object.keys(meta).sort(),['cipher','iv','revision']);assert.doesNotMatch(Buffer.from(meta.cipher).toString(),/sourceId|Course repo|git\.coco/);
  for(const record of database.stores.get('rows').values()){assert.deepEqual(Object.keys(record).sort(),['cipher','iv']);assert.doesNotMatch(Buffer.from(record.cipher).toString(),/SYNTHETIC PRIVATE SOURCE|Actual board title|Miro/);}
  store.close();const reopened=createPlatformSourceStore({indexedDB:database});t.after(()=>reopened.close());const restored=await reopened.load();assert.equal(restored.revision,1);assert.deepEqual(restored.rows,cleanPlatformSources([row(),miroRow()]));
});

test('concurrent initial opens share a key and CAS allows one complete writer without overwriting the winner',async t=>{
  const database=fakeIndexedDB(),a=createPlatformSourceStore({indexedDB:database}),b=createPlatformSourceStore({indexedDB:database});t.after(()=>{a.close();b.close();});
  assert.deepEqual((await Promise.all([a.load(),b.load()])).map(value=>value.revision),[0,0]);assert.equal(database.stores.get('keys').size,1);
  const attempts=await Promise.allSettled([a.save([row()],{expectedRevision:0}),b.save([miroRow()],{expectedRevision:0})]);assert.equal(attempts.filter(value=>value.status==='fulfilled').length,1);assert.equal(attempts.find(value=>value.status==='rejected').reason.code,'REVISION_CONFLICT');
  const loaded=await a.load();assert.equal(loaded.revision,1);assert.equal(loaded.rows.length,1);assert.equal(database.stores.get('rows').size,1);
});

test('unchanged rows reuse ciphertext; changed rows get fresh IVs; clearing atomically removes provider texts while retaining the key',async t=>{
  const database=fakeIndexedDB(),store=createPlatformSourceStore({indexedDB:database});t.after(()=>store.close());await store.save([row()],{expectedRevision:0});const first=structuredClone(database.stores.get('rows').get(git.id)),firstMeta=structuredClone(database.stores.get('meta').get('state'));
  await store.save([row()],{expectedRevision:1});assert.deepEqual(database.stores.get('rows').get(git.id),first);assert.notDeepEqual(database.stores.get('meta').get('state').iv,firstMeta.iv);
  await store.save([row({documents:[doc(1,{text:'Updated task text'})]})],{expectedRevision:2});assert.notDeepEqual(database.stores.get('rows').get(git.id).iv,first.iv);assert.equal((await store.load()).rows[0].documents[0].text,'Updated task text');
  assert.equal(await store.clear({expectedRevision:3}),4);assert.equal(database.stores.get('rows').size,0);assert.equal(database.stores.get('keys').size,1);assert.deepEqual(await store.load(),{rows:[],revision:4});
});

test('missing/tampered/swapped/stale records, altered public revision and extractable keys fail visibly without empty-success fallback',async t=>{
  for(const mutation of ['missing','cipher','swap','rollback','revision','key']){
    const database=fakeIndexedDB(),store=createPlatformSourceStore({indexedDB:database});t.after(()=>store.close());await store.save([row(),miroRow()],{expectedRevision:0});const old=structuredClone(database.stores.get('rows').get(git.id));await store.save([row({documents:[doc(1,{text:'Changed source text'})]}),miroRow()],{expectedRevision:1});
    if(mutation==='missing')database.stores.get('rows').delete(git.id);if(mutation==='cipher')new Uint8Array(database.stores.get('rows').get(git.id).cipher)[0]^=1;if(mutation==='swap')database.stores.get('rows').set(git.id,database.stores.get('rows').get(miro.id));if(mutation==='rollback')database.stores.get('rows').set(git.id,old);if(mutation==='revision')database.stores.get('meta').get('state').revision=3;if(mutation==='key')database.stores.get('keys').set('aes',await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']));
    store.close();const next=createPlatformSourceStore({indexedDB:database});t.after(()=>next.close());await assert.rejects(next.load(),mutation);
  }
});

test('failed transactions and encryption leave the previous committed corpus and revision recoverable',async t=>{
  const database=fakeIndexedDB(),store=createPlatformSourceStore({indexedDB:database});t.after(()=>store.close());await store.save([row()],{expectedRevision:0});database.failNext({operation:'put',name:'meta'});await assert.rejects(store.save([miroRow()],{expectedRevision:1}),/konnten nicht gespeichert/);assert.equal((await store.load()).rows[0].sourceId,git.id);assert.equal((await store.load()).revision,1);
  const cryptoAPI={getRandomValues:array=>crypto.getRandomValues(array),subtle:{generateKey:(...args)=>crypto.subtle.generateKey(...args),digest:(...args)=>crypto.subtle.digest(...args),decrypt:(...args)=>crypto.subtle.decrypt(...args),encrypt:()=>Promise.reject(Error('Synthetic cipher failure'))}};
  const broken=createPlatformSourceStore({indexedDB:database,cryptoAPI});t.after(()=>broken.close());await assert.rejects(broken.save([miroRow()],{expectedRevision:1}),/cipher failure/);assert.equal((await store.load()).revision,1);assert.equal((await store.load()).rows[0].sourceId,git.id);
});

test('source/account/cancellation fences after cryptography stop stale writes before any provider row can be committed',async t=>{
  const database=fakeIndexedDB(),store=createPlatformSourceStore({indexedDB:database});t.after(()=>store.close());await store.save([row()],{expectedRevision:0});let resolve,entered,current=true;const gate=new Promise(r=>resolve=r),started=new Promise(r=>entered=r);
  const cryptoAPI={getRandomValues:array=>crypto.getRandomValues(array),subtle:{generateKey:(...args)=>crypto.subtle.generateKey(...args),digest:(...args)=>crypto.subtle.digest(...args),decrypt:(...args)=>crypto.subtle.decrypt(...args),encrypt:async(...args)=>{entered();await gate;return crypto.subtle.encrypt(...args);}}};
  const delayed=createPlatformSourceStore({indexedDB:database,cryptoAPI});t.after(()=>delayed.close());const pending=delayed.save([miroRow()],{expectedRevision:1,assertCurrent:()=>current});await started;current=false;resolve();await assert.rejects(pending,{name:'AbortError'});assert.equal((await store.load()).revision,1);assert.equal(database.stores.get('rows').has(miro.id),false);
  const controller=new AbortController();controller.abort();await assert.rejects(store.clear({expectedRevision:1,signal:controller.signal}),{name:'AbortError'});assert.equal((await store.load()).rows.length,1);
});

test('the final transaction guard aborts already queued puts atomically when the source epoch changes in the metadata-write callback',async t=>{
  const database=fakeIndexedDB(),store=createPlatformSourceStore({indexedDB:database});t.after(()=>store.close());await store.save([row()],{expectedRevision:0});let current=true,putReached=false;
  database.onOperation(({operation,name})=>{if(operation==='put'&&name==='meta'){putReached=true;current=false;}});
  await assert.rejects(store.save([miroRow()],{expectedRevision:1,assertCurrent:()=>current}),{name:'AbortError'});database.onOperation(undefined);assert.equal(putReached,true);
  assert.equal((await store.load()).revision,1);assert.equal((await store.load()).rows[0].sourceId,git.id);assert.equal(database.stores.get('rows').has(miro.id),false);
});

test('a live abort signal rolls back queued provider writes even when cancellation arrives at the last metadata write',async t=>{
  const database=fakeIndexedDB(),store=createPlatformSourceStore({indexedDB:database});t.after(()=>store.close());await store.save([row()],{expectedRevision:0});const controller=new AbortController();
  database.onOperation(({operation,name})=>{if(operation==='put'&&name==='meta')controller.abort();});await assert.rejects(store.save([miroRow()],{expectedRevision:1,signal:controller.signal}),{name:'AbortError'});database.onOperation(undefined);
  assert.equal((await store.load()).revision,1);assert.equal((await store.load()).rows[0].sourceId,git.id);
});

test('close aborts pending crypto work and unsupported storage never falls back to plaintext or silently accepts malformed CAS bookkeeping',async t=>{
  await assert.rejects(createPlatformSourceStore({indexedDB:null}).load(),/nicht verfügbar/);await assert.rejects(createPlatformSourceStore({indexedDB:fakeIndexedDB(),crypto:null}).load(),/nicht verfügbar/);
  const database=fakeIndexedDB(),store=createPlatformSourceStore({indexedDB:database});t.after(()=>store.close());for(const value of [undefined,-1,NaN,'0',Number.MAX_SAFE_INTEGER])await assert.rejects(store.save([],{expectedRevision:value}),/Speicherversion/);
  await store.save([row()],{expectedRevision:0});for(const value of [undefined,0,-1,'1']){const meta=database.stores.get('meta').get('state'),old=meta.revision;meta.revision=value;await assert.rejects(store.load(),/Speicherversion/);meta.revision=old;}
  let release,enter;const gate=new Promise(r=>release=r),started=new Promise(r=>enter=r),api={getRandomValues:array=>crypto.getRandomValues(array),subtle:{generateKey:(...args)=>crypto.subtle.generateKey(...args),digest:(...args)=>crypto.subtle.digest(...args),decrypt:(...args)=>crypto.subtle.decrypt(...args),encrypt:async(...args)=>{enter();await gate;return crypto.subtle.encrypt(...args);}}};
  const delayed=createPlatformSourceStore({indexedDB:database,cryptoAPI:api});t.after(()=>delayed.close());const saving=delayed.save([miroRow()],{expectedRevision:1});await started;delayed.close();release();await assert.rejects(saving,{name:'AbortError'});assert.equal((await store.load()).revision,1);
});

test('global source cache retains an empty course scope and cannot turn a global Miro link into trusted course knowledge',async t=>{
  const [source]=platformCatalog({projects:[],tools:[{id:'gitlab',url:repo}]}),globalDoc=doc(1,{sourceId:source.id,projectId:''}),globalRow=row({sourceId:source.id,revision:source.revision,projectId:'',documents:[globalDoc]});
  assert.equal(platformDocumentAllowed(globalDoc,source),true);assert.equal(platformDocumentAllowed(globalDoc,git),false);assert.equal(platformDocumentAllowed(doc(),source),false);assert.equal(cleanPlatformSources([globalRow])[0].projectId,'');
  const database=fakeIndexedDB(),store=createPlatformSourceStore({indexedDB:database});t.after(()=>store.close());await store.save([globalRow],{expectedRevision:0});assert.equal((await store.load()).rows[0].documents[0].targetId,'');assert.equal((await store.load()).rows[0].documents[0].projectId,'');
  assert.throws(()=>cleanPlatformSources([miroRow({projectId:'',documents:[miroDoc({projectId:''})]})]));
});
