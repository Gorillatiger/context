import {createSearchClient} from './search-client.js';
import {brandClass,brandLogo} from './brand-logos.js';

const LIMIT=24,EXCERPT=180;
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=(value,max=200)=>typeof value==='string'?value.slice(0,max):'';
const kindNames={projects:'Projekte',project:'Projekt',tasks:'Aufgaben',task:'Aufgabe',notes:'Notizen',note:'Notiz',links:'Links',link:'Link',bookmarks:'Ablage',bookmark:'Ablage',tools:'Tools',tool:'Tool',diaries:'Dev Diaries',diary:'Dev Diary',calendar:'Termine',calendars:'Termine',events:'Termine',messages:'Nachrichten',message:'Nachricht',updates:'Mitteilungen',update:'Mitteilung',files:'Dateien',file:'Datei',boards:'Boards',board:'Board',browser:'Browser',sources:'Quellen',source:'Quelle',chats:'Chats',chat:'Chat',mail:'Mail',service:'Kursinhalt',miro:'Boardinhalt'};
const sourceNames={context:'Context',local:'Lokal',spaces:'TH-Spaces',mattermost:'Mattermost',gitlab:'GitLab',webmail:'TH-Mail',outlook:'Outlook',gmail:'Gmail',google:'Google',drive:'Google Drive',browser:'Browser',miro:'Miro',knowledge:'Projektwissen',assistant:'Gespeicherte Chats',inventory:'Studio-Inventar',sciebo:'Sciebo',signal:'Signal',whatsapp:'WhatsApp',zoom:'Zoom',github:'GitHub',obsidian:'Obsidian'};
const paths={search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',file:'<path d="M5 3h9l5 5v13H5Zm9 0v5h5M9 12h6m-6 4h6"/>',external:'<path d="M9 4H4v16h16v-5m-7-11h7v7m-11 4L20 4"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',back:'<path d="M19 12H5m6-6-6 6 6 6"/>',filter:'<path d="M4 5h16l-6 7v6l-4 2v-8Z"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18a8 8 0 0 1-13-3"/>',agent:'<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8m0-12.8L5.6 18.4"/>'};
const icon=name=>`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.file}</svg>`;
const sourceIcon=source=>{
  // Single-purpose Google records use the matching bundled mark rather than
  // the combined Calendar/Drive connection logo. Unknown sources stay generic.
  const googleAsset=source==='drive'?'googledrive':source==='google'?'googlecalendar':'';
  if(googleAsset)return `<span class="tool-icon brand-logo brand-${googleAsset} small" aria-hidden="true"><img src="./brands/${googleAsset}.svg" alt="" width="40" height="40" decoding="async" draggable="false"></span>`;
  if(source==='gmail')return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></svg>';
  const aliases={github:'github-submissions',local:'context',knowledge:'context',assistant:'context',browser:'web'};
  const asset=Object.hasOwn(aliases,source)?aliases[source]:source;
  return brandClass(asset)?brandLogo(asset,{small:true}):['context','web','inventory'].includes(asset)?brandLogo(asset,{small:true}):icon('file');
};
function timestamp(value){
  if(typeof value!=='string'||value.length>80||!/^\d{4}-\d{2}-\d{2}T/.test(value))return '';
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
  return `<time datetime="${escape(date.toISOString())}">${escape(date.toLocaleDateString('de-DE',{day:'numeric',month:'short',year:'numeric'}))}</time>`;
}
function originalURL(value){
  if(typeof value!=='string'||!value.trim())return '';
  try{const url=new URL(value);return !url.username&&!url.password&&(url.protocol==='https:'||url.protocol==='http:'&&url.origin===globalThis.location?.origin)?url.href:'';}catch{return '';}
}
function snippet(result){
  const value=short(result.text||result.excerpt,EXCERPT),offset=Number.isSafeInteger(result.excerptOffset)?result.excerptOffset:0;
  const ranges=(Array.isArray(result.matchedRanges)?result.matchedRanges:[]).slice(0,30).filter(r=>Number.isSafeInteger(r?.start)&&Number.isSafeInteger(r?.end)&&r.end>r.start)
    .map(r=>({start:Math.max(0,r.start-offset),end:Math.min(value.length,r.end-offset)})).filter(r=>r.end>r.start&&r.start<value.length).sort((a,b)=>a.start-b.start);
  let html='',cursor=0;
  for(const range of ranges){if(range.end<=cursor)continue;const start=Math.max(cursor,range.start);html+=escape(value.slice(cursor,start))+'<mark>'+escape(value.slice(start,range.end))+'</mark>';cursor=range.end;}
  return html+escape(value.slice(cursor));
}

export function createSearchView({dialog,getContext=()=>({}),getDocuments=()=>[],onOpen=()=>{},onCrawl,onRefreshSources,onAgentSearch,onClose=()=>{},onStatus=()=>{},clientFactory=createSearchClient}={}){
  if(!dialog?.addEventListener||!dialog?.querySelector)throw new Error('Suchdialog fehlt.');
  const doc=dialog.ownerDocument||globalThis.document;
  let client,disposed=false,opened=false,built=false,loaded=false,refreshVersion=0,queryVersion=0,loading=null,timer,controller,returnFocus,sourceController,sourceRefreshVersion=0,sourceRefreshBusy=false;
  let query='',course='',kind='',source='',offset=0,totalMatches=0,resultMode='',pageFocus=false,documents=[],results=[],selected=-1,stats={},complete=false,warnings=[],error='',pending=false,indexing=false,persistBusy=false;
  const context=()=>getContext()||{};
  const workspace=()=>context().workspace||context();
  const find=selector=>dialog.querySelector(selector);
  const publishStatus=value=>{
    if(disposed)return;
    stats={...stats,...value};
    if(value?.status==='error'){loaded=false;indexing=false;pending=false;error='Die lokale Suche ist nicht verfügbar. Bitte erneut öffnen.';abortSearch();results=[];totalMatches=0;selected=-1;if(built)renderResults();}
    if(built)renderStatus();onStatus(value);
  };
  client=clientFactory({onStatus:publishStatus});
  function abortSearch(){clearTimeout(timer);controller?.abort();controller=null;queryVersion++;}
  function shell(){
    dialog.classList.add('context-search');dialog.setAttribute('aria-labelledby','search-title');
    dialog.innerHTML=`
      <div class="context-search-head">
        <h2 id="search-title" class="sr-only">Alles durchsuchen</h2>${icon('search')}
        <label class="sr-only" for="context-search-input">Alle verfügbaren Inhalte durchsuchen</label>
        <input id="context-search-input" type="search" maxlength="500" autocomplete="off" spellcheck="false" placeholder="Alles durchsuchen …" aria-controls="context-search-results">
        <button type="button" class="context-search-icon" data-search-action="close" aria-label="Suche schließen" title="Suche schließen">${icon('close')}</button>
      </div>
      <div class="context-search-toolbar">
        <div class="context-search-count" id="context-search-count" role="status" aria-live="polite"></div>
        <details id="context-search-filter-menu" class="context-search-filter-menu">
          <summary title="Kurs, Dienst oder Inhalt filtern">${icon('filter')}<span id="context-search-filter-label">Filter</span></summary>
          <div class="context-search-filters">
            <label for="context-search-course">Kurs<select id="context-search-course" aria-label="Kurs filtern"></select></label>
            <label for="context-search-source">Dienst<select id="context-search-source" aria-label="Dienst filtern"></select></label>
            <label for="context-search-kind">Inhalt<select id="context-search-kind" aria-label="Inhaltsart filtern"></select></label>
            <button type="button" class="context-search-reset" data-search-action="reset-filters">Filter zurücksetzen</button>
          </div>
        </details>
      </div>
      <div id="context-search-active-filters" class="context-search-active-filters" hidden></div>
      <div class="context-search-error" role="alert" hidden></div>
      <div class="context-search-scroll"><ol id="context-search-results" class="context-search-results" aria-label="Suchergebnisse"></ol></div>
      <nav id="context-search-pages" class="context-search-pages" aria-label="Trefferseiten" hidden>
        <button type="button" id="context-search-previous" data-search-action="previous" aria-label="Vorherige Trefferseite" title="Vorherige Trefferseite" aria-controls="context-search-results">${icon('back')}<span>Vorherige</span></button>
        <span id="context-search-page"></span>
        <button type="button" id="context-search-next" data-search-action="next" aria-label="Nächste Trefferseite" title="Nächste Trefferseite" aria-controls="context-search-results"><span>Nächste</span>${icon('arrow')}</button>
      </nav>
      <footer class="context-search-footer">
        <div class="context-search-footer-row"><div id="context-search-index" class="context-search-index" role="status" aria-live="polite"></div>
          ${typeof onRefreshSources==='function'?`<button type="button" id="context-search-refresh" class="context-search-icon" data-search-action="refresh-sources" aria-label="Quellen aktualisieren" title="Verbundene Quellen aktualisieren">${icon('refresh')}</button>`:''}
          ${typeof onAgentSearch==='function'?`<button type="button" id="context-search-agent" class="context-search-agent" data-search-action="agent-search" aria-label="Suchfrage mit dem Assistenten bearbeiten">${icon('agent')}<span>KI fragen</span></button>`:''}
        </div>
        <details class="context-search-details"><summary>${icon('info')}<span>Quellen & Datenschutz</span></summary>
          <div id="context-search-scope"></div>
          ${typeof onCrawl==='function'?`<button type="button" id="context-search-crawl" class="context-search-source-action" data-search-action="crawl" aria-label="Spaces indexieren" title="Spaces-Kursseiten einlesen">${brandLogo('spaces',{small:true})}<span>Spaces-Unterseiten einlesen</span>${icon('arrow')}</button>`:''}
          <label class="context-search-persist"><input id="context-search-persist" type="checkbox"> Index lokal behalten</label>
          <p class="context-search-persist-note">Suchinhalte, auch private Nachrichten, werden lokal verschlüsselt gespeichert. Ausschalten löscht den Suchindex.</p>
        </details>
        <p class="context-search-keys"><span><kbd>↑</kbd><kbd>↓</kbd> auswählen · <kbd>↵</kbd> öffnen</span><span><kbd>esc</kbd> schließen</span></p>
      </footer>`;
    built=true;find('#context-search-input').value=query;filters();renderResults();renderStatus();
  }
  function filters(){
    const projects=Array.isArray(workspace().projects)?workspace().projects:[];
    if(course&&!projects.some(p=>p.id===course))course='';
    find('#context-search-course').innerHTML='<option value="">Alle Kurse</option>'+projects.filter(p=>!p.archived||p.id===course).map(p=>`<option value="${escape(p.id)}">${escape(short(p.name))}</option>`).join('');
    const kinds=[...new Set(documents.map(d=>short(d?.kind,80)).filter(Boolean))].sort();
    const sources=[...new Set([...documents.map(d=>short(d?.source,80)),...(Array.isArray(context().sources)?context().sources.map(s=>short(s?.source,80)):[])].filter(Boolean))].sort();
    if(kind&&!kinds.includes(kind))kind='';if(source&&!sources.includes(source))source='';
    find('#context-search-kind').innerHTML='<option value="">Alle Inhalte</option>'+kinds.map(value=>`<option value="${escape(value)}">${escape(kindNames[value]||value)}</option>`).join('');
    find('#context-search-source').innerHTML='<option value="">Alle Dienste</option>'+sources.map(value=>`<option value="${escape(value)}">${escape(sourceNames[value]||value)}</option>`).join('');
    find('#context-search-course').value=course;find('#context-search-kind').value=kind;find('#context-search-source').value=source;
    renderFilters();
  }
  function renderFilters(){
    const projects=Array.isArray(workspace().projects)?workspace().projects:[];
    const active=[course&&{action:'clear-course',label:short(projects.find(p=>p.id===course)?.name)||'Kurs'},source&&{action:'clear-source',label:sourceNames[source]||short(source,80)},kind&&{action:'clear-kind',label:kindNames[kind]||short(kind,80)}].filter(Boolean);
    find('#context-search-filter-label').textContent=active.length?`Filter · ${active.length}`:'Filter';
    const strip=find('#context-search-active-filters');strip.hidden=!active.length;
    strip.innerHTML=active.map(item=>`<button type="button" data-search-action="${item.action}" aria-label="Filter entfernen: ${escape(item.label)}" title="Filter entfernen: ${escape(item.label)}"><span>${escape(item.label)}</span>${icon('close')}</button>`).join('');
  }
  function renderStatus(){
    const confirmed=client?.stats?.()||stats;
    const count=Number.isSafeInteger(confirmed.documents)?confirmed.documents:0;
    const partial=complete===false||Number(confirmed.omitted)>0||!!confirmed.truncated;
    const persistence=confirmed.persistence||stats.persistence||{enabled:false,state:'off'};
    const storage=persistence.enabled?(persistence.state==='stored'?'Lokal verschlüsselt gespeichert':persistence.state==='saving'?'Speichert verschlüsselt …':persistence.state==='error'?'Speichern fehlgeschlagen':'Lokales Speichern aktiv'):'Arbeitsspeicher'+(persistence.state==='error'?' · Speicherfehler':'');
    const offline=globalThis.navigator?.onLine===false?' · offline':'';
    find('#context-search-index').textContent=(confirmed.status==='error'?'Suchindex nicht verfügbar':sourceRefreshBusy?'Quellen werden aktualisiert …':indexing?'Index wird aktualisiert …':`${count} Inhalte${partial?' · Teilindex':''}`)+' · '+storage+offline;
    const refreshButton=find('#context-search-refresh');if(refreshButton){refreshButton.disabled=sourceRefreshBusy;refreshButton.setAttribute('aria-busy',String(sourceRefreshBusy));}
    const agentButton=find('#context-search-agent');if(agentButton)agentButton.disabled=!query.trim()||sourceRefreshBusy;
    const checkbox=find('#context-search-persist');checkbox.checked=persistence.enabled===true;checkbox.disabled=persistBusy;
    const allWarnings=[...warnings];if(Number(confirmed.omitted)>0)allWarnings.push(`${confirmed.omitted} Inhalte wurden wegen der Indexgrenzen ausgelassen.`);
    if(confirmed.truncated)allWarnings.push('Einige Inhalte sind gekürzt.');
    if(Number(confirmed.lastSearch?.omittedCandidates)>0||confirmed.lastSearch?.expansionTruncated||confirmed.lastSearch?.queryTruncated)allWarnings.push('Diese Suche erreicht eine Suchgrenze. Präzisiere den Suchbegriff oder die Filter.');
    const statuses=(Array.isArray(context().sources)?context().sources:[]).filter(s=>s?.source).map(s=>`<li>${sourceIcon(s.source)}<span><strong>${escape(sourceNames[s.source]||short(s.source))}</strong><small>${escape(({connected:'Eingelesener Stand',snapshot:'Browser-Auszug',error:'Abruf fehlgeschlagen',login_required:'Anmeldung erforderlich',not_configured:'Nicht verbunden'})[s.status]||'Stand unbekannt')}${s.complete===false?' · unvollständig':''}</small>${s.message?`<span>${escape(short(s.message,600))}</span>`:''}</span></li>`).join('');
    find('#context-search-scope').innerHTML=`<p>Die Treffer stammen aus lokal eingelesenen Inhalten. Weitere Inhalte können beim Anbieter vorhanden sein. Deine Suchbegriffe bleiben auf diesem Gerät.</p>${statuses?`<ul class="context-search-sources">${statuses}</ul>`:''}${allWarnings.length?`<details class="context-search-limits"><summary>Hinweise zur Abdeckung · ${allWarnings.length}</summary><ul>${allWarnings.slice(0,10).map(w=>`<li>${escape(short(w,600))}</li>`).join('')}</ul></details>`:''}<p>${LIMIT} Treffer pro Seite. Alle Treffer im lokalen Index sind über die Seiten erreichbar. Originale öffnen beim jeweiligen Dienst.</p>`;
    const alert=find('.context-search-error');alert.hidden=!error;alert.textContent=error;
  }
  function renderResults(){
    const old=doc?.activeElement?.dataset?.searchResult,wasResult=opened&&dialog.contains(doc?.activeElement)&&old!==undefined;
    const related=query&&resultMode==='or';
    find('#context-search-count').textContent=pending?(indexing?'Index wird geladen …':'Suche …'):results.length?`${offset+1}–${offset+results.length} von ${totalMatches} Treffern${related?' · ähnliche Treffer · nicht alle Suchwörter gefunden':''}`:query?'Keine Treffer':'Verfügbare Inhalte · lokale Suche';
    find('#context-search-results').setAttribute('aria-busy',String(pending));find('#context-search-results').setAttribute('start',String(offset+1));
    find('#context-search-pages').hidden=totalMatches<=LIMIT;
    find('#context-search-previous').disabled=pending||offset===0;
    find('#context-search-next').disabled=pending||offset+LIMIT>=totalMatches;
    find('#context-search-page').textContent=totalMatches?`Seite ${Math.floor(offset/LIMIT)+1} von ${Math.ceil(totalMatches/LIMIT)}`:'';
    const projects=Array.isArray(workspace().projects)?workspace().projects:[];
    find('#context-search-results').innerHTML=results.length?results.map((item,index)=>{
      const url=originalURL(item.url),label=short(item.title)||'Ohne Titel';
      const contentType=item.status==='metadata'?'Nur Metadaten':item.status==='excerpt'?'Quellenauszug':item.truncated?'Auszug':'';
      const meta=[sourceNames[item.source]||short(item.source,80),projects.find(p=>p.id===item.projectId)?.name,kindNames[item.kind]||short(item.kind,80)].filter(Boolean).join(' · ');
      const excerpt=snippet(item);
      return `<li class="context-search-row" data-active="${index===selected}"><button type="button" class="context-search-result" id="context-search-result-${index}" data-search-result="${index}" aria-label="${escape(label)} öffnen">${sourceIcon(item.source)}<span><strong>${escape(label)}</strong><small>${escape(short(meta,280))}${contentType?`<span class="context-search-content-type">${escape(contentType)}</span>`:''}${timestamp(item.updatedAt)}</small>${excerpt?`<span class="context-search-excerpt">${excerpt}</span>`:''}</span>${icon('arrow')}</button>${url?`<a class="context-search-original" href="${escape(url)}" target="_blank" rel="noopener noreferrer" aria-label="Original öffnen: ${escape(label)}" title="Original öffnen">${icon('external')}</a>`:''}</li>`;
    }).join(''):`<li class="context-search-empty">${pending?'Lokalen Index vorbereiten …':query?'Suchbegriff oder Filter ändern.':'Bereits erfasste Inhalte erscheinen hier.'}</li>`;
    if(wasResult&&selected>=0)find(`#context-search-result-${selected}`)?.focus({preventScroll:true});
  }
  function queueSearch(wait=100,resetPage=true){
    if(resetPage){offset=0;totalMatches=0;pageFocus=false;}
    abortSearch();if(!opened||disposed)return;
    pending=true;results=[];selected=-1;renderFilters();renderResults();renderStatus();
    const scroll=find('.context-search-scroll');if(scroll)scroll.scrollTop=0;
    const version=queryVersion;
    timer=setTimeout(()=>void runSearch(version),wait);
  }
  async function runSearch(version){
    try{
      if(loading)await loading;
      if(disposed||!opened||version!==queryVersion)return;
      if(!loaded)throw new Error('Local index unavailable');
      controller=new AbortController();
      const found=await client.search(query,{projectId:course,...(kind?{kinds:[kind]}:{}),...(source?{sources:[source]}:{}),limit:LIMIT,offset,excerptLength:EXCERPT,signal:controller.signal});
      if(disposed||!opened||version!==queryVersion)return;
      if(!Array.isArray(found))throw new Error('Invalid local results');
      const searchStats=client.stats?.().lastSearch;
      results=found.slice(0,LIMIT);totalMatches=Number.isSafeInteger(searchStats?.totalMatches)&&searchStats.totalMatches>=0?searchStats.totalMatches:offset+results.length;resultMode=searchStats?.mode||'';
      selected=-1;pending=false;error='';renderResults();renderStatus();
      if(pageFocus){pageFocus=false;if(results.length)select(0);else find('#context-search-input')?.focus({preventScroll:true});}
    }catch(err){
      if(disposed||!opened||version!==queryVersion||err?.name==='AbortError')return;
      pending=false;results=[];totalMatches=0;error='Die lokale Suche ist nicht verfügbar. Bitte erneut öffnen.';renderResults();renderStatus();
      if(pageFocus){pageFocus=false;find('#context-search-input')?.focus({preventScroll:true});}
    }
  }
  async function refresh(){
    if(disposed)return;
    const version=++refreshVersion;abortSearch();loaded=false;indexing=true;pending=true;offset=0;totalMatches=0;pageFocus=false;results=[];selected=-1;if(built){renderResults();renderStatus();}
    const job=(async()=>{
      try{
        const collection=await getDocuments();if(disposed||version!==refreshVersion)return;
        const next=Array.isArray(collection)?collection:collection?.documents;if(!Array.isArray(next))throw new Error('Invalid local documents');
        const confirmed=await client.replace(next);if(disposed||version!==refreshVersion)return;
        documents=next;stats={...stats,...confirmed};complete=!Array.isArray(collection)&&collection.complete===true;warnings=Array.isArray(collection?.warnings)?collection.warnings.filter(w=>typeof w==='string').slice(0,20):[];
        loaded=true;indexing=false;error='';if(built){filters();renderStatus();}if(opened)queueSearch(0);
      }catch{
        if(disposed||version!==refreshVersion)return;
        indexing=false;pending=false;error='Der lokale Suchindex konnte nicht aktualisiert werden.';if(built){renderResults();renderStatus();}
      }
    })();
    loading=job;await job;if(loading===job)loading=null;
  }
  async function open({projectId='',query:initialQuery=''}={}){
    if(disposed)return;
    if(opened){find('#context-search-input')?.focus({preventScroll:true});return;}
    returnFocus=doc?.activeElement;opened=true;query=short(initialQuery,500);kind='';source='';offset=0;totalMatches=0;pageFocus=false;course=short(projectId,100);error='';pending=true;results=[];selected=-1;
    shell();if(!dialog.open)dialog.showModal();find('#context-search-input').focus({preventScroll:true});
    if(!loaded&&!loading)await refresh();else queueSearch(0);
  }
  function close(){
    if(!opened)return;opened=false;abortSearch();sourceController?.abort();sourceController=null;sourceRefreshVersion++;sourceRefreshBusy=false;if(dialog.open)dialog.close();
    if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});onClose();
  }
  async function openResult(index){
    const item=results[index];if(!item||pending||disposed)return;close();
    try{await onOpen(item);}catch{if(disposed)return;await open();error='Der Treffer konnte nicht geöffnet werden.';renderStatus();}
  }
  async function openCrawler(){
    if(!opened||disposed||typeof onCrawl!=='function')return;
    close();const version=queryVersion;
    try{await onCrawl();}catch{if(disposed||opened||version!==queryVersion)return;await open();error='Der Spaces-Dialog konnte nicht geöffnet werden.';renderStatus();}
  }
  // Provider reads and AI handoffs are explicit actions. Typing only searches
  // the local index; close/dispose invalidates unfinished source refreshes.
  async function refreshSources(){
    if(!opened||disposed||sourceRefreshBusy||typeof onRefreshSources!=='function')return;
    const version=++sourceRefreshVersion,signal=(sourceController=new AbortController()).signal;
    sourceRefreshBusy=true;error='';renderStatus();
    try{
      await onRefreshSources({query,projectId:course,source,kind,signal});
      if(disposed||!opened||signal.aborted||version!==sourceRefreshVersion)return;
      await refresh();
    }catch(err){
      if(disposed||!opened||signal.aborted||version!==sourceRefreshVersion||err?.name==='AbortError')return;
      error='Die Quellen konnten nicht aktualisiert werden. Der bisherige lokale Stand bleibt durchsuchbar.';
    }finally{
      if(version===sourceRefreshVersion){sourceRefreshBusy=false;sourceController=null;if(built&&!disposed)renderStatus();}
    }
  }
  async function agentSearch(){
    if(!opened||disposed||sourceRefreshBusy||!query.trim()||typeof onAgentSearch!=='function')return;
    const request={query:query.trim(),projectId:course,source,kind};close();const version=queryVersion;
    try{await onAgentSearch(request);}catch{if(disposed||opened||version!==queryVersion)return;await open({projectId:request.projectId});error='Der Assistent konnte nicht geöffnet werden.';renderStatus();}
  }
  function resetFilters(action){
    if(action==='reset-filters'||action==='clear-course')course='';
    if(action==='reset-filters'||action==='clear-source')source='';
    if(action==='reset-filters'||action==='clear-kind')kind='';
    filters();queueSearch(0);if(action!=='reset-filters')find('#context-search-input')?.focus({preventScroll:true});
  }
  function select(index){
    if(!results.length||pending)return;
    if(index<0){selected=-1;find('#context-search-input').focus({preventScroll:true});}
    else {selected=Math.min(results.length-1,index);find(`#context-search-result-${selected}`)?.focus({preventScroll:true});find(`#context-search-result-${selected}`)?.scrollIntoView?.({block:'nearest'});}
    dialog.querySelectorAll('.context-search-row').forEach((row,i)=>row.dataset.active=String(i===selected));
  }
  function changePage(direction){
    if(pending||disposed||!opened)return;
    const next=offset+direction*LIMIT;if(next<0||next>=totalMatches)return;
    offset=next;pageFocus=true;queueSearch(0,false);
  }
  const onInput=event=>{if(event.target.id==='context-search-input'&&!event.isComposing){query=short(event.target.value,500);queueSearch();}};
  const onComposition=event=>{if(event.target.id==='context-search-input'){query=short(event.target.value,500);queueSearch();}};
  const onChange=event=>{
    if(event.target.id==='context-search-course'){course=event.target.value;queueSearch(0);}
    else if(event.target.id==='context-search-kind'){kind=event.target.value;queueSearch(0);}
    else if(event.target.id==='context-search-source'){source=event.target.value;queueSearch(0);}
    else if(event.target.id==='context-search-persist'){
      const enabled=event.target.checked;persistBusy=true;renderStatus();
      void client.optPersist(enabled).then(()=>{if(disposed)return;persistBusy=false;error='';renderStatus();}).catch(()=>{if(disposed)return;persistBusy=false;error=enabled?'Verschlüsseltes Speichern ist nicht verfügbar. Der Index bleibt im Arbeitsspeicher.':'Der gespeicherte Suchindex konnte nicht gelöscht werden. Schließe weitere App-Fenster und versuche es erneut.';renderStatus();});
    }
  };
  const onClick=event=>{
    const menu=find('#context-search-filter-menu');if(menu?.open&&!menu.contains(event.target))menu.open=false;
    const target=event.target.closest?.('[data-search-result],[data-search-action]');
    if(target&&dialog.contains(target)){event.preventDefault();event.stopPropagation();if(target.dataset.searchAction==='close')close();else if(target.dataset.searchAction==='crawl')void openCrawler();else if(target.dataset.searchAction==='refresh-sources')void refreshSources();else if(target.dataset.searchAction==='agent-search')void agentSearch();else if(['reset-filters','clear-course','clear-source','clear-kind'].includes(target.dataset.searchAction))resetFilters(target.dataset.searchAction);else if(target.dataset.searchAction==='previous')changePage(-1);else if(target.dataset.searchAction==='next')changePage(1);else void openResult(Number(target.dataset.searchResult));}
  };
  const onKey=event=>{
    if(event.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();const menu=find('#context-search-filter-menu');if(menu?.open){menu.open=false;menu.querySelector('summary')?.focus({preventScroll:true});}else close();return;}
    const input=event.target.id==='context-search-input',result=event.target.closest?.('[data-search-result]');
    if(!input&&!result)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopPropagation();const current=result?Number(result.dataset.searchResult):-1;select(current+(event.key==='ArrowDown'?1:-1));}
    else if(event.key==='Enter'){event.preventDefault();event.stopPropagation();void openResult(result?Number(result.dataset.searchResult):selected>=0?selected:0);}
  };
  const onCancel=event=>{event.preventDefault();close();};
  const onDialogClose=()=>close();
  const listeners={input:onInput,compositionend:onComposition,change:onChange,click:onClick,keydown:onKey,cancel:onCancel,close:onDialogClose};
  for(const [name,handler] of Object.entries(listeners))dialog.addEventListener(name,handler);
  function dispose(){if(disposed)return;close();disposed=true;refreshVersion++;abortSearch();for(const [name,handler] of Object.entries(listeners))dialog.removeEventListener(name,handler);client.dispose();documents=[];results=[];}
  return {open,refresh,close,dispose};
}
