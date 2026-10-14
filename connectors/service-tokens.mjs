import {readJSON,SERVICE_ORIGINS} from './notifications.mjs';

// Access tokens for the read-only GitLab and Mattermost connectors. Entered once in the
// app, checked against the provider, then kept only in the operating system's encrypted
// store (see desktop/key-store.mjs). They never leave the server process: not toward the
// page, backups, exports or logs. Without a store they live in memory until quit.
const SERVICES=Object.freeze({
  gitlab:{name:'GitLab',env:'GITLAB_TOKEN',path:'/api/v4/todos?state=pending&per_page=1',headers:token=>({'PRIVATE-TOKEN':token,Accept:'application/json'})},
  mattermost:{name:'Mattermost',env:'MATTERMOST_TOKEN',path:'/api/v4/users/me',headers:token=>({Authorization:'Bearer '+token,Accept:'application/json'})},
});
export class ServiceTokenError extends Error{constructor(status,code,message){super(message);this.name='ServiceTokenError';this.status=status;this.code=code;}}
const TOKEN=/^[A-Za-z0-9_.~+/=-]{8,512}$/;
/** Stored instead of a token when the app reads through the person's login in the Context browser. */
export const BROWSER_SESSION='browser-session';
export const serviceIds=()=>Object.keys(SERVICES);

export function createServiceTokens({stores={},env=process.env,fetcher=fetch,sessionFetch={}}={}){
  const memory=new Map(),storage=new Map();let restored=false;
  const known=service=>{if(!Object.hasOwn(SERVICES,service))throw new ServiceTokenError(400,'invalid_service','Unbekannter Dienst.');return SERVICES[service];};
  async function restore(){
    if(restored)return;restored=true;
    for(const service of Object.keys(SERVICES)){
      let token='';try{token=await stores[service]?.load()||'';}catch{}
      if(TOKEN.test(token)&&!memory.has(service)){memory.set(service,token);storage.set(service,'encrypted');}
    }
  }
  const fromEnvironment=service=>TOKEN.test(String(env[SERVICES[service].env]||'').trim());
  async function status(){
    await restore();
    return Object.fromEntries(Object.keys(SERVICES).map(service=>[service,memory.has(service)?{configured:true,origin:memory.get(service)===BROWSER_SESSION?'browser':'app',storage:storage.get(service)||'session'}:fromEnvironment(service)?{configured:true,origin:'environment',storage:''}:{configured:false,origin:'',storage:''}]));
  }
  /** Environment overrides for the connectors: tokens saved in the app win over process variables. */
  async function overrides(){await restore();return Object.fromEntries([...memory].map(([service,token])=>[SERVICES[service].env,token]));}
  async function configure(service,input){
    const spec=known(service);await restore();
    const token=typeof input==='string'?input.trim():'';
    if(token===BROWSER_SESSION)return viaBrowser(service,spec);
    if(!TOKEN.test(token))throw new ServiceTokenError(400,'invalid_token','Der Token sieht ungültig aus. Bitte genau den angezeigten Token ohne Leerzeichen einfügen.');
    // The same read the connector will make, so a token that cannot read is rejected now.
    try{await readJSON(SERVICE_ORIGINS[service]+spec.path,spec.headers(token),fetcher);}
    catch(error){
      if(error?.status===401||error?.status===403)throw new ServiceTokenError(400,'token_rejected',spec.name+' hat den Token abgelehnt. Prüfe, ob er gültig ist'+(service==='gitlab'?' und den Zugriff „read_api“ hat.':'.'));
      throw new ServiceTokenError(502,'provider_unreachable',spec.name+' ist gerade nicht erreichbar. Der Token wurde nicht gespeichert.');
    }
    let saved=false;try{saved=await stores[service]?.save(token)===true;}catch{}
    memory.set(service,token);storage.set(service,saved?'encrypted':'session');
    return {configured:true,origin:'app',storage:storage.get(service)};
  }
  // No token: the app's own browser session (cookies stay inside Electron) makes the same read-only GETs.
  async function viaBrowser(service,spec){
    if(typeof sessionFetch[service]!=='function')throw new ServiceTokenError(503,'not_available','Das Lesen über die Browser-Anmeldung braucht die Context-Desktop-App.');
    try{await readJSON(SERVICE_ORIGINS[service]+spec.path,{Accept:'application/json'},sessionFetch[service]);}
    catch(error){
      if(error?.status===401||error?.status===403)throw new ServiceTokenError(400,'not_logged_in','Du bist im Context-Browser nicht bei '+spec.name+' angemeldet. Öffne die Seite dort, melde dich an und versuche es erneut.');
      throw new ServiceTokenError(502,'provider_unreachable',spec.name+' ist gerade nicht erreichbar.');
    }
    let saved=false;try{saved=await stores[service]?.save(BROWSER_SESSION)===true;}catch{}
    memory.set(service,BROWSER_SESSION);storage.set(service,saved?'encrypted':'session');
    return {configured:true,origin:'browser',storage:storage.get(service)};
  }
  /** Fetch for the connectors: requests of a service in browser mode go through the browser session. */
  const connectorFetch=(url,options={})=>{
    const target=String(url),service=Object.keys(SERVICES).find(id=>target.startsWith(SERVICE_ORIGINS[id]+'/'));
    if(service&&memory.get(service)===BROWSER_SESSION&&typeof sessionFetch[service]==='function'){const {headers={},...rest}=options,{Authorization,'PRIVATE-TOKEN':_t,...plain}=headers;return sessionFetch[service](url,{...rest,headers:plain});}
    return fetcher(url,options);
  };
  async function forget(service){
    known(service);await restore();
    try{await stores[service]?.clear();}catch{throw new ServiceTokenError(500,'forget_failed','Der gespeicherte Token konnte nicht entfernt werden. Bitte erneut versuchen.');}
    memory.delete(service);storage.delete(service);
    return {configured:fromEnvironment(service),origin:fromEnvironment(service)?'environment':'',storage:''};
  }
  return {status,overrides,configure,forget,fetcher:connectorFetch};
}
