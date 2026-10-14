import {PLATFORM_SOURCE_LIMITS,normalizePlatformURL,platformDocumentURL,platformSourceId,validPlatformProjectId} from './source-catalog.js';
import {redactKnowledge} from './knowledge.js';

// Knowledge imports the pure scope guard. Keep this module's top-level limits
// self-contained so that guard does not form an initialization cycle.
export const PLATFORM_STORAGE_LIMITS=Object.freeze({sources:100,documents:5000,characters:5000000,documentText:20000,recordBytes:24000000,metadataBytes:1000000});
const failure=message=>new Error(message||'Ungültiger lokaler Plattform-Speicher.');
const aborted=()=>new DOMException('Abgebrochen','AbortError');
const sourceKey=value=>typeof value==='string'&&/^platform:[a-f0-9]{32}$/.test(value);
const docKey=value=>typeof value==='string'&&/^(?:miro|service):[a-f0-9]{64}(?::part\d{1,5})?$/.test(value);
const generation=value=>typeof value==='string'&&/^(?:[a-f0-9]{16,128}|\d{1,12})$/.test(value);
const revision=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const bounded=(value,max)=>{const result=redactKnowledge(typeof value==='string'?value.slice(0,max):'');return result.slice(0,max).replace(/[\uD800-\uDBFF]$/,'');};
const stamp=value=>{if(typeof value!=='string'||value.length>80||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value.slice(0,10)+'T12:00:00Z').toISOString().slice(0,10)!==value.slice(0,10))return '';return new Date(value).toISOString();};
function scopeRow(value){
  if(!value||Array.isArray(value)||!validPlatformProjectId(value.projectId)||!['miro','gitlab','sciebo','mattermost'].includes(value.service)||value.service==='miro'&&!value.projectId)throw failure('Ungültige Plattform-Kurszuordnung.');
  const url=normalizePlatformURL(value.service,value.url),sourceId=value.sourceId||value.id;
  if(!sourceKey(sourceId)||sourceId!==platformSourceId({service:value.service,url,projectId:value.projectId}))throw failure('Die Quellenkennung stimmt nicht mit dem Kurslink überein.');
  return {sourceId,projectId:value.projectId,service:value.service,url};
}
export function cleanPlatformDocument(value,sourceRow){
  const scope=scopeRow(sourceRow),miro=scope.service==='miro';
  if(!value||Array.isArray(value)||!docKey(value.id)||value.sourceId!==scope.sourceId||value.projectId!==scope.projectId||value.service!==scope.service||value.kind!==(miro?'miro':'service')||!value.id.startsWith(miro?'miro:':'service:')||typeof value.title!=='string'||value.title.length>240||typeof value.text!=='string'||value.text.length>PLATFORM_SOURCE_LIMITS.documentText||!['full','excerpt','metadata'].includes(value.status))throw failure('Ungültiger Plattformtext.');
  const body=redactKnowledge(value.text);if(body.length>PLATFORM_SOURCE_LIMITS.documentText)throw failure('Der Plattformtext überschreitet die lokale Textgrenze.');
  let url,extra={};
  if(miro){
    const boardId=new URL(scope.url).pathname.split('/')[3],itemId=value.itemId;
    if(typeof itemId!=='string'||itemId&&!/^[a-zA-Z0-9_=-]{1,128}$/.test(itemId)||value.boardURL!==scope.url||value.boardId!==undefined&&value.boardId!==boardId)throw failure('Ungültige Miro-Boardzuordnung.');
    const expected=new URL(scope.url);if(itemId)expected.searchParams.set('moveToWidget',itemId);
    if(value.url!==expected.href)throw failure('Das Miro-Element gehört nicht zu diesem Board.');url=expected.href;extra={boardURL:scope.url,boardId,itemId};
  }else url=platformDocumentURL(scope.service,value.url,scope.url);
  if(value.accountGeneration!==undefined&&(!generation(value.accountGeneration)||sourceRow.accountGeneration!==undefined&&value.accountGeneration!==sourceRow.accountGeneration))throw failure('Die Quellenanmeldung stimmt nicht überein.');
  if(value.contentRevision!==undefined&&(!/^[a-f0-9]{64}$/.test(value.contentRevision)))throw failure('Ungültiger Inhaltsstand.');
  if(value.extraction!==undefined){if(miro||!value.extraction||typeof value.extraction!=='object'||Array.isArray(value.extraction))throw failure('Ungültige Dateierkennung.');extra.extraction=cleanCoverage(value.extraction);}
  if(value.warnings!==undefined){if(!Array.isArray(value.warnings)||value.warnings.length>10||value.warnings.some(w=>typeof w!=='string'||w.length>300))throw failure('Ungültige Dateihinweise.');extra.warnings=value.warnings.map(w=>bounded(w,300));}
  return {id:value.id,...scope,url,kind:miro?'miro':'service',source:miro?'Miro':scope.service,targetId:scope.projectId,title:bounded(value.title,240),text:body,status:value.status,trust:'untrusted-source',...extra,updatedAt:stamp(value.updatedAt),checkedAt:stamp(value.checkedAt),fetchedAt:stamp(value.fetchedAt),...(value.contentRevision?{contentRevision:value.contentRevision}:{}),...(value.accountGeneration!==undefined?{accountGeneration:value.accountGeneration}:{})};
}
export function platformDocumentAllowed(value,sourceRow){try{cleanPlatformDocument(value,sourceRow);return true;}catch{return false;}}
function cleanCoverage(value){
  if(typeof value==='string'&&['rendered-view','partial','none','text-file','api','board-api','rest-api-text'].includes(value))return value;
  if(!value||typeof value!=='object'||Array.isArray(value))throw failure('Ungültige Quellenabdeckung.');
  const clean={};for(const key of ['complete','truncated','bounded','limitReached'])if(value[key]!==undefined){if(typeof value[key]!=='boolean')throw failure('Ungültige Quellenabdeckung.');clean[key]=value[key];}
  for(const key of ['pages','items','readableItems','unsupportedItems','documents','read','total','omitted','views','files'])if(value[key]!==undefined){if(!Number.isSafeInteger(value[key])||value[key]<0||value[key]>2000000)throw failure('Ungültige Quellenabdeckung.');clean[key]=value[key];}
  for(const key of ['status','basis','method','reason','message'])if(value[key]!==undefined)clean[key]=bounded(value[key],key==='message'?300:80);
  return clean;
}
export function cleanPlatformSources(values){
  if(!Array.isArray(values)||values.length>PLATFORM_SOURCE_LIMITS.sources)throw failure('Zu viele gespeicherte Plattformquellen.');
  let count=0,characters=0;const ids=new Set();
  return values.map(value=>{
    const scope=scopeRow(value);if(ids.has(scope.sourceId)||!revision(value.revision)||!generation(value.accountGeneration)||!stamp(value.fetchedAt)||!Array.isArray(value.documents)||value.documents.length>PLATFORM_SOURCE_LIMITS.documents||!Array.isArray(value.warnings)||value.warnings.length>20||value.warnings.some(w=>typeof w!=='string'||w.length>600))throw failure('Ungültiger gespeicherter Quellenstand.');
    ids.add(scope.sourceId);const documentIds=new Set(),documents=value.documents.map(document=>{const clean=cleanPlatformDocument(document,value);if(documentIds.has(clean.id))throw failure('Doppelte Plattformtexte.');documentIds.add(clean.id);characters+=clean.text.length;count++;if(count>PLATFORM_SOURCE_LIMITS.documents||characters>PLATFORM_SOURCE_LIMITS.characters)throw failure('Die lokale Plattform-Textgrenze ist erreicht.');return clean;});
    return {...scope,revision:value.revision,title:bounded(value.title,240),documents,coverage:cleanCoverage(value.coverage),warnings:value.warnings.map(w=>bounded(w,600)),fetchedAt:stamp(value.fetchedAt),accountGeneration:value.accountGeneration};
  });
}
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error||failure('Plattform-Speicher nicht verfügbar.'));});
const textEncoder=new TextEncoder(),textDecoder=new TextDecoder();
async function encryptPlain(plain,key,aad,cryptoAPI,maxBytes){const bytes=textEncoder.encode(plain);if(bytes.byteLength+16>maxBytes)throw failure('Die verschlüsselte Plattform-Speichergrenze ist erreicht.');const iv=cryptoAPI.getRandomValues(new Uint8Array(12));return {iv,cipher:await cryptoAPI.subtle.encrypt({name:'AES-GCM',iv,additionalData:textEncoder.encode(aad)},key,bytes)};}
async function decrypt(record,key,aad,cryptoAPI,maxBytes){if(!(record?.iv instanceof Uint8Array)||record.iv.length!==12||!(record.cipher instanceof ArrayBuffer)||record.cipher.byteLength<16||record.cipher.byteLength>maxBytes)throw failure('Ungültiger verschlüsselter Plattform-Speicher.');return JSON.parse(textDecoder.decode(await cryptoAPI.subtle.decrypt({name:'AES-GCM',iv:record.iv,additionalData:textEncoder.encode(aad)},key,record.cipher)));}
const digest=async(plain,cryptoAPI)=>[...new Uint8Array(await cryptoAPI.subtle.digest('SHA-256',textEncoder.encode(plain)))].map(v=>v.toString(16).padStart(2,'0')).join('');
const validRevision=value=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER;
const currentRevision=value=>{if(value===undefined)return 0;if(!validRevision(value.revision)||value.revision<1)throw failure('Ungültige Plattform-Speicherversion.');return value.revision;};

