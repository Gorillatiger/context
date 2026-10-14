import test from 'node:test';
import assert from 'node:assert/strict';
import {createSearchIndex,normalizeSearch,SEARCH_LIMITS,searchIndexDocuments} from '../dist/search-index.js';
import {createSearchClient} from '../dist/search-client.js';
import {createSearchWorkerController,encryptSearchSnapshot,decryptSearchSnapshot,createEncryptedSearchStorage} from '../dist/search-worker.js';

const doc=(id,text='',extra={})=>({id,kind:'notes',title:'Lokaler Beleg',text,projectId:'alpha',source:'context',targetId:id,...extra});
const ids=results=>results.map(result=>result.id);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function replaceGlobal(t,key,value){const descriptor=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>{if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});}

test('German normalization and excerpts preserve exact original UTF-16 positions across accents, decomposed marks and emoji',()=>{
  assert.equal(normalizeSearch('ÄÖÜ Straße STRAẞE'),'aou strasse strasse');
  const original='😀'.repeat(90)+'\nVorwort '.repeat(90)+'Mu\u0308ller trifft die Straße bei der ABGÄBE.';
  const index=createSearchIndex();index.replace([doc('unicode',original)]);
  for(const query of ['muller','strasse','abgabe']){
    const result=index.search(query,{excerptLength:90})[0];assert.equal(result.text,original.slice(result.excerptOffset,result.excerptOffset+result.text.length));assert.ok(result.excerptOffset>0);assert.equal(result.truncated,true);
    assert.ok(result.matchedRanges.length);for(const range of result.matchedRanges){assert.ok(range.start>=result.excerptOffset);assert.match(normalizeSearch(original.slice(range.start,range.end)),new RegExp(query));}
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(result.text));
  }
});

test('title-focused BM25 ranks a precise title above repetitive broad text and keeps deterministic ties',()=>{
  const index=createSearchIndex();index.replace([doc('body','Architektur '.repeat(500)),doc('title','Eine kompakte Notiz.',{title:'Architektur'}),doc('tie-b','Gleiches Stichwort'),doc('tie-a','Gleiches Stichwort')]);
  assert.deepEqual(ids(index.search('architektur')),['title','body']);assert.deepEqual(ids(index.search('stichwort')),['tie-a','tie-b']);assert.ok(index.search('architektur')[0].score>0);
});

test('AND and quoted-phrase preference fall back only to actual matching terms',()=>{
  const index=createSearchIndex();index.replace([doc('one','Kalender'),doc('two','Quellen'),doc('and','Kalender und viele Quellen'),doc('phrase','Kalender Quellen kompakt')]);
  assert.deepEqual(new Set(ids(index.search('kalender quellen'))),new Set(['and','phrase']));assert.deepEqual(ids(index.search('"Kalender Quellen"')),['phrase']);assert.equal(index.stats().lastSearch.mode,'phrase');
  assert.ok(index.search('kalender unmöglicheswort').every(result=>['one','and','phrase'].includes(result.id)));assert.equal(index.stats().lastSearch.mode,'or');
  assert.deepEqual(index.search('vollkommenunbekannt'),[]);assert.deepEqual(ids(index.search('',{limit:2})),['one','two']);
});

test('all 500 ranked matches remain reachable through bounded pages with exact totals and no duplicates',()=>{
  const documents=Array.from({length:500},(_,i)=>doc('paged-'+String(i).padStart(4,'0'),'😀 Vorwort. Gemeinsam recherchieren und dokumentieren.',{title:'Gemeinsame Recherche',offset:100+i}));
  const index=createSearchIndex();index.replace(documents);const found=[];
  for(let offset=0;offset<documents.length;offset+=24){
    const page=index.search('recherche',{limit:24,offset,excerptLength:80}),last=index.stats().lastSearch;
    assert.equal(last.totalMatches,500);assert.equal(last.offset,offset);assert.equal(last.returned,page.length);assert.ok(page.length<=24);
    for(const item of page){assert.equal(item.offset,100+Number(item.id.slice(-4)),'the source document offset is independent of pagination');found.push(item.id);}
  }
  assert.equal(found.length,500);assert.equal(new Set(found).size,500);assert.deepEqual(found,documents.map(item=>item.id));
  assert.deepEqual(ids(index.search('recherche',{limit:24,offset:24})),found.slice(24,48));
  assert.deepEqual(index.search('recherche',{limit:24,offset:500}),[]);assert.equal(index.stats().lastSearch.totalMatches,500);assert.equal(index.stats().lastSearch.returned,0);
});

