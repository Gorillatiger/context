import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {createDesktopNango,NangoError} from '../desktop/nango.mjs';

const key='synthetic-environment-secret-key',otherKey='synthetic-other-environment-key';
const integrations={outlook:'integration-outlook',gmail:'integration-gmail','google-calendar':'integration-calendar','google-drive':'integration-drive'};
const integrationRows=[{unique_key:integrations.outlook,provider:'outlook'},{unique_key:integrations.gmail,provider:'google-mail'},{unique_key:integrations['google-calendar'],provider:'google-calendar'},{unique_key:integrations['google-drive'],provider:'google-drive'}];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const json=(value,status=200,headers={})=>Response.json(value,{status,headers});
function encryption({available=true,backend='keychain'}={}){
 const secret=randomBytes(32);let writes=0;
 return {get writes(){return writes;},getSelectedStorageBackend:()=>backend,isAsyncEncryptionAvailable:async()=>available,
  encryptStringAsync:async text=>{writes++;const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,nonce),body=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),body]);},
  decryptStringAsync:async buffer=>{const cipher=createDecipheriv('aes-256-gcm',secret,buffer.subarray(0,12));cipher.setAuthTag(buffer.subarray(12,28));return {result:Buffer.concat([cipher.update(buffer.subarray(28)),cipher.final()]).toString('utf8')};}
 };
}
async function fixture(t,{crypto=encryption(),autoconnect=true,handler,connectTimeout=1000,pollInterval=5}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'context-nango-qa-')),calls=[],opened=[],connections=[],sessions=[],cores=[];
 const data={integrationRows:structuredClone(integrationRows),connections,sessions,autoconnect,handler,connectURL:'https://connect.nango.dev/?session_token=synthetic-session-token'};
 const fetchImpl=async(url,options)=>{
  const call={url:new URL(url),...options};calls.push(call);assert.equal(options.redirect,'manual');assert.equal(options.signal.aborted,false);
  const intercepted=await data.handler?.(call,data);if(intercepted!==undefined)return intercepted;
  if(call.url.pathname==='/integrations')return json({data:data.integrationRows});
  if(call.url.pathname==='/connect/sessions'){
   assert.equal(options.method,'POST');const body=JSON.parse(options.body);sessions.push(body);const integrationId=body.allowed_integrations[0],provider=data.integrationRows.find(row=>row.unique_key===integrationId).provider;
   if(data.autoconnect)connections.push({connection_id:'connection-'+sessions.length,provider,provider_config_key:integrationId,tags:body.tags,errors:[]});
   return json({data:{token:'synthetic-session-token',connect_link:data.connectURL,expires_at:new Date(Date.now()+600000).toISOString()}},201);
  }
  if(call.url.pathname==='/connections'){
   const limit=Number(call.url.searchParams.get('limit')||1000),page=Number(call.url.searchParams.get('page')||0);
   return json({connections:connections.slice(page*limit,(page+1)*limit)});
  }
  if(call.url.pathname.startsWith('/proxy')){
   if(call.url.pathname==='/proxy/v1.0/me/sendMail')return new Response(null,{status:202});
   return json({value:[]},200,{'ETag':'"fixture-etag"','Set-Cookie':'private-fixture-provider-cookie'});
  }
  throw Error('Unexpected fake route');
 };
 const create=()=>{const core=createDesktopNango({directory,crypto,openExternal:async url=>opened.push(url),fetchImpl,pollInterval,connectTimeout});cores.push(core);return core;};
 const core=create();t.after(async()=>{await Promise.all(cores.map(core=>core.dispose()));await rm(directory,{recursive:true,force:true});});
 const configure=body=>core.handle({action:'configure',body:{baseURL:'https://api.nango.dev',secretKey:key,integrations,...body}});
 const connect=service=>core.handle({action:'connect',service,id:randomUUID()});
 return {core,create,configure,connect,directory,crypto,calls,opened,data,connections,sessions};
}