/** Only explicitly read provider texts enter this encrypted, bounded cache. */
export function createPlatformSourceStore({indexedDB=globalThis.indexedDB,crypto:cryptoOption=globalThis.crypto,cryptoAPI=cryptoOption}={}){
  let db,key,opening,epoch=0;const transactions=new Set(),cached=new Map();
  const track=tx=>{transactions.add(tx);return tx;};
  async function open(){
    if(opening)return opening;
    const token=epoch,job=(async()=>{
      if(!indexedDB||!cryptoAPI?.subtle||typeof cryptoAPI.getRandomValues!=='function')throw failure('Der lokale Plattform-Speicher ist nicht verfügbar.');
      const r=indexedDB.open('context-platform-sources',1);r.onupgradeneeded=()=>{r.result.createObjectStore('keys');r.result.createObjectStore('meta');r.result.createObjectStore('rows');};
      const connection=await request(r),assert=()=>{if(token!==epoch){connection.close();throw aborted();}};assert();
      try{
        let aes=await request(connection.transaction('keys').objectStore('keys').get('aes'));assert();
        if(!aes){const candidate=await cryptoAPI.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);assert();await new Promise((resolve,reject)=>{
          const tx=track(connection.transaction('keys','readwrite')),store=tx.objectStore('keys');store.get('aes').onsuccess=event=>{try{assert();aes=event.target.result||candidate;if(!event.target.result)store.add(candidate,'aes');}catch{tx.abort();}};
          tx.oncomplete=()=>{transactions.delete(tx);resolve();};tx.onabort=tx.onerror=()=>{transactions.delete(tx);reject(failure('Der Plattform-Schlüssel konnte nicht gespeichert werden.'));};
        });}
        assert();if(aes?.extractable!==false||aes.algorithm?.name!=='AES-GCM'||aes.algorithm?.length!==256||!aes.usages?.includes('encrypt')||!aes.usages?.includes('decrypt'))throw failure('Ungültiger Plattform-Speicherschlüssel.');
        db=connection;key=aes;connection.onversionchange=()=>close();
      }catch(reason){connection.close();throw reason;}
    })();opening=job;try{await job;}catch(reason){if(opening===job)opening=null;throw reason;}
  }
  function close(){epoch++;for(const tx of transactions){try{tx.abort();}catch{}}transactions.clear();db?.close();db=null;key=null;opening=null;cached.clear();}
  async function load(){
    await open();const token=epoch,connection=db,aes=key;
    const snapshot=await new Promise((resolve,reject)=>{
      const tx=track(connection.transaction(['meta','rows'])),records=new Map();let meta;
      tx.objectStore('meta').get('state').onsuccess=event=>{meta=event.target.result;};
      const rows=tx.objectStore('rows');rows.getAllKeys().onsuccess=event=>{for(const id of event.target.result)rows.get(id).onsuccess=result=>records.set(id,result.target.result);};
      tx.oncomplete=()=>{transactions.delete(tx);resolve({meta,records});};tx.onabort=tx.onerror=()=>{transactions.delete(tx);reject(failure('Der Plattform-Speicher konnte nicht gelesen werden.'));};
    });
    if(token!==epoch)throw aborted();const revision=currentRevision(snapshot.meta);
    if(!revision){if(snapshot.records.size)throw failure('Plattformtexte ohne Speicherstand.');cached.clear();return {rows:[],revision:0};}
    const meta=await decrypt(snapshot.meta,aes,'context-platform-meta-v1:'+revision,cryptoAPI,PLATFORM_STORAGE_LIMITS.metadataBytes);
    if(meta?.version!==1||meta.revision!==revision||!Array.isArray(meta.sources)||meta.sources.length>PLATFORM_SOURCE_LIMITS.sources||snapshot.records.size!==meta.sources.length)throw failure('Ungültige Plattform-Quellenliste.');
    const restored=[],nextCache=new Map(),seen=new Set();
    for(const entry of meta.sources){
      if(!sourceKey(entry?.id)||seen.has(entry.id)||typeof entry.digest!=='string'||!/^[a-f0-9]{64}$/.test(entry.digest))throw failure('Ungültige Plattform-Quellenliste.');seen.add(entry.id);
      const record=snapshot.records.get(entry.id);if(!record)throw failure('Eine gespeicherte Plattformquelle fehlt.');
      const value=await decrypt(record,aes,'context-platform-row-v1:'+entry.id,cryptoAPI,PLATFORM_STORAGE_LIMITS.recordBytes),plain=JSON.stringify(value);
      if(value.sourceId!==entry.id||await digest(plain,cryptoAPI)!==entry.digest)throw failure('Der gespeicherte Quellenstand stimmt nicht überein.');restored.push(value);nextCache.set(entry.id,{digest:entry.digest,record});
    }
    const rows=cleanPlatformSources(restored);if(token!==epoch)throw aborted();cached.clear();for(const [id,value]of nextCache)cached.set(id,value);return {rows,revision};
  }
  async function save(values,{expectedRevision,assertCurrent,signal}={}){
    if(!validRevision(expectedRevision)||assertCurrent!==undefined&&typeof assertCurrent!=='function')throw failure('Ungültige Plattform-Speicherversion.');
    const token=epoch,guard=()=>{if(token!==epoch||signal?.aborted||assertCurrent?.()===false)throw aborted();};guard();const rows=cleanPlatformSources(values);await open();guard();const aes=key,connection=db,records=new Map(),entries=[];
    for(const row of rows){guard();const plain=JSON.stringify(row),hash=await digest(plain,cryptoAPI),prior=cached.get(row.sourceId),record=prior?.digest===hash?prior.record:await encryptPlain(plain,aes,'context-platform-row-v1:'+row.sourceId,cryptoAPI,PLATFORM_STORAGE_LIMITS.recordBytes);guard();records.set(row.sourceId,{digest:hash,record});entries.push({id:row.sourceId,digest:hash});}
    const nextRevision=expectedRevision+1,meta=await encryptPlain(JSON.stringify({version:1,revision:nextRevision,sources:entries}),aes,'context-platform-meta-v1:'+nextRevision,cryptoAPI,PLATFORM_STORAGE_LIMITS.metadataBytes);guard();
    return new Promise((resolve,reject)=>{
      let reason;const tx=track(connection.transaction(['meta','rows'],'readwrite')),metadata=tx.objectStore('meta'),saved=tx.objectStore('rows'),stop=error=>{reason=error;try{tx.abort();}catch{}};
      const cancel=()=>stop(aborted());signal?.addEventListener('abort',cancel,{once:true});const finish=()=>{transactions.delete(tx);signal?.removeEventListener('abort',cancel);};
      metadata.get('state').onsuccess=event=>{
        try{guard();if(currentRevision(event.target.result)!==expectedRevision)throw Object.assign(failure('Ein anderer Tab hat die Plattformquellen geändert. Bitte neu laden.'),{code:'REVISION_CONFLICT'});
          saved.getAllKeys().onsuccess=keys=>{try{guard();const keep=new Set(records.keys());for(const id of keys.target.result)if(!keep.has(id))saved.delete(id);for(const [id,value]of records)saved.put(value.record,id);metadata.put({...meta,revision:nextRevision},'state').onsuccess=()=>{try{guard();}catch(error){stop(error);}};}catch(error){stop(error);}};
        }catch(error){stop(error);}
      };
      tx.oncomplete=()=>{finish();cached.clear();for(const [id,value]of records)cached.set(id,value);resolve(nextRevision);};
      tx.onabort=tx.onerror=()=>{finish();reject(reason||failure('Plattformtexte konnten nicht gespeichert werden.'));};
    });
  }
  return {load,save,clear:options=>save([],options),close};
}
