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
export const forgetServiceToken=service=>call('/api/services/forget',{method:'POST',body:{service}});

/** Form and status for one service. info comes from the status endpoint; message is a result line. */
export function serviceConnectHTML(service,status,{message='',error=false,busy=false}={}){
  const spec=SERVICES[service];if(!spec)return '';
  if(status&&status.available===false)return '<p class="subtle-note">Zugangsdaten lassen sich in der Context-Desktop-App eintragen.</p>';
  const info=status?.services?.[service]||{configured:false};
  const state=info.configured?info.origin==='environment'?'Verbunden über eine Umgebungsvariable des lokalen Servers.':info.storage==='encrypted'?'Verbunden. Der Token liegt verschlüsselt im Schlüsselbund dieses Macs.':'Verbunden, aber nur bis zum Beenden der App: Der Schlüsselbund ist nicht verfügbar.':'Noch nicht verbunden.';
  return `<div class="service-connect-box"><p class="service-connect-state" role="status"><strong>${esc(state)}</strong></p>${info.origin==='environment'?'':`<p class="subtle-note">${esc(spec.steps)}</p><form id="service-token-form" data-service="${esc(service)}" autocomplete="off"><label><span>${esc(spec.field)}${info.configured?' ersetzen':''}</span><input type="password" name="token" autocomplete="off" spellcheck="false" maxlength="512" required ${busy?'disabled':''}></label><div class="service-connect-actions"><button class="button primary" type="submit" ${busy?'disabled':''}>${busy?'Wird geprüft …':'Prüfen und speichern'}</button>${info.configured&&info.origin==='app'?`<button class="button secondary" type="button" data-action="service-forget" data-id="${esc(service)}" ${busy?'disabled':''}>Token entfernen</button>`:''}</div></form>`}${message?`<p class="${error?'error-message':'subtle-note'}" role="${error?'alert':'status'}">${esc(message)}</p>`:''}</div>`;
}
