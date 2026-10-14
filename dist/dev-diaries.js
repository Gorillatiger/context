import {devDiaryCourses,createDevDiary,validateDevDiary,updateDailyEntry,compileDevDiaryMarkdown,suggestDevDiaryPeriod} from './dev-diary-engine.js';
import {renderDevDiaryPost} from './dev-diary-format.js';
import {createSpeechInput,renderSpeechControls} from './speech.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const addDays=(date,days)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return Number.isFinite(d.getTime())?d.toISOString().slice(0,10):'';};
const label=date=>new Intl.DateTimeFormat('de-DE',{weekday:'short',day:'numeric',month:'short',timeZone:'Europe/Berlin'}).format(new Date(date+'T12:00:00Z'));
const fields=[['done','Was habe ich gemacht?','Arbeitsschritte, Entscheidungen und Ergebnisse.'],['learned','Was habe ich gelernt?','Neue Erkenntnisse und Beobachtungen.'],['problems','Wo hakt es?','Offene Fragen, Schwierigkeiten und benötigte Hilfe.'],['next','Was ist der nächste Schritt?','Was möchtest du als Nächstes ausprobieren?']];
const unwrap=reply=>{if(reply?.ok===false||reply?.error){const error=new Error(reply.error||'Spaces konnte nicht erreicht werden.');error.code=reply.code;throw error;}return reply?.ok===true?reply.value:reply;};