test('pagination totals describe only the filtered phrase/AND/OR ranked result set',()=>{
  const documents=Array.from({length:500},(_,i)=>doc('scoped-'+String(i).padStart(4,'0'),i<120?'Wichtige Abgabe':i<300?'Wichtige ausführliche Abgabe':'Wichtige Erkenntnisse',{projectId:i%2?'beta':'alpha',kind:i%5?'notes':'tasks',source:i%3?'context':'gmail'}));
  const index=createSearchIndex();index.replace(documents);
  index.search('"wichtige abgabe"',{limit:24,offset:24});assert.equal(index.stats().lastSearch.mode,'phrase');assert.equal(index.stats().lastSearch.totalMatches,120);
  index.search('wichtige abgabe',{limit:24,offset:24});assert.equal(index.stats().lastSearch.mode,'and');assert.equal(index.stats().lastSearch.totalMatches,300);
  index.search('wichtige zqyxwunbekannt',{limit:24,offset:24});assert.equal(index.stats().lastSearch.mode,'or');assert.equal(index.stats().lastSearch.totalMatches,500);
  const options={projectId:'alpha',kinds:['notes'],sources:['context'],limit:24},expected=documents.filter(item=>item.projectId==='alpha'&&item.kind==='notes'&&item.source==='context'),found=[];
  for(let offset=0;offset<expected.length;offset+=24){const page=index.search('wichtige',{...options,offset});assert.equal(index.stats().lastSearch.totalMatches,expected.length);found.push(...ids(page));}
  assert.deepEqual(new Set(found),new Set(expected.map(item=>item.id)));
  index.search('wichtige',{offset:24,kinds:[]});assert.equal(index.stats().lastSearch.totalMatches,0);assert.equal(index.stats().lastSearch.offset,24);assert.equal(index.stats().lastSearch.returned,0);
});

test('offset is bounded and integer-normalized; blank queries and clear publish truthful pagination stats',()=>{
  const index=createSearchIndex();index.replace(Array.from({length:60},(_,i)=>doc('item-'+String(i).padStart(3,'0'),'Beleg')));
  for(const offset of [undefined,-100,NaN,Infinity,'24',{}]){assert.equal(index.search('',{offset,limit:24})[0].id,'item-000');assert.equal(index.stats().lastSearch.offset,0);}
  assert.equal(index.search('',{offset:24.9,limit:24})[0].id,'item-024');assert.equal(index.stats().lastSearch.offset,24);assert.equal(index.stats().lastSearch.totalMatches,60);
  assert.deepEqual(index.search('',{offset:1e12}),[]);assert.equal(index.stats().lastSearch.offset,SEARCH_LIMITS.documents);assert.equal(index.stats().lastSearch.totalMatches,60);
  const clean=index.clear().lastSearch;assert.equal(clean.totalMatches,0);assert.equal(clean.offset,0);assert.equal(clean.returned,0);
});

test('a quoted phrase excerpt centers the actual deep phrase rather than an earlier scattered word',()=>{
  const original='Wichtige Vorbemerkung. '+('😀 Unabhängiger Absatz. '.repeat(100))+'Wichtige Abgabe am Freitag.';
  const index=createSearchIndex();index.replace([doc('deep',original)]);const result=index.search('"wichtige abgabe"',{excerptLength:100})[0];
  assert.ok(result.excerptOffset>1000);assert.match(result.text,/Wichtige Abgabe/);assert.equal(result.text,original.slice(result.excerptOffset,result.excerptOffset+result.text.length));
});

test('prefixes and bounded adjacent-letter typo correction find genuine matches without inventing unknown hits',()=>{
  const index=createSearchIndex();index.replace([doc('prototype','Der Prototyp'),doc('documentation','Abgabe Dokumentation'),doc('irrelevant','Material')]);
  assert.deepEqual(ids(index.search('prototy')),['prototype']);assert.deepEqual(ids(index.search('dokuemntation')),['documentation']);assert.deepEqual(ids(index.search('qzxxyzz')),[]);
  const expanded=Array.from({length:70},(_,i)=>doc('prefix-'+i,'Kalenderwort'+String(i).padStart(3,'0')));index.replace(expanded);assert.ok(index.search('kalenderwo').length>0);assert.equal(index.stats().lastSearch.expansionTruncated,true);
});

