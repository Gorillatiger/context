import {archiveSource} from './chat-archive.js';
import {validateDate} from './core.js';
import {courseRoot,scopedURL} from './companion-scan.js';
const str=(v,max=200)=>typeof v==='string'?v.slice(0,max):'';
function cleanFindings(value,limit){return (Array.isArray(value)?value:[]).slice(0,limit).map(f=>{
    if(!/^[a-f0-9]{64}$/.test(f.id||'')||!['new','accepted','done','dismissed'].includes(f.status)||!f.source||typeof f.evidence!=='string')throw new Error('Ungültiges Begleiter-Gedächtnis.');
    return {id:f.id,title:str(f.title,180),projectId:str(f.projectId,80),sourceId:str(f.sourceId,160),source:archiveSource(f.source),evidence:str(f.evidence,700),due:validateDate(f.due||''),reason:str(f.reason,500),method:f.method==='ai'?'ai':'local',status:f.status,taskId:str(f.taskId,80),stale:f.stale===true,changed:f.changed===true};
  });}
export function cleanMemory(value={}){
  const findings=cleanFindings(value.findings,150),archived=cleanFindings(value.archived,1500);
  const reviewed=Object.fromEntries(Object.entries(value.reviewed||{}).filter(([key,v])=>key.length<=200&&/^[a-f0-9]{64}$/.test(v)).slice(-10000));
  const settings={local:value.settings?.local!==false,automaticAI:value.settings?.automaticAI===true,autoProvider:['kiconnect','openrouter','local'].includes(value.settings?.autoProvider)?value.settings.autoProvider:'',mission:str(value.settings?.mission,800)};
  const log=(Array.isArray(value.log)?value.log:[]).slice(0,40).map(r=>({id:str(r.id,80),at:str(r.at,80),label:str(r.label,180),detail:str(r.detail,600),status:['running','done','error','interrupted'].includes(r.status)?r.status:'done',provider:str(r.provider,40),model:str(r.model,160),tokens:Number.isSafeInteger(r.tokens)&&r.tokens>=0?r.tokens:0}));
  const liveSources=(Array.isArray(value.liveSources)?value.liveSources:[]).slice(-80).map(d=>{
    const source=archiveSource(d);if(source.kind!=='browser'||!source.url||!source.id?.startsWith('live:'))throw new Error('Ungültige gespeicherte Browserquelle.');
    let courseURL;
    if(d.courseURL!==undefined){const root=courseRoot({links:[{tool:'spaces',url:d.courseURL}]});if(!root||root.url!==d.courseURL||scopedURL(source.url,root)!==source.url)throw new Error('Ungültige Herkunft der gespeicherten Browserquelle.');courseURL=root.url;}
    return {...source,...(courseURL?{courseURL}:{}),text:str(source.text,20000)};
  });
  const scanCoverage=(Array.isArray(value.scanCoverage)?value.scanCoverage:[]).slice(0,200).map(c=>({projectId:str(c.projectId,80),status:['read','partial','login_required','error','not_linked','not_scanned'].includes(c.status)?c.status:'not_scanned',pages:Number.isSafeInteger(c.pages)&&c.pages>=0?Math.min(12,c.pages):0,message:str(c.message,400),checkedAt:str(c.checkedAt,80)}));
  return {version:1,findings,archived,reviewed,settings,log,liveSources,scanCoverage,lastLocal:str(value.lastLocal,80),lastAI:str(value.lastAI,80)};
}
const req=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const finish=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error||new Error('Gedächtnis konnte nicht gespeichert werden.'));});
export async function encryptMemory(memory,key){const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('context-companion-v1')},key,new TextEncoder().encode(JSON.stringify(cleanMemory(memory))));return {iv,cipher};}
export async function decryptMemory(record,key){return cleanMemory(JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:record.iv,additionalData:new TextEncoder().encode('context-companion-v1')},key,record.cipher))));}
export function createCompanionMemory(){
  let opening,db,key;
  async function open(){if(opening)return opening;opening=(async()=>{
    if(!globalThis.indexedDB||!crypto?.subtle)throw new Error('Das lokale Begleiter-Gedächtnis ist nicht verfügbar.');
    const r=indexedDB.open('context-companion-memory',1);r.onupgradeneeded=()=>{r.result.createObjectStore('keys');r.result.createObjectStore('memory');};db=await req(r);db.onversionchange=()=>db.close();
    key=await req(db.transaction('keys').objectStore('keys').get('aes'));
    if(!key){const candidate=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),tx=db.transaction('keys','readwrite'),finished=finish(tx),store=tx.objectStore('keys');store.get('aes').onsuccess=e=>{key=e.target.result||candidate;if(!e.target.result)store.add(candidate,'aes');};await finished;}
  })();return opening;}
  return {
    async load(){await open();const row=await req(db.transaction('memory').objectStore('memory').get('state'));return {memory:row?await decryptMemory(row,key):cleanMemory(),revision:row?.revision||0};},
    async save(memory,revision){await open();const encrypted=await encryptMemory(memory,key);return new Promise((resolve,reject)=>{
      const tx=db.transaction('memory','readwrite'),store=tx.objectStore('memory');let conflict=false;
      store.get('state').onsuccess=e=>{if((e.target.result?.revision||0)!==revision){conflict=true;tx.abort();return;}store.put({...encrypted,revision:revision+1},'state');};
      tx.oncomplete=()=>resolve(revision+1);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(new Error(conflict?'Ein anderer Tab hat das Begleiter-Gedächtnis geändert. Lade die Ansicht neu.':'Das Gedächtnis konnte nicht gespeichert werden.'));
    });}
  };
}
