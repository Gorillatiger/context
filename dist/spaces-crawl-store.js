import {courseRoot,scopedURL} from './companion-scan.js';
import {redactKnowledge} from './knowledge.js';
import {emptyCrawlState,validateCrawlState,cleanCrawlBoardLinks,cleanCrawlPlatformLinks} from './spaces-crawl.js';

export const CRAWL_STORAGE_LIMITS=Object.freeze({sources:2000,characters:20000000,sourceText:60000});
const sourceId=value=>typeof value==='string'&&/^crawl:[a-f0-9]{64}$/.test(value);
const string=(value,max)=>typeof value==='string'?value.slice(0,max):'';
export function cleanCrawlSource(value){
  if(!value||!sourceId(value.id)||typeof value.projectId!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(value.projectId)||typeof value.text!=='string'||value.text.length>CRAWL_STORAGE_LIMITS.sourceText)throw Error('Ungültige gespeicherte Spaces-Quelle.');
  const root=courseRoot({links:[{tool:'spaces',url:value.courseURL}]});if(!root)throw Error('Die Kursverbindung fehlt.');
  const url=scopedURL(value.url,root);
  return {id:value.id,kind:'browser',projectId:value.projectId,courseURL:root.url,url,title:redactKnowledge(string(value.title,240)),text:redactKnowledge(value.text),status:value.status==='full'?'full':'excerpt',boardLinks:cleanCrawlBoardLinks(value.boardLinks,root),platformLinks:cleanCrawlPlatformLinks(value.platformLinks,root,url),platformLinksMore:value.platformLinksMore===true,contentRevision:/^[a-f0-9]{64}$/.test(value.contentRevision||'')?value.contentRevision:'',section:Array.isArray(value.section)?value.section.filter(s=>typeof s==='string').slice(0,8).map(s=>redactKnowledge(s).slice(0,160)):[],updatedAt:typeof value.updatedAt==='string'&&Number.isFinite(Date.parse(value.updatedAt))?value.updatedAt:'',postedBy:redactKnowledge(string(value.postedBy,200)),postedAt:typeof value.postedAt==='string'&&Number.isFinite(Date.parse(value.postedAt))?value.postedAt:''};
}
export function crawlSourcesForKnowledge(documents,workspace){
  const sources=[];let characters=0;
  for(const document of documents.slice(0,CRAWL_STORAGE_LIMITS.sources)){
    const project=workspace.projects?.find(p=>p.id===document.projectId&&!p.archived);if(!project)continue;
    let source;try{source=cleanCrawlSource(document);if(courseRoot(project)?.url!==source.courseURL)continue;}catch{continue;}
    if(characters+source.text.length>CRAWL_STORAGE_LIMITS.characters)break;characters+=source.text.length;
    // Keep citation archives bounded and preserve the end of lengthy pages.
    // The overlap prevents a word at a text-window boundary from disappearing.
    for(let offset=0,part=0;offset<source.text.length||part===0;offset+=11800,part++){
      const body=source.text.slice(offset,offset+12000);
      sources.push({...source,boardLinks:part===0?source.boardLinks:[],platformLinks:part===0?source.platformLinks:[],id:source.id+':part'+part,title:source.title+(source.text.length>12000?' · Abschnitt '+(part+1):''),text:body,status:source.text.length>12000?'excerpt':source.status});
    }
  }
  return sources;
}
function cleanSnapshot(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Ungültiger Spaces-Speicher.');
  if(value.version!==undefined&&value.version!==1)throw Error('Ungültiger Spaces-Speicher.');
  const sourceIds=value.sourceIds===undefined?[]:value.sourceIds;
  if(!Array.isArray(sourceIds)||sourceIds.length>2000||sourceIds.some(id=>!sourceId(id))||new Set(sourceIds).size!==sourceIds.length)throw Error('Ungültige Quellenliste.');
  return {version:1,state:validateCrawlState(value.state===undefined?emptyCrawlState():value.state),sourceIds,lastRun:string(value.lastRun,80)};
}
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error||Error('Spaces-Speicher nicht verfügbar.'));});
const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error||Error('Spaces-Speicherung unterbrochen.'));});
async function encrypt(value,key,aad,cryptoAPI,maxBytes=500000){const plain=new TextEncoder().encode(JSON.stringify(value));if(plain.byteLength+16>maxBytes)throw Error('Die lokale Speichergrenze ist erreicht.');const iv=cryptoAPI.getRandomValues(new Uint8Array(12)),cipher=await cryptoAPI.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(aad)},key,plain);return {iv,cipher};}
async function decrypt(record,key,aad,cryptoAPI,maxBytes){
  if(!(record?.iv instanceof Uint8Array)||record.iv.length!==12||!record.cipher||record.cipher.byteLength>maxBytes)throw Error('Ungültiger verschlüsselter Spaces-Speicher.');
  return JSON.parse(new TextDecoder().decode(await cryptoAPI.subtle.decrypt({name:'AES-GCM',iv:record.iv,additionalData:new TextEncoder().encode(aad)},key,record.cipher)));
}
export const encryptCrawlSource=(source,key,cryptoAPI=globalThis.crypto)=>encrypt(cleanCrawlSource(source),key,'context-spaces-source-v1:'+source.id,cryptoAPI);
export const decryptCrawlSource=async(record,id,key,cryptoAPI=globalThis.crypto)=>{if(!sourceId(id))throw Error('Ungültige Quellen-ID.');const value=cleanCrawlSource(await decrypt(record,key,'context-spaces-source-v1:'+id,cryptoAPI,500000));if(value.id!==id)throw Error('Quellenkennung stimmt nicht überein.');return value;};

