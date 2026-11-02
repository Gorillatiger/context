import {brandLogo} from './brand-logos.js';
import {collectLocalBoards,mergeBoardFindings,groupBoards,validateBoardFindings,applyMiroMetadata} from './board-index.js';
import {miroAvailable,requestMiro} from './miro-knowledge.js';
import {scanBoardSpaces} from './board-scan.js';
import {agentBrowserAvailable,requestAgentBrowser} from './agent-browser.js';
import {createBoardPrioritizer} from './board-ai.js';
import {aiRequest,providerName} from './ai-client.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=v=>v?new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',...(v.length===10?{}:{timeStyle:'short'}),timeZone:'Europe/Berlin'}).format(new Date(v.length===10?v+'T12:00:00Z':v)):'Unbekannt';
const link=(url,label)=>url?`<a class="text-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`:esc(label);
export function createBoardView({getContext,onSave,onChange,isBusy=()=>false,onRefresh=async()=>{},getAI=()=>({}),onArchive=async()=>{throw new Error('Sucharchiv fehlt.');}}){
 let busy=false,abort,error='',progress='',query='',sort='recent',coverage=[],localCount=0,checkedAt='',notice='',goal='Miro-Boards in Kursunterseiten, Orga und Ressourcen finden.',steps=[];
 const sessions=new Map();
 window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
 const change=()=>onChange();
 // Invitation links go only to the encrypted desktop store. Public title/owner
 // come from Miro oEmbed for at most 20 boards per search, rechecked weekly.
 async function syncMiro(invites,signal){
  if(!miroAvailable())return;
  if(invites?.length)try{await requestMiro('remember',{urls:invites.slice(0,100)},{signal});}catch(e){if(e.name==='AbortError')throw e;}
  const fresh=v=>v&&Date.now()-Date.parse(v)<7*86400000,urls=[...new Set((getContext().workspace.boardFindings||[]).filter(f=>!f.miroTitle&&!fresh(f.miroCheckedAt)).map(f=>f.url))].slice(0,20);
  if(!urls.length)return;progress='Öffentliche Board-Titel werden bei Miro abgefragt …';change();
  const value=await requestMiro('meta',{urls},{signal});
  if(!onSave(mergeBoardFindings([],applyMiroMetadata(getContext().workspace.boardFindings||[],value?.boards))))throw new Error('Die Board-Titel konnten nicht gespeichert werden.');
 }
 function store(fresh){const c=getContext(),next=mergeBoardFindings(c.workspace.boardFindings||[],fresh.filter(f=>!f.projectId||c.workspace.projects.some(p=>p.id===f.projectId)));if(!onSave(next))throw new Error('Die Board-Fundstellen konnten nicht gespeichert werden. Bitte zuerst den Workspace-Speicher prüfen.');}
 async function scan(live,withAI=false){
  if(busy||isBusy()){error='Eine andere Quellenprüfung oder der Assistent arbeitet gerade. Starte die Board-Suche danach.';change();return;}
  const run=async lock=>{
   if(lock===null){error='Eine andere Ansicht prüft gerade Quellen.';change();return;}
   busy=true;abort=new AbortController();error='';notice='';steps=[];coverage=[];progress='Verfügbare Quellen werden geprüft …';change();let ai,scope='',startedAt=new Date().toISOString(),runGoal=goal,found=[],wasInterrupted=false,invites=[];
   const aiChanged=()=>{const current=getAI();if(ai&&(current.provider!==ai.provider||current.model!==ai.model))abort?.abort();};window.addEventListener('context-ai-changed',aiChanged);
   try{
    await onRefresh();if(abort.signal.aborted)throw new DOMException('Abgebrochen','AbortError');
    const c=getContext(),local=collectLocalBoards(c);store(local.findings);localCount=local.sources;checkedAt=new Date().toISOString();invites=local.invites;
    if(live){
     if(!agentBrowserAvailable()||window.contextDesktop?.boardScanVersion!==2)throw new Error('Lokale Suche abgeschlossen. Für das Durchgehen von Spaces öffne Context Browser 0.13.0.');
     scope=c.workspace.activeCourse||'';const projects=c.workspace.projects.filter(p=>!scope||p.id===scope);
     let prioritize;
     if(withAI){
      let setup=getAI();if(!setup.ready&&typeof setup.load==='function'){await setup.load();setup=getAI();}
      if(abort.signal.aborted)throw new DOMException('Abgebrochen','AbortError');
      if(!setup.ready||!setup.model)throw new Error('Verbinde zuerst ein Modell unter Hochschul-KI. Die lokale Board-Suche funktioniert weiterhin.');
      const chosen={provider:setup.provider,model:setup.model};ai=chosen;
      // AI search revisits the selected course roots so it can inspect offered
      // labels even when an earlier deterministic pass already exhausted a queue.
      for(const p of projects)sessions.delete(p.id);
      prioritize=createBoardPrioritizer({...chosen,goal:runGoal,signal:abort.signal,maxCalls:8,isCurrent:()=>{const current=getAI();return current.provider===chosen.provider&&current.model===chosen.model;},request:body=>aiRequest(chosen.provider,'chat',{body,signal:abort.signal}),onStep:s=>{steps.push({...s,at:new Date().toISOString()});change();}});
     }
     const browserRequest=async(command,options)=>{aiChanged();if(abort.signal.aborted)throw new DOMException('Abgebrochen','AbortError');const page=await requestAgentBrowser(command,options);aiChanged();if(abort.signal.aborted)throw new DOMException('Abgebrochen','AbortError');return page;};
     const result=await scanBoardSpaces({projects,signal:abort.signal,sessions,request:browserRequest,prioritize,onFindings:rows=>{store(rows);found.push(...rows);},onProgress:p=>{progress=[c.workspace.projects.find(x=>x.id===p.projectId)?.name,p.message].filter(Boolean).join(' · ');change();}});wasInterrupted=result.interrupted;
     coverage=result.coverage;notice=result.interrupted?'Suche angehalten. Fundstellen sind gespeichert.':result.coverage.some(c=>c.status!=='read')?'Suche mit Zugriffslücken oder offenen Ansichten. Siehe Kursabdeckung.':'Angebotene Kursansichten geprüft. Siehe Kursabdeckung.';
    }else notice='Verfügbare lokale Quellen durchsucht. Live-Kursseiten wurden dabei nicht geöffnet.';
    try{await syncMiro(invites,abort.signal);}catch(e){if(e.name==='AbortError')throw e;notice+=' Öffentliche Miro-Titel waren gerade nicht abrufbar.';}
   }catch(e){error=e.name==='AbortError'?'Suche angehalten. Bereits gespeicherte Fundstellen bleiben erhalten.':e.message;}
   finally{window.removeEventListener('context-ai-changed',aiChanged);if(ai)try{await onArchive({provider:ai.provider,model:ai.model,scope,goal:runGoal,startedAt,steps,coverage,findings:found,error,interrupted:wasInterrupted||abort.signal.aborted});notice+=' Suchprotokoll lokal verschlüsselt gespeichert.';}catch{error=[error,'Das KI-Suchprotokoll konnte nicht lokal gesichert werden. Die gespeicherten Board-Fundstellen bleiben erhalten.'].filter(Boolean).join(' ');}busy=false;abort=null;progress='';change();}
  };
  if(navigator.locks)await navigator.locks.request('context-companion-review',{ifAvailable:true},run);else await run({});
 }
 document.addEventListener('input',e=>{if(e.target.id==='board-query'){query=e.target.value;change();}if(e.target.id==='board-ai-goal')goal=e.target.value.slice(0,240);});
 document.addEventListener('change',e=>{if(e.target.id==='board-sort'){sort=e.target.value;change();}});
 document.addEventListener('submit',e=>{
  if(e.target.id!=='board-edit-form')return;e.preventDefault();try{
   const form=e.target,c=getContext(),id=form.elements.findingId.value,row=(c.workspace.boardFindings||[]).find(f=>f.id===id);if(!row)throw new Error('Fundstelle fehlt.');
   const projectId=form.elements.projectId.value,customTitle=form.elements.title.value.trim();
   if(projectId&&!c.workspace.projects.some(p=>p.id===projectId))throw new Error('Kurs fehlt.');
   const rows=validateBoardFindings((c.workspace.boardFindings||[]).map(f=>f.id===id?{...f,projectId,assignedProjectId:projectId,customTitle}:f),c.workspace.projects.map(p=>p.id));
   if(!onSave(mergeBoardFindings([],rows)))throw new Error('Speichern nicht möglich.');document.getElementById('board-edit-dialog')?.close();error='';change();
  }catch(err){const out=e.target.querySelector('[role=alert]');if(out)out.textContent=err.message;}
 });
 document.addEventListener('click',e=>{const b=e.target.closest('[data-board]');if(!b)return;const action=b.dataset.board;
  if(action==='local')void scan(false);if(action==='scan')void scan(true);if(action==='ai')void scan(true,true);if(action==='stop')abort?.abort();
  if(action==='fresh'&&!busy){sessions.clear();coverage=[];void scan(true);}
  if(action==='edit'&&!busy){
   const c=getContext(),f=(c.workspace.boardFindings||[]).find(f=>f.id===b.dataset.id);if(!f)return;
   const dialog=document.getElementById('board-edit-dialog');dialog.innerHTML=`<form id="board-edit-form"><h2>Board zuordnen</h2><p>Dein Titel ersetzt die Anzeige dieser Fundstelle. Angaben aus dem Beitrag bleiben erhalten.</p><input name="findingId" type="hidden" value="${esc(f.id)}"><label>Titel<input name="title" maxlength="200" required value="${esc(f.customTitle||f.title)}"></label><label for="board-edit-course">Kurs</label><select id="board-edit-course" name="projectId"><option value="">Nicht zugeordnet</option>${c.workspace.projects.filter(p=>!p.archived||p.id===f.projectId).map(p=>`<option value="${esc(p.id)}" ${p.id===f.projectId?'selected':''}>${esc(p.name)}</option>`).join('')}</select><p role="alert"></p><div class="form-footer"><button class="button secondary" type="button" data-board="close">Abbrechen</button><button class="button primary">Speichern</button></div></form>`;dialog.showModal();
  }
  if(action==='close')document.getElementById('board-edit-dialog')?.close();
  if(action==='export'){const rows=getContext().workspace.boardFindings||[],url=URL.createObjectURL(new Blob([JSON.stringify({format:'context-miro-directory',version:1,exportedAt:new Date().toISOString(),findings:rows},null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='context-miro-boards.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
 });
 return {isBusy:()=>busy,render(){
  const {workspace:w}=getContext(),rows=w.boardFindings||[],groups=groupBoards(rows,{projectId:w.activeCourse,query,sort}),courses=w.projects.filter(p=>!p.archived),pending=coverage.some(c=>c.status==='partial'),selectedAI=getAI();
  return `<div class="page-heading"><div><p class="eyebrow">DEINE KURSE · DEINE BOARDS</p><h1>Alle Boards. Ein Überblick.</h1><p class="page-description">Miro-Links finden, nach Kurs ordnen und zur ursprünglichen Fundstelle zurückgehen.</p></div><div class="board-actions"><button class="button primary" data-board="scan" ${busy?'disabled':''}>${pending?'Spaces-Suche fortsetzen':'Spaces durchsuchen'}</button><button class="button secondary" data-board="${busy?'stop':'local'}">${busy?'Anhalten':'Lokale Quellen prüfen'}</button></div></div>
  <section class="board-summary" aria-label="Suchstatus"><div>${brandLogo('miro')}<span><strong>${groups.length} ${groups.length===1?'Board':'Boards'}${w.activeCourse?' im Kurs':''}</strong><small>${rows.length} gespeicherte Fundstellen · ${localCount} lokale Quellen zuletzt geprüft</small></span></div><p role="status">${esc(busy?progress:notice||'Starte die Suche über deine vorhandenen Kursquellen.')}</p>${checkedAt?`<small>Letzte lokale Suche: ${esc(date(checkedAt))}</small>`:''}${error?`<p class="board-error" role="alert">${esc(error)}</p>`:''}</section>
  <section class="board-ai" aria-labelledby="board-ai-heading"><div><p class="eyebrow">GEZIELT DURCH UNTERSEITEN</p><h2 id="board-ai-heading">Lass Context die Suche lenken.</h2><p>Die KI wählt vielversprechende Kursabschnitte. Der Browser prüft die Links und speichert belegte Funde.</p></div><div class="board-ai-controls"><label for="board-ai-goal">Wonach soll Context suchen?</label><input id="board-ai-goal" maxlength="240" value="${esc(goal)}" ${busy?'readonly':''}><button class="button primary" data-board="ai" ${busy?'disabled':''}>✳ Mit KI suchen</button><span class="subtle-note">${esc(providerName(selectedAI.provider))}${selectedAI.model?' · '+esc(selectedAI.model):' · Modell noch verbinden'} · ${esc(w.activeCourse?courses.find(p=>p.id===w.activeCourse)?.name||'Gewählter Kurs':'Alle Kurse')}</span></div><p class="board-ai-privacy">${selectedAI.provider==='local'?'Suchauftrag, Kursnamen und Abschnittstitel verarbeitet dein lokales Modell auf diesem Mac.':'Nur dein Suchauftrag, Kursnamen und angebotene Abschnittstitel gehen an '+esc(providerName(selectedAI.provider))+'.'} Keine Beitragstexte oder Zugangsdaten. Ein neuer KI-Lauf startet an den gewählten Kursstartseiten. Maximal eine KI-Auswahl je Kurs und acht je Lauf. Die KI kann keine neuen Adressen öffnen oder Beiträge ändern.</p>${steps.length?`<details class="board-ai-steps" open><summary>Suchschritte · ${steps.length}</summary><ol>${steps.map(s=>`<li><strong>${esc(courses.find(p=>p.id===s.projectId)?.name||'Context')}</strong><span>${esc(s.message)}</span></li>`).join('')}</ol><p class="subtle-note">Das Suchprotokoll wird nach dem Lauf im lokalen verschlüsselten Assistenten-Verlauf gesichert.</p></details>`:''}</section>
  <div class="board-toolbar"><label for="board-query">Boards oder Personen suchen<input id="board-query" type="search" maxlength="200" placeholder="Titel, Person oder Fundstelle …" value="${esc(query)}"></label><label for="board-sort">Sortieren<select id="board-sort"><option value="recent" ${sort==='recent'?'selected':''}>Neueste Fundstelle</option><option value="title" ${sort==='title'?'selected':''}>Titel A–Z</option></select></label><button class="text-link" data-board="export" ${!rows.length?'disabled':''}>Verzeichnis exportieren ↗</button></div>
  <div class="board-grid">${groups.map(g=>`<article class="board-card"><div class="board-card-top">${brandLogo('miro',{small:true})}<span class="tag">${esc(w.projects.find(p=>p.id===g.projectId)?.name||'Nicht zugeordnet')}</span></div><h2>${esc(g.title)}</h2><p class="subtle-note">${g.titleOrigin==='custom'?'Dein Titel':g.titleOrigin==='miro'?'Titel laut Miro':g.titleOrigin==='link'?'Titel aus dem Linktext':g.titleOrigin==='reference'?'Bezeichnung aus der Fundstelle · Miro-Originaltitel unbekannt':'Boardtitel nicht bekannt'} · ${g.owner?'Board-Besitz laut Miro: '+esc(g.owner):'Board-Ersteller unbekannt'}</p>${link(g.url,'Board öffnen')}<details ${g.occurrences.length===1?'open':''}><summary>${g.occurrences.length} ${g.occurrences.length===1?'Fundstelle':'Fundstellen'}</summary>${g.occurrences.map(f=>`<div class="board-occurrence"><strong>${link(f.sourceURL,f.sourceTitle)}</strong><dl><dt>Link gepostet von</dt><dd>${esc(f.postedBy||'Unbekannt')}</dd><dt>Beitrag vom</dt><dd>${esc(date(f.postedAt))}</dd><dt>Erstmals gefunden</dt><dd>${esc(date(f.foundAt))}</dd><dt>Quelle</dt><dd>${esc(f.sourceKind)}</dd></dl><button class="text-link" data-board="edit" data-id="${esc(f.id)}" ${busy?'disabled':''}>Titel & Kurs bearbeiten ↗</button></div>`).join('')}</details></article>`).join('')||`<div class="empty-state"><h2>${rows.length?'Keine passenden Boards.':'Noch keine Boards gesammelt.'}</h2><p>${rows.length?'Ändere den Kursfilter oder deinen Suchbegriff.':'Die Suche erkennt direkte Miro-Boardlinks in Notizen, Kursverbindungen und verfügbaren Spaces-, Mattermost- und GitLab-Inhalten.'}</p></div>`}</div>
  <section class="board-coverage"><div class="section-title"><h2>Kursabdeckung</h2><button class="text-link" data-board="fresh" ${busy?'disabled':''}>Spaces erneut prüfen ↗</button></div><p>Die Spaces-Suche folgt angebotenen lesenden Kurslinks und Abschnitten. Bis zu 60 Ansichten pro Lauf; Fortsetzung möglich, solange die App geöffnet bleibt. Dateien, Bilder und nachgeladene Inhalte können fehlen. Mattermost und GitLab liefern nur die Inhalte ihrer eingerichteten Verbindung. Kein Zugriff auf TH-Mail, WhatsApp- oder Signal-Chats.</p>${coverage.map(c=>`<div><strong>${esc(courses.find(p=>p.id===c.projectId)?.name||c.projectId)}</strong><span>${esc(({read:'Geprüft',partial:'Teilweise geprüft',pending:'Ausstehend',error:'Fehler',login_required:'Anmeldung nötig',update_required:'App-Update nötig',not_linked:'Space fehlt'})[c.status])} · ${c.pages} Ansichten in diesem Lauf</span><small>${esc(c.message)}</small></div>`).join('')}<p class="subtle-note">Fundstellen-Metadaten bleiben lokal und sind im Workspace-Backup enthalten. Nach einer Suche fragt Context bei Miro öffentlichen Titel und Besitz gefundener Boards ab (oEmbed, ohne Anmeldung, höchstens 20 Boards). „Spaces durchsuchen“ und „Lokale Quellen prüfen“ verwenden keine KI. Einladungsschlüssel (share_link_id) bleiben verschlüsselt in der Desktop-App und werden nur zum Lesen des Boards verwendet; Fundstellen, Export und Suche enthalten sie nicht.</p></section><dialog id="board-edit-dialog" class="board-edit-dialog"></dialog>`;
 }};
}
