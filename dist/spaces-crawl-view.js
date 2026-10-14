import {crawlSpaces,emptyCrawlState,validateCrawlState} from './spaces-crawl.js';
import {createSpacesCrawlStore,cleanCrawlSource,crawlSourcesForKnowledge,CRAWL_STORAGE_LIMITS} from './spaces-crawl-store.js';
import {agentBrowserAvailable,requestAgentBrowser} from './agent-browser.js';
import {courseRoot} from './companion-scan.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const glyph=name=>`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{play:'<path d="m8 5 11 7-11 7Z"/>',pause:'<path d="M8 5v14M16 5v14"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 8a7 7 0 0 1 12-2l2 3M4 15l2 3a7 7 0 0 0 12-2"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',external:'<path d="M9 4H4v16h16v-5m-7-11h7v7m-11 4L20 4"/>'}[name]||''}</svg>`;
const limitNames={'course-views':'500 Ansichten je Kurs','total-views':'2.000 Ansichten insgesamt','total-text':'20 Mio. Textzeichen','text':'60.000 Zeichen je Ansicht','links':'500 angebotene Kurslinks','controls':'300 Abschnittsschalter','depth':'8 verschachtelte Abschnitte','board-links':'100 Miro-Fundstellen je Ansicht','platform-links':'100 Plattformlinks je Ansicht'};
const date=value=>value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Berlin'}).format(new Date(value)):'Noch nicht geprüft';
function rows(state,projects){
  return projects.filter(p=>!p.archived).map(project=>{
    let root;try{root=courseRoot(project);}catch{}const session=state.sessions.find(s=>s.projectId===project.id&&s.root===root?.url);
    const views=session?.seen.length||0,pending=session?.queue.length||0,failed=session?.failed.length||0,limited=!!session?.limits.length||session?.seen.some(s=>s.status==='excerpt');
    return {project,root,views,pending,failed,limited,session,status:!root?'Kein Kurs-Space':!session?'Noch nicht eingelesen':pending?`${pending} offen`:failed?'Zugriffslücken':limited?'Teilstand':'Gefundene Seiten geprüft'};
  });
}
export function createSpacesCrawlView({dialog,getWorkspace,onModal,onChange=()=>{},onSearch=()=>{},onDiscovery=()=>{},isOtherBusy=()=>false,store=createSpacesCrawlStore(),request=requestAgentBrowser,available=agentBrowserAvailable,scan=crawlSpaces}={}){
  if(!dialog||typeof getWorkspace!=='function'||typeof onModal!=='function')throw Error('Spaces-Suchansicht fehlt.');
  let snapshot={version:1,state:emptyCrawlState(),sourceIds:[],lastRun:''},documents=new Map(),revision=0,ready=false,busy=false,disposed=false,controller,scope='',budget=100,error='',message='Speicher wird geöffnet …',coverage=[],used=0,opened=false,projection=[],projectionKey='',documentEpoch=0,conflict=false;
  const workspace=()=>getWorkspace();
  const selected=()=>workspace().projects.filter(p=>!p.archived&&(!scope||p.id===scope));
  const notify=()=>{if(disposed)return;render();onChange();};
  function persist(source,nextDocuments=documents){return store.save({...snapshot,sourceIds:[...nextDocuments.keys()]},revision,source?{source}:{}).then(value=>{revision=value;}).catch(err=>{error=err.message;conflict=/anderer Tab/.test(error);throw err;});}
  function prune(){
    snapshot.state=validateCrawlState(snapshot.state,{projects:workspace().projects});
    const roots=new Map(rows(snapshot.state,workspace().projects).filter(r=>r.root).map(r=>[r.project.id,r.root.url]));
    for(const [id,source] of documents)if(roots.get(source.projectId)!==source.courseURL){documents.delete(id);documentEpoch++;}
  }
  const loaded=store.load().then(result=>{
    if(disposed)return;snapshot=result.snapshot;revision=result.revision;documents=new Map(result.documents.map(d=>[d.id,d]));prune();ready=true;message='Lokale Kursquellen bereit.';documentEpoch++;notify();
  }).catch(err=>{if(disposed)return;error=err.message;message='Spaces-Speicher nicht verfügbar.';notify();});
  function render(){
    if(!opened||!dialog.open||disposed)return;
    const body=dialog.querySelector('#spaces-crawl-body');if(!body)return;
    const projects=workspace().projects.filter(p=>!p.archived),list=rows(snapshot.state,selected()),total=documents.size,characters=[...documents.values()].reduce((n,s)=>n+s.text.length,0),pending=list.reduce((n,r)=>n+r.pending,0);
    const active=dialog.ownerDocument?.activeElement,activeId=active?.id;
    const scroll=body.querySelector('.spaces-crawl-list')?.scrollTop||0;
    const details=new Set([...body.querySelectorAll('details[data-crawl-detail][open]')].map(element=>element.dataset.crawlDetail));
    body.innerHTML=`<div class="spaces-crawl-toolbar"><label>Kurse<select id="spaces-crawl-scope" ${busy?'disabled':''}><option value="">Alle verknüpften Kurse</option>${projects.map(p=>`<option value="${esc(p.id)}" ${scope===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label>Ansichten pro Lauf<select id="spaces-crawl-budget" ${busy?'disabled':''}>${[20,100,300].map(n=>`<option value="${n}" ${budget===n?'selected':''}>${n}</option>`).join('')}</select></label><button type="button" id="spaces-crawl-run" class="button primary" data-crawl-action="${busy?'pause':'start'}" ${!busy&&(!ready||conflict||isOtherBusy()||!available())?'disabled':''}>${glyph(busy?'pause':'play')}${busy?'Pausieren':pending?'Fortsetzen':'Spaces einlesen'}</button></div><div class="spaces-crawl-overview"><strong>${total} ${total===1?'Ansicht':'Ansichten'}</strong><span>${characters.toLocaleString('de-DE')} Textzeichen</span><span>${pending} offen</span></div><p class="spaces-crawl-status" role="status" aria-live="polite">${esc(message)}${busy?` · ${used}/${budget}`:''}</p>${error?`<p class="spaces-crawl-error" role="alert">${esc(error)}</p>`:''}${!available()?'<p class="spaces-crawl-error">Zum Einlesen die aktuelle Context-Mac-App öffnen. Gespeicherte Texte bleiben hier durchsuchbar.</p>':''}<div class="spaces-crawl-list" role="region" aria-label="Kursabdeckung" tabindex="0">${list.map(row=>{const detail=coverage.find(c=>c.projectId===row.project.id),status=detail?.status==='login_required'?'Anmeldung erforderlich':detail?.status==='permission_required'?'Nicht freigegeben':detail?.status==='update_required'?'App-Update erforderlich':row.status;return `<article class="spaces-crawl-course"><div><strong>${esc(row.project.name)}</strong><small>${row.views} erfasste Ansichten · ${row.pending} offen${row.failed?' · '+row.failed+' Fehler':''}</small></div><span class="spaces-crawl-badge ${row.failed||row.limited?'partial':''}">${esc(status)}</span>${row.root?`<a class="icon-button" href="${esc(row.root.url)}" target="_blank" rel="noopener noreferrer" aria-label="Kurs öffnen: ${esc(row.project.name)}" title="Kurs öffnen">${glyph('external')}</a>`:''}${detail?.message&&detail.status!=='read'?`<p>${esc(detail.message)}</p>`:''}${row.session?.limits.length?`<p>Begrenzung: ${esc(row.session.limits.map(code=>limitNames[code]||code).join(' · '))}</p>`:''}${row.session?.failed.length?`<details data-crawl-detail="${esc(row.project.id)}"><summary>Zugriffslücken</summary><ul>${row.session.failed.slice(0,12).map(job=>`<li>${esc(job.title||'Unterseite')}: ${esc(job.message)}</li>`).join('')}</ul></details>`:''}</article>`;}).join('')||'<p class="quiet-row">Zuerst eine konkrete Spaces-Kursseite mit einem Projekt verknüpfen.</p>'}</div><div class="spaces-crawl-footer"><button type="button" id="spaces-crawl-search" class="button secondary" data-crawl-action="search">${glyph('search')} Im Index suchen</button><button type="button" id="spaces-crawl-rescan" class="icon-button" data-crawl-action="rescan" ${busy||!ready||conflict?'disabled':''} aria-label="Gewählte Kurse erneut prüfen" title="Gewählte Kurse erneut prüfen">${glyph('refresh')}</button><small>Letzter Lauf: ${esc(date(snapshot.lastRun))}</small></div><details class="spaces-crawl-help" data-crawl-detail="privacy"><summary>Umfang &amp; Datenschutz</summary><p>Folgt angebotenen Kursunterseiten, Orga und Ressourcen über deine bestehende Spaces-Anmeldung. Nur lesbare HTML-Texte werden lokal verschlüsselt gespeichert; keine KI-Übertragung und keine Schreibaktionen. Schließen pausiert die Suche. Bis zu 500 Ansichten je Kurs, 2.000 insgesamt und 20 Mio. Textzeichen. Begrenzungen und Zugriffslücken bleiben sichtbar.</p><p>Dateien, Bilder, Mitgliederbereiche und versteckte Inhalte werden nicht automatisch eingelesen. Gefundene Miro-, Sciebo-, GitLab- und Mattermost-Links werden mit der Spaces-Fundstelle dem Kurs zugeordnet. Ihre Inhalte werden erst bei einem separaten Leseauftrag abgerufen. Die Kursseiten bleiben eine lokale Momentaufnahme.</p><p>„Erneut prüfen“ liest die gewählten Kurse neu ein. Bereits gespeicherte Texte bleiben bis zum erneuten Abruf als letzter Stand verfügbar. Nach Ende eines Laufs führt „Fortsetzen“ die gespeicherte Warteschlange weiter.</p></details>`;
    if(body.querySelector('.spaces-crawl-list'))body.querySelector('.spaces-crawl-list').scrollTop=scroll;
    for(const detail of body.querySelectorAll('details[data-crawl-detail]'))if(details.has(detail.dataset.crawlDetail))detail.open=true;
    if(activeId){const replacement=body.querySelector('#'+activeId);if(replacement&&!replacement.disabled)replacement.focus({preventScroll:true});}
  }
  async function start(rescan=false){
    await loaded;if(disposed||busy||!ready||conflict)return;
    if(!available()){error='Die aktuelle Context-Mac-App wird benötigt.';notify();return;}
    if(isOtherBusy()){error='Beende die andere Quellenprüfung oder den KI-Auftrag zuerst.';notify();return;}
    try{prune();}catch(err){error=err.message;notify();return;}const projects=selected(),ids=new Set(projects.map(p=>p.id)),outside=snapshot.state.sessions.filter(s=>!ids.has(s.projectId));
    const rootsAtStart=new Map(projects.map(project=>[project.id,courseRoot(project)?.url]));
    const initial={...snapshot.state,sessions:rescan?[]:snapshot.state.sessions.filter(s=>ids.has(s.projectId)),cursor:0};
    const mergeState=value=>{snapshot.state=validateCrawlState({...value,sessions:[...outside,...value.sessions]},{projects:workspace().projects});};
    controller=new AbortController();const runController=controller;busy=true;error='';used=0;message='Kursseiten werden eingelesen …';notify();
    try{
      const result=await scan({projects,state:initial,maxViews:budget,signal:runController.signal,request,
        onSource:async incoming=>{
          if(disposed||runController.signal.aborted)throw new DOMException('Pausiert','AbortError');
          const current=workspace().projects.find(p=>p.id===incoming.projectId&&!p.archived),root=current&&courseRoot(current);
          if(!root||root.url!==rootsAtStart.get(incoming.projectId))throw Error('Die Kursverbindung wurde geändert. Bitte erneut starten.');
          const source=cleanCrawlSource({...incoming,courseURL:root.url}),previous=documents.get(source.id),size=[...documents.values()].reduce((n,d)=>n+d.text.length,0)-(previous?.text.length||0)+source.text.length;
          if(size>CRAWL_STORAGE_LIMITS.characters||!previous&&documents.size>=CRAWL_STORAGE_LIMITS.sources)throw Error('Die lokale Quellengrenze ist erreicht.');
          const nextDocuments=new Map(documents);nextDocuments.set(source.id,source);
          await persist(source,nextDocuments);
          if(disposed||runController.signal.aborted)throw new DOMException('Pausiert','AbortError');
          const confirmed=workspace().projects.find(p=>p.id===source.projectId&&!p.archived);
          if(!confirmed||courseRoot(confirmed)?.url!==root.url)throw Error('Die Kursverbindung wurde geändert. Bitte erneut starten.');
          documents=nextDocuments;documentEpoch++;onChange();
          if(source.platformLinks.length)await onDiscovery(source,{projectId:source.projectId,courseURL:root.url,signal:runController.signal});
        },
        onProgress:async progress=>{if(disposed)throw new DOMException('Beendet','AbortError');mergeState(progress.state);used=progress.views;coverage=progress.coverage;message=progress.message;await persist();notify();},
      });
      if(disposed)return;mergeState(result.state);coverage=result.coverage;used=result.views;snapshot.lastRun=new Date().toISOString();await persist();
      const remaining=result.coverage.reduce((n,row)=>n+row.pending,0);
      message=result.interrupted?'Pausiert. Gelesene Texte und Warteschlange bleiben gespeichert.':remaining?`${result.views} ${result.views===1?'Ansicht':'Ansichten'} geprüft. ${remaining} ${remaining===1?'gefundene Ansicht wartet':'gefundene Ansichten warten'} auf Fortsetzen.`:'Lauf beendet. Kursabdeckung und Zugriffslücken siehe unten.';
    }catch(err){error=err.name==='AbortError'?'':err.message;message=err.name==='AbortError'?'Suche pausiert.':'Die Suche wurde angehalten.';}
    finally{busy=false;controller=null;notify();}
  }
  async function open(){
    if(disposed)return;scope=workspace().projects.some(p=>p.id===workspace().activeCourse&&!p.archived)?workspace().activeCourse:'';opened=true;onModal('<div id="spaces-crawl-body"></div>');render();await loaded;render();
  }
  function pause(){if(!controller||!busy)return;controller.abort();message='Suche wird pausiert …';notify();}
  const click=event=>{const button=event.target.closest?.('[data-crawl-action]');if(!button||button.disabled||!dialog.contains(button))return;event.preventDefault();event.stopPropagation();switch(button.dataset.crawlAction){case 'start':void start();break;case 'rescan':void start(true);break;case 'pause':pause();break;case 'search':pause();opened=false;dialog.close();onSearch();break;}};
  const change=event=>{if(event.target.id==='spaces-crawl-scope'){scope=event.target.value;coverage=[];render();}else if(event.target.id==='spaces-crawl-budget')budget=[20,100,300].includes(Number(event.target.value))?Number(event.target.value):100;};
  const close=()=>{if(opened&&(!dialog.open||!dialog.querySelector('#spaces-crawl-body'))){opened=false;pause();}};
  dialog.addEventListener('click',click);dialog.addEventListener('change',change);dialog.addEventListener('close',close);
  return {open,start,pause,loaded,isBusy:()=>busy,sources(){
    const projectKey=JSON.stringify(workspace().projects.map(p=>{let root='';try{root=courseRoot(p)?.url||'';}catch{}return [p.id,p.archived,root];}));const key=documentEpoch+projectKey;
    if(key!==projectionKey){projection=crawlSourcesForKnowledge([...documents.values()],workspace());projectionKey=key;}return projection;
  },summary:()=>({sources:documents.size,pending:snapshot.state.sessions.reduce((n,s)=>n+s.queue.length,0),ready,busy,error,lastRun:snapshot.lastRun}),dispose(){disposed=true;opened=false;controller?.abort();dialog.removeEventListener('click',click);dialog.removeEventListener('change',change);dialog.removeEventListener('close',close);store.close();}};
}