test('course, kind and source filters operate before ranking and preserve opt-out empty lists',()=>{
  const index=createSearchIndex(),selected=[doc('alpha-note','Beleg',{title:'Kalender'}),doc('alpha-task','Kalender',{kind:'tasks',source:'spaces'}),doc('personal','Kalender',{projectId:''})];
  index.replace(selected);const score=index.search('kalender',{projectId:'alpha',kinds:['notes'],sources:['context']})[0].score;
  index.replace([...selected,...Array.from({length:300},(_,i)=>doc('foreign-'+i,'Kalender '.repeat(30),{projectId:'beta',title:'Kalender Kalender Kalender',source:'gmail'}))]);
  const result=index.search('kalender',{projectId:'alpha',kinds:['notes'],sources:['context']});assert.deepEqual(ids(result),['alpha-note']);assert.equal(result[0].score,score,'excluded courses must not skew the selected ranking corpus');
  assert.deepEqual(ids(index.search('kalender',{projectId:'alpha',kinds:['tasks'],sources:['spaces']})),['alpha-task']);assert.deepEqual(index.search('kalender',{kinds:[]}),[]);assert.deepEqual(index.search('kalender',{sources:[]}),[]);assert.deepEqual(index.search('kalender',{projectId:'deleted'}),[]);
});

test('replacement incrementally invalidates changed and removed text, metadata and title without retaining old postings',()=>{
  const index=createSearchIndex(),first=[doc('a','Alter Inhalt'),doc('b','Einmalreferenz')];const initial=index.replace(first);
  const same=index.replace(first.map(value=>({...value})));assert.equal(same.revision,initial.revision);assert.deepEqual(same.lastDiff,{added:0,updated:0,removed:0,unchanged:2});
  const next=index.replace([doc('a','Neuer Text',{projectId:'beta',source:'spaces',title:'Überarbeitet'}),doc('c','Frische Dokumentation')]);assert.deepEqual(next.lastDiff,{added:1,updated:1,removed:1,unchanged:0});
  assert.deepEqual(index.search('alter'),[]);assert.deepEqual(index.search('einmalreferenz'),[]);assert.deepEqual(index.search('neuer',{projectId:'alpha'}),[]);assert.deepEqual(ids(index.search('neuer',{projectId:'beta',sources:['spaces']})),['a']);assert.deepEqual(ids(index.search('überarbeitet')),['a']);
});

test('repeated searches never revisit getters on irrelevant caller documents or mutate input/output records',()=>{
  let reads=0;const ignored=Array.from({length:1400},(_,i)=>({id:'other-'+i,kind:'notes',title:'Andere Quelle',get text(){reads++;return 'Irrelevant';},projectId:'beta'}));
  const input=Object.freeze(doc('hit','Gesuchter Prototyp',{route:Object.freeze({type:'note',id:'original'})})),index=createSearchIndex();index.replace([input,...ignored]);reads=0;
  const result=index.search('prototyp',{projectId:'alpha'})[0];result.title='Changed output';result.route.id='tampered';
  assert.equal(index.search('prototyp',{projectId:'alpha'})[0].title,input.title);assert.equal(index.search('prototyp',{projectId:'alpha'})[0].route.id,'original');assert.equal(reads,0);
});

test('private routing targets, account objects, keys and unknown document properties never enter indexed snapshots',()=>{
  const index=createSearchIndex();index.replace([doc('mail:opaque','Synthetische Nachricht',{kind:'mail',source:'gmail',route:{type:'mail',id:'opaque',target:{accountKey:'must-not-copy',uid:'private-uid'}},password:'must-not-copy',account:{token:'must-not-copy'}})]);
  const result=index.search('nachricht')[0];assert.deepEqual(result.route,{type:'mail',id:'opaque'});assert.ok(!JSON.stringify(result).includes('must-not-copy'));assert.ok(!JSON.stringify(searchIndexDocuments(index)).includes('private-uid'));
});

