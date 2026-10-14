import {randomUUID} from 'node:crypto';
import * as files from 'node:fs/promises';
import path from 'node:path';
import {MIRO_SERVICE,miroProxyRoute,miroProxyParams} from './nango-miro-policy.mjs';

// Metadata-only /connections, tagged connect sessions and the HTTP proxy:
// https://nango.dev/docs/reference/backend/http-api/connections/list
// https://nango.dev/docs/reference/backend/http-api/connect/sessions/create
// https://nango.dev/docs/reference/backend/http-api/proxy/get
// Provider names verified against NangoHQ/nango packages/providers/providers.yaml.
const SERVICES={
 outlook:{label:'Outlook',providers:['outlook','microsoft'],origin:'https://graph.microsoft.com',defaults:{mailRead:true,mailSend:false,mailModify:false,calendarRead:true,calendarWrite:false}},
 gmail:{label:'Gmail',providers:['google-mail'],origin:'https://www.googleapis.com',defaults:{mailRead:true,mailSend:false,mailModify:false}},
 'google-calendar':{label:'Google Calendar',providers:['google-calendar'],origin:'https://www.googleapis.com',defaults:{calendarRead:true}},
 'google-drive':{label:'Google Drive',providers:['google-drive'],origin:'https://www.googleapis.com',defaults:{driveRead:true}},
 miro:MIRO_SERVICE,
};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LIMIT=18*1024*1024,STORE_LIMIT=65536;
const MESSAGES={
 invalid_request:'Ungültige Nango-Anfrage.',invalid_service:'Unbekannter Nango-Dienst.',invalid_configuration:'Bitte Nango-Adresse, Schlüssel und Integrationen prüfen.',
 not_configured:'Nango ist noch nicht eingerichtet.',not_connected:'Verbinde zuerst das Konto für diesen Dienst.',permission_denied:'Diese Aktion ist nicht ausdrücklich für die Verbindung freigegeben.',
 auth_failed:'Nango hat die Anmeldung abgelehnt. Prüfe den Schlüssel oder verbinde das Konto erneut.',integration_mismatch:'Die Integration gehört nicht zum ausgewählten Dienst.',
 connection_mismatch:'Die Verbindung ist nicht eindeutig diesem Gerät und Dienst zugeordnet.',busy:'Eine Nango-Verwaltung für diesen Dienst läuft bereits.',
 cancelled:'Die Nango-Anfrage wurde abgebrochen.',timeout:'Die Nango-Anfrage ist abgelaufen.',connection_failed:'Nango ist gerade nicht erreichbar.',
 provider_error:'Der Anbieter konnte die Anfrage nicht beantworten.',provider_limit:'Der Anbieter begrenzt die Zugriffe. Bitte später erneut versuchen.',
 conflict:'Der Anbieterinhalt wurde inzwischen verändert.',response_limit:'Die Anbieterantwort ist zu groß.',invalid_response:'Nango hat keine gültige Antwort geliefert.',
 storage_failed:'Die Nango-Einstellungen konnten nicht sicher gespeichert oder gelesen werden.',closed:'Der Nango-Dienst wird geschlossen.',
};
export class NangoError extends Error{
 constructor(code,status=400){super(MESSAGES[code]||MESSAGES.connection_failed);this.name='NangoError';this.code=MESSAGES[code]?code:'connection_failed';this.status=status;}
}
const fail=(code,status)=>new NangoError(code,status);
const object=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fail('invalid_request');return value;};
const serviceID=value=>{if(!Object.hasOwn(SERVICES,value))throw fail('invalid_service');return value;};
const opaque=(value,max=512)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x20\x7f]/.test(value);
function baseOrigin(value){
 if(typeof value!=='string'||value.length>2048||!/^https?:\/\/[^/?#]+\/?$/.test(value)||/[\x00-\x20\x7f\\]/.test(value))throw fail('invalid_configuration');
 let url;try{url=new URL(value);}catch{throw fail('invalid_configuration');}
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='https:'&&!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9][0-9]{0,4})?\/?$/.test(value))throw fail('invalid_configuration');
 return url.origin;
}
function configuration(body,previous){
 object(body,['baseURL','secretKey','integrations','capabilities']);
 const baseURL=baseOrigin(body.baseURL);
 const secretKey=body.secretKey===undefined||body.secretKey===''?baseURL===previous?.baseURL?previous.secretKey:'':body.secretKey;
 if(!opaque(secretKey,16384)||/[^\x21-\x7e]/.test(secretKey))throw fail('invalid_configuration');
 object(body.integrations,Object.keys(SERVICES));
 if(body.capabilities!==undefined)object(body.capabilities,Object.keys(SERVICES));
 const integrations={},capabilities={};
 for(const service of Object.keys(SERVICES)){
  const id=body.integrations[service]??'';
  if(typeof id!=='string'||id&&(!opaque(id,200)||!/^[-\w.]+$/.test(id)))throw fail('invalid_configuration');
  integrations[service]=id;
  const supplied=body.capabilities?.[service]||{};object(supplied,Object.keys(SERVICES[service].defaults));
  if(Object.values(supplied).some(value=>typeof value!=='boolean'))throw fail('invalid_configuration');
  capabilities[service]={...SERVICES[service].defaults,...supplied};
 }
 if(!Object.values(integrations).some(Boolean)||new Set(Object.values(integrations).filter(Boolean)).size!==Object.values(integrations).filter(Boolean).length)throw fail('invalid_configuration');
 return {baseURL,secretKey,integrations,capabilities};
}
function proxyRoute(service,method,value){
 if(typeof value!=='string'||value.length>4096||!value.startsWith('/')||value.startsWith('//')||/[\x00-\x20\x7f\\?#]/.test(value))throw fail('invalid_request');
 const parts=value.slice(1).split('/');
 for(const [index,raw] of parts.entries()){
  let decoded;try{decoded=decodeURIComponent(raw);}catch{throw fail('invalid_request');}
  // Google holiday calendar IDs contain '#'. Only the encoded character in
  // this typed calendar-ID segment is allowed; raw fragments stay forbidden.
  const googleCalendarId=service==='google-calendar'&&method==='GET'&&index===3&&parts[0]==='calendar'&&parts[1]==='v3'&&parts[2]==='calendars';
  if(!decoded||/[\x00-\x20\x7f\\%?]/.test(decoded)||!googleCalendarId&&decoded.includes('#')||decoded.includes('://')||decoded.split('/').some(part=>part==='.'||part==='..'))throw fail('invalid_request');
 }
 const item='[^/]+';
 if(service==='miro'){const capability=miroProxyRoute(method,value);if(capability)return capability;throw fail('permission_denied',403);}
 if(service==='outlook'){
  if(method==='GET'&&value==='/v1.0/me')return 'profileRead';
  if(method==='GET'&&new RegExp('^/v1\\.0/me/(?:messages(?:/'+item+'(?:/attachments(?:/'+item+')?|/\\$value)?)?|mailFolders(?:/'+item+'(?:/childFolders|/messages(?:/'+item+'(?:/attachments(?:/'+item+')?)?)?)?)?)$').test(value))return 'mailRead';
  if(method==='GET'&&new RegExp('^/v1\\.0/me/(?:calendars(?:/'+item+'(?:/calendarView|/events(?:/'+item+')?)?)?|calendarView)$').test(value))return 'calendarRead';
  if(method==='POST'&&value==='/v1.0/me/sendMail')return 'mailSend';
  if(method==='PATCH'&&new RegExp('^/v1\\.0/me/(?:messages/'+item+'|mailFolders/'+item+'/messages/'+item+')$').test(value))return 'mailModify';
  if((method==='POST'&&new RegExp('^/v1\\.0/me/calendars/'+item+'/events$').test(value))||(method==='PATCH'&&new RegExp('^/v1\\.0/me/calendars/'+item+'/events/'+item+'$').test(value)))return 'calendarWrite';
 }
 if(service==='gmail'){
  if(method==='GET'&&new RegExp('^/gmail/v1/users/me/(?:profile|labels(?:/'+item+')?|messages(?:/'+item+'(?:/attachments/'+item+')?)?)$').test(value))return 'mailRead';
  if(method==='POST'&&value==='/gmail/v1/users/me/messages/send')return 'mailSend';
  if(method==='POST'&&new RegExp('^/gmail/v1/users/me/messages/'+item+'/modify$').test(value))return 'mailModify';
 }
 if(service==='google-calendar'&&method==='GET'&&new RegExp('^/calendar/v3/(?:users/me/calendarList(?:/'+item+')?|calendars/'+item+'(?:/events(?:/'+item+')?)?)$').test(value))return 'calendarRead';
 if(service==='google-drive'&&method==='GET'&&new RegExp('^/drive/v3/files(?:/'+item+'(?:/export)?)?$').test(value))return 'driveRead';
 throw fail('permission_denied',403);
}
function proxyRequest(service,input){
 object(input,['method','path','params','body','headers','identity']);
 if(!['GET','POST','PATCH'].includes(input.method))throw fail('invalid_request');
 const capability=proxyRoute(service,input.method,input.path),query=new URLSearchParams(),headers={};
 if(service==='miro'&&(input.params!==undefined&&(!input.params||typeof input.params!=='object'||Array.isArray(input.params))||!miroProxyParams(input.path,input.params)))throw fail('invalid_request');
 if(input.params!==undefined){
  object(input.params,Object.keys(input.params));if(Object.keys(input.params).length>50)throw fail('invalid_request');
  for(const [key,raw] of Object.entries(input.params)){
   if(!/^[\w$.[\]-]{1,100}$/.test(key)||/authorization|access_token|secret_key|base.?url|provider.?config|connection.?id/i.test(key))throw fail('invalid_request');
   const values=Array.isArray(raw)?raw:[raw];if(!values.length||values.length>50)throw fail('invalid_request');
   for(const value of values){if(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value)||String(value).length>20000||/[\x00-\x1f\x7f]/.test(String(value)))throw fail('invalid_request');query.append(key,String(value));}
  }
 }
 if(input.headers!==undefined){
  object(input.headers,Object.keys(input.headers));
  for(const [raw,value] of Object.entries(input.headers)){
   const key=raw.toLowerCase();if(!['accept','prefer','if-match','content-type'].includes(key)||typeof value!=='string'||value.length>2048||/[\x00-\x1f\x7f]/.test(value)||headers[key]!==undefined)throw fail('invalid_request');headers[key]=value;
  }
 }
 const contentType=headers['content-type']?.split(';')[0].trim().toLowerCase();
 if(contentType&&!['application/json','text/plain'].includes(contentType))throw fail('invalid_request');
 if(input.method==='GET'&&input.body!==undefined)throw fail('invalid_request');
 let body;
 if(input.body!==undefined){
  if(typeof input.body==='string'){
   if(service!=='outlook'||input.path!=='/v1.0/me/sendMail'||contentType!=='text/plain')throw fail('invalid_request');body=input.body;
  }else{if(!input.body||typeof input.body!=='object'||Array.isArray(input.body)||contentType==='text/plain')throw fail('invalid_request');try{body=JSON.stringify(input.body);}catch{throw fail('invalid_request');}headers['content-type']='application/json';}
  if(Buffer.byteLength(body)>LIMIT)throw fail('invalid_request');
 }else if(input.method!=='GET')throw fail('invalid_request');
 if(query.toString().length>65536)throw fail('invalid_request');
 if(input.identity!==undefined){
  object(input.identity,['integrationId','connectionId','generation','revision','capabilities']);
  if(!opaque(input.identity.integrationId,200)||!opaque(input.identity.connectionId)||input.identity.generation!==undefined&&!Number.isSafeInteger(input.identity.generation))throw fail('invalid_request');
  if(input.identity.revision!==undefined&&(typeof input.identity.revision!=='string'||!/^(?:0|[1-9]\d{0,15}):(?:0|[1-9]\d{0,15})$/.test(input.identity.revision)))throw fail('invalid_request');
  if(input.identity.capabilities!==undefined){object(input.identity.capabilities,['mailRead','mailSend','mailModify','calendarRead','calendarWrite','driveRead','boardRead']);if(Object.values(input.identity.capabilities).some(value=>typeof value!=='boolean'))throw fail('invalid_request');}
 }
 return {capability,query,headers,body,identity:input.identity};
}

export function createDesktopNango({directory,crypto,openExternal,fetchImpl=fetch,now=Date.now,pollInterval=2000,connectTimeout=300000}={}){
 if(typeof directory!=='string'||!directory||typeof fetchImpl!=='function')throw fail('invalid_configuration');
 const target=path.join(directory,'nango.enc');
 let config=null,ownerId=randomUUID(),storage='none',secureStorage=false,storeError,initialization,generation=0,closing=false,closed=false,queue=Promise.resolve(),configuring=false,configurePending=0,catalog=null;
 const records=new Map(Object.keys(SERVICES).map(service=>[service,{connectionId:'',verified:false,error:null,epoch:0}]));
 const controllers=new Map(),tasks=new Set(),attempts=new Map(),timers=new Set();
 const assertOpen=()=>{if(closing||closed)throw fail('closed',409);};
 const enqueue=fn=>{const pending=queue.then(fn);queue=pending.catch(()=>{});return pending;};
 function operation(fn){assertOpen();const pending=(async()=>{await initialize();return fn();})();tasks.add(pending);pending.finally(()=>tasks.delete(pending)).catch(()=>{});return pending;}
 function abortService(service){for(const [controller,scope] of controllers)if(!service||scope===service)controller.abort();}
 function invalidate(service){if(service){const record=records.get(service);record.epoch++;record.verified=false;abortService(service);}else{generation++;catalog=null;for(const service of records.keys())records.get(service).epoch++;abortService();}}
 const snapshot=service=>{
  if(service){serviceID(service);const r=records.get(service);return {service,label:SERVICES[service].label,integrationId:config?.integrations[service]||'',connectionId:r.connectionId,revision:generation+':'+r.epoch,connected:!!config&&r.verified&&!!r.connectionId,connecting:attempts.has(service),capabilities:{...(config?.capabilities[service]||SERVICES[service].defaults)},...(r.error?{error:{code:r.error.code,message:r.error.message}}:{})};}
  return {configured:!!config,baseURL:config?.baseURL||'https://api.nango.dev',storage:config?storage:'none',secureStorage,services:Object.keys(SERVICES).map(snapshot),...(storeError?{error:{code:storeError.code,message:storeError.message}}:{})};
 };
 async function available(){
  try{if(typeof crypto?.getSelectedStorageBackend==='function'&&await crypto.getSelectedStorageBackend()==='basic_text')return false;return typeof crypto?.isAsyncEncryptionAvailable==='function'?!!await crypto.isAsyncEncryptionAvailable():typeof crypto?.isEncryptionAvailable==='function'&&!!crypto.isEncryptionAvailable();}catch{return false;}
 }
 async function encrypt(value){return typeof crypto.encryptStringAsync==='function'?crypto.encryptStringAsync(value):crypto.encryptString(value);}
 async function decrypt(buffer){const value=typeof crypto.decryptStringAsync==='function'?await crypto.decryptStringAsync(buffer):crypto.decryptString(buffer);return typeof value==='string'?value:value?.result;}
 function storeValue(candidate=config,connections=Object.fromEntries([...records].map(([service,record])=>[service,record.connectionId]))){return {version:1,ownerId,...candidate,connections};}
 async function persist(candidate,connections){
  if(!candidate)return;
  if(!await available()){await files.unlink(target).catch(error=>{if(error.code!=='ENOENT')throw fail('storage_failed',500);});secureStorage=false;storage='session';return;}
  const temporary=path.join(directory,'nango.'+randomUUID()+'.tmp');
  try{
   const buffer=await encrypt(JSON.stringify(storeValue(candidate,connections)));if(!Buffer.isBuffer(buffer)||buffer.length>STORE_LIMIT)throw Error();
   await files.mkdir(directory,{recursive:true,mode:0o700});await files.writeFile(temporary,buffer,{flag:'wx',mode:0o600});await files.rename(temporary,target);secureStorage=true;storage='encrypted';
  }catch{throw fail('storage_failed',500);}finally{await files.unlink(temporary).catch(()=>{});}
 }
 function initialize(){
  if(closing||closed)return Promise.reject(fail('closed',409));
  if(initialization)return initialization;
  initialization=(async()=>{
   secureStorage=await available();
   try{
    const stat=await files.lstat(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>STORE_LIMIT||!secureStorage)throw Error();
    const value=JSON.parse(await decrypt(await files.readFile(target)));object(value,['version','ownerId','baseURL','secretKey','integrations','capabilities','connections']);
    if(value.version!==1||!UUID.test(value.ownerId))throw Error();
    const restored=configuration({baseURL:value.baseURL,secretKey:value.secretKey,integrations:value.integrations,capabilities:value.capabilities});object(value.connections,Object.keys(SERVICES));
    for(const [service,id] of Object.entries(value.connections)){if(id!==''&&!opaque(id))throw Error();records.get(service).connectionId=id;}
    ownerId=value.ownerId;config=restored;storage='encrypted';
   }catch(error){if(error.code!=='ENOENT')storeError=fail('storage_failed',500);}
   return snapshot();
  })();return initialization;
 }
 function context(service,candidate=config){if(!candidate)throw fail('not_configured',409);return {config:candidate,generation,service,epoch:service?records.get(service).epoch:0,connectionId:service?records.get(service).connectionId:''};}
 function assertContext(ctx){if(closing||closed)throw fail('closed',409);if(ctx.generation!==generation||ctx.service&&(ctx.epoch!==records.get(ctx.service).epoch||ctx.connectionId!==records.get(ctx.service).connectionId))throw fail('cancelled',499);}
 function addController(service,signal){const controller=new AbortController();controllers.set(controller,service||'');return {controller,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000),...(signal?[signal]:[])])};}
 async function abortable(promise,signal){
  if(signal.aborted)throw fail(signal.reason?.name==='TimeoutError'?'timeout':'cancelled',signal.reason?.name==='TimeoutError'?408:499);
  let abort;const cancelled=new Promise((_,reject)=>{abort=()=>reject(fail(signal.reason?.name==='TimeoutError'?'timeout':'cancelled',signal.reason?.name==='TimeoutError'?408:499));signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([promise,cancelled]);}finally{signal.removeEventListener('abort',abort);}
 }
 async function bytes(response,signal,limit){
  const declared=Number(response.headers.get('content-length')||0);if(!Number.isFinite(declared)||declared>limit)throw fail('response_limit',502);
  if(!response.body)return Buffer.alloc(0);
  const reader=response.body.getReader(),chunks=[];let length=0;
  try{while(true){const result=await abortable(reader.read(),signal);if(result.done)break;length+=result.value.byteLength;if(length>limit)throw fail('response_limit',502);chunks.push(Buffer.from(result.value));}return Buffer.concat(chunks);}
  catch(error){void reader.cancel().catch(()=>{});throw error;}
 }
 function httpError(status){return status===401?fail('auth_failed',401):status===403?fail('permission_denied',403):status===412?fail('conflict',409):status===429?fail('provider_limit',429):fail('provider_error',status>=400&&status<500?status:502);}
 async function http(ctx,pathname,{method='GET',query,headers={},body,signal,limit=2*1024*1024,json=true}={}){
  assertContext(ctx);const active=addController(ctx.service,signal);
  try{
   const url=new URL(pathname,ctx.config.baseURL);if(query)url.search=query.toString();
   const response=await abortable(fetchImpl(url.href,{method,headers:{Authorization:'Bearer '+ctx.config.secretKey,...headers},...(body!==undefined?{body}:{}),redirect:'manual',signal:active.signal}),active.signal);
   assertContext(ctx);if(response.status>=300&&response.status<400){void response.body?.cancel().catch(()=>{});throw fail('provider_error',502);}
   if(!response.ok){void response.body?.cancel().catch(()=>{});throw httpError(response.status);}
   const raw=await bytes(response,active.signal,limit);assertContext(ctx);
   const responseHeaders={};for(const name of ['content-type','etag','retry-after','request-id']){const value=response.headers.get(name);if(value&&value.length<=2048&&!/[\x00-\x1f\x7f]/.test(value))responseHeaders[name]=value;}
   let data=null;
   if(raw.length)try{
    const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);
    if(json){if(!responseHeaders['content-type']?.toLowerCase().includes('json'))throw fail('invalid_response',502);data=JSON.parse(text);}
    else if(responseHeaders['content-type']?.toLowerCase().includes('json'))data=JSON.parse(text);else data=text;
   }catch{throw fail('invalid_response',502);}
   return {status:response.status,headers:responseHeaders,data};
  }catch(error){if(error instanceof NangoError)throw error;if(active.signal.aborted)throw fail(active.signal.reason?.name==='TimeoutError'?'timeout':'cancelled',499);throw fail('connection_failed',502);}
  finally{controllers.delete(active.controller);}
 }
 async function integrations(ctx,force=false,signal){
  if(!force&&catalog&&catalog.generation===ctx.generation&&catalog.config===ctx.config&&now()-catalog.at<60000)return catalog.providers;
  const {data}=await http(ctx,'/integrations',{signal});if(!Array.isArray(data?.data)||data.data.length>500)throw fail('invalid_response',502);
  const providers={};
  for(const service of Object.keys(SERVICES)){
   const id=ctx.config.integrations[service];if(!id)continue;const matches=data.data.filter(row=>row?.unique_key===id);
   if(matches.length!==1||!SERVICES[service].providers.includes(matches[0].provider))throw fail('integration_mismatch',409);providers[service]=matches[0].provider;
  }
  assertContext(ctx);if(config===ctx.config)catalog={generation:ctx.generation,config:ctx.config,at:now(),providers};return providers;
 }
 async function matchingConnections(ctx,{connectionId,attempt,signal}={}){
  const providers=await integrations(ctx,false,signal),service=ctx.service,id=ctx.config.integrations[service];if(!id||!providers[service])throw fail('integration_mismatch',409);
  // Nango uses offset = page * limit; the first page is zero.
  const query=new URLSearchParams({limit:'100',page:'0'});
  if(connectionId)query.set('connectionId',connectionId);
  if(attempt){query.set('tags[end_user_id]',ownerId);query.set('tags[context_connection_attempt]',attempt);}
  const {data}=await http(ctx,'/connections',{query,signal});if(!Array.isArray(data?.connections)||data.connections.length>=100)throw fail('connection_mismatch',409);
  const found=data.connections.filter(row=>row?.provider_config_key===id&&row.provider===providers[service]&&(!row.tags||typeof row.tags==='object'&&!Array.isArray(row.tags))&&(attempt?row.tags?.end_user_id===ownerId&&row.tags.context_connection_attempt===attempt:row.tags?.end_user_id===undefined||row.tags.end_user_id===ownerId)&&(!connectionId||row.connection_id===connectionId));
  if(found.length>1)throw fail('connection_mismatch',409);
  if(!found.length)return null;
  const result=found[0];if(!opaque(result.connection_id)||!Array.isArray(result.errors)||result.errors.some(error=>error?.type==='auth'))throw fail('auth_failed',401);
  return result.connection_id;
 }
 async function verify(service,signal){
  if(configuring)throw fail('busy',429);
  const ctx=context(service),record=records.get(service);if(!record.connectionId)throw fail('not_connected',409);
  try{const id=await matchingConnections(ctx,{connectionId:record.connectionId,signal});assertContext(ctx);if(id!==record.connectionId)throw fail('connection_mismatch',409);if(signal?.aborted)throw fail('cancelled',499);record.verified=true;record.error=null;return ctx;}
  catch(error){if(ctx.generation===generation&&ctx.epoch===record.epoch){record.verified=false;record.error=error instanceof NangoError?error:fail('connection_failed',502);}throw error;}
 }
 async function status(service){
  if(service!==undefined)serviceID(service);
  return operation(async()=>{
   const selected=service?[service]:Object.keys(SERVICES);
   await Promise.all(selected.map(async current=>{if(config&&records.get(current).connectionId)try{await verify(current);}catch{}}));return snapshot(service);
  });
 }
 async function configure(body){
  const candidate=configuration(body,config);invalidate();const ctx=context(undefined,candidate);
  await integrations(ctx,true);assertContext(ctx);
   const preserve=config&&config.baseURL===candidate.baseURL&&config.secretKey===candidate.secretKey;
   const connections=Object.fromEntries([...records].map(([service,record])=>[service,preserve&&config.integrations[service]===candidate.integrations[service]?record.connectionId:'']));
   await persist(candidate,connections);assertContext(ctx);config=candidate;storeError=null;catalog=null;
   for(const [service,id] of Object.entries(connections)){const record=records.get(service);record.connectionId=id;record.verified=false;record.error=null;}
   return snapshot();
 }
 async function bind(service,connectionId){
  if(!opaque(connectionId))throw fail('invalid_request');invalidate(service);const ctx=context(service);
  const id=await matchingConnections(ctx,{connectionId});assertContext(ctx);if(id!==connectionId)throw fail('connection_mismatch',409);
  const connections=Object.fromEntries([...records].map(([name,record])=>[name,name===service?id:record.connectionId]));
  await persist(config,connections);assertContext(ctx);const record=records.get(service);record.connectionId=id;record.verified=true;record.error=null;return snapshot(service);
 }
 function pause(ms,signal){
  return new Promise((resolve,reject)=>{
   const finish=error=>{clearTimeout(timer);timers.delete(timer);signal.removeEventListener('abort',abort);error?reject(error):resolve();};
   const abort=()=>finish(fail('cancelled',499)),timer=setTimeout(()=>finish(),ms);timers.add(timer);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
 }
 async function connect(service,id){
  if(configuring||attempts.has(service))throw fail('busy',429);if(typeof openExternal!=='function')throw fail('invalid_configuration');
  invalidate(service);const ctx=context(service),controller=new AbortController(),attempt=randomUUID(),deadline=Math.max(10,Math.min(300000,connectTimeout));
  const timer=setTimeout(()=>controller.abort(fail('timeout',408)),deadline);timers.add(timer);controllers.set(controller,service);attempts.set(service,{id,controller});
  try{
   await integrations(ctx,false,controller.signal);const integrationId=ctx.config.integrations[service];if(!integrationId)throw fail('integration_mismatch',409);
   const response=await http(ctx,'/connect/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tags:{end_user_id:ownerId,context_connection_attempt:attempt},allowed_integrations:[integrationId]}),signal:controller.signal});
   const data=response.data?.data;if(!opaque(data?.token,32768)||typeof data.connect_link!=='string'||data.connect_link.length>32768||typeof data.expires_at!=='string'||!Number.isFinite(Date.parse(data.expires_at))||Date.parse(data.expires_at)<=now())throw fail('invalid_response',502);
   let link;try{link=new URL(data.connect_link);}catch{throw fail('invalid_response',502);}
   if(link.username||link.password||link.hash||link.origin!=='https://connect.nango.dev'&&!(ctx.config.baseURL!=='https://api.nango.dev'&&link.origin===ctx.config.baseURL))throw fail('invalid_response',502);
   assertContext(ctx);if(controller.signal.aborted)throw fail('cancelled',499);await openExternal(link.href);assertContext(ctx);
   while(!controller.signal.aborted&&now()<Date.parse(data.expires_at)){
    const connectionId=await matchingConnections(ctx,{attempt,signal:controller.signal});assertContext(ctx);
    if(connectionId)return await enqueue(async()=>{
     assertContext(ctx);const connections=Object.fromEntries([...records].map(([name,record])=>[name,name===service?connectionId:record.connectionId]));await persist(config,connections);assertContext(ctx);
     const record=records.get(service);record.connectionId=connectionId;record.verified=true;record.error=null;return snapshot(service);
    });
    await pause(Math.max(5,Math.min(30000,pollInterval)),controller.signal);
   }
   throw fail('timeout',408);
  }catch(error){if(controller.signal.aborted&&controller.signal.reason instanceof NangoError)throw controller.signal.reason;throw error instanceof NangoError?error:fail('connection_failed',502);}
  finally{clearTimeout(timer);timers.delete(timer);controllers.delete(controller);if(attempts.get(service)?.controller===controller)attempts.delete(service);}
 }
 async function disconnect(service){
  serviceID(service);assertOpen();invalidate(service);
  return operation(()=>enqueue(async()=>{
   const connections=Object.fromEntries([...records].map(([name,record])=>[name,name===service?'':record.connectionId]));if(config)await persist(config,connections);
   const record=records.get(service);record.connectionId='';record.verified=false;record.error=null;return snapshot(service);
  }));
 }
 async function proxy(service,input,signal){
  serviceID(service);const request=proxyRequest(service,input);
  return operation(async()=>{
   if(signal?.aborted)throw fail('cancelled',499);const ctx=await verify(service,signal);assertContext(ctx);
   if(request.identity&&(request.identity.integrationId!==ctx.config.integrations[service]||request.identity.connectionId!==ctx.connectionId||request.identity.generation!==undefined&&request.identity.generation!==ctx.generation||request.identity.revision!==undefined&&request.identity.revision!==ctx.generation+':'+ctx.epoch||Object.entries(request.identity.capabilities||{}).some(([key,value])=>(ctx.config.capabilities[service][key]===true)!==value)))throw fail('connection_mismatch',409);
   const capabilities=ctx.config.capabilities[service];if(request.capability==='profileRead'?!capabilities.mailRead&&!capabilities.calendarRead:capabilities[request.capability]!==true)throw fail('permission_denied',403);
   const headers={'Provider-Config-Key':ctx.config.integrations[service],'Connection-Id':ctx.connectionId,'Base-Url-Override':SERVICES[service].origin,Retries:'0'};
   for(const [key,value] of Object.entries(request.headers)){if(key==='content-type')headers['Content-Type']=value;else headers['nango-proxy-'+key]=value;}
   const result=await http(ctx,'/proxy'+input.path,{method:input.method,query:request.query,headers,body:request.body,signal,limit:LIMIT,json:false});assertContext(ctx);return result;
  });
 }
 function handle(message){
  object(message,['action','service','body','id']);
  const {action,service,body,id}=message;if(!['status','configure','connect','connection','disconnect','reset','cancel'].includes(action))throw fail('invalid_request');
  if(['connect','connection','disconnect'].includes(action))serviceID(service);
  if(action==='cancel'){
   assertOpen();if(!UUID.test(id)||body!==undefined||service!==undefined)throw fail('invalid_request');for(const attempt of attempts.values())if(attempt.id===id)attempt.controller.abort();return Promise.resolve(snapshot());
  }
  if(action==='status'){if(body!==undefined||id!==undefined)throw fail('invalid_request');return status(service);}
  if(action==='disconnect'){if(body!==undefined||id!==undefined)throw fail('invalid_request');return disconnect(service);}
  if(action==='configure'){
   if(service!==undefined||id!==undefined)throw fail('invalid_request');assertOpen();configurePending++;configuring=true;invalidate();
   return operation(()=>enqueue(()=>configure(body))).finally(()=>{configurePending--;configuring=configurePending>0;});
  }
  if(action==='connection'){object(body,['connectionId']);if(id!==undefined)throw fail('invalid_request');return operation(()=>enqueue(()=>bind(service,body.connectionId)));}
  if(action==='connect'){if(body!==undefined||!UUID.test(id))throw fail('invalid_request');return operation(()=>connect(service,id));}
  if(body!==undefined||id!==undefined||service!==undefined)throw fail('invalid_request');assertOpen();invalidate();
  return operation(()=>enqueue(async()=>{await files.unlink(target).catch(error=>{if(error.code!=='ENOENT')throw fail('storage_failed',500);});config=null;ownerId=randomUUID();storage='none';storeError=null;for(const record of records.values()){record.connectionId='';record.verified=false;record.error=null;}return snapshot();}));
 }
 async function dispose(){
  if(closed)return;if(closing){await Promise.allSettled([...tasks]);await queue;return;}closing=true;abortService();
  await initialization?.catch(()=>{});await Promise.allSettled([...tasks]);await queue;for(const timer of timers)clearTimeout(timer);timers.clear();attempts.clear();controllers.clear();config=null;catalog=null;closed=true;
 }
 return {initialize,handle,status,proxy,disconnect,dispose,localStatus:service=>snapshot(service),hasBinding:service=>{serviceID(service);return !!config&&!!config.integrations[service]&&!!records.get(service).connectionId;}};
}