export function createSpacesCrawlStore({indexedDB=globalThis.indexedDB,cryptoAPI=globalThis.crypto}={}){
  let opening,db,key;const lengths=new Map();
  async function open(){
    if(opening)return opening;
    opening=(async()=>{
      if(!indexedDB||!cryptoAPI?.subtle)throw Error('Der lokale Spaces-Speicher ist nicht verfügbar.');
      const r=indexedDB.open('context-spaces-crawl',1);r.onupgradeneeded=()=>{r.result.createObjectStore('keys');r.result.createObjectStore('meta');r.result.createObjectStore('sources');};db=await request(r);db.onversionchange=()=>{db.close();db=null;opening=null;};
      key=await request(db.transaction('keys').objectStore('keys').get('aes'));
      if(!key){const candidate=await cryptoAPI.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),tx=db.transaction('keys','readwrite'),done=complete(tx),store=tx.objectStore('keys');store.get('aes').onsuccess=event=>{key=event.target.result||candidate;if(!event.target.result)store.add(candidate,'aes');};await done;}
      if(key.extractable!==false||key.algorithm?.name!=='AES-GCM')throw Error('Ungültiger Spaces-Speicherschlüssel.');
    })();
    try{await opening;}catch(error){opening=null;throw error;}
  }
  return {
    async load(){
      await open();const row=await request(db.transaction('meta').objectStore('meta').get('state'));
      if(!row){lengths.clear();return {snapshot:cleanSnapshot(),documents:[],revision:0};}
      if(!Number.isSafeInteger(row.revision)||row.revision<1)throw Error('Ungültige Version des Spaces-Speichers.');
      const snapshot=cleanSnapshot(await decrypt(row,key,'context-spaces-meta-v1',cryptoAPI,12000000)),documents=[];let characters=0;
      // Individual encrypted records avoid re-encrypting the entire corpus for
      // each newly visited page. No raw HTML, audio, cookies or account fields.
      const nextLengths=new Map();
      for(const id of snapshot.sourceIds){const stored=await request(db.transaction('sources').objectStore('sources').get(id));if(!stored)throw Error('Eine gespeicherte Spaces-Quelle fehlt.');const value=await decryptCrawlSource(stored,id,key,cryptoAPI);characters+=value.text.length;if(characters>CRAWL_STORAGE_LIMITS.characters)throw Error('Der Spaces-Speicher überschreitet die Textgrenze.');documents.push(value);nextLengths.set(id,value.text.length);}
      lengths.clear();for(const [id,length] of nextLengths)lengths.set(id,length);
      return {snapshot,documents,revision:row.revision};
    },
    async save(snapshot,revision,{source}={}){
      if(!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)throw Error('Ungültige Version des Spaces-Speichers.');
      await open();const value=cleanSnapshot(snapshot),cleanSource=source?cleanCrawlSource(source):null;
      const nextLengths=new Map();let characters=0;
      for(const id of value.sourceIds){const length=cleanSource?.id===id?cleanSource.text.length:lengths.get(id);if(length===undefined)throw Error('Die Quellenliste enthält unbekannte Inhalte. Lade den Index neu.');characters+=length;if(characters>CRAWL_STORAGE_LIMITS.characters)throw Error('Die lokale Textgrenze ist erreicht.');nextLengths.set(id,length);}
      const encrypted=await encrypt(value,key,'context-spaces-meta-v1',cryptoAPI,12000000),record=cleanSource?await encryptCrawlSource(cleanSource,key,cryptoAPI):null;
      if(source&&!value.sourceIds.includes(source.id))throw Error('Die neue Quelle fehlt in der gespeicherten Liste.');
      return new Promise((resolve,reject)=>{
        const tx=db.transaction(['meta','sources'],'readwrite'),meta=tx.objectStore('meta'),sources=tx.objectStore('sources');let conflict=false;
        meta.get('state').onsuccess=event=>{
          if((event.target.result?.revision||0)!==revision){conflict=true;tx.abort();return;}
          if(record)sources.put(record,source.id);
          const keep=new Set(value.sourceIds);sources.getAllKeys().onsuccess=keys=>{for(const id of keys.target.result)if(!keep.has(id))sources.delete(id);};
          meta.put({...encrypted,revision:revision+1},'state');
        };
        tx.oncomplete=()=>{lengths.clear();for(const [id,length] of nextLengths)lengths.set(id,length);resolve(revision+1);};tx.onerror=tx.onabort=()=>reject(Error(conflict?'Ein anderer Tab hat den Spaces-Index geändert. Lade den Arbeitsbereich neu.':'Spaces-Quellen konnten nicht gespeichert werden.'));
      });
    },
    close(){db?.close();db=null;opening=null;},
  };
}