test('document, text, query and result limits report omissions and truncation instead of claiming complete coverage',()=>{
  const index=createSearchIndex();const docs=Array.from({length:SEARCH_LIMITS.documents+2},(_,i)=>doc('bounded-'+i,'Beleg'));
  const stats=index.replace(docs);assert.equal(stats.documents,SEARCH_LIMITS.documents);assert.equal(stats.omitted,2);assert.ok(stats.estimatedBytes>0);
  const result=index.search('beleg',{limit:999,excerptLength:99999});assert.equal(result.length,SEARCH_LIMITS.results);assert.ok(result.every(r=>r.text.length<=SEARCH_LIMITS.excerpt));
  assert.equal(index.search('beleg',{limit:24,offset:19992}).length,8);assert.equal(index.stats().lastSearch.totalMatches,20000);assert.equal(index.stats().lastSearch.returned,8);assert.equal(index.search('beleg',{limit:24,offset:20000}).length,0);
  index.replace([doc('long','Wort '.repeat(15000))]);assert.equal(index.stats().truncated,1);assert.equal(index.stats().indexedCharacters,SEARCH_LIMITS.text);assert.equal(index.search('wort')[0].truncated,true);
  index.search('wort '.repeat(200));assert.equal(index.stats().lastSearch.queryTruncated,true);
});

test('storage bounds never split an original surrogate pair while reporting the omitted tail',()=>{
  const original='x'.repeat(SEARCH_LIMITS.text-1)+'😀 Weiterer Beleg',index=createSearchIndex();index.replace([doc('bounded-emoji',original,{title:'Kamera'})]);
  const retained=searchIndexDocuments(index)[0];assert.equal(retained.text,original.slice(0,SEARCH_LIMITS.text-1));assert.equal(index.stats().truncated,1);assert.equal(index.search('kamera')[0].truncated,true);
});

test('invalid documents and duplicates are omitted, malformed filters fail visibly, clear releases postings and categories',()=>{
  const index=createSearchIndex();const stats=index.replace([doc('a','Suchwort'),doc('a','Duplicate'),null,{id:'invalid'},doc('bad-id\n','Bad')]);assert.equal(stats.documents,1);assert.equal(stats.omitted,4);
  assert.throws(()=>index.replace(null));assert.throws(()=>index.search(5));assert.throws(()=>index.search('a',{kinds:{notes:true}}));assert.throws(()=>index.search('a',{sources:['x'.repeat(161)]}));
  index.clear();assert.equal(index.stats().documents,0);assert.equal(index.stats().terms,0);assert.equal(index.stats().postings,0);assert.equal(index.stats().estimatedBytes,0);assert.deepEqual(index.search('suchwort'),[]);
});

test('pre-aborted and live abort signals stop search before returning any result',()=>{
  const index=createSearchIndex();index.replace([doc('a','Quelle')]);const controller=new AbortController();controller.abort();assert.throws(()=>index.search('quelle',{signal:controller.signal}),{name:'AbortError'});
  let reads=0;assert.throws(()=>index.search('quelle',{signal:{get aborted(){return ++reads>=2;}}}),{name:'AbortError'});
});

test('AES-GCM cache contains no readable document payload, uses fresh IVs, and rejects tampering or a different key',async()=>{
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),documents=[doc('a','SYNTHETIC PRIVATE CONTENT',{route:{type:'note',id:'note'}})];
  const first=await encryptSearchSnapshot(documents,key),second=await encryptSearchSnapshot(documents,key);assert.deepEqual(Object.keys(first).sort(),['cipher','iv','version']);assert.equal(first.iv.length,12);assert.notDeepEqual(first.iv,second.iv);assert.ok(!Buffer.from(first.cipher).toString().includes('SYNTHETIC PRIVATE CONTENT'));assert.equal(key.extractable,false);
  const restored=await decryptSearchSnapshot(first,key);assert.equal(restored[0].text,documents[0].text);assert.deepEqual(restored[0].route,documents[0].route);
  const corrupt={...first,cipher:first.cipher.slice(0)};new Uint8Array(corrupt.cipher)[0]^=1;await assert.rejects(decryptSearchSnapshot(corrupt,key));
  const other=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);await assert.rejects(decryptSearchSnapshot(first,other));await assert.rejects(decryptSearchSnapshot({...first,version:2},key));
});

