// Entering the access token of a read-only connector (GitLab, Mattermost) in the app.
// The token is sent once to the local server, checked there against the provider and stored
// encrypted by the desktop app. It is never shown again, kept in page state or put into links.
const SERVICES={
  gitlab:{name:'GitLab',field:'GitLab-Token',steps:'Öffne git.coco.study, dann Profilbild → Einstellungen → Zugriffstoken. Lege einen Token mit dem Zugriff „read_api“ an und füge ihn hier ein. Context liest damit nur deine offenen To-dos.'},
  mattermost:{name:'Mattermost',field:'Mattermost-Token',steps:'Öffne chat.coco.study, dann Profil → Sicherheit → Persönliche Zugriffstokens, lege einen Token an und füge ihn hier ein. Fehlt dieser Punkt, hat die Plattform persönliche Tokens nicht freigegeben. Dann geht dieser Weg nicht.'},
};
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const serviceConnectable=service=>Object.hasOwn(SERVICES,service);

async function call(path,{method='GET',body}={}){
  const response=await fetch(path,{method,credentials:'same-origin',...(body?{headers:{'Content-Type':'application/json','X-Context-Request':'service-token'},body:JSON.stringify(body)}:{})});
  let value={};try{value=await response.json();}catch{}
  if(!response.ok)throw new Error(typeof value.message==='string'?value.message:'Die Verbindung konnte nicht gespeichert werden.');
  return value;
}
export const loadServiceStatus=()=>call('/api/services/status');
export const saveServiceToken=(service,token)=>call('/api/services/configure',{method:'POST',body:{service,token}});
export const connectServiceViaBrowser=service=>call('/api/services/configure',{method:'POST',body:{service,token:'browser-session'}});
export const forgetServiceToken=service=>call('/api/services/forget',{method:'POST',body:{service}});

/** Form and status for one service. info comes from the status endpoint; message is a result line. */
export function serviceConnectHTML(service,status,{message='',error=false,busy=false}={}){
  const spec=SERVICES[service];if(!spec)return '';
  if(status&&status.available===false)return '<p class="subtle-note">Zugangsdaten lassen sich in der Context-Desktop-App eintragen.</p>';
  const info=status?.services?.[service]||{configured:false};
  const state=info.configured?info.origin==='environment'?'Verbunden über eine Umgebungsvariable des lokalen Servers.':info.origin==='browser'?'Verbunden über deine Anmeldung im Context-Browser. Läuft sie ab, melde dich dort neu an.':info.storage==='encrypted'?'Verbunden. Der Token liegt verschlüsselt im Schlüsselbund dieses Macs.':'Verbunden, aber nur bis zum Beenden der App: Der Schlüsselbund ist nicht verfügbar.':'Noch nicht verbunden.';
  return `<div class="service-connect-box"><p class="service-connect-state" role="status"><strong>${esc(state)}</strong></p>${info.origin==='environment'?'':`<p class="subtle-note">${esc(spec.steps)}</p><form id="service-token-form" data-service="${esc(service)}" autocomplete="off"><label><span>${esc(spec.field)}${info.configured?' ersetzen':''}</span><input type="password" name="token" autocomplete="off" spellcheck="false" maxlength="512" required ${busy?'disabled':''}></label><div class="service-connect-actions"><button class="button primary" type="submit" ${busy?'disabled':''}>${busy?'Wird geprüft …':'Prüfen und speichern'}</button>${info.configured&&info.origin!=='environment'?`<button class="button secondary" type="button" data-action="service-forget" data-id="${esc(service)}" ${busy?'disabled':''}>Verbindung entfernen</button>`:''}</div></form><div class="service-connect-session"><p class="subtle-note">Kein Token möglich? Context kann stattdessen deine Anmeldung im Context-Browser nutzen (nur lesend, die Cookies bleiben in der App). Öffne dort zuerst ${esc(spec.name)} und melde dich an.</p><button class="button secondary" type="button" data-action="service-session" data-id="${esc(service)}" ${busy?'disabled':''}>Über meine Browser-Anmeldung verbinden</button></div>`}${message?`<p class="${error?'error-message':'subtle-note'}" role="${error?'alert':'status'}">${esc(message)}</p>`:''}</div>`;
}

/** Read-only GitLab operation for the assistant (projects, tree, file, commits). */
export async function readGitlab(op,args,signal){
  const response=await fetch('/api/services/gitlab',{method:'POST',credentials:'same-origin',signal,headers:{'Content-Type':'application/json','X-Context-Request':'service-read'},body:JSON.stringify({op,...args})});
  let value={};try{value=await response.json();}catch{}
  if(!response.ok){const error=new Error(typeof value.message==='string'?value.message:'GitLab konnte nicht gelesen werden.');error.code=value.error;throw error;}
  return value;
}

/** Read-only Mattermost operation for the assistant (teams, search, channel). */
export async function readMattermost(op,args,signal){
  const response=await fetch('/api/services/mattermost',{method:'POST',credentials:'same-origin',signal,headers:{'Content-Type':'application/json','X-Context-Request':'service-read'},body:JSON.stringify({op,...args})});
  let value={};try{value=await response.json();}catch{}
  if(!response.ok){const error=new Error(typeof value.message==='string'?value.message:'Mattermost konnte nicht gelesen werden.');error.code=value.error;throw error;}
  return value;
}
