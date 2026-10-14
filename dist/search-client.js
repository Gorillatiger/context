import {createSearchIndex,cleanSearchDocument,SEARCH_LIMITS} from './search-index.js';
import {createEncryptedSearchStorage} from './search-worker.js';

const abort=()=>new DOMException('Suche abgebrochen.','AbortError');
const PERSIST_KEY='context-search-persist-v1';
const emptyStats=()=>({documents:0,indexedCharacters:0,terms:0,postings:0,estimatedBytes:0,omitted:0,truncated:0,revision:0,lastDiff:{added:0,updated:0,removed:0,unchanged:0},lastSearch:{mode:'empty',candidates:0,totalMatches:0,offset:0,returned:0,omittedCandidates:0,expansionTruncated:false,queryTruncated:false},persistence:{enabled:false,state:'off'}});

export function createSearchClient({onStatus=()=>{}}={}){
  let disposed=false,worker,local,workerFailure,projectionOmitted=0,indexStatus='idle',last=emptyStats(),localPersistence={enabled:false,state:'off'},sequence=0,localQueue=Promise.resolve(),preferenceEpoch=0,preferenceError='',savedOptIn=false;const pending=new Map();
  const snapshot=()=>structuredClone({...last,status:indexStatus,persistence:{...last.persistence,...(preferenceError&&!last.persistence?.error?{state:'error',error:preferenceError}:{})}});
  const notify=(status,error='')=>{indexStatus=status;try{onStatus({...snapshot(),status,...(error||preferenceError?{error:error||preferenceError}:{})});}catch{/* Consumer rendering must not reject an index command. */}};
  try{savedOptIn=globalThis.localStorage?.getItem(PERSIST_KEY)==='yes';}catch{preferenceError='Die Suchspeicherfreigabe konnte nicht gelesen werden. Der Index bleibt im Arbeitsspeicher.';}
  function preference(enabled){
    try{if(enabled)globalThis.localStorage?.setItem(PERSIST_KEY,'yes');else globalThis.localStorage?.removeItem(PERSIST_KEY);preferenceError='';}
    catch{preferenceError=enabled?'Die Suchspeicherfreigabe konnte nicht für das nächste Öffnen gespeichert werden.':'Die Suchspeicherfreigabe konnte nicht entfernt werden. Die Cache-Löschung wird trotzdem versucht.';}
  }
  function failure(error){for(const item of pending.values()){item.cleanup();item.reject(error);}pending.clear();notify('error',error.message);}
  if(typeof globalThis.Worker==='function'){
    try{
      const url=new URL('./search-worker.js',import.meta.url),origin=globalThis.location?.origin;
      if(origin&&url.origin!==origin)throw new Error('Der Suchworker liegt außerhalb dieses App-Ursprungs.');
      if(!['http:','https:','file:'].includes(url.protocol))throw new Error('Ungültiger Suchworker-Ursprung.');
      worker=new Worker(url,{type:'module',name:'context-local-search'});
      worker.onmessage=event=>{
        const message=event.data;if(disposed||!message||typeof message!=='object')return;
        if(message.stats)last=message.stats;
        if(message.type==='status'){const {type,status,error,...stats}=message;last=stats;notify(status,error);return;}
        const item=pending.get(message.id);if(!item)return;pending.delete(message.id);item.cleanup();
        if(message.type==='error'){const error=new Error(message.error||'Die lokale Suche ist fehlgeschlagen.');error.name=message.name||'Error';item.reject(error);notify('ready',error.message);}
        else{item.resolve(message.result);notify('ready');}
      };
      worker.onerror=()=>{workerFailure=new Error('Der lokale Suchworker konnte nicht geladen werden.');failure(workerFailure);};worker.onmessageerror=()=>{workerFailure=new Error('Der lokale Suchworker lieferte ein ungültiges Ergebnis.');failure(workerFailure);};
    }catch(error){notify('error',error.message);}
  }
  // Compatibility fallback remains local and bounded. It never fetches code,
  // account state or documents. Persistence requires the worker environment.
  if(!worker)local=createSearchIndex();
  function rpc(op,data={},signal){
    if(disposed)return Promise.reject(new Error('Die lokale Suche wurde beendet.'));if(workerFailure)return Promise.reject(workerFailure);if(signal?.aborted)return Promise.reject(abort());
    const id=String(++sequence);notify(op==='search'?'searching':op==='replace'?'indexing':indexStatus);
    if(!worker){
      const work=localQueue.then(()=>{
        if(disposed||signal?.aborted)throw abort();let result;
        if(op==='search')result=local.search(data.query,{...data.options,signal});
        else if(op==='replace'){result=local.replace(data.documents);projectionOmitted=data.omitted||0;}
        else if(op==='clear'){result=local.clear();projectionOmitted=0;}
        else if(op==='optPersist'&&data.enabled)throw new Error('Verschlüsselter Suchspeicher benötigt den lokalen Suchworker.');
        else if(op==='optPersist'){localPersistence={enabled:false,state:'off'};result=local.stats();}
        last={...local.stats(),omitted:local.stats().omitted+projectionOmitted,persistence:{...localPersistence}};notify('ready');return op==='search'?result:snapshot();
      });localQueue=work.catch(()=>{});return work.catch(error=>{if(op==='optPersist'){localPersistence={enabled:false,state:'error',error:error.message};last={...last,persistence:{...localPersistence}};}notify(error.name==='AbortError'||op==='optPersist'?'ready':'error',error.message);throw error;});
    }
    return new Promise((resolve,reject)=>{
      const cancel=()=>{pending.delete(id);signal?.removeEventListener('abort',cancel);worker.postMessage({id,op:'cancel'});reject(abort());};
      const cleanup=()=>signal?.removeEventListener('abort',cancel);pending.set(id,{resolve,reject,cleanup});signal?.addEventListener('abort',cancel,{once:true});
      try{worker.postMessage({id,op,...data});}catch(error){pending.delete(id);cleanup();reject(error);notify('error',error.message);}
    });
  }
  // A remembered, deliberate yes is the only automatic cache read. Enqueue
  // it before any caller can replace the restored index with current sources.
  if(savedOptIn&&worker){
    void rpc('optPersist',{enabled:true}).catch(error=>{if(!disposed)notify(workerFailure?'error':'ready',error.message);});
  }else if(savedOptIn){
    localPersistence={enabled:false,state:'error',error:'Die gespeicherte Suchspeicherfreigabe benötigt einen lokalen Suchworker. Der Index bleibt im Arbeitsspeicher.'};last={...last,persistence:{...localPersistence}};notify('ready',localPersistence.error);
  }else if(preferenceError)notify('ready',preferenceError);
  return {
    replace(documents){
      if(!Array.isArray(documents))return Promise.reject(new TypeError('Der Suchindex benötigt eine Dokumentliste.'));
      // Clone only the known document fields before crossing the worker boundary.
      // Private mail routing targets, account objects and credentials never enter it.
      let characters=0;const clean=[];let omitted=Math.max(0,documents.length-SEARCH_LIMITS.documents*2);
      for(let i=0;i<Math.min(documents.length,SEARCH_LIMITS.documents*2);i++){
        const value=documents[i],doc=cleanSearchDocument(value,Math.min(SEARCH_LIMITS.text,Math.max(0,SEARCH_LIMITS.characters-characters)));
        if(!doc||clean.length>=SEARCH_LIMITS.documents){omitted++;continue;}
        characters+=doc.text.length;clean.push({...doc,originalLength:value.text.length,indexTruncated:doc.text.length<value.text.length||doc.title.length<value.title.length});
      }
      return rpc('replace',{documents:clean,omitted});
    },
    search(query,options={}){const {signal,...selected}=options||{};return rpc('search',{query,options:Object.fromEntries(['projectId','kinds','sources','limit','offset','excerptLength'].filter(key=>selected[key]!==undefined).map(key=>[key,selected[key]]))},signal);},
    clear:()=>rpc('clear'),stats:snapshot,
    optPersist(enabled){
      if(typeof enabled!=='boolean')return Promise.reject(new TypeError('Ungültige Suchspeicherfreigabe.'));
      const epoch=++preferenceEpoch;
      // Revoke the harmless preference first, even if another window later
      // blocks deletion of the encrypted database. Never re-enable on reload.
      if(!enabled)preference(false);
      if(!enabled&&(!worker||workerFailure)){
        if(disposed)return Promise.reject(new Error('Die lokale Suche wurde beendet.'));
        // Explicit opt-out must remove a cache created in an earlier worker
        // session even when this environment can only search in RAM.
        return createEncryptedSearchStorage().remove().then(()=>{localPersistence={enabled:false,state:'off'};last={...last,persistence:{...localPersistence}};notify(workerFailure?'error':'ready',workerFailure?.message||'');return snapshot();}).catch(error=>{localPersistence={enabled:false,state:'error',error:error.message};last={...last,persistence:{...localPersistence}};notify(workerFailure?'error':'ready',error.message);throw error;});
      }
      return rpc('optPersist',{enabled}).then(result=>{if(enabled&&epoch===preferenceEpoch&&!disposed){preference(true);notify('ready');}return snapshot();});
    },
    dispose(){if(disposed)return;disposed=true;worker?.terminate();local?.clear();failure(abort());last=emptyStats();indexStatus='disposed';},
  };
}