test('worker never reads or writes persistent storage before opt-in, and current snapshots cannot resurrect a cached deleted course',async()=>{
  const posts=[],calls=[],storage={async read(){calls.push('read');return [doc('old','Alte private Quelle',{projectId:'deleted'})];},async write(docs){calls.push(['write',docs.map(d=>d.id)]);},async remove(){calls.push('remove');},close(){calls.push('close');}};
  const worker=createSearchWorkerController({post:m=>posts.push(m),storage});await worker.receive({id:'1',op:'replace',documents:[doc('new','Aktuell')]});await worker.receive({id:'2',op:'search',query:'aktuell'});assert.deepEqual(calls,[]);assert.equal(worker.stats().persistence.enabled,false);
  await worker.receive({id:'3',op:'optPersist',enabled:true});assert.deepEqual(calls,[['write',['new']]]);assert.equal(worker.stats().persistence.state,'stored');
  await worker.receive({id:'4',op:'clear'});assert.deepEqual(calls.at(-1),['write',[]]);assert.equal(worker.stats().documents,0);
  await worker.receive({id:'5',op:'optPersist',enabled:false});assert.equal(calls.at(-1),'remove');assert.equal(worker.stats().persistence.state,'off');worker.dispose();
});

test('explicit first opt-in can restore an encrypted cache, queued cancellation drops requests, and storage errors keep RAM search usable',async()=>{
  const posts=[],storage={async read(){return [doc('restored','Gespeicherter Prototyp')];},async write(){throw new Error('Synthetischer Speicherfehler');},async remove(){},close(){}};
  const worker=createSearchWorkerController({post:m=>posts.push(m),storage});await worker.receive({id:'opt',op:'optPersist',enabled:true});assert.equal(posts.find(p=>p.id==='opt').type,'error');assert.equal(worker.stats().persistence.state,'error');
  await worker.receive({id:'search',op:'search',query:'prototyp'});assert.deepEqual(ids(posts.find(p=>p.id==='search').result),['restored']);
  const queued=worker.receive({id:'cancelled',op:'search',query:'prototyp'});await worker.receive({id:'cancelled',op:'cancel'});await queued;assert.equal(posts.find(p=>p.id==='cancelled').name,'AbortError');worker.dispose();
});

test('the actual storage factory performs no IndexedDB open before an explicit read or write',async()=>{
  let calls=0;const storage=createEncryptedSearchStorage({indexedDB:{open(){calls++;throw new Error('Fake database unavailable');}},cryptoAPI:crypto});assert.equal(calls,0);storage.close();assert.equal(calls,0);await assert.rejects(storage.read(),/Fake database/);assert.equal(calls,1);
});

function fakeIndexedDB(){
  const stores=new Map(),connections=[],calls=[];let created=false;
  const pending=result=>{const req={result};queueMicrotask(()=>req.onsuccess?.({target:req}));return req;};
  return {stores,calls,
    open(name){calls.push(['open',name]);const req={};queueMicrotask(()=>{
      const db={closed:false,createObjectStore(key){stores.set(key,new Map());},close(){this.closed=true;},transaction(key){
        const tx={objectStore(storeName){const store=stores.get(storeName);return {get(key){return pending(structuredClone(store.get(key)));},add(value,key){assert.ok(!store.has(key));store.set(key,structuredClone(value));return pending(key);},put(value,key){store.set(key,structuredClone(value));return pending(key);}};}};
        setTimeout(()=>tx.oncomplete?.(),0);return tx;
      }};
      connections.push(db);req.result=db;if(!created){created=true;req.onupgradeneeded?.();}req.onsuccess?.({target:req});
    });return req;},
    deleteDatabase(name){calls.push(['delete',name]);for(const connection of connections)if(!connection.closed)connection.onversionchange?.();stores.clear();created=false;return pending(undefined);},
  };
}

test('actual IndexedDB storage writes only a nonexportable key and ciphertext, restores correctly and deletes both on opt-out',async()=>{
  const database=fakeIndexedDB(),storage=createEncryptedSearchStorage({indexedDB:database,cryptoAPI:crypto});
  assert.deepEqual(database.calls,[]);await storage.write([doc('stored','SYNTHETIC PRIVATE MESSAGE',{route:{type:'mail',id:'opaque'}})]);
  const row=database.stores.get('index').get('snapshot'),key=database.stores.get('keys').get('aes');assert.deepEqual(Object.keys(row).sort(),['cipher','iv','version']);assert.equal(key.extractable,false);await assert.rejects(crypto.subtle.exportKey('raw',key));
  assert.ok(!Buffer.from(row.cipher).toString().includes('SYNTHETIC PRIVATE MESSAGE'));assert.equal((await storage.read())[0].text,'SYNTHETIC PRIVATE MESSAGE');
  const second=createEncryptedSearchStorage({indexedDB:database,cryptoAPI:crypto});assert.equal((await second.read())[0].route.id,'opaque');
  await storage.remove();assert.equal(database.stores.size,0);assert.equal(database.calls.at(-1)[0],'delete');storage.close();second.close();
});

