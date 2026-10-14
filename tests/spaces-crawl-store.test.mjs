import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpacesCrawlStore,cleanCrawlSource,crawlSourcesForKnowledge,encryptCrawlSource,decryptCrawlSource,CRAWL_STORAGE_LIMITS} from '../dist/spaces-crawl-store.js';
import {emptyCrawlState} from '../dist/spaces-crawl.js';
import {buildKnowledge,searchKnowledge,DEFAULT_KNOWLEDGE} from '../dist/knowledge.js';
import {buildSearchDocuments} from '../dist/search-documents.js';
import {createSearchIndex} from '../dist/search-index.js';

const root='https://spaces.th-koeln.de/wp/synthetic-course/';
const identity=n=>'crawl:'+Number(n).toString(16).padStart(64,'0');
const document=(n=1,patch={})=>({id:identity(n),projectId:'synthetic-course',courseURL:root,url:root+'material/',title:'Synthetic course source',text:'SYNTHETIC PRIVATE SOURCE',status:'full',section:['Material'],updatedAt:'2026-10-14T10:00:00Z',postedBy:'Synthetic author',postedAt:'2026-10-13T09:00:00Z',...patch});
const snapshot=(ids=[],patch={})=>({version:1,state:emptyCrawlState(),sourceIds:ids,lastRun:'2026-10-14T10:00:00Z',...patch});
const workspace=(projects=[{id:'synthetic-course',name:'Synthetic course',links:[{tool:'spaces',url:root}]}])=>({projects,notes:[],tasks:[],calendarEvents:[],bookmarks:[],boardFindings:[],tools:[],devDiaries:[]});
const aes=()=>crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
const failure=message=>new Error(message||'Synthetic IndexedDB failure');

// Requests are asynchronous and transactions commit atomically. Writers are
// serialized across connections, matching IndexedDB's CAS/key-creation lease.
// A fault/abort rolls every write in that transaction back.
function fakeIndexedDB(){
  const stores=new Map(),calls=[],connections=[],queue=[];let created=false,busy=false,nextFault;
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
        request.onsuccess?.({target:request});pump(tx);
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
  return {stores,calls,
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

test('AES-GCM source roundtrip binds source ID/AAD, uses fresh IVs, and keeps every private field in ciphertext',async()=>{
  const key=await aes(),input=document(),one=await encryptCrawlSource(input,key),two=await encryptCrawlSource(input,key);
  assert.deepEqual(Object.keys(one).sort(),['cipher','iv']);assert.equal(one.iv.length,12);assert.notDeepEqual(one.iv,two.iv);assert.equal(key.extractable,false);await assert.rejects(crypto.subtle.exportKey('raw',key));
  assert.doesNotMatch(Buffer.from(one.cipher).toString(),/SYNTHETIC PRIVATE SOURCE|Synthetic course source|Synthetic author|spaces\.th-koeln/);
  assert.deepEqual(await decryptCrawlSource(one,input.id,key),cleanCrawlSource(input));
  await assert.rejects(decryptCrawlSource(one,identity(2),key));await assert.rejects(decryptCrawlSource(one,input.id,await aes()));
  const tampered={...one,cipher:one.cipher.slice(0)};new Uint8Array(tampered.cipher)[4]^=1;await assert.rejects(decryptCrawlSource(tampered,input.id,key));
  await assert.rejects(decryptCrawlSource({...one,iv:new Uint8Array(11)},input.id,key));await assert.rejects(decryptCrawlSource({...one,cipher:new ArrayBuffer(500001)},input.id,key));
});

test('valid encryption with an unrelated AAD or embedded different source ID is still rejected',async()=>{
  const key=await aes(),input=document(),iv=crypto.getRandomValues(new Uint8Array(12));
  const forged=async(value,aad)=>({iv,cipher:await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(aad)},key,new TextEncoder().encode(JSON.stringify(value)))});
  await assert.rejects(decryptCrawlSource(await forged(input,'context-spaces-meta-v1'),input.id,key));
  await assert.rejects(decryptCrawlSource(await forged({...input,id:identity(2)},'context-spaces-source-v1:'+input.id),input.id,key),/Quellenkennung/);
});

