import {brandLogo} from './brand-logos.js';

const CLOUD='https://api.nango.dev';
const CAPABILITIES=['mailRead','mailSend','mailModify','calendarRead','calendarWrite','driveRead','boardRead'];
const SERVICES=Object.freeze([
  {id:'outlook',label:'Outlook',description:'Deine Nachrichten und Kalender bei Microsoft.',signIn:'Mit Microsoft anmelden',allowed:['mailRead','mailSend','mailModify','calendarRead','calendarWrite'],read:['mailRead','calendarRead']},
  {id:'gmail',label:'Gmail',description:'Deine Google-Nachrichten in Context.',signIn:'Mit Google anmelden',allowed:['mailRead','mailSend','mailModify'],read:['mailRead']},
  {id:'google-calendar',label:'Google Kalender',description:'Deine Google-Termine in Context einlesen.',signIn:'Mit Google anmelden',allowed:['calendarRead'],read:['calendarRead']},
  {id:'google-drive',label:'Google Drive',description:'Dateien und Terminpläne zum Import auswählen.',signIn:'Mit Google anmelden',allowed:['driveRead'],read:['driveRead']},
  {id:'miro',label:'Miro',description:'Aufgaben und Inhalte aus verknüpften Kursboards lesen.',signIn:'Mit Miro anmelden',allowed:['boardRead'],read:['boardRead']},
]);
const serviceById=id=>SERVICES.find(service=>service.id===id);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const safeText=(value,maximum=200)=>typeof value==='string'&&value.length<=maximum&&!/[\u0000-\u001f\u007f]/.test(value)?value.trim():'';
function endpoint(value){
  const text=safeText(value,2048);if(!text)throw new Error('endpoint');
  const url=new URL(text),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(!['https:','http:'].includes(url.protocol)||(url.protocol==='http:'&&!local)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('endpoint');
  return url.href.replace(/\/+$/,'');
}
function capabilities(service,value){
  return Object.fromEntries(CAPABILITIES.map(key=>[key,service.allowed.includes(key)&&(typeof value?.[key]==='boolean'?value[key]:service.read.includes(key))]));
}
export function nangoConnectionsSnapshot(value){
  let baseURL=CLOUD,valid=true;try{baseURL=endpoint(value?.baseURL??CLOUD);}catch{valid=false;}
  const configured=valid&&value?.configured===true,rows=Array.isArray(value?.services)?value.services.slice(0,20):[];
  return {configured,baseURL,storage:value?.storage==='encrypted'?'encrypted':value?.storage==='session'?'session':'unavailable',services:SERVICES.map(service=>{
    const row=rows.find(candidate=>candidate?.service===service.id)||{},integrationId=safeText(row.integrationId),connectionId=safeText(row.connectionId);
    return {service:service.id,label:service.label,integrationId,connectionId,connected:configured&&!!integrationId&&!!connectionId&&row.connected===true,capabilities:capabilities(service,row.capabilities),needsAttention:!!row.error};
  })};
}
function logo(service){
  if(service==='miro')return brandLogo('miro');
  if(service==='outlook')return brandLogo('outlook');
  if(service==='gmail')return '<span class="tool-icon brand-logo brand-gmail" aria-hidden="true"><svg viewBox="0 0 24 24" width="36" height="36"><path fill="#4285f4" d="M1.636 20.727h3.819v-9.272L0 7.364v11.727c0 .905.732 1.636 1.636 1.636"/><path fill="#34a853" d="M18.545 20.727h3.819c.904 0 1.636-.731 1.636-1.636V7.364l-5.455 4.091"/><path fill="#fbbc04" d="M18.545 4.364v7.091L24 7.364V5.182c0-2.024-2.311-3.179-3.927-1.964"/><path fill="#ea4335" d="M5.455 11.455V4.364L12 9.273l6.545-4.909v7.091L12 16.364"/><path fill="#c5221f" d="M0 5.182v2.182l5.455 4.091V4.364L3.927 3.218C2.31 2.003 0 3.158 0 5.182"/></svg></span>';
  const asset=service==='google-calendar'?'googlecalendar':'googledrive';
  return `<span class="tool-icon brand-logo brand-${asset}" aria-hidden="true"><img src="./brands/${asset}.svg" width="40" height="40" alt="" decoding="async" draggable="false"></span>`;
}

/* Credentials live only in the submitted DOM field and the native IPC call.
   This controller never stores a key in drafts, state, HTML or localStorage. */
export function createNangoConnectionsView({onChange=()=>{},onNotice=()=>{},onMail=()=>{},onCalendar=()=>{},onMiro=()=>{},onConnectionChange=()=>{},bridge=globalThis.window?.contextDesktop,document=globalThis.document,randomUUID=()=>globalThis.crypto.randomUUID()}={}){
  let snapshot=nangoConnectionsSnapshot(),draft,loaded=false,busy='',error='',notice='',editing=false,confirmReset=false,disposed=false,epoch=0,pending,connecting=null,cancelling=false;
  const available=()=>typeof bridge?.nango==='function';
  const changed=()=>{if(disposed)return;const field=document?.activeElement,id=field?.closest?.('.nango-page')?field.id:'';onChange();if(id)document?.getElementById?.(id)?.focus?.({preventScroll:true});};
  const fresh=token=>!disposed&&token===epoch;
  function hydrate(){draft={mode:snapshot.baseURL===CLOUD?'cloud':'self',baseURL:snapshot.baseURL,customURL:snapshot.baseURL===CLOUD?'http://127.0.0.1:3003':snapshot.baseURL,integrations:Object.fromEntries(snapshot.services.map(service=>[service.service,service.integrationId])),capabilities:Object.fromEntries(snapshot.services.map(service=>[service.service,{...service.capabilities}]))};}
  hydrate();
  async function request(message){const reply=await bridge.nango(message);if(reply?.ok!==true)throw new Error('native');return reply.value;}
  async function status(){return nangoConnectionsSnapshot(await request({action:'status'}));}
  async function perform(name,operation,failure){
    if(disposed||busy||!available())return false;
    const token=++epoch;busy=name;error='';notice='';changed();
    const work=(async()=>{
      try{await operation(token);return fresh(token);}
      catch{if(fresh(token)){if(name.startsWith('connect-')&&connecting?.cancelRequested)announce('Die Anmeldung wird in Context nicht weiter geprüft. Prüfe den Status bei Bedarf erneut.');else error=failure;}return false;}
      finally{if(fresh(token)){busy='';pending=null;if(name.startsWith('connect-')){connecting=null;cancelling=false;}changed();}}
    })();pending=work;return work;
  }
  function announce(text){error='';notice=text;onNotice(text);}
  function connectionChanged(action,service){try{void Promise.resolve(onConnectionChange({action,...(service?{service}:{})})).catch(()=>{});}catch{}}
  function focusSetup(){queueMicrotask(()=>{if(disposed)return;const form=document?.querySelector?.('[data-nango-form="configure"]');form?.scrollIntoView?.({block:'start',behavior:'auto'});const field=form?.querySelector?.(draft.mode==='cloud'?'[name="secretKey"]':'[name="baseURL"]');field?.focus?.({preventScroll:true});});}
  function readFields(form){
    const values=new FormData(form),integrations={},writes={};
    for(const service of SERVICES){integrations[service.id]=String(values.get('integration-'+service.id)||'');writes[service.id]={...draft.capabilities[service.id],mailSend:values.has('mailSend-'+service.id),mailModify:values.has('mailModify-'+service.id),calendarWrite:values.has('calendarWrite-'+service.id)};}
    return {baseURL:values.get('baseURL'),secretKey:values.get('secretKey'),integrations,capabilities:writes};
  }
  function clearSecret(form){const input=form?.elements?.namedItem?.('secretKey')||form?.querySelector?.('[name="secretKey"]');if(input)input.value='';}
  async function configure(fields={},form){
    clearSecret(form);if(disposed||busy||!available())return false;
    let body;
    try{
      const baseURL=endpoint(fields.baseURL??draft.baseURL),secretKey=safeText(fields.secretKey??'',8192);
      if((!snapshot.configured||baseURL!==snapshot.baseURL)&&!secretKey){error='Trage den Nango-Schlüssel für diesen Server ein.';changed();return false;}
      const integrations={},permissions={};
      for(const service of SERVICES){const input=fields.integrations?.[service.id]??draft.integrations[service.id];if(typeof input!=='string'||input.length>200||/[\u0000-\u0020\u007f]/.test(input.trim()))throw new Error('integration');integrations[service.id]=input.trim();const values=capabilities(service,fields.capabilities?.[service.id]??draft.capabilities[service.id]);permissions[service.id]=Object.fromEntries(service.allowed.map(key=>[key,values[key]]));}
      if(!Object.values(integrations).some(Boolean)){error='Trage mindestens eine Integration-ID aus Nango ein.';changed();return false;}
      body={baseURL,integrations,capabilities:permissions};if(secretKey)body.secretKey=secretKey;
      draft.baseURL=baseURL;draft.integrations={...integrations};draft.capabilities=permissions;
    }catch{error='Prüfe die Serveradresse und die Integration-IDs. HTTPS oder ein lokaler Server sind möglich.';changed();return false;}
    return perform('configure',async token=>{
      try{await request({action:'configure',body});const next=await status();if(!fresh(token))return;snapshot=next;loaded=true;hydrate();editing=!snapshot.configured;if(!snapshot.configured)throw new Error('unconfirmed');announce('Nango-Einrichtung gespeichert. Verbinde dein Konto über die passende Karte.');connectionChanged('configure');}
      finally{if(body.secretKey)body.secretKey='';}
    },'Die Einrichtung konnte nicht gespeichert werden. Prüfe Server, Schlüssel und Integration-IDs und versuche es erneut.');
  }
  function load(){
    if(disposed)return Promise.resolve(false);if(busy)return pending||Promise.resolve(false);
    if(!available()){loaded=true;error='Kontoverbindungen über Nango sind in der Context-Desktop-App verfügbar.';changed();return Promise.resolve(false);}
    // An attempted load also counts as loaded when IPC fails; app.js must not
    // turn an error render into an immediate, unbounded automatic retry.
    loaded=true;
    return perform('status',async token=>{const next=await status();if(fresh(token)){snapshot=next;loaded=true;if(!editing)hydrate();}},'Der Verbindungsstatus konnte nicht geladen werden. Versuche es erneut.');
  }
  function bindConnection(service,connectionId,form){
    const row=snapshot.services.find(item=>item.service===service),id=safeText(connectionId);
    if(!row||!snapshot.configured||!row.integrationId||disposed||busy)return Promise.resolve(false);
    if(!id){error='Trage die Connection-ID deiner bestehenden Nango-Verbindung ein.';changed();return Promise.resolve(false);}
    const field=form?.elements?.namedItem?.('connectionId');if(field)field.value='';
    return perform('connection-'+service,async token=>{await request({action:'connection',service,body:{connectionId:id}});const next=await status();if(!fresh(token))return;snapshot=next;loaded=true;if(!snapshot.services.find(item=>item.service===service)?.connected)throw new Error('unconfirmed');announce('Bestehende Kontoverbindung geprüft und übernommen.');connectionChanged('connection',service);},'Diese Verbindung konnte nicht bestätigt werden. Verwende eine Connection-ID aus deinem Context-Nango-Konto.');
  }
  function click(action,service){
    if(disposed)return Promise.resolve(false);
    if(action==='cancel-connect'&&connecting&&!cancelling){
      const attempt=connecting,token=epoch;attempt.cancelRequested=true;cancelling=true;changed();
      return request({action:'cancel',id:attempt.id}).then(()=>true).catch(()=>{if(fresh(token)&&connecting===attempt){attempt.cancelRequested=false;cancelling=false;error='Die Anmeldung konnte nicht angehalten werden. Versuche es erneut oder prüfe anschließend den Status.';changed();}return false;});
    }
    if(action==='refresh')return load();
    if(action==='settings'&&!busy){editing=!snapshot.configured||!editing;confirmReset=false;if(editing)hydrate();changed();if(editing)focusSetup();return Promise.resolve(true);}
    if(action==='reset'&&!busy&&snapshot.configured){confirmReset=true;changed();return Promise.resolve(true);}
    if(action==='cancel-reset'&&!busy){confirmReset=false;changed();return Promise.resolve(true);}
    if(action==='confirm-reset'&&confirmReset)return perform('reset',async token=>{await request({action:'reset'});const next=await status();if(fresh(token)){snapshot=next;if(next.configured)throw new Error('unconfirmed');hydrate();loaded=true;editing=true;confirmReset=false;announce('Die Nango-Einrichtung wurde aus Context entfernt.');connectionChanged('reset');}},'Die lokale Einrichtung konnte nicht entfernt werden. Versuche es erneut.');
    const definition=serviceById(service),row=snapshot.services.find(item=>item.service===service);
    if(!definition||!row||!snapshot.configured||!row.integrationId||busy)return Promise.resolve(false);
    if(action==='connect')return perform('connect-'+service,async token=>{const id=randomUUID();connecting={id,service,cancelRequested:false};changed();await request({action:'connect',service,id});const next=await status();if(!fresh(token))return;snapshot=next;loaded=true;const confirmed=snapshot.services.find(item=>item.service===service)?.connected;announce(confirmed?'Kontoverbindung bestätigt.':'Anmeldung gestartet. Schließe sie im Systembrowser ab und prüfe anschließend den Status.');if(confirmed)connectionChanged('connect',service);},'Die Anmeldung wurde nicht bestätigt. Prüfe die Nango-Integration und versuche es erneut.');
    if(action==='disconnect'&&row.connected)return perform('disconnect-'+service,async token=>{await request({action:'disconnect',service});const next=await status();if(fresh(token)){snapshot=next;loaded=true;if(snapshot.services.find(item=>item.service===service)?.connected)throw new Error('unconfirmed');announce('Kontoverbindung getrennt.');connectionChanged('disconnect',service);}},'Die Kontoverbindung konnte nicht getrennt werden. Versuche es erneut.');
    if(action==='mail'&&row.connected&&row.capabilities.mailRead)return perform('mail-'+service,async()=>{await onMail(service);},'Die Mailansicht konnte nicht geöffnet werden.');
    if(action==='boards'&&row.connected&&row.capabilities.boardRead)return perform('boards-'+service,async()=>{await onMiro();},'Die Boardansicht konnte nicht geöffnet werden.');
    if(action==='calendar'&&row.connected&&(row.capabilities.calendarRead||row.capabilities.calendarWrite||row.capabilities.driveRead))return perform('calendar-'+service,async()=>{await onCalendar(service);},'Die Kalenderansicht konnte nicht geöffnet werden.');
    return Promise.resolve(false);
  }
  function change(name,value){
    if(disposed||busy)return;
    if(name==='mode'&&['cloud','self'].includes(value)){draft.mode=value;draft.baseURL=value==='cloud'?CLOUD:draft.customURL;changed();}
    else if(name==='baseURL'){draft.baseURL=String(value).slice(0,2048);if(draft.mode==='self')draft.customURL=draft.baseURL;}
    else if(name.startsWith('integration-')){const service=name.slice(12);if(serviceById(service))draft.integrations[service]=String(value).slice(0,200);}
    else for(const capability of ['mailSend','mailModify','calendarWrite'])if(name.startsWith(capability+'-')){const service=name.slice(capability.length+1);if(serviceById(service)?.allowed.includes(capability))draft.capabilities[service][capability]=value===true;}
  }
  function connectionCard(definition){
    const row=snapshot.services.find(item=>item.service===definition.id),ready=available()&&snapshot.configured&&!!row.integrationId,state=row.connected?'Verbunden':row.needsAttention?'Verbindung prüfen':ready?'Bereit zur Anmeldung':'Einrichtung offen';
    const tags=[row.capabilities.mailRead&&'Mail lesen',row.capabilities.mailSend&&'Mail senden',row.capabilities.mailModify&&'Mail verwalten',row.capabilities.calendarRead&&'Termine lesen',row.capabilities.calendarWrite&&'Termine schreiben',row.capabilities.driveRead&&'Dateien lesen',row.capabilities.boardRead&&'Boards lesen'].filter(Boolean);
    const disabled=busy||!ready?'disabled':'';
    return `<article class="nango-service" aria-labelledby="nango-title-${definition.id}"><div class="nango-service-head"><div class="nango-service-identity"><div class="nango-service-logo">${logo(definition.id)}</div><h2 id="nango-title-${definition.id}">${definition.label}</h2></div><span class="nango-status${row.connected?' connected':row.needsAttention?' attention':''}">${state}</span></div><p>${definition.description}</p><ul class="nango-permissions" aria-label="In Context erlaubte Funktionen">${tags.map(tag=>`<li>${tag}</li>`).join('')}</ul>${row.needsAttention?'<p class="nango-service-note">Die Verbindung benötigt eine erneute Prüfung.</p>':''}${!ready?'<p class="nango-service-note">Zuerst Nango und die passende Integration einrichten.</p>':''}<div class="nango-service-actions">${row.connected?`${row.capabilities.boardRead?`<button class="button primary" data-nango="boards" data-nango-service="${definition.id}" ${busy?'disabled':''}>Kursboards lesen</button>`:''}${row.capabilities.mailRead?`<button class="button primary" data-nango="mail" data-nango-service="${definition.id}" ${busy?'disabled':''}>Mail öffnen</button>`:''}${row.capabilities.calendarRead||row.capabilities.calendarWrite||row.capabilities.driveRead?`<button class="button ${row.capabilities.mailRead?'secondary':'primary'}" data-nango="calendar" data-nango-service="${definition.id}" ${busy?'disabled':''}>${row.capabilities.driveRead?'Drive-Dateien öffnen':'Kalender öffnen'}</button>`:''}<button class="text-link" data-nango="disconnect" data-nango-service="${definition.id}" ${busy?'disabled':''}>Verbindung trennen</button>`:`<button class="button primary" data-nango="connect" data-nango-service="${definition.id}" ${disabled}>${busy==='connect-'+definition.id?'Anmeldung läuft …':definition.signIn}</button>`}</div>${ready&&!row.connected?`<details class="nango-existing"><summary>Bestehende Verbindung übernehmen</summary><p>Nutze eine Connection-ID, die zu deinem Context-Nango-Konto gehört. Context prüft die Zuordnung vor der Übernahme.</p><form data-nango-form="connection" data-nango-service="${definition.id}"><label for="nango-connection-${definition.id}">Connection-ID<input id="nango-connection-${definition.id}" name="connectionId" maxlength="200" autocomplete="off" required ${busy?'disabled':''}></label><button class="button secondary" type="submit" ${busy?'disabled':''}>Prüfen & übernehmen</button></form></details>`:''}</article>`;
  }
  function configuration(){
    return `<section class="nango-setup" aria-labelledby="nango-setup-title"><h2 id="nango-setup-title">Einmal einrichten</h2><p>Wähle deinen Nango-Server und ordne die dort eingerichteten Integrationen zu. Je nach Anbieter und Nango-Einrichtung brauchst du weiterhin eine registrierte OAuth-App mit passenden Rechten.</p><form data-nango-form="configure" aria-busy="${!!busy}"><fieldset class="nango-host-choice"><legend>Wo soll Nango laufen?</legend><label><input id="nango-host-cloud" type="radio" name="mode" value="cloud" ${draft.mode==='cloud'?'checked':''} ${busy?'disabled':''}> Nango Cloud</label><label><input id="nango-host-self" type="radio" name="mode" value="self" ${draft.mode==='self'?'checked':''} ${busy?'disabled':''}> Eigener Server</label></fieldset><div class="nango-fields"><label for="nango-base-url">Nango-Server<input id="nango-base-url" name="baseURL" type="url" value="${esc(draft.baseURL)}" required maxlength="2048" autocomplete="off" ${busy?'disabled':''} ${draft.mode==='cloud'?'readonly':''}></label><label for="nango-secret">Nango-Schlüssel ${snapshot.configured&&draft.baseURL===snapshot.baseURL?'<span class="nango-optional">leer lassen zum Beibehalten</span>':''}<input id="nango-secret" name="secretKey" type="password" maxlength="8192" autocomplete="new-password" spellcheck="false" aria-describedby="nango-secret-note" ${!snapshot.configured||draft.baseURL!==snapshot.baseURL?'required':''} ${busy?'disabled':''}></label></div><p class="nango-subtle" id="nango-secret-note">Der Schlüssel wird nur an die native Context-App übergeben und nach dem Absenden aus dem Feld entfernt. Er erscheint nicht erneut in dieser Ansicht.</p><div class="nango-integration-fields">${SERVICES.map(service=>`<fieldset><legend>${service.label}</legend><label for="nango-integration-${service.id}">Integration-ID in Nango<input id="nango-integration-${service.id}" name="integration-${service.id}" value="${esc(draft.integrations[service.id])}" maxlength="200" autocomplete="off" ${busy?'disabled':''}></label>${service.allowed.includes('mailSend')?`<label class="nango-write"><input name="mailSend-${service.id}" type="checkbox" ${draft.capabilities[service.id].mailSend?'checked':''} ${busy?'disabled':''}><span>Senden von E-Mails erlauben</span></label>`:''}${service.allowed.includes('mailModify')?`<label class="nango-write"><input name="mailModify-${service.id}" type="checkbox" ${draft.capabilities[service.id].mailModify?'checked':''} ${busy?'disabled':''}><span>Mail verwalten erlauben</span></label>`:''}${service.allowed.includes('calendarWrite')?`<label class="nango-write"><input name="calendarWrite-${service.id}" type="checkbox" ${draft.capabilities[service.id].calendarWrite?'checked':''} ${busy?'disabled':''}><span>Schreiben von Terminen erlauben</span></label>`:''}</fieldset>`).join('')}</div><p class="nango-subtle">Lesen ist voreingestellt. Diese Auswahl regelt, welche Aktionen Context ausführen darf. OAuth-Rechte werden zusätzlich in Nango und beim Anbieter erteilt. Senden, Verwalten und Schreiben sind anfangs aus; Aktivieren löst noch keine Übertragung aus.</p><div class="nango-form-actions"><button class="button primary" type="submit" ${busy||!available()?'disabled':''}>${busy==='configure'?'Wird gespeichert …':'Einrichtung speichern'}</button><a class="text-link" href="https://docs.nango.dev/guides" target="_blank" rel="noopener noreferrer" data-open="Nango-Einrichtung">Nango-Dokumentation ↗</a></div></form></section>`;
  }
  function render(){
    const count=snapshot.services.filter(service=>service.connected).length;
    const storageNote=snapshot.configured?snapshot.storage==='encrypted'?'Dein Nango-Schlüssel ist lokal verschlüsselt gespeichert.':snapshot.storage==='session'?'Dein Nango-Schlüssel gilt nur für diese Sitzung.':'Die lokale Schlüsselablage wurde nicht bestätigt.':'';
    return `<div class="nango-page"><header class="nango-heading"><div><p class="small-label">DEIN ARBEITSBEREICH</p><h1>Verbindungen</h1><p>Deine Konten für Mail, Kalender und Dateien. Mit den Rechten, die du freigibst.</p></div><button class="button secondary" data-nango="refresh" ${busy||!available()?'disabled':''}>${busy==='status'?'Status wird geprüft …':'Status prüfen'}</button></header><section class="nango-overview" aria-label="Nango-Verbindung"><div><strong>${snapshot.configured?'Nango eingerichtet':'Nango noch nicht eingerichtet'}</strong><span>${count} ${count===1?'Konto verbunden':'Konten verbunden'}${snapshot.configured?' · '+(snapshot.baseURL===CLOUD?'Nango Cloud':'Eigener Server'):''}</span></div><button class="text-link" data-nango="settings" ${busy?'disabled':''}>${snapshot.configured?(editing?'Einrichtung schließen':'Einrichtung bearbeiten'):'Zur Einrichtung'}</button></section><aside class="nango-data-flow"><strong>Du entscheidest, wo die Verbindung liegt.</strong><p>Bei Nango Cloud werden Zugriffstokens bei Nango gespeichert. Mail-, Kalender- und Drive-Anfragen laufen über Nango. Mit einem eigenen Server erfolgt das über deine Nango-Instanz.</p>${storageNote?`<p>${storageNote}</p>`:''}</aside>${!available()?'<p class="nango-message" role="status">Nutze die Context-Desktop-App, um Konten über Nango zu verbinden.</p>':''}${error?`<p class="nango-message error" role="alert">${esc(error)}</p>`:''}${notice?`<p class="nango-message success" role="status">${esc(notice)}</p>`:''}${busy.startsWith('connect-')?`<section class="nango-auth-pending" aria-label="Anmeldung"><p role="status" aria-live="polite">Anmeldung im Systembrowser läuft. Context bestätigt das Konto erst nach der Prüfung.</p><button class="button secondary" data-nango="cancel-connect" ${cancelling?'disabled':''}>${cancelling?'Wird angehalten …':'Warten abbrechen'}</button><small>Stoppt das Warten in Context. Bereits erteilte Freigaben bleiben bestehen.</small></section>`:''}${!snapshot.configured?configuration():''}<div class="nango-service-grid">${SERVICES.map(connectionCard).join('')}</div>${editing&&snapshot.configured?configuration():''}${snapshot.configured?`<footer class="nango-footer"><p>Konten werden erst nach bestätigter Anmeldung als verbunden angezeigt.</p><button class="text-link" data-nango="reset" ${busy?'disabled':''}>Lokale Einrichtung entfernen</button></footer>`:''}${confirmReset?'<section class="nango-reset" role="group" aria-labelledby="nango-reset-title"><h2 id="nango-reset-title">Nango-Einrichtung entfernen?</h2><p>Entfernt den Nango-Schlüssel und die Kontenzuordnungen aus Context. Bereits importierte lokale Daten bleiben erhalten.</p><div class="nango-form-actions"><button class="button secondary" data-nango="cancel-reset">Beibehalten</button><button class="button primary" data-nango="confirm-reset">Einrichtung entfernen</button></div></section>':''}${!loaded&&available()&&!busy?'<p class="nango-subtle" role="status">Der Verbindungsstatus wurde noch nicht geladen.</p>':''}</div>`;
  }
  const clickListener=event=>{const button=event.target?.closest?.('[data-nango]');if(!button||button.disabled)return;void click(button.dataset.nango,button.dataset.nangoService);};
  const changeListener=event=>{const field=event.target,form=field?.closest?.('[data-nango-form="configure"]');if(!form||field.name==='secretKey')return;change(field.name,field.type==='checkbox'?field.checked:field.value);};
  const submitListener=event=>{const form=event.target;if(form?.dataset?.nangoForm==='configure'){event.preventDefault();const fields=readFields(form);void configure(fields,form);}else if(form?.dataset?.nangoForm==='connection'){event.preventDefault();const value=new FormData(form).get('connectionId');void bindConnection(form.dataset.nangoService,String(value||''),form);}};
  const inputListener=event=>{const field=event.target,form=field?.closest?.('[data-nango-form="configure"]');if(!form||field.name==='secretKey'||field.type==='radio'||field.type==='checkbox')return;change(field.name,field.value);};
  document?.addEventListener?.('click',clickListener);document?.addEventListener?.('change',changeListener);document?.addEventListener?.('input',inputListener);document?.addEventListener?.('submit',submitListener);
  return {render,load,open:()=>{editing=false;confirmReset=false;return load();},click,configure,bindConnection,change,state:()=>({snapshot:structuredClone(snapshot),draft:structuredClone(draft),loaded,busy,error,notice,editing,confirmReset,connecting:connecting?{service:connecting.service,cancelling}:null}),dispose:()=>{if(connecting&&available())void request({action:'cancel',id:connecting.id}).catch(()=>{});clearSecret(document?.querySelector?.('[data-nango-form="configure"]'));disposed=true;++epoch;pending=null;connecting=null;document?.removeEventListener?.('click',clickListener);document?.removeEventListener?.('change',changeListener);document?.removeEventListener?.('input',inputListener);document?.removeEventListener?.('submit',submitListener);}};
}