function workerFixture(t,{storage:provided}={}){
  const instances=[],storage=provided||{async read(){return null;},async write(){},async remove(){},close(){}};
  class Worker{
    constructor(url,options){this.url=url;this.options=options;this.messages=[];this.controller=createSearchWorkerController({storage,post:message=>queueMicrotask(()=>this.onmessage?.({data:structuredClone(message)}))});instances.push(this);}
    postMessage(message){this.messages.push(structuredClone(message));void this.controller.receive(structuredClone(message));}
    terminate(){this.terminated=true;this.controller.dispose();}
  }
  replaceGlobal(t,'Worker',Worker);replaceGlobal(t,'location',{origin:'null'});return instances;
}

test('client uses a fixed same-origin module worker and reports only acknowledged snapshots',async t=>{
  const workers=workerFixture(t),status=[],client=createSearchClient({onStatus:s=>status.push(s)});t.after(()=>client.dispose());
  const pending=client.replace([doc('a','Lokaler Kalender',{route:{type:'mail',id:'safe',target:{token:'not-in-worker'}}})]);assert.equal(client.stats().documents,0);await pending;assert.equal(client.stats().documents,1);
  assert.equal(workers[0].url.pathname.endsWith('/dist/search-worker.js'),true);assert.equal(workers[0].options.type,'module');assert.ok(!JSON.stringify(workers[0].messages).includes('not-in-worker'));assert.deepEqual(ids(await client.search('kalender')),['a']);assert.equal(client.stats().persistence.enabled,false);assert.ok(status.some(s=>s.status==='indexing'));assert.ok(status.some(s=>s.status==='ready'));
  await client.optPersist(true);assert.equal(client.stats().persistence.state,'stored');await client.optPersist(false);assert.equal(client.stats().persistence.state,'off');await client.clear();assert.equal(client.stats().documents,0);
});

test('the actual client/worker transport preserves offsets and confirmed totals for 500 local documents',async t=>{
  replaceGlobal(t,'localStorage',{getItem:()=>null});const workers=workerFixture(t),client=createSearchClient();t.after(()=>client.dispose());
  const documents=Array.from({length:500},(_,i)=>doc('worker-page-'+String(i).padStart(3,'0'),'Gemeinsamer Beleg'));await client.replace(documents);
  const page=await client.search('beleg',{limit:24,offset:480,credential:'must-not-cross'});
  assert.equal(page.length,20);assert.equal(page[0].id,'worker-page-480');assert.equal(client.stats().lastSearch.totalMatches,500);assert.equal(client.stats().lastSearch.offset,480);assert.equal(client.stats().lastSearch.returned,20);
  const sent=workers[0].messages.findLast(message=>message.op==='search');assert.equal(sent.options.offset,480);assert.equal(sent.options.credential,undefined);
  const previous=await client.search('beleg',{limit:24,offset:456});assert.equal(previous[0].id,'worker-page-456');assert.equal(previous.length,24);
});

test('client abort rejects stale searches and worker load failures do not leave future requests hanging',async t=>{
  const workers=workerFixture(t),client=createSearchClient();t.after(()=>client.dispose());await client.replace([doc('a','Quelle')]);const controller=new AbortController(),pending=client.search('quelle',{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});await tick();
  workers[0].onerror();await assert.rejects(client.search('quelle'),/Suchworker/);assert.equal(client.stats().status,'error');
});

test('RAM fallback stays searchable after denied persistence and dispose rejects further operations',async t=>{
  replaceGlobal(t,'Worker',undefined);const client=createSearchClient();await client.replace([doc('a','Prototyp')]);await assert.rejects(client.optPersist(true),/Suchworker/);assert.equal(client.stats().status,'ready');assert.equal(client.stats().persistence.state,'error');assert.deepEqual(ids(await client.search('prototyp')),['a']);assert.equal(client.stats().persistence.state,'error');
  await client.optPersist(false);assert.equal(client.stats().persistence.state,'off');client.dispose();await assert.rejects(client.search('prototyp'),/beendet/);assert.equal(client.stats().status,'disposed');
});