test('unconfigured status is local, safe and does not contact Nango',async t=>{
 const f=await fixture(t);await f.core.initialize();const status=await f.core.status();assert.equal(status.configured,false);assert.equal(status.storage,'none');assert.equal(status.secureStorage,true);assert.equal(status.services.length,5);assert.equal(f.calls.length,0);
 assert.equal(f.core.hasBinding('outlook'),false);assert.equal(f.core.localStatus('outlook').capabilities.mailSend,false);
});
test('configuration verifies each explicit provider integration and stores only ciphertext atomically',async t=>{
 const f=await fixture(t);const status=await f.configure();assert.equal(status.configured,true);assert.equal(status.storage,'encrypted');
 const disk=await readFile(path.join(f.directory,'nango.enc'));assert.ok(!disk.includes(Buffer.from(key)));assert.ok(!disk.includes(Buffer.from('integration-outlook')));assert.equal((await stat(path.join(f.directory,'nango.enc'))).mode&0o777,0o600);assert.deepEqual(await readdir(f.directory),['nango.enc']);
 assert.ok(!JSON.stringify(status).includes(key));assert.equal(f.calls[0].url.pathname,'/integrations');assert.equal(f.calls.length,1);assert.equal(status.services.find(s=>s.service==='outlook').capabilities.calendarWrite,false);
});
test('Linux basic_text and unavailable encryption are session-only without plaintext files',async t=>{
 for(const crypto of [encryption({backend:'basic_text'}),encryption({available:false})]){
  const f=await fixture(t,{crypto});const result=await f.configure();assert.equal(result.storage,'session');assert.equal(result.secureStorage,false);assert.equal(crypto.writes,0);assert.deepEqual(await readdir(f.directory),[]);
 }
});
test('base URLs require origin-only HTTPS or exact loopback HTTP; credentials cannot leak on origin changes',async t=>{
 const f=await fixture(t);for(const baseURL of ['http://example.org','http://127.1:3000','http://2130706433:3000','http://localhost.evil.org:3000','https://user:pass@example.org','https://example.org/path','https://example.org?key=x','https://example.org#fragment'])await assert.rejects(f.configure({baseURL}),NangoError);
 assert.equal(f.calls.length,0);await f.configure();await f.configure({secretKey:''});assert.equal(f.calls.at(-1).headers.Authorization,'Bearer '+key);
 await assert.rejects(f.configure({baseURL:'https://selfhost.example.org',secretKey:''}),{code:'invalid_configuration'});
 await f.configure({baseURL:'http://127.0.0.1:3003',secretKey:otherKey});assert.equal(f.calls.at(-1).url.origin,'http://127.0.0.1:3003');assert.equal(f.calls.at(-1).headers.Authorization,'Bearer '+otherKey);
});
test('integration aliases are verified; Gmail uses the official google-mail provider',async t=>{
 const f=await fixture(t);f.data.integrationRows[0].provider='microsoft';await f.configure();f.data.integrationRows[1].provider='gmail-guess';await assert.rejects(f.configure(),{code:'integration_mismatch'});
 f.data.integrationRows[1].provider='google-mail';f.data.integrationRows[2].provider='google';await assert.rejects(f.configure(),{code:'integration_mismatch'});
});
test('auth and provider error bodies never reach renderer status or errors',async t=>{
 const f=await fixture(t,{handler:()=>json({error:{message:'private-fixture-token-provider-body'}},401)});
 await assert.rejects(f.configure(),error=>error.code==='auth_failed'&&!error.message.includes('private-fixture'));assert.equal(f.core.localStatus().configured,false);
});
test('connect opens only the verified Connect URL and binds the exact owner/attempt/integration match',async t=>{
 const f=await fixture(t);await f.configure();f.connections.push({connection_id:'foreign',provider:'outlook',provider_config_key:integrations.outlook,tags:{end_user_id:'foreign-owner'},errors:[]});
 const result=await f.connect('outlook');assert.equal(result.connected,true);assert.equal(result.connectionId,'connection-1');assert.equal(f.opened.length,1);assert.ok(!JSON.stringify(result).includes('session-token'));
 const session=f.sessions[0];assert.deepEqual(session.allowed_integrations,[integrations.outlook]);assert.match(session.tags.end_user_id,/^[0-9a-f-]{36}$/);assert.match(session.tags.context_connection_attempt,/^[0-9a-f-]{36}$/);
 const lookup=f.calls.find(call=>call.url.pathname==='/connections');assert.equal(lookup.url.searchParams.get('tags[end_user_id]'),session.tags.end_user_id);assert.equal(lookup.url.searchParams.get('tags[context_connection_attempt]'),session.tags.context_connection_attempt);assert.ok(!f.calls.some(call=>/^\/connections\//.test(call.url.pathname)));
});
test('zero-based Nango pagination confirms OAuth, manual import and subsequent status',async t=>{
 const f=await fixture(t);await f.configure();
 const connected=await f.connect('outlook');assert.equal(connected.connected,true);
 const id=connected.connectionId;await f.core.disconnect('outlook');
 assert.equal((await f.core.handle({action:'connection',service:'outlook',body:{connectionId:id}})).connected,true);
 assert.equal((await f.core.status('outlook')).connected,true);
 const lookups=f.calls.filter(call=>call.url.pathname==='/connections');assert.ok(lookups.length>=3);
 assert.ok(lookups.every(call=>call.url.searchParams.get('page')==='0'));
 assert.ok(!f.calls.some(call=>/^\/connections\//.test(call.url.pathname)));
});
test('foreign connect links and redirects are rejected before opening or forwarding credentials',async t=>{
 const f=await fixture(t);await f.configure();f.data.connectURL='https://evil.example.org/connect';await assert.rejects(f.connect('outlook'),{code:'invalid_response'});assert.equal(f.opened.length,0);
 const g=await fixture(t,{handler:()=>new Response(null,{status:302,headers:{Location:'https://evil.example.org'}})});await assert.rejects(g.configure(),{code:'provider_error'});assert.equal(g.calls.length,1);
});
test('same-origin self-hosted connect links are supported without accepting lookalike origins',async t=>{
 const f=await fixture(t);await f.configure({baseURL:'http://localhost:3003'});f.data.connectURL='http://localhost:3003/connect?token=synthetic';assert.equal((await f.connect('outlook')).connected,true);
 await f.core.disconnect('outlook');f.data.connectURL='http://localhost:3004/connect?token=synthetic';await assert.rejects(f.connect('outlook'),{code:'invalid_response'});
});
test('connect refuses ambiguous matching connections and auth-error metadata',async t=>{
 const f=await fixture(t,{handler:(call,data)=>{if(call.url.pathname==='/connections'){const row=data.connections.at(-1);return json({connections:[row,{...row,connection_id:'duplicate'}]});}}});await f.configure();await assert.rejects(f.connect('outlook'),{code:'connection_mismatch'});
 const g=await fixture(t,{handler:(call,data)=>{if(call.url.pathname==='/connections')return json({connections:data.connections.map(row=>({...row,errors:[{type:'auth',log_id:'private-log'}]}))});}});await g.configure();await assert.rejects(g.connect('outlook'),{code:'auth_failed'});
});
test('unrelated old attempts are never selected and a bounded connect eventually times out',async t=>{
 const f=await fixture(t,{autoconnect:false,connectTimeout:25});await f.configure();f.connections.push({connection_id:'old',provider:'outlook',provider_config_key:integrations.outlook,tags:{end_user_id:'foreign',context_connection_attempt:randomUUID()},errors:[]});
 await assert.rejects(f.connect('outlook'),{code:'timeout'});assert.equal(f.core.hasBinding('outlook'),false);assert.equal(f.core.localStatus('outlook').connecting,false);
});
test('explicit cancellation interrupts pending connect polling and retains configuration',async t=>{
 const started=deferred();const f=await fixture(t,{autoconnect:false,handler:call=>{if(call.url.pathname==='/connections')started.resolve();}});await f.configure();const id=randomUUID(),pending=f.core.handle({action:'connect',service:'outlook',id});await started.promise;
 await f.core.handle({action:'cancel',id});await assert.rejects(pending,{code:'cancelled'});assert.equal(f.core.localStatus().configured,true);assert.equal(f.core.hasBinding('outlook'),false);
});
test('manual binding requires an explicit verified connection ID, integration and owner tag',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');const own=f.connections[0];await f.core.disconnect('outlook');
 f.connections.push({...own,connection_id:'foreign-id',tags:{end_user_id:'another-owner'}});await assert.rejects(f.core.handle({action:'connection',service:'outlook',body:{connectionId:'foreign-id'}}),{code:'connection_mismatch'});
 const result=await f.core.handle({action:'connection',service:'outlook',body:{connectionId:own.connection_id}});assert.equal(result.connected,true);const lookup=f.calls.at(-1);assert.equal(lookup.url.searchParams.get('connectionId'),own.connection_id);
});
test('live status verifies only existing bindings and reflects remote auth errors safely',async t=>{
 const f=await fixture(t);await f.configure();const before=f.calls.length;await f.core.status();assert.equal(f.calls.length,before);
 await f.connect('outlook');f.connections[0].errors=[{type:'auth',log_id:'private-provider-log'}];const status=await f.core.status();const outlook=status.services.find(s=>s.service==='outlook');assert.equal(outlook.connected,false);assert.equal(outlook.error.code,'auth_failed');assert.ok(!JSON.stringify(status).includes('private-provider-log'));
});
test('encrypted restart preserves owner and selected ID but verifies metadata before access',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');await f.core.dispose();const restored=f.create();await restored.initialize();assert.equal(restored.hasBinding('outlook'),true);assert.equal(restored.localStatus('outlook').connected,false);
 const result=await restored.status('outlook');assert.equal(result.connected,true);assert.equal(result.connectionId,'connection-1');assert.equal(f.calls.at(-1).url.searchParams.get('connectionId'),'connection-1');
});
test('corrupt and symlinked stores are rejected and do not expose contents',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.directory,'nango.enc'),'private-fixture-broken-secret');await f.core.initialize();assert.equal(f.core.localStatus().configured,false);assert.equal(f.core.localStatus().error.code,'storage_failed');assert.equal(await readFile(path.join(f.directory,'nango.enc'),'utf8'),'private-fixture-broken-secret');
 const g=await fixture(t);const other=path.join(g.directory,'other');await writeFile(other,'private-fixture-other');await symlink(other,path.join(g.directory,'nango.enc'));await g.core.initialize();assert.equal(g.core.localStatus().configured,false);
});
test('typed proxy pins fixed origin, exact binding, retries zero and documented custom headers',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');const binding=f.core.localStatus('outlook');
 const result=await f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars',params:{$top:'50'},headers:{Prefer:'outlook.timezone="UTC"',Accept:'application/json'},identity:{integrationId:binding.integrationId,connectionId:binding.connectionId,capabilities:{calendarRead:true,calendarWrite:false,driveRead:false}}});
 const call=f.calls.at(-1);assert.equal(call.url.pathname,'/proxy/v1.0/me/calendars');assert.equal(call.url.searchParams.get('$top'),'50');assert.equal(call.headers['Base-Url-Override'],'https://graph.microsoft.com');assert.equal(call.headers.Retries,'0');assert.equal(call.headers['nango-proxy-prefer'],'outlook.timezone="UTC"');assert.equal(call.headers['Connection-Id'],'connection-1');assert.equal(result.headers.etag,'"fixture-etag"');assert.ok(!result.headers['set-cookie']);assert.ok(!Object.keys(call.headers).some(key=>key.toLowerCase()==='nango-proxy-retries'));
});
test('renderer bridge never exposes raw proxy, arbitrary paths or credentials',async t=>{
 const f=await fixture(t);for(const message of [{action:'proxy',service:'outlook',body:{path:'/v1.0/me'}},{op:'status'},{action:'status',secretKey:key},{action:'connect',service:'gmail',id:'not-uuid'}])assert.throws(()=>f.core.handle(message),NangoError);
 assert.equal(f.calls.length,0);
});
test('proxy rejects traversal, foreign URLs, injected auth headers and unknown methods before any fetch',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');const before=f.calls.length;
 for(const change of [{path:'https://evil.example.org/'},{path:'//evil.example.org/'},{path:'/v1.0/me/../users'},{path:'/v1.0/me/%2e%2e/users'},{path:'/v1.0/me/messages/..%2fusers'},{path:'/v1.0/me/%252e%252e'},{path:'/v1.0/me?key=x'},{headers:{Authorization:'Bearer private'}},{headers:{'Base-Url-Override':'https://evil.example'}},{headers:{Prefer:'x\r\nAuthorization: x'}},{method:'DELETE'}])await assert.rejects(f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars',...change}),NangoError);
 assert.equal(f.calls.length,before);
});
test('writes require exact optional capabilities and identity snapshot matches',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');await assert.rejects(f.core.proxy('outlook',{method:'POST',path:'/v1.0/me/sendMail',body:{message:{}}}),{code:'permission_denied'});
 await assert.rejects(f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars',identity:{integrationId:integrations.outlook,connectionId:'wrong'}}),{code:'connection_mismatch'});
 await assert.rejects(f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars',identity:{integrationId:integrations.outlook,connectionId:'connection-1',capabilities:{calendarWrite:true}}}),{code:'connection_mismatch'});
 const before=f.calls.filter(call=>call.url.pathname.startsWith('/proxy')).length;assert.equal(before,0);
});
test('Outlook MIME and JSON writes use actual Content-Type and explicit mail permissions',async t=>{
 const f=await fixture(t);await f.configure({capabilities:{outlook:{mailSend:true,mailModify:true,calendarWrite:true}}});await f.connect('outlook');
 const mime=await f.core.proxy('outlook',{method:'POST',path:'/v1.0/me/sendMail',headers:{'Content-Type':'text/plain'},body:'RnJvbTogc3ludGhldGlj'});assert.equal(mime.status,202);assert.equal(f.calls.at(-1).headers['Content-Type'],'text/plain');assert.equal(f.calls.at(-1).body,'RnJvbTogc3ludGhldGlj');
 await f.core.proxy('outlook',{method:'PATCH',path:'/v1.0/me/messages/message-1',body:{isRead:true}});assert.equal(f.calls.at(-1).headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(f.calls.at(-1).body),{isRead:true});
 await f.core.proxy('outlook',{method:'PATCH',path:'/v1.0/me/calendars/calendar-1/events/event-1',headers:{'If-Match':'W/"own-etag"'},body:{subject:'Synthetic'}});assert.equal(f.calls.at(-1).headers['nango-proxy-if-match'],'W/"own-etag"');
});
test('Gmail, Google Calendar and Drive proxy routes stay in their typed service origins',async t=>{
 const f=await fixture(t);await f.configure();for(const service of ['gmail','google-calendar','google-drive'])await f.connect(service);
 for(const [service,path] of [['gmail','/gmail/v1/users/me/messages/message-1/attachments/attachment-1'],['google-calendar','/calendar/v3/calendars/primary/events'],['google-drive','/drive/v3/files/file-1/export']]){await f.core.proxy(service,{method:'GET',path});assert.equal(f.calls.at(-1).headers['Base-Url-Override'],'https://www.googleapis.com');}
 await assert.rejects(f.core.proxy('google-calendar',{method:'POST',path:'/calendar/v3/calendars/primary/events',body:{summary:'Synthetic'}}),{code:'permission_denied'});
});

test('Google holiday calendar IDs retain an encoded hash without creating a URL fragment',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('google-calendar');
 const id=encodeURIComponent('en.usa#holiday@group.v.calendar.google.com'),route='/calendar/v3/calendars/'+id+'/events';
 await f.core.proxy('google-calendar',{method:'GET',path:route,params:{maxResults:250}});
 const call=f.calls.at(-1);assert.equal(call.url.pathname,'/proxy'+route);assert.equal(call.url.hash,'');assert.equal(call.headers['Base-Url-Override'],'https://www.googleapis.com');
 const before=f.calls.length;
 for(const unsafe of ['/calendar/v3/calendars/a#b/events','/calendar/v3/calendars/a%3Faccess_token=secret/events','/calendar/v3/calendars/a%2523b/events','/calendar/v3/calendars/%2e%2e/events','/gmail/v1/users/me/messages/a%23b'])
  await assert.rejects(f.core.proxy(unsafe.startsWith('/gmail')?'gmail':'google-calendar',{method:'GET',path:unsafe}),{code:'invalid_request'});
 assert.equal(f.calls.length,before);
});
test('calendar pagination query keys pass the typed Nango proxy without accepting injected auth parameters',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('google-calendar');await f.connect('outlook');
 const params={timeMin:'2026-10-01T00:00:00Z',timeMax:'2026-11-01T00:00:00Z',maxResults:'250',pageToken:'opaque+/=cursor'};
 await f.core.proxy('google-calendar',{method:'GET',path:'/calendar/v3/calendars/primary/events',params});
 assert.equal(f.calls.at(-1).url.searchParams.get('pageToken'),params.pageToken);assert.equal(f.calls.at(-1).url.origin,'https://api.nango.dev');
 for(const key of ['$skip','$skiptoken','$skipToken']){
  const value=key==='$skip'?'250':'opaque+/=cursor';
  await f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars/own/calendarView',params:{startDateTime:params.timeMin,endDateTime:params.timeMax,$top:'250',[key]:value}});
  assert.equal(f.calls.at(-1).url.searchParams.get(key),value);assert.equal(f.calls.at(-1).headers['Base-Url-Override'],'https://graph.microsoft.com');
 }
 const before=f.calls.length;
 await assert.rejects(f.core.proxy('google-calendar',{method:'GET',path:'/calendar/v3/calendars/primary/events',params:{...params,access_token:'synthetic-secret'}}),{code:'invalid_request'});
 assert.equal(f.calls.length,before);
});
test('configuration/disconnect abort pending proxy work and discard late replies',async t=>{
 const started=deferred(),release=deferred();const f=await fixture(t,{handler:call=>{if(call.url.pathname.startsWith('/proxy')){started.resolve();return release.promise;}}});await f.configure();await f.connect('outlook');
 const pending=f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars'}),rejected=assert.rejects(pending,{code:'cancelled'});await started.promise;await f.core.disconnect('outlook');await rejected;release.resolve(json({value:[{id:'late'}]}));assert.equal(f.core.hasBinding('outlook'),false);
});
test('changing environment key clears old account bindings and invalidates prior identity',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');await f.configure({secretKey:otherKey});assert.equal(f.core.hasBinding('outlook'),false);assert.equal(f.core.localStatus('outlook').connectionId,'');
 await assert.rejects(f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars'}),{code:'not_connected'});
});
test('proxy response limits and conditional provider failures produce safe typed errors',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');f.data.handler=call=>call.url.pathname.startsWith('/proxy')?json({error:'private-fixture-error'},412):undefined;
 await assert.rejects(f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars'}),error=>error.code==='conflict'&&!error.message.includes('private-fixture'));
 f.data.handler=call=>call.url.pathname.startsWith('/proxy')?new Response('x',{headers:{'Content-Type':'text/plain','Content-Length':String(18*1024*1024+1)}}):undefined;
 await assert.rejects(f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars'}),{code:'response_limit'});
});
test('reset/disconnect only forget locally and never delete a remote Nango connection',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');const remote=f.connections.length;await f.core.disconnect('outlook');assert.equal(f.connections.length,remote);assert.equal(f.core.localStatus().configured,true);
 await f.core.handle({action:'reset'});assert.equal(f.core.localStatus().configured,false);assert.deepEqual(await readdir(f.directory),[]);assert.ok(!f.calls.some(call=>call.method==='DELETE'));
});
test('dispose cancels connect timers and blocks later operations without changing saved selection',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');const disk=await readFile(path.join(f.directory,'nango.enc'));
 f.data.autoconnect=false;const started=deferred();f.data.handler=call=>{if(call.url.pathname==='/connections')started.resolve();};const pending=f.connect('gmail');await started.promise;const stopped=assert.rejects(pending,error=>['closed','cancelled'].includes(error.code));await f.core.dispose();await stopped;
 assert.deepEqual(await readFile(path.join(f.directory,'nango.enc')),disk);await assert.rejects(f.core.status(),{code:'closed'});await assert.rejects(f.core.proxy('outlook',{method:'GET',path:'/v1.0/me'}),{code:'closed'});
});
test('manual untagged exact binding works but a present foreign owner is rejected',async t=>{
 const f=await fixture(t);await f.configure();f.connections.push({connection_id:'dashboard-choice',provider:'outlook',provider_config_key:integrations.outlook,tags:{},errors:[]});
 const bound=await f.core.handle({action:'connection',service:'outlook',body:{connectionId:'dashboard-choice'}});assert.equal(bound.connected,true);
 assert.equal(f.calls.at(-1).url.searchParams.get('connectionId'),'dashboard-choice');assert.equal(f.calls.at(-1).url.searchParams.has('tags[end_user_id]'),false);
 assert.equal((await f.core.status('outlook')).connected,true);f.connections[0].tags.end_user_id='different-owner';assert.equal((await f.core.status('outlook')).connected,false);
});
test('folder-scoped message attachments preserve encoded base64 slash IDs within opaque segments',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');
 const url='/v1.0/me/mailFolders/'+encodeURIComponent('folder/A+=')+'/messages/'+encodeURIComponent('message/B+=')+'/attachments/'+encodeURIComponent('attachment/C+=');
 await f.core.proxy('outlook',{method:'GET',path:url});assert.equal(f.calls.at(-1).url.pathname,'/proxy'+url);
 await f.core.proxy('outlook',{method:'GET',path:url.slice(0,url.lastIndexOf('/'))});
 await assert.rejects(f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/messages/'+encodeURIComponent('../users')}),{code:'invalid_request'});
});
test('definite provider 4xx HTTP status is preserved without forwarding its body',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');
 for(const status of [400,404,409,413,422]){
  f.data.handler=call=>call.url.pathname.startsWith('/proxy')?json({error:{message:'private-fixture-provider-body'}},status):undefined;
  await assert.rejects(f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/messages/missing'}),error=>error.status===status&&error.code==='provider_error'&&!error.message.includes('private-fixture'));
 }
});
test('configuration invalidation aborts old proxy before verification of a new origin/key completes',async t=>{
 const started=deferred(),release=deferred();const f=await fixture(t,{handler:call=>{if(call.url.pathname.startsWith('/proxy')){started.resolve();return release.promise;}}});await f.configure();await f.connect('outlook');
 const pending=f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars'}),rejected=assert.rejects(pending,{code:'cancelled'});await started.promise;
 await f.configure({secretKey:otherKey});await rejected;release.resolve(json({value:[]}));assert.equal(f.core.hasBinding('outlook'),false);
});
test('native opener errors cannot export the connect-session URL/token',async t=>{
 const f=await fixture(t);const core=createDesktopNango({directory:f.directory,crypto:f.crypto,openExternal:async url=>{throw Error('failed '+url);},fetchImpl:async(url,options)=>{
  if(new URL(url).pathname==='/integrations')return json({data:integrationRows});
  return json({data:{token:'private-fixture-connect-token',connect_link:'https://connect.nango.dev/?token=private-fixture-connect-token',expires_at:new Date(Date.now()+60000).toISOString()}},201);
 }});t.after(()=>core.dispose());await core.handle({action:'configure',body:{baseURL:'https://api.nango.dev',secretKey:key,integrations}});
 await assert.rejects(core.handle({action:'connect',service:'outlook',id:randomUUID()}),error=>error.code==='connection_failed'&&!error.message.includes('private-fixture-connect-token'));
});
test('initialize and dispose cannot restore a secret after shutdown has completed',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');await f.core.dispose();const gate=deferred();
 const crypto={...f.crypto,decryptStringAsync:async buffer=>{await gate.promise;return f.crypto.decryptStringAsync(buffer);}};
 const core=createDesktopNango({directory:f.directory,crypto,fetchImpl:async()=>{throw Error('must remain local');}});const initializing=core.initialize(),disposing=core.dispose();gate.resolve();await initializing;await disposing;
 assert.equal(core.localStatus().configured,false);assert.equal(core.hasBinding('outlook'),false);await assert.rejects(core.initialize(),{code:'closed'});
});
test('read-only status checks preserve the stable local binding revision',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');const initial=f.core.localStatus('outlook');
 assert.match(initial.revision,/^\d+:\d+$/);assert.equal((await f.core.status('outlook')).revision,initial.revision);assert.equal((await f.core.status()).services.find(service=>service.service==='outlook').revision,initial.revision);
 const identity={integrationId:initial.integrationId,connectionId:initial.connectionId,revision:initial.revision};await f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars',identity});assert.equal(f.core.localStatus('outlook').revision,initial.revision);
});
test('manual rebinding the same ID changes revision and rejects its old identity before proxy',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');const old=f.core.localStatus('outlook');await f.core.handle({action:'connection',service:'outlook',body:{connectionId:old.connectionId}});
 const current=f.core.localStatus('outlook');assert.equal(current.integrationId,old.integrationId);assert.equal(current.connectionId,old.connectionId);assert.notEqual(current.revision,old.revision);
 const before=f.calls.filter(call=>call.url.pathname.startsWith('/proxy')).length;
 await assert.rejects(f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars',identity:{integrationId:old.integrationId,connectionId:old.connectionId,revision:old.revision}}),{code:'connection_mismatch'});
 assert.equal(f.calls.filter(call=>call.url.pathname.startsWith('/proxy')).length,before);
 await f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars',identity:{integrationId:current.integrationId,connectionId:current.connectionId,revision:current.revision}});
});
test('key/origin reconfiguration prevents stale identity reuse despite unchanged restored IDs',async t=>{
 const f=await fixture(t);await f.configure();await f.connect('outlook');let previous=f.core.localStatus('outlook');
 for(const body of [{secretKey:otherKey},{baseURL:'https://selfhost.example.org',secretKey:otherKey}]){
  await f.configure(body);await f.core.handle({action:'connection',service:'outlook',body:{connectionId:previous.connectionId}});const current=f.core.localStatus('outlook');
  assert.equal(current.connectionId,previous.connectionId);assert.equal(current.integrationId,previous.integrationId);assert.notEqual(current.revision,previous.revision);
  const before=f.calls.filter(call=>call.url.pathname.startsWith('/proxy')).length;
  await assert.rejects(f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars',identity:{integrationId:previous.integrationId,connectionId:previous.connectionId,revision:previous.revision}}),{code:'connection_mismatch'});assert.equal(f.calls.filter(call=>call.url.pathname.startsWith('/proxy')).length,before);
  previous=current;
 }
});
test('malformed identity revisions fail before any network access',async t=>{
 const f=await fixture(t);for(const revision of [0,'0','0:1\n','01:0','x:0','1:2:3'])await assert.rejects(f.core.proxy('outlook',{method:'GET',path:'/v1.0/me/calendars',identity:{integrationId:integrations.outlook,connectionId:'connection-1',revision}}),{code:'invalid_request'});assert.equal(f.calls.length,0);
});
