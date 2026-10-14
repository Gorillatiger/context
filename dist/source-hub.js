import {platformCatalog,platformDocumentURL} from './source-catalog.js';
import {createPlatformSourceStore,cleanPlatformSources} from './source-store.js';
import {miroBoardSources} from './miro-knowledge.js';
import {redactKnowledge,searchKnowledge} from './knowledge.js';
import {brandLogo} from './brand-logos.js';
import {currentPlatformFindings} from './platform-links.js';
import {renderSourceFiles} from './source-files.js';
const labels={miro:'Miro',gitlab:'GitLab',sciebo:'Sciebo',mattermost:'Mattermost'};
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const abort=()=>new DOMException('Abgebrochen','AbortError');
// A Miro row stays valid for the connection that produced it: the Nango account, or the public visitor overview.
const miroAccount=(status,generation)=>!!status&&/^[a-f0-9]{64}$/.test(generation||'')&&(status.connected===true&&status.boardRead!==false&&generation===status.generation||status.visitor===true&&generation===status.visitorGeneration);
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const originIcon='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 14 4-4M8 16l-1 1a4.2 4.2 0 0 1-6-6l4-4a4.2 4.2 0 0 1 6 0m2 10a4.2 4.2 0 0 0 6 0l4-4a4.2 4.2 0 0 0-6-6l-1 1"/></svg>';
const controlIcon=name=>'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+({read:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 8a7 7 0 0 1 12-2l2 3M4 15l2 3a7 7 0 0 0 12-2"/>',open:'<path d="M9 4H4v16h16v-5m-7-11h7v7m-11 4L20 4"/>',connect:'<path d="m9 6-3 3a5 5 0 0 0 7 7l3-3M7 2l4 4m7 7 4 4M3 7l4 4m7 7 4 4m-8 1-3 3"/>'}[name]||'')+'</svg>';
export function createSourceHub({getWorkspace,onChange=()=>{},onNotice=()=>{},onOpen=()=>{},onConnections=()=>{},onDiscover,bridge=globalThis.window?.contextDesktop,store=createPlatformSourceStore()}={}){
  let rows=[],revision=0,signature='',registry=null,epoch=0,storeReadyPromise,storeReadyFailed=false,loadPromise,loadFailed=false,registryPromise,miroStatus=null,closed=false,busy='',error='',saving=Promise.resolve(),suppressHydration=false;
  const requests=new Map(),states=new Map(),transactions=new Set(),filePages=new Map(),openMaterials=new Set();
  let discovering=false;
  const available=()=>typeof bridge?.service==='function'&&typeof bridge?.miro==='function';
  const catalog=()=>platformCatalog(getWorkspace());
  const changed=()=>{if(!closed)onChange();};
  function current(row){return catalog().some(source=>source.id===row.sourceId&&source.revision===row.revision&&source.url===row.url&&source.projectId===row.projectId&&source.service===row.service);}
  function currentAccount(row){return row.service==='miro'?miroAccount(miroStatus,row.accountGeneration):!!registry?.accounts?.[row.service]&&row.accountGeneration===registry.accounts[row.service];}
  function documents(){return rows.filter(current).flatMap(row=>row.documents.map(doc=>({...doc,accountGeneration:row.accountGeneration})));}
  async function native(channel,message,signal){
    if(!available())throw new Error('Aktuelle Context-Desktop-App benötigt.');if(signal?.aborted)throw abort();
    const id=crypto.randomUUID();let stopped=false;
    const cancel=()=>{stopped=true;void Promise.resolve().then(()=>bridge[channel]({action:'cancel',id})).catch(()=>{});};
    const controller=new AbortController();requests.set(id,{controller,cancel});const relay=()=>controller.abort();signal?.addEventListener('abort',relay,{once:true});controller.signal.addEventListener('abort',cancel,{once:true});
    let timer;const stoppedPromise=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(abort()),{once:true});timer=setTimeout(()=>{controller.abort();},channel==='miro'?180000:message.action==='read-file'?65000:30000);});
    try{const reply=await Promise.race([Promise.resolve().then(()=>controller.signal.aborted?undefined:bridge[channel]({...message,id})),stoppedPromise]);if(stopped||closed)throw abort();if(reply?.ok!==true)throw Object.assign(new Error(typeof reply?.error==='string'?reply.error:'Quelle konnte nicht gelesen werden.'),{code:reply?.code});return reply.value;}
    finally{clearTimeout(timer);requests.delete(id);signal?.removeEventListener('abort',relay);controller.signal.removeEventListener('abort',cancel);}
  }
  function stopWork(){for(const request of requests.values())request.controller.abort();for(const controller of transactions)controller.abort();}
  function invalidate(service){if(closed)return Promise.resolve();epoch++;stopWork();suppressHydration=true;if(service)rows=rows.filter(row=>row.service!==service);else rows=[];filePages.clear();openMaterials.clear();signature='';registry=null;registryPromise=null;miroStatus=null;states.clear();changed();const pending=commit(previous=>previous.filter(current));void pending.catch(reason=>{if(reason.name!=='AbortError'){error=reason.message;changed();}});return pending;}
  async function sync(){
    if(closed)throw abort();
    const sources=catalog(),next=JSON.stringify(sources);if(next!==signature){epoch++;stopWork();rows=rows.filter(current);filePages.clear();openMaterials.clear();signature=next;registry=null;registryPromise=null;}
    if(!available())return;
    if(registry)return;
    if(registryPromise)return registryPromise;
    const token=epoch,pending=(async()=>{
      const reply=await bridge.service({action:'registry',sources});if(token!==epoch||closed)throw abort();if(reply?.ok!==true)throw new Error(reply?.error||'Quellenregistrierung fehlgeschlagen.');
      const value=reply.value;if(!value||!/^[a-f0-9]{64}$/.test(value.generation||'')||!value.accounts||typeof value.accounts!=='object'||sources.some(source=>source.service!=='miro'&&!/^[a-f0-9]{64}$/.test(value.accounts[source.service]||'')))throw new Error('Ungültiger Kontostand.');
      const miro=await native('miro',{action:'status'});if(token!==epoch||closed)throw abort();if(miro?.connected&&(!/^[a-f0-9]{64}$/.test(miro.generation||''))||miro?.visitor&&!/^[a-f0-9]{64}$/.test(miro.visitorGeneration||''))throw new Error('Ungültiger Miro-Kontostand.');
      registry=value;miroStatus=miro;rows=rows.filter(row=>current(row)&&currentAccount(row));
    })();registryPromise=pending;
    try{return await pending;}finally{if(registryPromise===pending)registryPromise=null;}
  }
  // Every mutation stages a fresh snapshot in one queue, persists it under a
  // scope/account/abort fence, and only then publishes searchable documents.
  function storeReady(){if(!storeReadyPromise)storeReadyPromise=store.load().then(value=>{if(!value||!Array.isArray(value.rows)||!Number.isSafeInteger(value.revision)||value.revision<0)throw new Error('Ungültiger lokaler Quellenstand.');revision=value.revision;return value;}).catch(reason=>{storeReadyFailed=true;throw reason;});return storeReadyPromise;}
  function commit(transform,{token=epoch,signal,guard=()=>{}}={}){
    const controller=new AbortController(),relay=()=>controller.abort();if(signal?.aborted)controller.abort();signal?.addEventListener('abort',relay,{once:true});transactions.add(controller);
    const assertCurrent=()=>{if(closed||controller.signal.aborted||token!==epoch)throw abort();guard();};
    const run=saving.catch(()=>{}).then(async()=>{assertCurrent();await storeReady();assertCurrent();const snapshot=cleanPlatformSources(transform(rows).filter(current));const saved=await store.save(snapshot,{expectedRevision:revision,assertCurrent,signal:controller.signal});revision=saved;assertCurrent();rows=snapshot;return snapshot;});
    saving=run;return run.finally(()=>{transactions.delete(controller);signal?.removeEventListener('abort',relay);});
  }
  async function load({retry=false}={}){
    if(closed)throw abort();if(retry&&loadFailed){loadPromise=undefined;loadFailed=false;error='';if(storeReadyFailed){storeReadyPromise=undefined;storeReadyFailed=false;}}
    if(loadPromise)return loadPromise;const token=epoch;
    loadPromise=(async()=>{try{const value=await storeReady();if(closed||token!==epoch)throw abort();await sync();if(closed)throw abort();if(!available())return;const candidates=suppressHydration?[]:value.rows.filter(row=>current(row)&&currentAccount(row));await commit(previous=>{const combined=new Map(candidates.map(row=>[row.sourceId,row]));for(const row of previous)combined.set(row.sourceId,row);return [...combined.values()];});changed();}catch(reason){if(reason.name!=='AbortError'){loadFailed=true;rows=[];error=reason.message;changed();}else if(!closed)loadPromise=undefined;throw reason;}})();return loadPromise;
  }
  async function pageDocuments(page,source){
    if(page.sourceId!==source.id||page.projectId!==source.projectId||page.service!==source.service||typeof page.text!=='string'||page.text.length>12000||typeof page.url!=='string'||!/^[a-f0-9]{64}$/.test(page.contentRevision||'')||page.offset!==undefined&&(!Number.isSafeInteger(page.offset)||page.offset<0||page.offset>60000))throw new Error('Ungültiger Quellenstand.');
    const url=platformDocumentURL(source.service,page.url,source.url),text=redactKnowledge(page.text),docs=[];
    for(let start=0;start<text.length||start===0;){let end=Math.min(start+5000,text.length);if(/[\uD800-\uDBFF]/.test(text[end-1]||'')&&/[\uDC00-\uDFFF]/.test(text[end]||''))end--;const id=await digest(source.id+'\n'+url+'\n'+((page.offset||0)+start));docs.push({id:'service:'+id+':part0',kind:'service',sourceId:source.id,projectId:source.projectId,service:source.service,source:source.service,title:redactKnowledge(page.title).slice(0,200),url,text:text.slice(start,end),status:text.trim()?'excerpt':'metadata',contentRevision:page.contentRevision,updatedAt:page.checkedAt||'',checkedAt:page.checkedAt||'',trust:'untrusted-source',...(page.coverage&&typeof page.coverage==='object'?{extraction:page.coverage}:{}),...(Array.isArray(page.warnings)?{warnings:page.warnings.slice(0,10).map(value=>redactKnowledge(value).slice(0,300))}:{})});if(end>=text.length)break;start=end;}
    return docs;
  }
  async function read(sourceId,{action='read',query='',offset=0,url,expectedRevision,signal,projectId=''}={}){
    await load({retry:true});await sync();if(signal?.aborted)throw abort();
    const source=catalog().find(item=>item.id===sourceId&&(!projectId||item.projectId===projectId));if(!source)throw new Error('Diese Quelle liegt außerhalb des ausgewählten Kurses.');
    const token=epoch;states.set(sourceId,{state:'reading'});changed();
    try{
      let value,docs;
      if(source.service==='miro'){
        if(!['read','search'].includes(action))throw new Error('Miro-Boards werden ausschließlich gelesen.');
        value=await native('miro',{action:'board',body:{url:source.url,projectId:source.projectId}},signal);
        docs=await Promise.all(miroBoardSources(value,{workspace:getWorkspace(),projectId:source.projectId}).map(async doc=>({...doc,id:'miro:'+await digest(source.id+'\n'+doc.id)+':part'+(doc.id.match(/:part(\d+)$/)?.[1]||'0'),sourceId:source.id,service:'miro',text:redactKnowledge(doc.text)})));
      }else{
        const body={action,sourceId,...(action==='search'?{query,maxViews:3}:['read','read-file'].includes(action)?{offset}:{}),...(url?{url}:{}),...(expectedRevision?{expectedRevision}:{})};
        value=await native('service',body,signal);
        if(value.loginRequired||value.permissionRequired||value.navigationBlocked){await commit(previous=>previous.filter(row=>row.sourceId!==sourceId),{token,signal});filePages.delete(sourceId);states.set(sourceId,{state:value.loginRequired?'login':'permission'});changed();return {result:{loginRequired:!!value.loginRequired,permissionRequired:!!value.permissionRequired,message:'Quelle nicht zugänglich. Anmeldung im eingebauten Browser prüfen.'},documents:[]};}
        docs=(await Promise.all((value.documents||[value]).map(page=>pageDocuments(page,source)))).flat();
      }
      if(token!==epoch||signal?.aborted||!catalog().some(row=>row.id===source.id&&row.revision===source.revision))throw abort();
      const accountGeneration=source.service==='miro'?value.generation:value.accountGeneration;
      if(!/^[a-f0-9]{64}$/.test(accountGeneration||'')||value.scopeGeneration!==registry?.generation)throw new Error('Die Quellenanmeldung wurde geändert.');
      docs=docs.map(doc=>({...doc,accountGeneration}));
      if(source.service==='miro'){const latest=await native('miro',{action:'status'},signal);if(!miroAccount(latest,accountGeneration))throw new Error('Die Miro-Anmeldung wurde geändert.');miroStatus=latest;}
      else if(accountGeneration!==registry.accounts?.[source.service])throw new Error('Die Quellenanmeldung wurde geändert.');
      const guard=()=>{if(!catalog().some(row=>row.id===source.id&&row.revision===source.revision&&row.url===source.url&&row.projectId===source.projectId)||!currentAccount({service:source.service,accountGeneration}))throw abort();};
      let record;await commit(previous=>{
        const prior=previous.find(row=>row.sourceId===source.id&&row.accountGeneration===accountGeneration),merged=new Map((source.service==='miro'?[]:prior?.documents||[]).map(doc=>[doc.id,doc]));
        // A changed page replaces all windows of that page, preventing a new
        // opening paragraph from being combined with a stale later section.
        for(const [id,doc]of merged)if(docs.some(next=>next.url===doc.url&&next.contentRevision!==doc.contentRevision))merged.delete(id);
        for(const doc of docs)merged.set(doc.id,doc);
        record={sourceId:source.id,revision:source.revision,projectId:source.projectId,service:source.service,url:source.url,title:source.service==='miro'?value.board.title:source.title,documents:[...merged.values()],coverage:source.service==='miro'?value.coverage:'partial',warnings:[...new Set([...[...merged.values()].flatMap(doc=>doc.warnings||[]),...(value.warnings||[])])].slice(0,20),fetchedAt:value.fetchedAt||value.checkedAt||new Date().toISOString(),accountGeneration};
        return [...previous.filter(row=>row.sourceId!==source.id),record];
      },{token,signal,guard});
      if(token!==epoch||signal?.aborted)throw abort();
      // Offered-file leases are transient. Never restore them from disk, and
      // refresh the observed page again before a human requests its material.
      if(source.service!=='miro'&&action!=='read-file'&&Array.isArray(value.fileLinks)&&/^[a-f0-9]{64}$/.test(value.contentRevision||''))filePages.set(sourceId,{files:value.fileLinks.slice(0,50),contentRevision:value.contentRevision});
      states.set(sourceId,{state:'read'});changed();
      const results=(query?searchKnowledge(docs,query,5):docs.slice(0,5)).map(doc=>({id:doc.id,title:doc.title,text:doc.text.slice(0,1500),status:doc.status,url:doc.url,projectId:doc.projectId}));
      return {documents:docs,result:{sourceId,service:source.service,coverage:action==='read-file'?value.coverage:record.coverage,results,totalDocuments:docs.length,contentRevision:value.contentRevision,hasMore:value.hasMore,nextOffset:value.nextOffset,links:(value.links||[]).slice(0,20),fileLinks:(value.fileLinks||[]).slice(0,10),warnings:record.warnings,complete:false}};
    }catch(reason){if(reason.name!=='AbortError')states.set(sourceId,{state:'error',message:reason.message});else if(token===epoch)states.delete(sourceId);changed();throw reason;}
  }
  async function tool(name,args,signal,scope=''){
    if(name==='list_platform_sources'){await load({retry:true});await sync();return {documents:[],result:{sources:catalog().filter(row=>!scope||row.projectId===scope).map(row=>({id:row.id,title:row.title,service:row.service,projectId:row.projectId,url:row.url,state:states.get(row.id)?.state||'unread'})),complete:false}};}
    const action={read_platform:'read',search_platform:'search',open_platform:'open',read_platform_file:'read-file'}[name];if(!action)throw new Error('Unbekanntes Plattformwerkzeug.');return read(args.sourceId,{...args,action,signal,projectId:scope});
  }
  async function refresh({query='',projectId='',source='',signal}={}){
    const selected=catalog().filter(row=>(!projectId||row.projectId===projectId)&&(!source||row.service===source));let checked=0;const failures=[];
    for(const row of selected.slice(0,8)){if(signal?.aborted)throw abort();try{await read(row.id,{action:query&&row.service!=='miro'?'search':'read',query:query.slice(0,200),signal,projectId});checked++;}catch(reason){if(reason.name==='AbortError')throw reason;failures.push(row.title+': '+reason.message);}}
    return {checked,remaining:Math.max(0,selected.length-8),failures};
  }
  function originFor(row,findings=currentPlatformFindings(getWorkspace())){return findings.find(finding=>finding.projectId===row.projectId&&finding.service===row.service&&finding.url===row.url);}
  function render(){
    void load().catch(()=>{});const sources=catalog().filter(row=>!getWorkspace().activeCourse||row.projectId===getWorkspace().activeCourse),findings=currentPlatformFindings(getWorkspace());
    return `<section class="source-hub"><header><div><p class="small-label">KURSWISSEN</p><h1>Deine Quellen</h1></div><div class="source-hub-header-actions">${typeof onDiscover==='function'?`<button type="button" class="button secondary source-hub-discover" data-platform="discover" aria-label="Spaces-Kursseiten einlesen" title="Plattformlinks aus Spaces-Kursseiten finden" ${discovering?'disabled':''}>${brandLogo('spaces',{small:true})}<span>Spaces einlesen</span></button>`:''}<button type="button" class="button primary" data-platform="refresh" ${busy?'disabled':''}>${busy?'Wird gelesen …':'Aktualisieren'}</button></div></header>${!available()?'<p role="status">Lesezugriffe sind in der aktuellen Desktop-App verfügbar.</p>':''}${error?`<p class="error-message" role="alert">${esc(error)}</p>`:''}<div class="source-hub-list">${sources.map(row=>{const saved=rows.find(value=>value.sourceId===row.id&&current(value)),state=states.get(row.id),course=getWorkspace().projects.find(course=>course.id===row.projectId),origin=originFor(row,findings),originLabel=origin?'Originalfundstelle: '+(origin.sourceTitle||row.title):'';return `<article><div class="source-hub-logo">${brandLogo(row.service)}</div><div class="source-hub-name"><strong>${esc(saved?.title||row.title)}</strong><small>${esc(course?.name||'Arbeitsbereich')} · ${labels[row.service]}</small><span>${state?.state==='reading'?'Wird gelesen …':state?.state==='login'?'Anmeldung erforderlich':state?.state==='permission'?'Zugriff fehlt':state?.state==='error'?esc(state.message):saved?`${saved.documents.length} ${saved.documents.length===1?'Abschnitt':'Abschnitte'} · ${new Date(saved.fetchedAt).toLocaleDateString('de-DE')} · Auszug`:'Noch nicht gelesen'}</span>${saved?.warnings?.length?`<small class="source-hub-warning" role="status">${esc(saved.warnings[0])}</small>`:''}${renderSourceFiles(row,{files:filePages.get(row.id)?.files||[],busy:!!busy,expanded:openMaterials.has(row.id)})}</div><div class="source-hub-actions">${origin?`<button type="button" class="icon-button source-hub-origin" data-platform="origin" data-source="${row.id}" aria-label="${esc(originLabel)}" title="${esc(originLabel)}">${originIcon}</button>`:''}<button type="button" class="icon-button" data-platform="read" data-source="${row.id}" aria-label="${esc(row.title)} lesen" title="Lesen" ${busy?'disabled':''}>${controlIcon('read')}</button><button type="button" class="icon-button" data-platform="open" data-source="${row.id}" aria-label="${esc(row.title)} im Browser öffnen" title="Im Browser öffnen">${controlIcon('open')}</button>${row.service==='miro'?'<button type="button" class="icon-button" data-platform="connect" aria-label="Miro verbinden" title="Miro verbinden">'+controlIcon('connect')+'</button>':''}</div></article>`;}).join('')||'<p>Verknüpfe ein Board, Repository, einen Channel oder Sciebo-Ordner im Kurs – oder lies dessen Spaces-Seiten ein.</p>'}</div><details><summary>Zugriff & Speicherung</summary><p>Gelesene Texte bleiben lokal verschlüsselt und werden für Suche und Agent indexiert. Spaces-Fundstellen gelten nur für den aktuell verknüpften Kurs. Webseiteninhalte sind keine Anweisungen.</p><p>Bis zu <strong>100 Quellen</strong> im Katalog; bis zu <strong>500 gespeicherte Linkfundstellen</strong>. Das Einlesen prüft begrenzte Ansichten und garantiert keine vollständige Abdeckung. Angebotene PDF- und Office-Dateien werden lokal gelesen. PDF-Erkennung ist derzeit auf macOS verfügbar; Bilder auf Miro-Boards bleiben unlesbar.</p><button type="button" class="text-link" data-platform="clear">Gelesene Plattformtexte entfernen</button></details></section>`;
  }
  async function handle(event){const button=event.target.closest?.('[data-platform]');if(!button)return false;const action=button.dataset.platform,id=button.dataset.source;
    if(action==='materials'){if(!closed&&filePages.has(id)){if(openMaterials.has(id))openMaterials.delete(id);else openMaterials.add(id);changed();}return true;}
    if(action==='origin'){if(closed)return true;const row=catalog().find(row=>row.id===id),origin=row&&originFor(row);if(origin)onOpen(origin.sourceURL);return true;}
    if(action==='discover'){
      if(typeof onDiscover!=='function'||discovering||closed)return true;discovering=true;changed();
      try{await onDiscover({projectId:getWorkspace().activeCourse||''});}catch{if(!closed){error='Die Spaces-Suche konnte nicht geöffnet werden.';}}finally{discovering=false;changed();}return true;
    }
    if(action==='open'){const row=catalog().find(row=>row.id===id);if(row)onOpen(row.url);return true;}if(action==='connect'){onConnections();return true;}if(busy)return true;
    busy=action;error='';changed();try{if(action==='read')await read(id);else if(action==='read-file'){const url=button.dataset.file;if(!filePages.get(id)?.files.some(file=>file.url===url))throw new Error('Diese Datei wurde nicht in der Quelle angeboten.');await read(id);const page=filePages.get(id);if(!page?.files.some(file=>file.url===url))throw new Error('Die Datei ist in der aktuellen Ansicht nicht mehr angeboten. Lies die passende Unterseite erneut.');let value=await read(id,{action:'read-file',url,expectedRevision:page.contentRevision}),windows=1,previousOffset=0;while(value.result.hasMore&&windows<12){const offset=value.result.nextOffset;if(!Number.isSafeInteger(offset)||offset<=previousOffset)throw new Error('Ungültiger Dateifortschritt.');value=await read(id,{action:'read-file',url,offset,expectedRevision:value.result.contentRevision});previousOffset=offset;windows++;}onNotice(value.result.hasMore?'Datei nur teilweise gelesen – weitere Abschnitte über den Agenten lesen':value.result.warnings?.[0]||((value.documents||[]).some(doc=>doc.text.trim())?'Datei lokal gelesen':'Kein lesbarer Text gefunden'));}else if(action==='refresh'){const value=await refresh({projectId:getWorkspace().activeCourse});onNotice(value.checked+' Quellen gelesen'+(value.remaining?' · weitere Quellen einzeln öffnen':'')+(value.failures.length?' · '+value.failures.length+' Zugriffslücken':''));}else if(action==='clear'){await invalidate();}}catch(reason){if(reason.name!=='AbortError')error=reason.message;}finally{busy='';changed();}return true;
  }
  const unsubscribe=bridge?.onEvent?.(({type,detail})=>{if(type==='context-platform-auth')void invalidate(detail?.service);});
  return {render,handle,load,documents,catalog,tool,refresh,sync,invalidate,isBusy:()=>!!busy,dispose:()=>{if(closed)return saving.catch(()=>{});closed=true;epoch++;stopWork();filePages.clear();openMaterials.clear();unsubscribe?.();return saving.catch(()=>{}).finally(()=>store.close());}};
}
