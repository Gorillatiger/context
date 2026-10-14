import {createSearchIndex,searchIndexDocuments,cleanSearchDocument,SEARCH_LIMITS} from './search-index.js';

const CACHE_NAME='context-local-search-index',AAD=new TextEncoder().encode('context-local-search-cache-v1'),CACHE_BYTES=80000000;
const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error||new Error('Suchspeicher nicht verfügbar.'));});
const completion=transaction=>new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onabort=transaction.onerror=()=>reject(transaction.error||new Error('Suchspeicher konnte nicht geschrieben werden.'));});
const aborted=()=>new DOMException('Suche abgebrochen.','AbortError');
function cacheDocuments(documents){
  if(!Array.isArray(documents)||documents.length>SEARCH_LIMITS.documents)throw new Error('Ungültiger Suchindex-Cache.');
  let characters=0;const ids=new Set();
  return documents.map(value=>{
    const doc=cleanSearchDocument(value);if(!doc||ids.has(doc.id)||(characters+=doc.text.length)>SEARCH_LIMITS.characters)throw new Error('Ungültiger Suchindex-Cache.');ids.add(doc.id);
    return {...doc,originalLength:Number.isSafeInteger(value.originalLength)&&value.originalLength>=doc.text.length&&value.originalLength<=100000000?value.originalLength:doc.text.length,indexTruncated:value.indexTruncated===true};
  });
}
export async function encryptSearchSnapshot(documents,key,cryptoAPI=globalThis.crypto){
  const plaintext=new TextEncoder().encode(JSON.stringify({version:1,documents:cacheDocuments(documents)}));
  if(plaintext.byteLength>CACHE_BYTES)throw new Error('Der verschlüsselte Suchcache überschreitet die Speichergrenze.');
  const iv=cryptoAPI.getRandomValues(new Uint8Array(12)),cipher=await cryptoAPI.subtle.encrypt({name:'AES-GCM',iv,additionalData:AAD},key,plaintext);plaintext.fill(0);return {version:1,iv,cipher};
}
export async function decryptSearchSnapshot(record,key,cryptoAPI=globalThis.crypto){
  if(record?.version!==1||!(record.iv instanceof Uint8Array)||record.iv.length!==12||!(record.cipher instanceof ArrayBuffer)||record.cipher.byteLength>CACHE_BYTES+16)throw new Error('Ungültiger verschlüsselter Suchcache.');
  const plaintext=new Uint8Array(await cryptoAPI.subtle.decrypt({name:'AES-GCM',iv:record.iv,additionalData:AAD},key,record.cipher));
  let value;try{value=JSON.parse(new TextDecoder().decode(plaintext));}finally{plaintext.fill(0);}
  if(value?.version!==1)throw new Error('Unbekannte Suchcache-Version.');return cacheDocuments(value.documents);
}

// No database is opened or read until the explicit opt-in command arrives.
export function createEncryptedSearchStorage({indexedDB=globalThis.indexedDB,cryptoAPI=globalThis.crypto,onDisabled=()=>{}}={}){
  let db,key,opening,generation=0;
  function close(){generation++;db?.close();db=null;key=null;opening=null;}
  async function open(){
    if(db&&key)return;if(opening)return opening;
    if(!indexedDB||!cryptoAPI?.subtle)throw new Error('Verschlüsselter Suchspeicher ist in diesem Browser nicht verfügbar.');
    const current=generation;
    opening=(async()=>{
      const pending=indexedDB.open(CACHE_NAME,1);pending.onupgradeneeded=()=>{pending.result.createObjectStore('keys');pending.result.createObjectStore('index');};
      const opened=await request(pending);if(current!==generation){opened.close();throw aborted();}db=opened;
      db.onversionchange=()=>{close();onDisabled();};
      key=await request(db.transaction('keys').objectStore('keys').get('aes'));
      if(current!==generation)throw aborted();
      if(!key){
        const candidate=await cryptoAPI.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);if(current!==generation)throw aborted();
        const tx=db.transaction('keys','readwrite'),finished=completion(tx),store=tx.objectStore('keys');
        store.get('aes').onsuccess=event=>{key=event.target.result||candidate;if(!event.target.result)store.add(candidate,'aes');};await finished;
      }
      if(key.extractable!==false||key.algorithm?.name!=='AES-GCM'||!key.usages.includes('encrypt')||!key.usages.includes('decrypt'))throw new Error('Ungültiger Suchspeicherschlüssel.');
    })();
    try{await opening;}catch(error){close();throw error;}
  }
  return {
    async read(){await open();const record=await request(db.transaction('index').objectStore('index').get('snapshot'));return record?decryptSearchSnapshot(record,key,cryptoAPI):null;},
    async write(documents){await open();const current=generation,encrypted=await encryptSearchSnapshot(documents,key,cryptoAPI);if(current!==generation||!db)throw aborted();const tx=db.transaction('index','readwrite'),finished=completion(tx);tx.objectStore('index').put(encrypted,'snapshot');await finished;},
    async remove(){close();if(!indexedDB)return;const pending=indexedDB.deleteDatabase(CACHE_NAME);return new Promise((resolve,reject)=>{pending.onsuccess=resolve;pending.onerror=()=>reject(pending.error||new Error('Suchcache konnte nicht gelöscht werden.'));pending.onblocked=()=>reject(new Error('Ein anderes Fenster blockiert das Löschen des Suchcaches. Schließe es und schalte die Speicherung erneut aus.'));});},
    close,
  };
}