test('source validation projects unknown account/raw fields and enforces exact read-only Spaces scope',()=>{
  const clean=cleanCrawlSource(document(1,{kind:'mail',password:'must-not-copy',cookies:'must-not-copy',rawHTML:'must-not-copy',account:{token:'must-not-copy'},title:'API Key: synthetic-secret',text:'https://example.test/?token=secret&view=calendar',postedBy:'password: another-secret'}));
  assert.equal(clean.kind,'browser');assert.doesNotMatch(JSON.stringify(clean),/must-not-copy|synthetic-secret|another-secret|token=secret/);assert.match(clean.text,/token=ENTFERNT/);
  for(const patch of [{id:'crawl:'+ 'A'.repeat(64)},{id:'live:'+ 'a'.repeat(64)},{projectId:'bad\n-id'},{text:'x'.repeat(60001)},{courseURL:'https://spaces.th-koeln.de/'},{url:'https://foreign.example/material/'},{url:'https://spaces.th-koeln.de/wp/another-course/'},{url:root+'members/'},{url:root+'slides.pdf'},{url:root+'?token=private'},{url:'https://user:password@spaces.th-koeln.de/wp/synthetic-course/'}])assert.throws(()=>cleanCrawlSource(document(1,patch)));
});

test('source section metadata receives the same credential redaction as title, body, and author',()=>{
  const clean=cleanCrawlSource(document(1,{section:['API Key: synthetic-secret','https://example.test/?token=private&view=calendar']}));
  assert.doesNotMatch(JSON.stringify(clean.section),/synthetic-secret|token=private/);assert.match(clean.section[0],/entfernt/);
});

test('knowledge projection drops removed/archived/relinked/malformed courses and retains a bound current source only',()=>{
  const good=document(),documents=[good,document(2,{projectId:'missing'}),document(3,{projectId:'archived'}),document(4,{projectId:'relinked'}),document(5,{url:'https://foreign.example/'})],state=workspace([
    {id:'synthetic-course',links:[{tool:'spaces',url:root}]},{id:'archived',archived:true,links:[{tool:'spaces',url:root}]},{id:'relinked',links:[{tool:'spaces',url:'https://spaces.th-koeln.de/wp/new-course/'}]},
  ]);
  const projected=crawlSourcesForKnowledge(documents,state);assert.equal(projected.length,1);assert.equal(projected[0].id,good.id+':part0');assert.equal(projected[0].courseURL,root);assert.equal(projected[0].text,good.text);
  assert.deepEqual(crawlSourcesForKnowledge([good],workspace([])),[]);
});

test('bounded knowledge projection preserves overlap, the entire long source tail, and the 20M character ceiling',()=>{
  const text='Vorwort '.repeat(6200)+'Schlusserkenntnis für die letzte Kursseite.',long=document(1,{text}),parts=crawlSourcesForKnowledge([long],workspace());
  assert.ok(text.length>20000);assert.ok(parts.length>1);assert.ok(parts.every(part=>part.text.length<=12000&&part.status==='excerpt'));
  assert.equal(parts[0].text,text.slice(0,12000));assert.equal(parts[1].text,text.slice(11800,23800));assert.ok(parts.at(-1).text.endsWith('Schlusserkenntnis für die letzte Kursseite.'));
  const body='x'.repeat(60000),sources=Array.from({length:334},(_,i)=>document(i+1,{text:body}));
  const bounded=crawlSourcesForKnowledge(sources,workspace()),included=new Set(bounded.map(part=>part.id.replace(/:part\d+$/,'')));
  assert.equal(included.size,333);assert.ok(included.size*body.length<=CRAWL_STORAGE_LIMITS.characters);assert.ok(!included.has(sources[333].id));
  const sourceCap=crawlSourcesForKnowledge(Array.from({length:2001},(_,i)=>document(i+1,{text:''})),workspace());assert.equal(sourceCap.length,2000);
});

