import {buildKnowledge,redactKnowledge} from './knowledge.js';
import {dateKey} from './core.js';
import {aiRequest,providerName} from './ai-client.js';
import {createCompanionMemory,cleanMemory} from './companion-memory.js';
import {fingerprint,localFindings,reviewPlan,reviewPrompt,parseReview,mergeFindings,partitionFindings,matchingTask,urgency} from './companion-engine.js';
import {agentBrowserAvailable,requestAgentBrowser} from './agent-browser.js';
import {spaceBrowserURL} from './spaces.js';
import {scanCourseSpaces,pendingCourseOrder,courseRoot,scopedURL} from './companion-scan.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=at=>at?new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'short'}).format(new Date(at)):'Noch nicht geprüft';
const dueLabel={overdue:'Überfällig',today:'Heute fällig',soon:'Diese Woche',later:'Später',undated:'Frist offen'};

export async function readCourseSpace({project,request=requestAgentBrowser,signal}={}){
  if(!project||project.archived||!spaceBrowserURL(project)||typeof request!=='function')throw new Error('Dieser aktive Kurs hat keine gültige Spaces-Verbindung.');
  let first,last,sections=[];
  const read=async(command,options)=>{
    const page=await request(command,options);
    if(page?.loginRequired!==true){
      const offset=command.command==='read'?command.offset:0;
      if(page?.offset!==offset)throw new Error('Spaces lieferte keinen passenden Textabschnitt.');
      if(command.command==='start')first={url:page.url,title:page.title};
      else if(!first||page.url!==first.url||page.title!==first.title)throw new Error('Die Spaces-Seite hat sich während des Lesens geändert.');
    }
    last=page;if(page?.loginRequired!==true)sections.push(page.text);
    return page;
  };
  const result=await scanCourseSpaces({projects:[project],maxPages:1,signal,request:read});
  const row=result.coverage[0],source=result.sources[0];
  if(!source||result.interrupted||row.status==='error'||row.status==='login_required'||last?.hasMore!==true)return result;
  const root=courseRoot(project);
  let safeText=sections.map(redactKnowledge).join('');
  const active=()=>{if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');};
  try{
    // The manual action reads only this one view. Four native 5k sections keep
    // its original capacity without following any offered course link or tab.
    for(const offset of [10000,15000]){
      active();const tail=await read({command:'read',offset},{signal});active();
      if(tail?.loginRequired===true){row.status='login_required';row.message='Die Spaces-Anmeldung ist während der Prüfung abgelaufen.';return result;}
      if(!tail||typeof tail!=='object'||scopedURL(tail.url,root)!==source.url||typeof tail.text!=='string'||tail.text.length>5000||!Array.isArray(tail.links)||tail.links.length>45||tail.controls!==undefined&&(!Array.isArray(tail.controls)||tail.controls.length>30)||tail.hasMore!==undefined&&typeof tail.hasMore!=='boolean')throw new Error('Spaces lieferte einen ungültigen Textabschnitt.');
      safeText+=redactKnowledge(tail.text);source.text=safeText.slice(0,20000);source.status=tail.hasMore===true||safeText.length>20000?'excerpt':'full';source.updatedAt=new Date().toISOString();
      if(tail.hasMore!==true)break;
    }
    const otherViews=(last.controls||[]).some(c=>c&&/^(?:secondary-swap-menu-label|accordion-item-[a-zA-Z0-9_-]{1,80})$/.test(c.id||''))||last.links.some(link=>{try{return scopedURL(link?.url,root)!==source.url;}catch{return false;}});
    row.status=source.status==='excerpt'||otherViews?'partial':'read';
    row.message=source.status==='excerpt'?'Eine lesende Ansicht mit bis zu 20.000 Zeichen geprüft; weiterer Seitentext wurde durch das Textbudget nicht gelesen.':otherViews?'Eine lesende Ansicht geprüft; weitere angebotene Kursansichten wurden nicht geöffnet.':'Eine lesende Ansicht lokal geprüft. Das ist eine Momentaufnahme, keine vollständige Kursprüfung.';
  }catch(error){
    source.status='excerpt';
    if(signal?.aborted||error?.name==='AbortError'){result.interrupted=true;row.status='partial';row.message='Prüfung angehalten. Bereits gelesene Quellen bleiben erhalten.';}
    else{row.status='error';row.message=redactKnowledge(error?.message||'Spaces konnte nicht gelesen werden.').slice(0,400);}
  }
  return result;
}

export function createCompanion({getContext,getAI,onChange,onTask,onSource,onAsk,onRefreshSources=async()=>{},onAttention=()=>{}}){
  const store=createCompanionMemory();let memory=cleanMemory(),revision=0,ready=false,error='',storage='Gedächtnis wird geöffnet …',pending=0,saving=Promise.resolve(),conflict=false;
  let busy=false,localBusy=false,scanProgress='',abort,localStamp='',timer,showHistory=false,pendingChunks=0;
  const context=()=>getContext();
  const allFindings=()=>[...memory.archived,...memory.findings];
  function merge(incoming){Object.assign(memory,partitionFindings(mergeFindings(allFindings(),incoming,context().workspace,1650),context().workspace));}
  function docs(){const c=context();return buildKnowledge(c.workspace,c.updates,{platformSources:c.platformSources||[],browserSources:[...memory.liveSources,...(c.browserSources||[])],maxDocuments:20000}).filter(d=>!d.projectId||c.workspace.projects.some(p=>p.id===d.projectId&&!p.archived));}
  const visibleFinding=f=>!context().workspace.projects.find(p=>p.id===f.projectId)?.archived;
  const openFindings=()=>memory.findings.filter(f=>f.status==='new'&&!f.stale&&visibleFinding(f)&&(f.changed||!matchingTask(context().workspace,f)));
  function notify(){onAttention(openFindings().length);onChange();}
  function persist(){if(!ready||conflict)return Promise.resolve(false);const snapshot=cleanMemory(memory);pending++;storage='Gedächtnis wird gesichert …';
    saving=saving.then(async()=>{try{if(conflict)return false;revision=await store.save(snapshot,revision);storage='Gedächtnis lokal verschlüsselt gespeichert';return true;}catch(e){error=e.message;storage='Nicht gespeichert';if(/anderer Tab/.test(error))conflict=true;return false;}finally{pending--;notify();}});return saving;
  }
  function log(label,detail,status='done',extra={}){const item={id:crypto.randomUUID(),at:new Date().toISOString(),label,detail,status,...extra};memory.log.unshift(item);memory.log=memory.log.slice(0,40);return item;}
  function savedSources(findings){return findings.map(f=>{const position=f.source.text.indexOf(f.evidence),offset=Math.max(0,position-100);return {...f,source:{...f.source,text:f.source.text.slice(offset,offset+1800),offset,status:'excerpt'}};});}
  async function inspectLocal(force=false){
    if(!ready||conflict||localBusy||!force&&!memory.settings.local)return;
    localBusy=true;try{
    const c=context(),documents=docs(),stamp=await fingerprint([documents.map(d=>[d.id,d.projectId,d.text,d.status]),c.workspace.tasks,dateKey()]);
    if(!force&&stamp===localStamp)return;localStamp=stamp;
    const findings=await localFindings(documents);
    merge(savedSources(findings));
    for(const f of allFindings()){const d=documents.find(d=>d.id===f.sourceId);f.stale=!d||d.projectId!==f.projectId||!d.text.includes(f.evidence);}
    memory.lastLocal=new Date().toISOString();
    log('Lokalen Stand geprüft',`${documents.length} Quellen und ${c.workspace.tasks.length} Aufgaben abgeglichen. ${openFindings().length} Hinweise zur Prüfung. Keine Daten versendet.`);
    await persist();notify();
    }finally{localBusy=false;}
  }
  async function review({automatic=false}={}){
    if(!ready||busy||conflict)return;
    const run=async lock=>{
      if(lock===null){error='Eine andere Ansicht prüft den Arbeitsbereich gerade.';notify();return;}
      busy=true;error='';abort=new AbortController();notify();
      const record=log(automatic?'Automatische KI-Prüfung':'KI-Prüfung gestartet','Quellen werden vorbereitet.','running');
      try{
        await inspectLocal();
        await saving;
        // Refresh memory before an unattended run; another view may have changed it.
        const latest=await store.load();if(latest.revision!==revision){memory=latest.memory;revision=latest.revision;memory.log.unshift(record);}
        if(conflict||automatic&&(!memory.settings.automaticAI||memory.settings.autoProvider!==getAI().provider)){record.status='interrupted';record.detail='Automatische Prüfung ist pausiert oder der Anbieter wurde geändert.';return;}
        const initial=context(),scope=automatic?'':initial.workspace.activeCourse||'';
        let ai=getAI();if(ai.busy)throw new Error('Der Assistent bearbeitet gerade einen Auftrag. Prüfe danach erneut.');
        await ai.load();ai=getAI();if(!ai.ready)throw new Error('Verbinde zuerst deinen KI-Anbieter und wähle ein Modell in Hochschul-KI.');
        const all=docs(),documents=all.filter(d=>!scope||d.projectId===scope),plan=await reviewPlan(documents,memory.reviewed,{mission:memory.settings.mission,tasks:initial.workspace.tasks});
        pendingChunks=plan.totalChunks;
        if(!plan.batches.length){record.status='done';record.detail='Alle verfügbaren Textabschnitte sind mit diesem Stand bereits geprüft. Neue Inhalte lösen eine neue Prüfung aus.';return;}
        let added=0,read=0,tokens=0;
        for(const batch of plan.batches.slice(0,3)){
          if(abort.signal.aborted)throw new DOMException('Abgebrochen','AbortError');
          if(!await persist())throw new Error(error||'Prüfung angehalten: Das Gedächtnis konnte nicht gesichert werden.');
          const fresh=await store.load();
          if(fresh.revision!==revision){conflict=true;throw new Error('Ein anderer Tab hat das Begleiter-Gedächtnis geändert. Die KI-Prüfung wurde angehalten. Lade die Ansicht neu.');}
          if(getAI().provider!==ai.provider||automatic&&(!fresh.memory.settings.automaticAI||fresh.memory.settings.autoProvider!==ai.provider))throw new DOMException('Abgebrochen','AbortError');
          const label=initial.workspace.projects.find(p=>p.id===batch.projectId)?.name||'Ohne Kurszuordnung';
          record.detail=`${label} · ${read+1}. Quellenpaket lesen`;record.provider=ai.provider;record.model=ai.model;notify();
          const answer=await aiRequest(ai.provider,'chat',{body:{model:ai.model,messages:[{role:'user',content:reviewPrompt(batch,initial.workspace,dateKey(),memory.settings.mission)}]},signal:abort.signal});
          if(abort.signal.aborted)throw new DOMException('Abgebrochen','AbortError');
          const findings=await parseReview(answer.content,batch);
          const current=docs();
          if(batch.chunks.some(chunk=>!current.some(d=>d.id===chunk.source.id&&d.projectId===chunk.source.projectId&&d.text===chunk.source.text)))throw new Error('Quellen wurden während der Prüfung geändert. Prüfe den aktuellen Stand erneut.');
          const before=allFindings().length;merge(savedSources(findings));added+=allFindings().length-before;
          batch.chunks.forEach(chunk=>memory.reviewed[chunk.key]=chunk.version);read+=batch.chunks.length;tokens+=answer.totalTokens||0;
          record.tokens=tokens;if(!await persist())throw new Error(error||'Prüfung angehalten: Das Gedächtnis konnte nicht gesichert werden.');
        }
        pendingChunks=Math.max(0,plan.totalChunks-read);record.status='done';record.detail=`${read} Textabschnitte gelesen · ${added} neue Hinweise · ${pendingChunks} Abschnitte noch ungeprüft. Hinweise brauchen deine Prüfung.`;
      }catch(e){record.status=e.name==='AbortError'?'interrupted':'error';record.detail=e.name==='AbortError'?'Prüfung angehalten. Bereits belegte Hinweise bleiben erhalten.':e.message;error=record.detail;}
      finally{memory.lastAI=new Date().toISOString();busy=false;abort=null;await persist();notify();}
    };
    if(navigator.locks)await navigator.locks.request('context-companion-review',{ifAvailable:true},run);else await run({});
  }
  function update(){clearTimeout(timer);timer=setTimeout(()=>{void inspectLocal().catch(e=>{error=e.message;notify();});},700);}
  const loaded=store.load().then(result=>{memory=result.memory;revision=result.revision;for(const r of memory.log)if(r.status==='running'){r.status='interrupted';r.detail='Beim Schließen unterbrochen. Keine Aktion wurde fortgesetzt.';}ready=true;storage='Begleiter-Gedächtnis lokal geöffnet';update();notify();}).catch(e=>{error=e.message;storage='Gedächtnis nicht verfügbar';notify();});
  setInterval(()=>{if(document.visibilityState!=='visible')return;update();if(ready&&memory.settings.automaticAI&&!getAI().busy&&Date.now()-Date.parse(memory.lastAI||'1970-01-01')>=30*60000)void review({automatic:true});},60000);
  window.addEventListener('beforeunload',e=>{if(pending){e.preventDefault();e.returnValue='';}});
  window.addEventListener('context-ai-changed',()=>{abort?.abort();if(memory.settings.automaticAI){memory.settings.automaticAI=false;log('Automatik pausiert','Der KI-Anbieter wurde geändert. Aktiviere die automatische Prüfung für den neuen Anbieter bei Bedarf erneut.');void persist();notify();}});
  document.addEventListener('change',event=>{
    const input=event.target;
    if(input.id==='companion-local'){memory.settings.local=input.checked;void persist();if(input.checked)update();}
    if(input.id==='companion-auto-ai'){memory.settings.automaticAI=input.checked;memory.settings.autoProvider=getAI().provider;void persist();notify();if(input.checked)void review({automatic:true});}
  });
  document.addEventListener('submit',event=>{if(event.target.id!=='companion-mission-form')return;event.preventDefault();memory.settings.mission=event.target.elements.mission.value.trim().slice(0,800);void persist();notify();});
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-companion]');if(!button)return;
    const action=button.dataset.companion,finding=allFindings().find(f=>f.id===button.dataset.id);
    if(action==='local')void inspectLocal(true).catch(e=>{error=e.message;notify();});
    if(action==='review')void review();
    if(action==='stop')abort?.abort();
    if(action==='history'){showHistory=!showHistory;notify();}
    if(action==='source'&&finding)onSource(finding.source);
    if(action==='ask'&&finding)onAsk(`Prüfe diese mögliche Aufgabe für ${context().workspace.projects.find(p=>p.id===finding.projectId)?.name||'ohne Kurszuordnung'}: ${finding.title}. Quellenbeleg: ${finding.evidence}. Welche nächsten Schritte sind sinnvoll?`,finding.projectId);
    if(action==='accept'&&finding&&!conflict){try{const task=onTask(finding);finding.status='accepted';finding.changed=false;finding.taskId=task.id;log('Aufgabe übernommen',finding.title);void persist();notify();}catch(e){error=e.message;notify();}}
    if(['dismiss','done','restore'].includes(action)&&finding&&!conflict){try{const next=allFindings().map(f=>f.id===finding.id?{...f,status:action==='dismiss'?'dismissed':action==='done'?'done':'new'}:f);Object.assign(memory,partitionFindings(next,context().workspace));log(action==='restore'?'Hinweis wieder geöffnet':action==='done'?'Als bereits erledigt markiert':'Hinweis verworfen',finding.title);void persist();notify();}catch(e){error=e.message;notify();}}
    if(action==='export'){const url=URL.createObjectURL(new Blob([JSON.stringify({format:'context-companion-memory',version:1,memory:cleanMemory(memory)},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='context-begleiter-'+dateKey()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
    if(action==='live')void readSpace(button.dataset.id);
    if(action==='scan')void scan();
    if(action==='ask-all')onAsk('Prüfe die verfügbaren Kurse und Quellen. Was muss ich als Nächstes erledigen? Ordne jeden Schritt einem Kurs zu und nenne Frist, Quellenlink und fehlende Daten.',context().workspace.activeCourse||'');
  });
  async function scan(){
    if(!ready||busy||conflict)return;
    if(getAI().busy){error='Der Assistent arbeitet gerade. Starte die Quellenprüfung danach.';notify();return;}
    const run=async lock=>{
      if(lock===null){error='Eine andere Ansicht prüft gerade Quellen.';notify();return;}
      busy=true;error='';scanProgress='Verbindungen aktualisieren …';abort=new AbortController();
      const record=log('Quellenprüfung gestartet','Kursquellen werden lesend geprüft.','running');notify();
      try{
        await onRefreshSources();
        if(abort.signal.aborted)throw new DOMException('Abgebrochen','AbortError');
        const c=context(),projects=pendingCourseOrder(c.workspace.projects.filter(p=>!p.archived&&(!c.workspace.activeCourse||p.id===c.workspace.activeCourse)),memory.scanCoverage);
        if(!agentBrowserAvailable())throw new Error('Live-Spaces-Prüfung benötigt die aktuelle Context-Mac-App. Lokale Quellen sind weiterhin durchsuchbar.');
        const result=await scanCourseSpaces({projects,signal:abort.signal,request:(command,options)=>requestAgentBrowser({...command,background:true},options),onProgress:progress=>{scanProgress=typeof progress==='string'?progress:[c.workspace.projects.find(p=>p.id===progress.projectId)?.name,progress.message||'Kursquellen werden gelesen …'].filter(Boolean).join(' · ');record.detail=scanProgress;notify();}});
        const now=new Date().toISOString();
        const checked=new Set(result.coverage.map(c=>c.projectId));
        memory.scanCoverage=[...memory.scanCoverage.filter(c=>!checked.has(c.projectId)),...result.coverage.map(c=>({...c,checkedAt:now}))];
        const fresh=new Map(memory.liveSources.map(d=>[d.id,d]));
        for(const d of result.sources)if(c.workspace.projects.some(p=>p.id===d.projectId&&!p.archived))fresh.set(d.id,d);
        memory.liveSources=[...fresh.values()].slice(-80);
        record.status=result.interrupted?'interrupted':'done';record.detail=`${result.sources.length} Spaces-Seiten gelesen. ${result.coverage.filter(c=>c.status!=='read').length} Kurse mit Grenzen oder Zugriffslücken. Keine KI-Übertragung.`;
        await inspectLocal(true);
      }catch(e){record.status=e.name==='AbortError'?'interrupted':'error';record.detail=e.message;error=e.name==='AbortError'?'Quellenprüfung angehalten. Bereits gelesene Quellen bleiben gespeichert.':e.message;}
      finally{busy=false;scanProgress='';abort=null;await persist();notify();}
    };
    if(navigator.locks)await navigator.locks.request('context-companion-review',{ifAvailable:true},run);else await run({});
  }
  async function readSpace(projectId){
    if(!ready||busy||conflict)return;const c=context(),project=c.workspace.projects.find(p=>p.id===projectId&&!p.archived),url=spaceBrowserURL(project);if(!url)return;
    busy=true;error='';abort=new AbortController();notify();const record=log('Kurs-Space lesen',project.name,'running');
    try{
      const result=await readCourseSpace({project,signal:abort.signal});
      const current=context().workspace.projects.find(p=>p.id===projectId&&!p.archived);
      if(!current||spaceBrowserURL(current)!==url)throw new Error('Die Kursverknüpfung wurde während des Lesens geändert. Bitte den aktuellen Kurs erneut einlesen.');
      const fresh=new Map(memory.liveSources.map(d=>[d.id,d]));for(const source of result.sources)fresh.set(source.id,source);
      memory.liveSources=[...fresh.values()].slice(-80);
      const row=result.coverage[0];memory.scanCoverage=[...memory.scanCoverage.filter(c=>c.projectId!==projectId),{...row,checkedAt:new Date().toISOString()}];
      record.status=result.interrupted?'interrupted':['error','login_required'].includes(row.status)?'error':'done';
      record.detail=`${project.name} · ${result.sources.reduce((n,d)=>n+d.text.length,0)} Zeichen lokal eingelesen. ${row.message} Keine KI-Übertragung.`;
      if(record.status==='error')error=row.message;
      await inspectLocal(true);
    }catch(e){record.status='error';record.detail=e.message;error=e.message;}
    finally{busy=false;abort=null;await persist();notify();}
  }
  function coverage(){const c=context(),documents=docs().filter(d=>!c.workspace.activeCourse||d.projectId===c.workspace.activeCourse);return {total:documents.length,incomplete:documents.filter(d=>d.status!=='full').length,remote:documents.filter(d=>d.kind==='updates'||d.kind==='browser').length};}
  function card(f){const workspace=context().workspace,task=matchingTask(workspace,f),status=urgency(f.due,dateKey()),name=workspace.projects.find(p=>p.id===f.projectId)?.name||'Kurs zuordnen';
    return `<article class="companion-finding ${f.stale?'stale':''}"><div class="companion-finding-meta"><span class="tag">${esc(name)}</span><span class="companion-deadline ${status}">${dueLabel[status]}${f.due?' · '+esc(f.due):''}</span><span>${f.method==='ai'?'KI-Hinweis':'Lokal erkannt'}${f.stale?' · Quelle verändert':f.changed?' · Aktualisierte Angabe':''}</span></div><h3>${esc(f.title)}</h3><p>${esc(f.reason)}</p><details><summary>Beleg ansehen</summary><blockquote>${esc(f.evidence)}</blockquote><button class="text-link" data-companion="source" data-id="${f.id}">${esc(f.source.title)} ↗</button>${f.source.url?`<a class="companion-source-link" href="${esc(f.source.url)}" target="_blank" rel="noopener noreferrer">Originalquelle ↗</a>`:''}</details><div class="companion-finding-actions">${f.status==='new'&&(!task||f.changed)?`<button class="button primary" data-companion="accept" data-id="${f.id}" ${f.stale||conflict?'disabled':''}>${task?'Änderung übernehmen':'Als Aufgabe übernehmen'}</button><button class="text-link" data-companion="ask" data-id="${f.id}">Mit Agent planen ↗</button><button class="text-link" data-companion="done" data-id="${f.id}">Schon erledigt</button><button class="text-link" data-companion="dismiss" data-id="${f.id}">Betrifft mich nicht</button>`:`<span class="subtle-note">${task?task.status==='done'?'Aufgabe erledigt':'In deinen Aufgaben':({done:'Als erledigt markiert',dismissed:'Verworfen',accepted:'Übernommen'})[f.status]||'Quelle erneut prüfen'}</span>${task?'<button class="text-link" data-view="tasks">Aufgabe ansehen ↗</button>':`<button class="text-link" data-companion="restore" data-id="${f.id}">Hinweis wieder öffnen</button>`}`}</div></article>`;
  }
  function scoped(){const c=context(),scope=c.workspace.activeCourse;return {c,scope,tasks:c.workspace.tasks.filter(t=>(!scope||t.projectId===scope)&&t.status!=='done'&&!c.workspace.projects.find(p=>p.id===t.projectId)?.archived),findings:openFindings().filter(f=>!scope||f.projectId===scope)};}
  return {update,loaded,sources:()=>memory.liveSources.map(d=>({...d})),isBusy:()=>busy,renderTeaser(){const {tasks,findings}=scoped();return `<section class="companion-teaser" aria-label="Dein Studienbegleiter"><span class="ki-mark" aria-hidden="true">✳</span><div><span class="small-label">DEIN BEGLEITER</span><h2>${findings.length?`${findings.length} Hinweise verdienen einen Blick.`:tasks.length?`${tasks.length} offene Aufgabe${tasks.length===1?'':'n'}. Ein klarer nächster Schritt.`:'Dein Kursstand im Blick.'}</h2><p>Ich behalte Aufgaben, Fristen und gelesene Kursquellen im Blick.</p></div><button class="button secondary" data-view="companion">Stand ansehen ↗</button></section>`;},render(){
    const {c,scope,tasks,findings}=scoped(),cv=coverage(),overdue=tasks.filter(t=>urgency(t.due,dateKey())==='overdue').length,ai=getAI();
    const history=allFindings().filter(f=>(!scope||f.projectId===scope)&&(f.status!=='new'||f.stale||!f.changed&&matchingTask(c.workspace,f)));
    const sorted=[...findings].sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999'));
    const courses=c.workspace.projects.filter(p=>!p.archived&&(!scope||p.id===scope));
    return `<div class="page-heading"><div><p class="eyebrow">CONTEXT · DEIN STUDIENBEGLEITER</p><h1>Dein nächster Schritt.</h1><p class="page-description">Was steht an, in welchem Kurs — und woher wissen wir das?</p></div><div class="companion-heading-actions"><button class="button primary" data-companion="scan" ${!ready||busy?'disabled':''}>${memory.scanCoverage.some(c=>c.status==='not_scanned'&&courses.some(p=>p.id===c.projectId))?'Weitere Kurse prüfen':'Quellen prüfen'}</button><button class="text-link" data-companion="local" ${!ready||busy?'disabled':''}>Stand prüfen</button><button class="button secondary" data-companion="${busy?'stop':'review'}" ${!ready?'disabled':''}>${busy?'Prüfung anhalten':'Mit KI prüfen ↗'}</button></div></div>
      <div class="companion-status" role="status"><span class="tiny-dot"></span><strong>${busy?esc(scanProgress||'KI-Prüfung läuft'):memory.settings.local?'Lokaler Begleiter aktiv':'Lokale Automatik pausiert'}</strong><span>${esc(storage)}</span>${error?`<p class="companion-error" role="alert">${esc(error)}</p>`:''}</div>
      <div class="companion-layout"><div><section class="companion-focus"><div><span class="small-label">${scope?esc(c.workspace.projects.find(p=>p.id===scope)?.name):'ALLE KURSE'}</span><h2>${overdue?`${overdue} Aufgabe${overdue===1?' ist':'n sind'} überfällig.`:tasks.length?'Hier kannst du weiterkommen.':findings.length?'Neue Aufgabenhinweise für dich.':'Dein Stand braucht Quellen.'}</h2><p>${tasks.length?`${tasks.length} bestätigte offene Aufgabe${tasks.length===1?'':'n'}. `:''}${findings.length} ${findings.length===1?'neuer Hinweis':'neue Hinweise'} zur eigenen Prüfung. ${!tasks.length&&!findings.length?'Keine erkannten Aufgaben ist keine Garantie, dass alles erledigt ist.':''}</p></div><div><button class="button secondary" data-companion="ask-all" ${busy?'disabled':''}>Mit mir planen ↗</button><button class="text-link" data-view="tasks">Deine Aufgaben ↗</button></div></section>
      <section class="companion-courses" aria-label="Kursübersicht">${courses.map(p=>{const open=tasks.filter(t=>t.projectId===p.id),found=findings.filter(f=>f.projectId===p.id),known=docs().filter(d=>d.projectId===p.id),next=[...open].sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999'))[0];return `<article class="companion-course"><div><span class="project-dot ${p.color}"></span><h3>${esc(p.name)}</h3></div><p><strong>${open.length}</strong> offen · <strong>${found.length}</strong> ${found.length===1?'Hinweis':'Hinweise'}</p><p class="companion-course-next">${next?esc(next.title):found[0]?esc(found[0].title):'Noch kein nächster Schritt belegt.'}</p><small>${known.length} Quellen · ${known.filter(d=>d.status!=='full').length} unvollständig</small>${(()=>{const check=memory.scanCoverage.find(c=>c.projectId===p.id);return check?`<p class="companion-coverage"><strong>${esc(({read:'Seiten gelesen',partial:'Teilweise gelesen',login_required:'Anmeldung nötig',error:'Prüfung fehlgeschlagen',not_linked:'Space fehlt',not_scanned:'Noch nicht geprüft'})[check.status])}</strong><small>${check.pages} Seiten · ${esc(when(check.checkedAt))}</small><span>${esc(check.message)}</span></p>`:'<p class="companion-coverage">Live-Quellen noch nicht geprüft.</p>';})()}<div><button class="text-link" data-action="companion-course" data-id="${esc(p.id)}">Kurs ansehen ↗</button>${spaceBrowserURL(p)?`<button class="text-link" data-companion="live" data-id="${esc(p.id)}" ${busy||!agentBrowserAvailable()?'disabled':''}>Space einlesen ↗</button>`:''}</div></article>`;}).join('')}</section>
      <section><div class="section-title"><h2>Noch zu prüfen <span class="companion-counter">${findings.length}</span></h2><button class="text-link" data-companion="history" aria-expanded="${showHistory}">${showHistory?'Verlauf ausblenden':`Bearbeitete Hinweise (${history.length})`}</button></div><p class="subtle-note">Der Begleiter erkennt mögliche Aufgaben. Du entscheidest, was dich betrifft. Quellen können Auszüge oder ältere Stände sein.</p><div class="companion-findings">${sorted.length?sorted.map(card).join(''):`<div class="empty-state"><h3>${ready?'Noch keine neuen Hinweise.':'Dein Gedächtnis wird geöffnet.'}</h3><p>Prüfe mit KI, importiere Kursmaterial oder lies einen Kurs-Space ein. Bestätigte Aufgaben stehen weiterhin unter Aufgaben.</p><button class="button secondary" data-view="imports">Quellen importieren ↗</button></div>`}</div>${showHistory?`<div class="companion-findings companion-history">${history.map(card).join('')||'<p class="quiet-row">Noch keine bearbeiteten Hinweise.</p>'}</div>`:''}</section></div>
      <aside class="companion-aside"><section><span class="small-label">ARBEITSWEISE</span><h2>Aufmerksam.<br>Nachvollziehbar.</h2><label class="companion-setting"><input id="companion-local" type="checkbox" ${memory.settings.local?'checked':''} ${!ready||conflict?'disabled':''}><span><strong>Lokal mitdenken</strong><small>Prüft bei neuen Daten und beim Öffnen. Ohne KI-Kosten.</small></span></label><label class="companion-setting"><input id="companion-auto-ai" type="checkbox" ${memory.settings.automaticAI?'checked':''} ${!ready||busy||conflict?'disabled':''}><span><strong>Automatische KI-Prüfung</strong><small>Alle 30 Minuten bei geöffneter, sichtbarer App. Nur ungeprüfte Abschnitte; höchstens 3 Aufrufe pro Prüfung. ${ai.provider==='local'?'Auszüge werden vom lokalen Modell auf diesem Mac verarbeitet.':'Auszüge gehen an '+esc(providerName(ai.provider))+'. Kosten sind möglich.'}</small></span></label><p class="subtle-note">Anbieter: ${esc(providerName(ai.provider))}${ai.model?' · '+esc(ai.model):''}. Aufgaben werden erst beim Übernehmen angelegt.</p><button class="text-link" data-view="ai">Anbieter & Modell wählen ↗</button></section>
      <section><span class="small-label">BEGLEITAUFTRAG</span><form id="companion-mission-form"><label for="companion-mission">Worauf soll ich achten?</label><textarea id="companion-mission" name="mission" maxlength="800" rows="3" placeholder="Zum Beispiel: Abgaben und Vorbereitung für die nächsten Kurstermine." ${!ready||conflict?'disabled':''}>${esc(memory.settings.mission)}</textarea><button class="button secondary" ${!ready||conflict?'disabled':''}>Auftrag speichern</button></form></section>
      <section><span class="small-label">WISSENSSTAND</span><h3>${cv.total} Quellen verfügbar</h3><p>${cv.incomplete} davon Auszug oder Kopfzeile. TH-Mail ist nicht im automatischen Wissen.</p><p>Lokal geprüft: ${esc(when(memory.lastLocal))}<br>KI geprüft: ${esc(when(memory.lastAI))}${pendingChunks?`<br>${pendingChunks} Textabschnitte warten auf eine KI-Prüfung.`:''}</p><p>Browser-Stände bleiben Momentaufnahmen. „Quellen prüfen“ erkundet die Kurs-Spaces und ihre angebotenen Textabschnitte/Beitragslinks, bis zu 12 Seiten insgesamt und 3 je Kurs. Fotos und Dateien erst nach Import. Jede Grenze wird angezeigt.</p><details><summary>Verbindungen & Lücken</summary>${(c.sources||[]).filter(s=>s.source!=='webmail').map(s=>`<p>${esc(s.source)} · ${esc(s.status)}${s.capturedAt?' · '+esc(when(s.capturedAt)):''}${s.complete===false?' · unvollständig':''}</p>`).join('')||'<p>Noch kein Quellenabruf verfügbar.</p>'}</details></section>
      <section class="companion-access"><span class="small-label">MEIN ZUGRIFF</span><h3>Du siehst, was ich weiß.</h3><p><strong>Lokal:</strong> Projekte, Notizen, Aufgaben, Termine und importierte Texte.</p><p><strong>Spaces:</strong> Lesend im angemeldeten Browser. Gelesene Seiten werden lokal verschlüsselt gespeichert.</p><p><strong>Mattermost & GitLab:</strong> Nur Inhalte, die ihre Verbindung tatsächlich liefert. Ein Browser-Login allein gibt mir keinen API-Zugriff.</p><p><strong>TH-Mail, WhatsApp & Signal:</strong> Kein automatischer Chat-/Postfachzugriff.</p><details><summary>Sicherheitsgrenzen</summary><p>Quellen sind Daten, keine Befehle. Kein Terminal, kein E-Mailversand, keine Uploads, keine Anmelde- oder Passwortfelder. Aufgabenhinweise werden erst beim Übernehmen zu Aufgaben. Die Chatwerkzeuge bleiben in deinem freigegebenen Kursbereich. Lokale Modelle erhalten dieselben begrenzten Werkzeuge wie Cloud-Modelle.</p></details></section>
      <section><span class="small-label">PRÜFPROTOKOLL</span><ol class="companion-log">${memory.log.slice(0,8).map(r=>`<li><strong>${r.status==='running'?'◌':r.status==='error'?'!':'✓'} ${esc(r.label)}</strong><p>${esc(r.detail)}</p><small>${esc(when(r.at))}${r.provider?' · '+esc(providerName(r.provider)):''}${r.tokens?' · '+r.tokens+' Tokens':''}</small></li>`).join('')||'<li>Die erste Prüfung beginnt mit deinen gespeicherten Quellen.</li>'}</ol></section>
      <section><button class="text-link" data-companion="export" ${!ready?'disabled':''}>Gedächtnis als Backup exportieren ↗</button><p class="subtle-note">Das JSON-Backup ist lesbar. Das lokale Gedächtnis ist verschlüsselt; der Schlüssel liegt im selben Browserprofil. Bearbeitete Hinweise bleiben im Verlauf und werden bei Bedarf automatisch archiviert. App schließen pausiert die Prüfungen.</p></section></aside></div>`;
  }};
}