export function createSearchWorkerController({post=()=>{},storage,storageFactory=createEncryptedSearchStorage}={}){
  const index=createSearchIndex(),cancelled=new Set();let queue=Promise.resolve(),provided=false,disposed=false,projectionOmitted=0;
  let persistence={enabled:false,state:'off'};
  const stats=()=>({...index.stats(),omitted:index.stats().omitted+projectionOmitted,persistence:{...persistence}});
  const status=(state,error='')=>post({type:'status',status:state,...stats(),...(error?{error}:{})});
  const cache=storage||storageFactory({onDisabled:()=>{persistence={enabled:false,state:'off'};status('ready');}});
  async function store(strict=false){
    if(!persistence.enabled)return;
    persistence={enabled:true,state:'saving'};status('indexing');
    try{await cache.write(searchIndexDocuments(index));persistence={enabled:true,state:'stored'};}
    catch(error){persistence={enabled:true,state:'error',error:error.message};status('ready',error.message);if(strict)throw error;}
  }
  async function operation(message){
    if(disposed||cancelled.has(message.id))throw aborted();
    if(message.op==='replace'){status('indexing');index.replace(message.documents);projectionOmitted=Number.isSafeInteger(message.omitted)&&message.omitted>=0?message.omitted:0;provided=true;await store();status('ready');return stats();}
    if(message.op==='search'){
      status('searching');const result=index.search(message.query,{...(message.options||{}),signal:{get aborted(){return cancelled.has(message.id)||disposed;}}});status('ready');return result;
    }
    if(message.op==='stats')return stats();
    if(message.op==='clear'){index.clear();projectionOmitted=0;provided=true;if(persistence.enabled)await store();status('ready');return stats();}
    if(message.op==='optPersist'){
      if(typeof message.enabled!=='boolean')throw new Error('Ungültige Suchspeicherfreigabe.');
      if(!message.enabled){persistence={enabled:false,state:'off'};try{await cache.remove();}catch(error){persistence={enabled:false,state:'error',error:error.message};status('ready',error.message);throw error;}status('ready');return stats();}
      persistence={enabled:true,state:'saving'};status('indexing');
      try{if(!provided){const saved=await cache.read();if(saved){index.replace(saved);provided=true;}}await store(true);status('ready');return stats();}
      catch(error){persistence={enabled:true,state:'error',error:error.message};status('ready',error.message);throw error;}
    }
    throw new Error('Unbekannter lokaler Suchauftrag.');
  }
  function receive(message){
    if(!message||typeof message!=='object'||typeof message.id!=='string'||message.id.length>100)return Promise.resolve();
    if(message.op==='cancel'){if(cancelled.size>=1000)cancelled.delete(cancelled.values().next().value);cancelled.add(message.id);return Promise.resolve();}
    const work=queue.then(async()=>{
      try{const result=await operation(message);if(cancelled.has(message.id)||disposed)throw aborted();post({type:'result',id:message.id,result,stats:stats()});}
      catch(error){post({type:'error',id:message.id,name:error.name||'Error',error:error.message||'Die lokale Suche ist fehlgeschlagen.',stats:stats()});}
      finally{cancelled.delete(message.id);}
    });queue=work.catch(()=>{});return work;
  }
  return {receive,stats,dispose(){disposed=true;cache.close?.();index.clear();cancelled.clear();}};
}

if(typeof globalThis.WorkerGlobalScope!=='undefined'&&globalThis instanceof WorkerGlobalScope){
  const controller=createSearchWorkerController({post:message=>globalThis.postMessage(message)});
  globalThis.onmessage=event=>{void controller.receive(event.data);};
}