test('actual Knowledge and human Search collectors detect a >20k cached source tail while enforcing opt-out/course scope',()=>{
  const long=document(1,{text:'Vorwort '.repeat(6200)+'Schlusserkenntnis Kursfinale.'}),ws=workspace(),browserSources=crawlSourcesForKnowledge([long],ws);
  const knowledge=buildKnowledge(ws,[],{browserSources,projectId:'synthetic-course',maxDocuments:20000});
  const hits=searchKnowledge(knowledge,'schlusserkenntnis');assert.ok(hits.length>0,'accepted crawl parts must enter the actual knowledge index');assert.match(hits[0].text,/Schlusserkenntnis/);assert.equal(hits[0].projectId,'synthetic-course');
  assert.equal(buildKnowledge(ws,[],{browserSources,enabled:{...DEFAULT_KNOWLEDGE,browser:false}}).filter(item=>item.kind==='browser').length,0);
  const collection=buildSearchDocuments({workspace:ws,browserSources}),index=createSearchIndex();index.replace(collection.documents);assert.ok(index.search('schlusserkenntnis',{projectId:'synthetic-course'}).length>0);assert.equal(index.search('schlusserkenntnis',{projectId:'other'}).length,0);
});

test('actual storage persists only ciphertext and a nonexportable key, and restores the full source after restart',async t=>{
  const database=fakeIndexedDB(),store=createSpacesCrawlStore({indexedDB:database}),input=document();t.after(()=>store.close());
  assert.deepEqual(database.calls,[]);assert.equal((await store.load()).revision,0);
  const revision=await store.save(snapshot([input.id]),0,{source:input});assert.equal(revision,1);
  const key=database.stores.get('keys').get('aes'),meta=database.stores.get('meta').get('state'),source=database.stores.get('sources').get(input.id);
  assert.equal(key.extractable,false);assert.equal(key.algorithm.length,256);assert.deepEqual(Object.keys(meta).sort(),['cipher','iv','revision']);assert.deepEqual(Object.keys(source).sort(),['cipher','iv']);
  assert.doesNotMatch(Buffer.from(meta.cipher).toString(),/sourceIds|synthetic-course|spaces\.th-koeln/);assert.doesNotMatch(Buffer.from(source.cipher).toString(),/SYNTHETIC PRIVATE SOURCE/);
  store.close();const restarted=createSpacesCrawlStore({indexedDB:database});t.after(()=>restarted.close());const loaded=await restarted.load();assert.equal(loaded.revision,1);assert.deepEqual(loaded.documents,[cleanCrawlSource(input)]);assert.deepEqual(loaded.snapshot,snapshot([input.id]));
});

test('concurrent initial opens share one key and competing CAS writes preserve exactly one winner',async t=>{
  const database=fakeIndexedDB(),one=createSpacesCrawlStore({indexedDB:database}),two=createSpacesCrawlStore({indexedDB:database});t.after(()=>{one.close();two.close();});
  assert.deepEqual((await Promise.all([one.load(),two.load()])).map(result=>result.revision),[0,0]);assert.equal(database.stores.get('keys').size,1);
  const a=document(1),b=document(2),outcomes=await Promise.allSettled([one.save(snapshot([a.id]),0,{source:a}),two.save(snapshot([b.id]),0,{source:b})]);
  assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);assert.equal(outcomes.filter(item=>item.status==='rejected').length,1);assert.match(outcomes.find(item=>item.status==='rejected').reason.message,/anderer Tab/);
  const restored=await one.load();assert.equal(restored.revision,1);assert.equal(restored.documents.length,1);assert.deepEqual([...database.stores.get('sources').keys()],restored.snapshot.sourceIds);
});

test('a same-source replacement gets fresh IVs; deleting it removes the old ciphertext without changing the key',async t=>{
  const database=fakeIndexedDB(),store=createSpacesCrawlStore({indexedDB:database});t.after(()=>store.close());const input=document();await store.save(snapshot([input.id]),0,{source:input});
  const first=structuredClone(database.stores.get('sources').get(input.id)),key=database.stores.get('keys').get('aes');await store.save(snapshot([input.id]),1,{source:{...input,text:'Replacement course text'}});
  assert.notDeepEqual(first.iv,database.stores.get('sources').get(input.id).iv);assert.equal((await store.load()).documents[0].text,'Replacement course text');
  await store.save(snapshot(),2);assert.equal(database.stores.get('sources').size,0);assert.equal(database.stores.get('keys').get('aes'),key);assert.deepEqual((await store.load()).documents,[]);
});