export function createDevDiaryView({getState,onSave,onModal,onNotice=()=>{},bridge=globalThis.window?.contextDesktop,onChange=()=>{},speechFactory=createSpeechInput}){
 let active='',day='',setup=null,error='',busy=false,review=null,conflict=null,connection=null,probeRunId='',epoch=0,open=false;
 const drafts=new Map(),appearanceDrafts=new Map(),speechFinals=new Set();
 let speech=null,voiceField='done',voiceOverflow='',settingsOpen=false,voiceOpen=false;
 const micIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8"/></svg>';
 const voiceKey=()=>active+'|'+day+'|'+voiceField;
 function invalidateReview(){review=null;document.querySelector('.dd-review')?.remove();const confirm=document.getElementById('dd-conflict-checked');if(confirm)confirm.checked=false;}
 function ensureSpeech(){
  if(speech)return speech;
  speech=speechFactory({bridge,getContextKey:voiceKey,canStart:()=>open&&currentModal()&&!busy&&!setup,onChange:()=>{if(open&&currentModal()){remember();paint();}},onFinal:event=>{
   if(!open||!currentModal()||event.contextKey!==voiceKey()||speechFinals.has(event.id))return;
   speechFinals.add(event.id);if(speechFinals.size>100)speechFinals.delete(speechFinals.values().next().value);
   const node=document.getElementById('dd-'+voiceField);if(!node)return;
   const text=String(event.text||'').trim();if(!text)return;
   const next=node.value+(node.value.trim()?'\n':'')+text;
   if(next.length>4000){voiceOverflow=text;error='Das Diktat passt nicht vollständig in dieses Feld (4.000 Zeichen). Kürze den vorhandenen Text; dein Diktat steht unten zum Kopieren.';paint();return;}
   node.value=next;remember();invalidateReview();paint();document.getElementById('dd-'+voiceField)?.focus({preventScroll:true});
  }});return speech;
 }
 function cancelVoice(){if(speech)void speech.cancel('');}
 function draftDiary(){
  let diary=current();if(!diary)return null;
  const appearance=appearanceDrafts.get(active);if(appearance)diary=validateDevDiary({...diary,...appearance});
  for(const [k,value]of drafts)if(k.startsWith(active+'|'))diary=updateDailyEntry(diary,k.slice(active.length+1),value);
  return diary;
 }
 function updatePreview(){const node=document.getElementById('dd-preview-content');if(node)try{const opened=new Set([...(node.querySelectorAll?.('details[open]')||[])].map(d=>d.querySelector('summary')?.textContent));node.innerHTML=renderDevDiaryPost(compileDevDiaryMarkdown(draftDiary()));for(const d of node.querySelectorAll?.('details')||[])if(opened.has(d.querySelector('summary')?.textContent))d.open=true;}catch{node.textContent='Bitte Titel und Beitragsgestaltung prüfen.';}}
 function rememberAppearance(){
  const f=document.getElementById('dd-appearance-form'),d=current();if(!f||!d)return;
  const previous=appearanceDrafts.get(active)||d;
  const presentation={...previous.presentation};
  for(const name of ['layout','order','headings'])presentation[name]=f.elements[name].value;
  for(const name of ['hideEmpty','showPeriod'])presentation[name]=f.elements[name].checked;
  const value={title:f.elements.title.value,presentation};
  if(value.title===d.title&&JSON.stringify(value.presentation)===JSON.stringify(d.presentation))appearanceDrafts.delete(active);else appearanceDrafts.set(active,value);
  invalidateReview();updatePreview();
 }

 const courses=()=>devDiaryCourses(getState());
 const find=id=>(getState().devDiaries||[]).find(d=>d.id===id);
 const current=()=>find(active);
 const available=()=>typeof bridge?.devDiary==='function';
 const currentModal=()=>document.getElementById('modal')?.open===true&&document.getElementById('dd-entry-form')?.dataset.diaryId===active;
 const key=(id,date)=>id+'|'+date;
 function remember(){
  const f=document.getElementById('dd-entry-form');if(!f||!current()||busy)return;
  const previous=current().entries.find(e=>e.date===day)||{};
  const entry=Object.fromEntries(fields.map(([name])=>[name,f.elements[name]?.value||'']));
  entry.completed=f.elements.completed?.checked===true;
  if(fields.every(([name])=>(previous[name]||'')===entry[name])&&!!previous.completed===entry.completed)drafts.delete(key(active,day));
  else drafts.set(key(active,day),entry);
 }
 function readSetup(){
  const f=document.getElementById('dd-setup-form');if(!f)return;
  const course=courses().find(c=>c.courseUrl===f.elements.courseUrl.value);
  setup={...setup,...course,title:f.elements.title.value,startDate:f.elements.startDate.value,days:Number(f.elements.days.value),reminder:{enabled:f.elements.reminderEnabled.checked,time:f.elements.reminderTime.value,weekdays:f.elements.weekends.checked?[0,1,2,3,4,5,6]:[1,2,3,4,5]}};
 }
 function store(diary,remoteConfirmed=false){if(onSave(diary)!==true)throw new Error(remoteConfirmed?'Spaces hat den Beitrag gespeichert, aber der lokale Status konnte nicht gesichert werden. Beim erneuten Prüfen wird derselbe Beitrag wiedergefunden.':'Dein Dev Diary konnte nicht lokal gespeichert werden. Der Text bleibt im Entwurf; es wurde nichts veröffentlicht.');onChange();return diary;}
 function saveDrafts(){
  remember();let diary=current();if(!diary)throw new Error('Dieser Dev Diary ist nicht mehr vorhanden.');
  const entries=[...drafts.entries()].filter(([k])=>k.startsWith(active+'|'));
  for(const [k,value] of entries)diary=updateDailyEntry(diary,k.slice(active.length+1),value);
  const appearance=appearanceDrafts.get(active);if(appearance)diary=validateDevDiary({...diary,...appearance,remote:{...diary.remote,status:diary.remote.status==='published'?'draft':diary.remote.status}});
  store(diary);for(const [k]of entries)drafts.delete(k);appearanceDrafts.delete(active);return diary;
 }
 function errorHTML(){return error?`<p class="dd-error" role="alert">${esc(error)}</p>`:'';}
 function paint(){
  if(!open)return;
  const scroll=document.getElementById('modal')?.scrollTop;
  const focused=document.activeElement,id=focused?.id,selection=typeof focused?.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
  onModal(setup?'Dein Dev Diary startet hier.':'Dein Dev Diary',setup?'Kurs wählen · zwei Wochen als Standard':'Ein Kurs · ein Beitrag · dein täglicher Fortschritt',setup?setupHTML():studioHTML(),current()?.projectId||setup?.projectId);
  if(scroll!==undefined)document.getElementById('modal').scrollTop=scroll;
  if(id){const node=document.getElementById(id);node?.focus({preventScroll:true});if(selection&&typeof node?.setSelectionRange==='function')node.setSelectionRange(...selection);}
 }
 function suggestion(){try{return suggestDevDiaryPeriod(getState(),{projectId:setup?.projectId,courseUrl:setup?.courseUrl,days:setup?.days||14,today:today()});}catch{return null;}}
 function setupHTML(){
  const choices=courses(),proposal=suggestion();
  if(!choices.length)return `<section class="dd-empty"><h3>Verbinde zuerst einen Kurs-Space.</h3><p>Ein Dev Diary braucht einen Kurs mit einem Spaces-Link. Füge ihn unter Projekte → Verbindungen hinzu.</p><button class="button secondary" type="button" data-dd-action="close">Zurück zu den Notizen</button></section>`;
  return `<form id="dd-setup-form" class="dd-setup"><div class="dd-callout"><strong>Ein Beitrag für die ganze Kursphase</strong><p>Du ergänzt jeden Tag deine Vorlage. Nach dem ersten Veröffentlichen wird derselbe Spaces-Beitrag aktualisiert.</p></div><div class="dd-setup-grid"><label for="dd-course">Kurs auf Spaces<select id="dd-course" name="courseUrl" data-dd-course>${choices.map(c=>`<option value="${esc(c.courseUrl)}" ${setup.courseUrl===c.courseUrl?'selected':''}>${esc(c.courseName)}</option>`).join('')}</select></label><label for="dd-title">Beitragstitel<input id="dd-title" name="title" maxlength="200" required value="${esc(setup.title)}"></label><label for="dd-start">Kursbeginn<input id="dd-start" type="date" name="startDate" required value="${esc(setup.startDate)}"></label><label for="dd-days">Dauer in Kalendertagen<input id="dd-days" type="number" name="days" min="1" max="90" required value="${setup.days||14}"><small>14 Tage = zwei Wochen; auch Wochenenden zählen zur Laufzeit.</small></label></div>${proposal?.source==='calendar'?`<section class="dd-calendar-proposal"><span class="small-label">VORSCHLAG AUS DEINEM KALENDER</span><p>${esc(proposal.reason)}<br><strong>${esc(label(proposal.startDate))} – ${esc(label(proposal.endDate))}</strong></p><button type="button" class="button secondary" data-dd-action="suggest">Zeitraum übernehmen</button></section>`:'<p class="subtle-note">Im lokalen Kalender ist noch kein eindeutiger Kurszeitraum verfügbar. Du kannst Beginn und Dauer selbst festlegen; Kalender-Vorschläge werden nur nach eindeutiger Kurszuordnung gemacht.</p>'}${available()?`<div class="dd-connection-check"><button type="button" class="button secondary" data-dd-action="connection" ${busy?'disabled':''}>${busy?'Spaces wird geprüft …':'Spaces-Verbindung prüfen'}</button><span role="status">${connection?.supported?'Verbunden · Kategorie DevDiary verfügbar.':''}</span></div>`:''}<fieldset class="dd-reminders"><legend>Deine tägliche Erinnerung</legend><label class="dd-check"><input type="checkbox" name="reminderEnabled" ${setup.reminder.enabled?'checked':''}>Jeden Tag an meinen Dev Diary erinnern</label><div><label for="dd-time">Uhrzeit · Berlin<input id="dd-time" type="time" name="reminderTime" required value="${esc(setup.reminder.time)}"></label><label class="dd-check"><input type="checkbox" name="weekends" ${setup.reminder.weekdays.includes(0)?'checked':''}>Auch am Wochenende</label></div><p class="subtle-note">Erinnerungen erscheinen in Context und als Desktop-Hinweis, solange die Mac-App läuft. Bei geschlossener App erscheint ein fälliger Hinweis beim nächsten Öffnen. Ein abgeschlossener Tag braucht keine weitere Erinnerung.</p></fieldset>${errorHTML()}<div class="form-footer"><span class="subtle-note">Zunächst lokal. Es wird noch nichts auf Spaces veröffentlicht.</span><button class="button primary" type="submit" ${busy?'disabled':''}>Dev Diary anlegen</button></div></form>`;
 }
 function studioHTML(){
  const diary=current();if(!diary)return '<p>Dieser Dev Diary ist nicht mehr vorhanden.</p>';
  const saved=diary.entries.find(e=>e.date===day)||{},entry=drafts.get(key(active,day))||saved,days=[];
  for(let d=diary.startDate;d<=diary.endDate&&days.length<366;d=addDays(d,1))days.push(d);
  const pending=[...drafts.keys()].filter(k=>k.startsWith(active+'|')).length,appearance=appearanceDrafts.get(active)||diary,style=appearance.presentation;
  const remote=diary.remote||{},recording=speech?.isActive()===true,locked=busy||recording;
  let preview;try{preview=renderDevDiaryPost(compileDevDiaryMarkdown(draftDiary()));}catch{preview='<p>Bitte einen Beitragstitel eingeben.</p>';}
  return `<section class="dd-studio"><header class="dd-course-strip"><div><span class="small-label">${esc(diary.courseName)}</span><strong>${esc(appearance.title||diary.title)}</strong><span>${esc(label(diary.startDate))} – ${esc(label(diary.endDate))} · ${diary.entries.filter(e=>e.completed).length}/${days.length} Tage abgeschlossen</span></div><span class="tag">${remote.postId?'Spaces verbunden':'Lokaler Entwurf'}</span></header>
  <div class="dd-date-bar"><label class="dd-date-picker" for="dd-day-date">Dein Tag<input id="dd-day-date" type="date" min="${diary.startDate}" max="${diary.endDate}" value="${day}" ${busy?'disabled':''}></label><button type="button" class="button secondary dd-voice-toggle" data-dd-action="voice" aria-expanded="${voiceOpen}">${micIcon}<span>Diktieren</span></button></div>
  <nav class="dd-days" aria-label="Tag im Dev Diary auswählen">${days.map(d=>`<button type="button" data-dd-action="day" data-dd-day="${d}" class="dd-day ${d===day?'selected':''}" aria-pressed="${d===day}"><span>${esc(label(d))}</span>${diary.entries.some(e=>e.date===d&&e.completed)?'<span aria-label="abgeschlossen">✓</span>':drafts.has(key(active,d))?'<span aria-label="ungesicherter Entwurf">●</span>':''}</button>`).join('')}</nav>
  ${voiceOpen?`<div class="dd-voice" data-dd-voice><label for="dd-voice-field">Diktat einfügen in<select id="dd-voice-field" ${recording?'disabled':''}>${fields.map(([name,title])=>`<option value="${name}" ${name===voiceField?'selected':''}>${title}</option>`).join('')}</select></label>${speech?renderSpeechControls(speech.state,{purpose:'diary',disabled:busy}):''}${voiceOverflow?`<label>Vollständiges Diktat<textarea readonly rows="4">${esc(voiceOverflow)}</textarea></label>`:''}</div>`:''}
  <div class="dd-editor-layout"><form id="dd-entry-form" data-diary-id="${esc(active)}"><fieldset ${busy?'disabled':''}><legend>${esc(label(day))}</legend>${fields.map(([name,title,hint],i)=>`<div class="dd-field"><div class="dd-field-head"><label for="dd-${name}"><span class="dd-field-number">0${i+1}</span>${title}</label><button type="button" class="icon-button dd-field-mic" data-dd-action="dictate" data-dd-field="${name}" aria-label="${esc(title)} diktieren" title="Dieses Feld diktieren" ${busy?'disabled':''}>${micIcon}</button></div><textarea id="dd-${name}" name="${name}" rows="3" maxlength="4000" placeholder="${hint}">${esc(entry[name]||'')}</textarea></div>`).join('')}<label class="dd-check"><input type="checkbox" name="completed" ${entry.completed?'checked':''}>Tag abgeschlossen</label></fieldset><div class="dd-save-bar"><span class="dd-local-state" role="status">${pending||appearanceDrafts.has(active)?'Ungesicherter Entwurf':'Lokal gespeichert'}</span><button class="button secondary" type="submit" ${locked?'disabled':''}>Speichern</button></div></form>
  <aside class="dd-publish-panel"><div class="dd-preview-heading"><span class="small-label">BEITRAGSVORSCHAU</span><span class="tag">Mit Entwürfen</span></div>
  <details class="dd-appearance" data-dd-settings ${settingsOpen?'open':''}><summary>Beitrag gestalten</summary><form id="dd-appearance-form"><label for="dd-post-title">Titel<input id="dd-post-title" name="title" maxlength="200" required value="${esc(appearance.title)}" ${locked?'disabled':''}></label><div class="dd-format-grid"><label>Tage anzeigen<select name="layout" ${locked?'disabled':''}><option value="sections" ${style.layout==='sections'?'selected':''}>Offene Abschnitte</option><option value="collapsible" ${style.layout==='collapsible'?'selected':''}>Aufklappbare Tage</option></select></label><label>Reihenfolge<select name="order" ${locked?'disabled':''}><option value="oldest" ${style.order==='oldest'?'selected':''}>Ältester Tag zuerst</option><option value="newest" ${style.order==='newest'?'selected':''}>Neuester Tag zuerst</option></select></label></div><label>Überschriften<select name="headings" ${locked?'disabled':''}><option value="questions" ${style.headings==='questions'?'selected':''}>Fragen der Vorlage</option><option value="compact" ${style.headings==='compact'?'selected':''}>Kurze Überschriften</option></select></label><label class="dd-check"><input type="checkbox" name="hideEmpty" ${style.hideEmpty?'checked':''} ${locked?'disabled':''}>Leere Felder ausblenden</label><label class="dd-check"><input type="checkbox" name="showPeriod" ${style.showPeriod?'checked':''} ${locked?'disabled':''}>Kurszeitraum im Beitrag zeigen</label><button class="button secondary" type="submit" ${locked?'disabled':''}>Gestaltung speichern</button></form></details>
  <div id="dd-preview-content" class="markdown-content dd-post-preview" aria-label="Vorschau des gesamten Beitrags">${preview}</div>
  <div class="dd-publish-actions"><p class="dd-remote-status">${remote.url?`<a href="${esc(remote.url)}" target="_blank" rel="noopener noreferrer">Beitrag auf Spaces ↗</a>`:remote.status==='unknown'?'Spaces-Stand muss abgeglichen werden.':'Ein Beitrag für die gesamte Kursphase.'}</p><button class="button primary" type="button" data-dd-action="prepare" ${locked||!available()?'disabled':''}>${busy?'Spaces wird geprüft …':remote.postId?'Aktualisierung prüfen':'Für Spaces prüfen'}</button><p class="subtle-note">Sichert deine Entwürfe. Veröffentlichen folgt erst nach der Prüfung.</p>${!available()?'<p class="subtle-note">Spaces-Veröffentlichung und lokale Spracheingabe sind in der Desktop-App verfügbar.</p>':''}<div class="dd-utility-actions"><button type="button" class="text-link" data-dd-action="connection" ${locked||!available()?'disabled':''}>Verbindung prüfen</button><button class="text-link" type="button" data-dd-action="export">Markdown ↓</button></div></div>
  <details class="dd-reminder-settings"><summary>Erinnerung</summary><form id="dd-reminder-form"><label class="dd-check"><input type="checkbox" name="enabled" ${diary.reminder.enabled?'checked':''}>Erinnerung aktiv</label><label>Uhrzeit · Berlin<input type="time" name="time" required value="${esc(diary.reminder.time)}"></label><label class="dd-check"><input type="checkbox" name="weekends" ${diary.reminder.weekdays.includes(0)?'checked':''}>Auch am Wochenende</label><button class="button secondary" type="submit" ${locked?'disabled':''}>Erinnerung speichern</button></form></details></aside></div>${errorHTML()}${conflict?conflictHTML():''}${review?reviewHTML():''}</section>`;
 }

 function reviewHTML(){return `<section class="dd-review" aria-label="Spaces-Vorschau"><span class="small-label">${review.action==='create'?'EINEN BEITRAG VERÖFFENTLICHEN':review.action==='unchanged'?'DER BEITRAG IST BEREITS AKTUELL':'BESTEHENDEN BEITRAG AKTUALISIEREN'}</span><h3>${esc(review.preview?.title||current().title)}</h3><p>${esc(current().courseName)} · Kategorie DevDiary</p><div class="markdown-content">${renderDevDiaryPost(review.preview?.content||compileDevDiaryMarkdown(current()))}</div>${review.warning?`<p class="dd-error" role="status">${esc(review.warning)}</p>`:review.notifications==='disabled'?'<p class="subtle-note">Automatische E-Mail-Hinweise an Kursmitglieder sind für diese Veröffentlichung ausgeschaltet.</p>':''}<p class="subtle-note">Dieser Inhalt wird für die Mitglieder dieses Kurses auf Spaces sichtbar. Spätere Tage aktualisieren denselben Beitrag. Externe Änderungen werden vor dem Schreiben geprüft.</p><div class="dd-actions"><button type="button" class="button secondary" data-dd-action="discard-review" ${busy?'disabled':''}>Weiter schreiben</button><button type="button" class="button primary" data-dd-action="publish" ${busy?'disabled':''}>${busy?'Wird übertragen …':review.action==='create'?'Diesen Beitrag veröffentlichen':review.action==='unchanged'?'Stand übernehmen':'Diesen Beitrag aktualisieren'}</button></div></section>`;}
 function conflictHTML(){return `<section class="dd-review"><span class="small-label">SPACES WURDE AUẞERHALB VON CONTEXT BEARBEITET</span><h3>Änderungen zuerst abgleichen.</h3><p>Übertrage relevante Änderungen aus diesem aktuellen Spaces-Stand in deine Tagesnotizen. Danach wird deine vollständige lokale Version über denselben Beitrag geschrieben.</p>${conflict.post?.url?`<a href="${esc(conflict.post.url)}" target="_blank" rel="noopener noreferrer">Aktuellen Beitrag auf Spaces öffnen ↗</a>`:''}${conflict.post?.contentTruncated?'<p class="subtle-note">Die Anzeige ist gekürzt. Prüfe den vollständigen Beitrag über den Spaces-Link.</p>':''}<pre class="dd-remote-text">${esc(conflict.post?.contentText||'Öffne den Originalbeitrag, um den aktuellen Inhalt zu prüfen.')}</pre><label class="dd-check"><input id="dd-conflict-checked" type="checkbox">Ich habe die Änderungen in meinen lokalen Tagesnotizen abgeglichen.</label><button type="button" class="button secondary" data-dd-action="resolve-conflict" ${busy?'disabled':''}>Abgeglichenen Gesamtbeitrag prüfen</button></section>`;}
 async function checkConnection(){
  if(busy||!available())return;if(setup)readSetup();const d=current()||setup;if(!d?.courseUrl)return;
  const token=++epoch,scope=d.courseUrl,runId=d.id||probeRunId;
  const visible=()=>open&&(currentModal()||setup?.courseUrl===scope&&document.getElementById('modal')?.open&&document.getElementById('dd-setup-form'));
  busy=true;error='';paint();
  try{const result=unwrap(await bridge.devDiary({op:'get',runId,courseURL:scope}));if(token===epoch&&visible()){connection=result;if(!result.supported)error=result.reason||'Bitte melde dich bei Spaces im Context-Browser an.';}}
  catch(e){if(token===epoch&&visible())error=e.message;}
  finally{if(token===epoch){busy=false;if(!currentModal()&&!(setup&&document.getElementById('modal')?.open&&document.getElementById('dd-setup-form')))open=false;paint();}}
 }

 function openSetup(){
  if(busy)return;cancelVoice();voiceOpen=false;
  const cs=courses(),selected=cs.find(c=>c.projectId===getState().activeCourse)||cs[0];
  active='';probeRunId=crypto.randomUUID();review=null;conflict=null;connection=null;error='';epoch++;open=true;setup={...selected,title:selected?'Dev Diary · '+selected.courseName:'Dev Diary',startDate:today(),days:14,reminder:{enabled:true,time:'18:00',weekdays:[0,1,2,3,4,5,6]}};paint();
 }
 function openDiary(id,date){if(busy)return;cancelVoice();voiceOpen=false;const diary=find(id);if(!diary)return;remember();active=id;setup=null;review=null;conflict=null;connection=null;error='';epoch++;open=true;day=date&&date>=diary.startDate&&date<=diary.endDate?date:today()>=diary.startDate&&today()<=diary.endDate?today():diary.startDate;paint();}
 async function prepare(acknowledgeRevision){
  if(busy||speech?.isActive()||!current()||!available())return;
  let diary;try{diary=saveDrafts();if(!diary.entries.some(e=>fields.some(([k])=>e[k]?.trim())))throw new Error('Schreibe zuerst mindestens eine Tagesnotiz.');}catch(e){error=e.message;paint();return;}
  const token=++epoch;busy=true;review=null;error='';paint();
  try{const next=unwrap(await bridge.devDiary({op:'prepare',runId:diary.id,courseURL:diary.courseUrl,title:diary.title,content:compileDevDiaryMarkdown(diary),...(acknowledgeRevision?{acknowledgeRevision}:{})}));if(token===epoch&&open&&currentModal()){if(!next?.reviewToken)throw new Error('Spaces hat noch keine verlässliche Vorschau geliefert.');review=next;conflict=null;}}
  catch(e){if(token===epoch&&open){error=e.message;if(e.code==='DIARY_REMOTE_CHANGED')try{const latest=unwrap(await bridge.devDiary({op:'get',runId:diary.id,courseURL:diary.courseUrl}));if(token===epoch&&currentModal()&&latest?.post?.revision)conflict=latest;}catch{}}}
  finally{if(token===epoch){busy=false;if(!currentModal())open=false;paint();}}
 }
 async function publish(){
  if(busy||speech?.isActive()||!review?.reviewToken||!current())return;
  const token=++epoch,diary=current(),prepared=review;busy=true;error='';paint();
  try{const result=unwrap(await bridge.devDiary({op:'publish',reviewToken:prepared.reviewToken}));
   const latest=find(diary.id);if(latest){const remote={postId:String(result.postId||result.id||''),url:result.postURL||result.url||'',lastPublishedHash:result.contentHash||result.hash||'',status:'published'};store({...latest,remote,updatedAt:new Date().toISOString()},true);}
   if(token===epoch){review=null;onNotice('Der Dev-Diary-Beitrag ist auf Spaces gespeichert.');}
  }catch(e){if(token===epoch){error=e.message;review=null;}}
  finally{if(token===epoch){busy=false;if(!currentModal())open=false;paint();}}
 }
 function exportMarkdown(){if(!current())return;remember();const diary=draftDiary(),url=URL.createObjectURL(new Blob([compileDevDiaryMarkdown(diary)],{type:'text/markdown;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='dev-diary-'+diary.startDate+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

 document.addEventListener('input',e=>{
  if(e.target.closest('#dd-appearance-form')){rememberAppearance();return;}
  if(e.target.closest('#dd-entry-form')){remember();updatePreview();if(review){review=null;document.querySelector('.dd-review')?.remove();}const confirm=document.getElementById('dd-conflict-checked');if(confirm)confirm.checked=false;const node=document.querySelector('.dd-local-state');if(node)node.textContent='Ungesicherter Entwurf · Speichern übernimmt deine Tagesnotizen.';}
  if(e.target.closest('#dd-setup-form'))readSetup();
 });
 document.addEventListener('toggle',e=>{if(e.target.matches?.('[data-dd-settings]'))settingsOpen=e.target.open;if(e.target.closest?.('[data-dd-voice]'))speech?.handleToggle(e);},true);
 document.addEventListener('change',e=>{
  if(e.target.closest?.('[data-dd-voice]')){if(e.target.id==='dd-voice-field'){cancelVoice();voiceField=e.target.value;return;}speech?.handleChange(e);return;}
  if(e.target.closest('#dd-appearance-form')){rememberAppearance();return;}
  if(e.target.id==='dd-day-date'){const next=e.target.value,d=current();if(!busy&&d&&next>=d.startDate&&next<=d.endDate){cancelVoice();remember();day=next;review=null;error='';paint();}return;}
  if(e.target.matches('[data-dd-course]')){readSetup();const c=courses().find(c=>c.courseUrl===setup.courseUrl);setup={...setup,...c,title:'Dev Diary · '+c.courseName};connection=null;error='';paint();}
  else if(e.target.closest('#dd-entry-form')){remember();if(review){review=null;document.querySelector('.dd-review')?.remove();}const confirm=document.getElementById('dd-conflict-checked');if(confirm)confirm.checked=false;}
 });
 document.addEventListener('submit',e=>{
  const f=e.target;if(!['dd-setup-form','dd-entry-form','dd-reminder-form','dd-appearance-form'].includes(f.id))return;e.preventDefault();if(busy||speech?.isActive())return;
  try{
   error='';review=null;
   if(f.id==='dd-setup-form'){readSetup();const diary=createDevDiary(setup,getState());if((getState().devDiaries||[]).some(d=>!d.archived&&d.courseUrl===diary.courseUrl&&d.startDate===diary.startDate&&d.endDate===diary.endDate))throw new Error('Für diesen Kurs und Zeitraum gibt es bereits einen Dev Diary. Öffne ihn in deinen Notizen.');store(diary);setup=null;active=diary.id;day=today()>=diary.startDate&&today()<=diary.endDate?today():diary.startDate;onNotice('Dev Diary lokal angelegt.');}
   else if(f.id==='dd-appearance-form'){rememberAppearance();saveDrafts();onNotice('Beitragsgestaltung gespeichert.');}
   else if(f.id==='dd-entry-form'){saveDrafts();onNotice('Tagesnotizen lokal gespeichert.');}
   else {const d=current(),data=new FormData(f),next=validateDevDiary({...d,reminder:{...d.reminder,enabled:data.get('enabled')==='on',time:data.get('time'),weekdays:data.get('weekends')==='on'?[0,1,2,3,4,5,6]:[1,2,3,4,5]}},getState().projects);store(next);onNotice('Erinnerung gespeichert.');}
  }catch(e){error=e.message;}paint();
 });
 document.addEventListener('click',e=>{
  if(e.target.closest?.('[data-dd-voice]')){if(e.target.closest?.('[data-speech-action]')?.dataset.speechAction==='start')invalidateReview();speech?.handleClick(e);return;}
  const b=e.target.closest('[data-dd-action]');if(!b)return;const action=b.dataset.ddAction;
  if(action==='new'){openSetup();return;}if(action==='open'){openDiary(b.dataset.ddId,b.dataset.ddDay);return;}
  if(busy)return;
  if(action==='close'){document.getElementById('modal')?.close();return;}
  if(action==='suggest'){readSetup();const p=suggestion();if(p?.source==='calendar'){setup={...setup,startDate:p.startDate,days:p.days||setup.days};error='';paint();}}
  if(action==='voice'){remember();voiceOpen=!voiceOpen;if(voiceOpen)ensureSpeech();else cancelVoice();paint();}
  if(action==='dictate'){if(!fields.some(([name])=>name===b.dataset.ddField))return;remember();void (async()=>{const input=ensureSpeech();if(input.isActive()){if(voiceField===b.dataset.ddField){await input.stop();return;}await input.cancel('');}voiceField=b.dataset.ddField;voiceOpen=true;voiceOverflow='';invalidateReview();paint();await input.start();})();}
  if(action==='day'){cancelVoice();remember();day=b.dataset.ddDay;review=null;error='';paint();}
  if(action==='prepare'){conflict=null;void prepare();}
  if(action==='resolve-conflict'){if(!document.getElementById('dd-conflict-checked')?.checked){error='Bitte gleiche die externen Änderungen zuerst ab und bestätige dies.';paint();return;}void prepare(conflict?.post?.revision);}
  if(action==='publish')void publish();
  if(action==='connection')void checkConnection();
  if(action==='discard-review'){review=null;paint();}
  if(action==='export')try{exportMarkdown();}catch(e){error=e.message;paint();}
 });
 document.getElementById('modal')?.addEventListener('close',()=>{if(!open)return;if(document.getElementById('modal')?.open&&(currentModal()||document.getElementById('dd-setup-form')))return;remember();open=false;cancelVoice();if(speech){const old=speech;speech=null;void old.dispose();}review=null;conflict=null;if(!busy)epoch++;});
 return {open:openDiary,start:openSetup,hasUnsaved:()=>drafts.size>0||appearanceDrafts.size>0,
  renderCards(){return (getState().devDiaries||[]).filter(d=>!d.archived&&(!getState().activeCourse||d.projectId===getState().activeCourse)).map(d=>`<article class="note-card dd-note-card"><span class="small-label">DEV DIARY · ${esc(d.courseName)}</span><button class="note-title" data-dd-action="open" data-dd-id="${esc(d.id)}">${esc(d.title)} ↗</button><p>${esc(label(d.startDate))} – ${esc(label(d.endDate))}</p><div class="note-card-foot"><span>${d.entries.filter(e=>e.completed).length} Tage abgeschlossen</span><span>${d.remote?.postId?'Mit Spaces verbunden':'Lokal'}</span></div></article>`).join('');},
  banner(){return `<section class="dd-notes-banner"><div><span class="small-label">TÄGLICH FESTHALTEN</span><h2>Dein Dev Diary für den Kurs.</h2><p>Tagesvorlage, Kalender-Vorschlag und Erinnerung. Auf Spaces bleibt es ein Beitrag für die ganze Kursphase.</p></div><button class="button primary" type="button" data-dd-action="new">Dev Diary starten</button></section>`;}
 };
}