test('explicit opt-out in the RAM fallback deletes a cache created during an earlier worker-capable session',async t=>{
  const database=fakeIndexedDB(),old=createEncryptedSearchStorage({indexedDB:database,cryptoAPI:crypto});await old.write([doc('old','Synthetischer vorheriger Suchcache')]);old.close();
  replaceGlobal(t,'Worker',undefined);replaceGlobal(t,'indexedDB',database);const client=createSearchClient();t.after(()=>client.dispose());await client.replace([doc('fresh','Aktuelle Quelle')]);await client.optPersist(false);
  assert.equal(database.stores.size,0);assert.equal(client.stats().persistence.state,'off');assert.deepEqual(ids(await client.search('aktuelle')),['fresh']);
});

test('invalid and clipped client input remains honestly counted after subsequent searches',async t=>{
  workerFixture(t);const client=createSearchClient();t.after(()=>client.dispose());await client.replace([null,doc('a','Wort '.repeat(15000))]);assert.equal(client.stats().omitted,1);assert.equal(client.stats().truncated,1);assert.equal((await client.search('wort'))[0].truncated,true);assert.equal(client.stats().omitted,1);
});

const persistKey='context-search-persist-v1';
function preferenceStorage(value){const entries=new Map(value===undefined?[]:[[persistKey,value]]),calls=[];return {entries,calls,getItem(key){calls.push(['get',key]);return entries.get(key)||null;},setItem(key,value){calls.push(['set',key,value]);entries.set(key,value);},removeItem(key){calls.push(['remove',key]);entries.delete(key);}};}

test('saved deliberate yes restores the actual encrypted cache before the first fresh snapshot replacement',async t=>{
  const database=fakeIndexedDB(),old=createEncryptedSearchStorage({indexedDB:database,cryptoAPI:crypto});await old.write([doc('cached','Synthetischer gespeicherter Beleg')]);old.close();
  const preference=preferenceStorage('yes'),storage=createEncryptedSearchStorage({indexedDB:database,cryptoAPI:crypto}),workers=workerFixture(t,{storage});replaceGlobal(t,'localStorage',preference);
  const client=createSearchClient();t.after(()=>client.dispose());assert.equal(workers[0].messages[0].op,'optPersist');assert.equal(workers[0].messages[0].enabled,true);
  assert.deepEqual(ids(await client.search('gespeicherter')),['cached']);assert.equal(client.stats().persistence.enabled,true);
  await client.replace([doc('fresh','Aktuelle Quellen')]);assert.deepEqual(workers[0].messages.map(m=>m.op),['optPersist','search','replace']);assert.deepEqual(await client.search('gespeicherter'),[]);assert.deepEqual(ids(await client.search('aktuelle')),['fresh']);
  assert.deepEqual((await storage.read()).map(d=>d.id),['fresh']);assert.equal(preference.entries.get(persistKey),'yes');
});

test('default, malformed and explicitly false preferences never read the database or start automatic persistence',async t=>{
  for(const saved of [undefined,'no','false','true','1']){
    let reads=0,writes=0;const storage={async read(){reads++;return [doc('old','Private cache')];},async write(){writes++;},async remove(){},close(){}};
    const preference=preferenceStorage(saved),workers=workerFixture(t,{storage});replaceGlobal(t,'localStorage',preference);const client=createSearchClient();await client.replace([doc('fresh','Aktuell')]);
    assert.deepEqual(workers[0].messages.map(m=>m.op),['replace']);assert.equal(reads,0);assert.equal(writes,0);assert.equal(client.stats().persistence.enabled,false);client.dispose();
  }
});

test('successful opt-in remembers only the harmless flag, while failed opt-in never grants a reload preference',async t=>{
  const preference=preferenceStorage();replaceGlobal(t,'localStorage',preference);workerFixture(t);const client=createSearchClient();await client.replace([doc('a','Synthetischer Inhalt')]);await client.optPersist(true);
  assert.deepEqual([...preference.entries],[[persistKey,'yes']]);assert.equal(preference.calls.filter(c=>c[0]==='set').length,1);client.dispose();
  const failedPreference=preferenceStorage();replaceGlobal(t,'localStorage',failedPreference);workerFixture(t,{storage:{async read(){return null;},async write(){throw new Error('Synthetic write failed');},async remove(){},close(){}}});
  const failed=createSearchClient();await assert.rejects(failed.optPersist(true),/Synthetic write/);assert.equal(failedPreference.entries.has(persistKey),false);failed.dispose();
});