test('transaction failure is explicit, atomic, and preserves the last committed source for restart',async t=>{
  const database=fakeIndexedDB(),store=createSpacesCrawlStore({indexedDB:database});t.after(()=>store.close());const a=document(1),b=document(2);await store.save(snapshot([a.id]),0,{source:a});
  database.failNext({operation:'put',name:'meta'});await assert.rejects(store.save(snapshot([b.id]),1,{source:b}),/konnten nicht gespeichert/);
  store.close();const next=createSpacesCrawlStore({indexedDB:database});t.after(()=>next.close());const loaded=await next.load();assert.equal(loaded.revision,1);assert.equal(loaded.documents[0].id,a.id);assert.equal(database.stores.get('sources').has(b.id),false);
  assert.equal(await next.save(snapshot([a.id,b.id]),1,{source:b}),2);assert.equal((await next.load()).documents.length,2);
});

test('missing, corrupt, swapped-source, wrong-AAD and unusable-key cache failures never return an empty success',async t=>{
  for(const mutation of ['missing','tamper-meta','tamper-source','swap-source','wrong-aad','extractable-key']){
    const database=fakeIndexedDB(),store=createSpacesCrawlStore({indexedDB:database});t.after(()=>store.close());const input=document();await store.save(snapshot([input.id]),0,{source:input});
    if(mutation==='missing')database.stores.get('sources').delete(input.id);
    if(mutation==='tamper-meta')new Uint8Array(database.stores.get('meta').get('state').cipher)[0]^=1;
    if(mutation==='tamper-source')new Uint8Array(database.stores.get('sources').get(input.id).cipher)[0]^=1;
    if(mutation==='swap-source')database.stores.get('sources').set(input.id,await encryptCrawlSource(document(2),database.stores.get('keys').get('aes')));
    if(mutation==='wrong-aad')database.stores.get('meta').set('state',{...database.stores.get('sources').get(input.id),revision:1});
    if(mutation==='extractable-key')database.stores.get('keys').set('aes',await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']));
    store.close();const reopened=createSpacesCrawlStore({indexedDB:database});t.after(()=>reopened.close());await assert.rejects(reopened.load(),mutation);
  }
});

test('unsupported storage and temporary open/read failure remain explicit and can be retried',async t=>{
  await assert.rejects(createSpacesCrawlStore({indexedDB:null}).load(),/nicht verfügbar/);await assert.rejects(createSpacesCrawlStore({indexedDB:null}).save(snapshot(),0),/nicht verfügbar/);
  await assert.rejects(createSpacesCrawlStore({indexedDB:fakeIndexedDB(),cryptoAPI:null}).load(),/nicht verfügbar/);
  let unavailable=true;const database=fakeIndexedDB(),store=createSpacesCrawlStore({indexedDB:{open(...args){if(unavailable)throw failure('Synthetic unavailable storage');return database.open(...args);}}});t.after(()=>store.close());
  await assert.rejects(store.load(),/Synthetic unavailable/);unavailable=false;assert.equal((await store.load()).revision,0);
  database.failNext({operation:'get',name:'meta'});await assert.rejects(store.load());assert.equal((await store.load()).revision,0);
});

test('an encryption failure never advances revision, erases the previous source, or falls back to plaintext',async t=>{
  const database=fakeIndexedDB(),initial=createSpacesCrawlStore({indexedDB:database}),input=document();t.after(()=>initial.close());await initial.save(snapshot([input.id]),0,{source:input});initial.close();
  const cryptoAPI={getRandomValues:crypto.getRandomValues.bind(crypto),subtle:{decrypt:crypto.subtle.decrypt.bind(crypto.subtle),generateKey:crypto.subtle.generateKey.bind(crypto.subtle),encrypt:()=>Promise.reject(failure('Synthetic unavailable cipher'))}},broken=createSpacesCrawlStore({indexedDB:database,cryptoAPI});t.after(()=>broken.close());
  assert.equal((await broken.load()).revision,1);await assert.rejects(broken.save(snapshot(),1),/unavailable cipher/);assert.equal((await broken.load()).documents[0].id,input.id);assert.equal(database.stores.get('meta').get('state').revision,1);assert.deepEqual(Object.keys(database.stores.get('sources').get(input.id)).sort(),['cipher','iv']);
});

test('malformed snapshot fields cannot silently turn an existing corpus into an empty cache',async t=>{
  const database=fakeIndexedDB(),store=createSpacesCrawlStore({indexedDB:database});t.after(()=>store.close());const input=document();await store.save(snapshot([input.id]),0,{source:input});
  for(const patch of [{sourceIds:false},{sourceIds:null},{state:false},{state:null},{sourceIds:[input.id,input.id]},{state:{version:1,cursor:0,sessions:[{projectId:'synthetic-course',root,queue:[],seen:[{url:root+'not-observed/',controls:[],section:[],title:'Disconnected child',offeredBy:'',sourceId:input.id,length:input.text.length,status:'full'}],failed:[],limits:[]}]}}])await assert.rejects(store.save(snapshot([input.id],patch),1));
  const loaded=await store.load();assert.equal(loaded.revision,1);assert.equal(loaded.documents[0].id,input.id);
});

test('saved source lists cannot exceed the text ceiling and become unreadable on the next restart',async t=>{
  const database=fakeIndexedDB(),store=createSpacesCrawlStore({indexedDB:database});t.after(()=>store.close());const ids=[];let revision=0;
  const body='x'.repeat(60000);
  for(let i=1;i<=333;i++){const input=document(i,{text:body});ids.push(input.id);revision=await store.save(snapshot([...ids]),revision,{source:input});}
  const overflowing=document(334,{text:body});await assert.rejects(store.save(snapshot([...ids,overflowing.id]),revision,{source:overflowing}),/Textgrenze|Textlimit|Textgrenz|Textmenge/);
  const restored=await store.load();assert.equal(restored.revision,333);assert.equal(restored.documents.length,333);
});

test('malformed public revision bookkeeping is rejected at load instead of silently resetting the CAS lease',async t=>{
  for(const revision of [undefined,null,-1,0,NaN,'1',Number.MAX_SAFE_INTEGER+1]){
    const database=fakeIndexedDB(),store=createSpacesCrawlStore({indexedDB:database});t.after(()=>store.close());const input=document();await store.save(snapshot([input.id]),0,{source:input});
    database.stores.get('meta').get('state').revision=revision;store.close();const reopened=createSpacesCrawlStore({indexedDB:database});t.after(()=>reopened.close());await assert.rejects(reopened.load(),'invalid public revision must not be returned as a valid current snapshot');
  }
});

test('a version-change close reopens existing data without rotating the source key',async t=>{
  const database=fakeIndexedDB(),store=createSpacesCrawlStore({indexedDB:database});t.after(()=>store.close());const input=document();await store.save(snapshot([input.id]),0,{source:input});database.versionChange();
  assert.equal((await store.load()).documents[0].id,input.id);assert.equal(database.calls.filter(call=>call[0]==='open').length,2);
});

test('a valid large navigation graph cannot be committed beyond the metadata size accepted by restart',async t=>{
  const database=fakeIndexedDB(),store=createSpacesCrawlStore({indexedDB:database});t.after(()=>store.close());const ids=[],sessions=[],controls=Array.from({length:8},(_,i)=>'accordion-item-'+String(i)+'a'.repeat(79)),section=Array(8).fill('s'.repeat(160));let revision=0;
  for(let i=0;i<4;i++){
    const courseURL='https://spaces.th-koeln.de/wp/large-synthetic-'+i+'/'+'a'.repeat(1800)+'/',source=document(i+1,{projectId:'large-'+i,courseURL,url:courseURL,text:''});
    ids.push(source.id);revision=await store.save(snapshot([...ids]),revision,{source});
    const rootJob={url:courseURL,controls:[],section:[],title:'Synthetic root',offeredBy:'',sourceId:source.id,length:0,status:'full'},offeredBy=JSON.stringify([courseURL,[]]);
    sessions.push({projectId:source.projectId,root:courseURL,seen:[rootJob],queue:Array.from({length:499},(_,j)=>({url:courseURL+'child-'+j+'/',controls,section,title:'t'.repeat(200),offeredBy,attempts:0})),failed:[],limits:[]});
  }
  const large=snapshot(ids,{state:{version:1,cursor:0,sessions}});assert.ok(Buffer.byteLength(JSON.stringify(large))>12_000_000);
  await assert.rejects(store.save(large,revision),/Speicher|Metadaten|Größe|Grenze/);
  const restored=await store.load();assert.equal(restored.revision,4);assert.equal(restored.documents.length,4);
});