test('off removes the remembered flag before a blocked delete, so reloading cannot resume cached data',async t=>{
  const preference=preferenceStorage('yes'),order=[];replaceGlobal(t,'localStorage',preference);
  workerFixture(t,{storage:{async read(){return [doc('old','Cached')];},async write(){},async remove(){order.push(preference.entries.has(persistKey));throw new Error('Synthetic blocked delete');},close(){}}});
  const client=createSearchClient();await client.search('cached');await assert.rejects(client.optPersist(false),/blocked delete/);assert.deepEqual(order,[false]);assert.equal(preference.entries.has(persistKey),false);assert.equal(client.stats().persistence.enabled,false);assert.equal(client.stats().persistence.state,'error');client.dispose();
  let read=0;workerFixture(t,{storage:{async read(){read++;return [doc('old','Cached')];},async write(){},async remove(){},close(){}}});const reloaded=createSearchClient();await reloaded.replace([doc('current','Aktuell')]);assert.equal(read,0);assert.equal(reloaded.stats().persistence.enabled,false);reloaded.dispose();
});

test('saved yes in an unsupported RAM environment stays off and warns without touching IndexedDB',async t=>{
  let opened=0;replaceGlobal(t,'localStorage',preferenceStorage('yes'));replaceGlobal(t,'Worker',undefined);replaceGlobal(t,'indexedDB',{open(){opened++;throw new Error('Not allowed');}});
  const client=createSearchClient();t.after(()=>client.dispose());await client.replace([doc('a','Aktuell')]);assert.equal(opened,0);assert.equal(client.stats().persistence.enabled,false);assert.equal(client.stats().persistence.state,'error');assert.match(client.stats().persistence.error,/Suchworker/);assert.deepEqual(ids(await client.search('aktuell')),['a']);
});

test('a preference-read failure stays RAM-only with an honest warning and a usable search index',async t=>{
  let reads=0;replaceGlobal(t,'localStorage',{getItem(){throw new Error('Synthetic access denied');},removeItem(){}});workerFixture(t,{storage:{async read(){reads++;return null;},async write(){},async remove(){},close(){}}});
  const client=createSearchClient();t.after(()=>client.dispose());await client.replace([doc('a','Aktuell')]);assert.equal(reads,0);assert.equal(client.stats().persistence.enabled,false);assert.equal(client.stats().persistence.state,'error');assert.match(client.stats().persistence.error,/nicht gelesen/);assert.equal(client.stats().status,'ready');assert.deepEqual(ids(await client.search('aktuell')),['a']);
});

test('pending automatic startup cannot restore callbacks after disposal or overwrite a later off preference',async t=>{
  const preference=preferenceStorage('yes');replaceGlobal(t,'localStorage',preference);let release;const gate=new Promise(resolve=>{release=resolve;});
  workerFixture(t,{storage:{async read(){await gate;return [doc('old','Cache')];},async write(){},async remove(){},close(){}}});const client=createSearchClient();const off=client.optPersist(false);assert.equal(preference.entries.has(persistKey),false);release();await off;assert.equal(client.stats().persistence.enabled,false);assert.equal(preference.entries.has(persistKey),false);client.dispose();await tick();assert.equal(client.stats().status,'disposed');
});

test('a late successful on request cannot re-save the preference after a newer explicit off',async t=>{
  const preference=preferenceStorage();replaceGlobal(t,'localStorage',preference);let release;const gate=new Promise(resolve=>{release=resolve;}),deleted=[];
  workerFixture(t,{storage:{async read(){return null;},async write(){await gate;},async remove(){deleted.push(preference.entries.has(persistKey));},close(){}}});
  const client=createSearchClient();t.after(()=>client.dispose());const on=client.optPersist(true);await tick();const off=client.optPersist(false);release();await Promise.all([on,off]);
  assert.equal(preference.entries.has(persistKey),false);assert.deepEqual(deleted,[false]);assert.equal(client.stats().persistence.enabled,false);assert.equal(client.stats().persistence.state,'off');
});
