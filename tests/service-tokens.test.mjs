import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createServiceTokens,ServiceTokenError,serviceIds} from '../connectors/service-tokens.mjs';
import {createDesktopKeyStore} from '../desktop/key-store.mjs';

const realFetch=globalThis.fetch;
const GOOD='glpat-abcDEF123456_xyz',MM='abcdefghijklmnopqrstuvwxyz';
const json=(status,value)=>({ok:status<300,status,headers:new Map([['content-type','application/json']]),body:new Response(JSON.stringify(value)).body});
const withHeaders=response=>({...response,headers:{get:name=>String(name).toLowerCase()==='content-type'?'application/json':null}});
function provider({gitlab=200,mattermost=200}={}){
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url:String(url),headers:options.headers});
    if(String(url).startsWith('https://git.coco.study'))return withHeaders(gitlab===0?(()=>{throw new TypeError('offline');})():json(gitlab,gitlab<300?[]:{}));
    return withHeaders(mattermost===0?(()=>{throw new TypeError('offline');})():json(mattermost,mattermost<300?{id:'abcdefghijklmnopqrstuvwxyz'}:{}));
  };
  return {fetcher,calls};
}
function memoryStore({canPersist=true,initial=''}={}){let value=initial;const log=[];return {log,load:async()=>value,save:async key=>{log.push('save');if(!canPersist)return false;value=key;return true;},clear:async()=>{log.push('clear');value='';},get value(){return value;}};}

test('a token is checked against the provider with the read the connector will make, then stored',async()=>{
  const gitlab=memoryStore(),mattermost=memoryStore(),api=provider(),tokens=createServiceTokens({stores:{gitlab,mattermost},env:{},fetcher:api.fetcher});
  assert.deepEqual(serviceIds(),['gitlab','mattermost']);
  assert.deepEqual((await tokens.status()).gitlab,{configured:false,origin:'',storage:''});
  assert.deepEqual(await tokens.configure('gitlab',' '+GOOD+'\n'),{configured:true,origin:'app',storage:'encrypted'});
  assert.equal(api.calls[0].url,'https://git.coco.study/api/v4/todos?state=pending&per_page=1');assert.equal(api.calls[0].headers['PRIVATE-TOKEN'],GOOD);
  assert.equal(gitlab.value,GOOD);
  await tokens.configure('mattermost',MM);assert.equal(api.calls[1].url,'https://chat.coco.study/api/v4/users/me');assert.equal(api.calls[1].headers.Authorization,'Bearer '+MM);
  assert.deepEqual(await tokens.overrides(),{GITLAB_TOKEN:GOOD,MATTERMOST_TOKEN:MM});
  assert.doesNotMatch(JSON.stringify(await tokens.status()),new RegExp(GOOD+'|'+MM),'the status never contains a token');
});

test('rejected, malformed and unreachable tokens are never stored',async()=>{
  const gitlab=memoryStore();
  for(const [options,token,code] of [[{gitlab:401},GOOD,'token_rejected'],[{gitlab:403},GOOD,'token_rejected'],[{gitlab:0},GOOD,'provider_unreachable'],[{gitlab:500},GOOD,'provider_unreachable'],[{},'kurz','invalid_token'],[{},'mit Leerzeichen im Token','invalid_token'],[{},'x'.repeat(513),'invalid_token'],[{},'',"invalid_token"],[{},undefined,'invalid_token'],[{},{token:GOOD},'invalid_token']]){
    const api=provider(options),tokens=createServiceTokens({stores:{gitlab},env:{},fetcher:api.fetcher});
    await assert.rejects(tokens.configure('gitlab',token),error=>error instanceof ServiceTokenError&&error.code===code,code+' '+JSON.stringify(options));
    assert.equal(gitlab.value,'');assert.equal((await tokens.status()).gitlab.configured,false);
  }
  await assert.rejects(createServiceTokens({stores:{},env:{},fetcher:provider().fetcher}).configure('mail',GOOD),{code:'invalid_service'});
  await assert.rejects(createServiceTokens({stores:{},env:{}}).forget('__proto__'),{code:'invalid_service'});
});

test('without a usable keychain the token lives in memory and the status says so',async()=>{
  const tokens=createServiceTokens({stores:{gitlab:memoryStore({canPersist:false})},env:{},fetcher:provider().fetcher});
  assert.deepEqual(await tokens.configure('gitlab',GOOD),{configured:true,origin:'app',storage:'session'});
  assert.equal((await tokens.status()).gitlab.storage,'session');assert.equal((await tokens.overrides()).GITLAB_TOKEN,GOOD);
  const none=createServiceTokens({env:{},fetcher:provider().fetcher});await none.configure('mattermost',MM);assert.equal((await none.status()).mattermost.storage,'session');
});

test('stored tokens come back after a restart; a token saved in the app beats the environment; forgetting falls back to it',async()=>{
  const store=memoryStore({initial:GOOD}),tokens=createServiceTokens({stores:{gitlab:store},env:{GITLAB_TOKEN:'envtoken1234'},fetcher:provider().fetcher});
  assert.deepEqual((await tokens.status()).gitlab,{configured:true,origin:'app',storage:'encrypted'});assert.equal((await tokens.overrides()).GITLAB_TOKEN,GOOD);
  assert.deepEqual(await tokens.forget('gitlab'),{configured:true,origin:'environment',storage:''});assert.equal(store.value,'');assert.deepEqual(await tokens.overrides(),{});
  const env=createServiceTokens({stores:{},env:{MATTERMOST_TOKEN:MM}});assert.deepEqual((await env.status()).mattermost,{configured:true,origin:'environment',storage:''});
  const broken=createServiceTokens({stores:{gitlab:{load:async()=>{throw new Error('keychain');},save:async()=>false,clear:async()=>{throw new Error('keychain');}}},env:{}});
  assert.equal((await broken.status()).gitlab.configured,false);await assert.rejects(broken.forget('gitlab'),{code:'forget_failed'});
});

test('the encrypted key store holds the connector tokens next to the AI keys and knows no other names',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'service-keys-'));
  const crypto={isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async text=>Buffer.from('ENC:'+Buffer.from(text).toString('base64')),decryptStringAsync:async buffer=>({result:Buffer.from(String(buffer).slice(4),'base64').toString(),shouldReEncrypt:false})};
  try{
    const keys=createDesktopKeyStore({directory,crypto});
    assert.equal(await keys.forProvider('gitlab').save(GOOD),true);assert.equal(await keys.forProvider('mattermost').save(MM),true);assert.equal(await keys.forProvider('kiconnect').save('sk-ki'),true);await keys.flush();
    const again=createDesktopKeyStore({directory,crypto});assert.equal(await again.forProvider('gitlab').load(),GOOD);assert.equal(await again.forProvider('mattermost').load(),MM);assert.equal(await again.forProvider('kiconnect').load(),'sk-ki');
    await again.forProvider('gitlab').clear();await again.flush();assert.equal(await createDesktopKeyStore({directory,crypto}).forProvider('gitlab').load(),'');
    assert.throws(()=>keys.forProvider('mail'),TypeError);
  }finally{await rm(directory,{recursive:true,force:true});}
});

// The local server: the token endpoints and their effect on the feed.
const snapshotDir=await mkdtemp(path.join(tmpdir(),'service-snapshot-'));
process.env.CONTEXT_SNAPSHOT_PATH=path.join(snapshotDir,'notifications.json');
for(const key of ['GITLAB_TOKEN','MATTERMOST_TOKEN','TH_MAIL_USER','TH_MAIL_PASSWORD'])process.env[key]='';
const {createRequestHandler}=await import('../server.mjs');

async function serve(services){
  const server=http.createServer(createRequestHandler(()=>server.address().port,undefined,undefined,undefined,undefined,{services}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port,first=await realFetch(origin+'/');await first.text();const cookie=first.headers.get('set-cookie').split(';')[0];
  const post=(pathname,body,headers={})=>realFetch(origin+pathname,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-Context-Request':'service-token',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
  const get=(pathname,headers={})=>realFetch(origin+pathname,{headers:{Cookie:cookie,...headers}});
  return {server,origin,post,get,close:()=>{server.closeAllConnections?.();return new Promise(resolve=>server.close(resolve));}};
}

test('token endpoints need the session, the origin and the request header, accept only service and token and never echo a token',async()=>{
  const api=provider(),tokens=createServiceTokens({stores:{gitlab:memoryStore()},env:{},fetcher:api.fetcher}),app=await serve(tokens);
  try{
    assert.equal((await realFetch(app.origin+'/api/services/status')).status,403);
    assert.deepEqual(await (await app.get('/api/services/status')).json(),{available:true,services:{gitlab:{configured:false,origin:'',storage:''},mattermost:{configured:false,origin:'',storage:''}}});
    assert.equal((await app.post('/api/services/configure',{service:'gitlab',token:GOOD},{'X-Context-Request':'other'})).status,403);
    assert.equal((await app.post('/api/services/configure',{service:'gitlab',token:GOOD},{Origin:'https://evil.example'})).status,403);
    assert.equal((await app.post('/api/services/configure','service=gitlab',{'Content-Type':'text/plain'})).status,415);
    assert.equal((await realFetch(app.origin+'/api/services/configure',{headers:{Cookie:'x'}})).status,403);
    assert.equal((await app.get('/api/services/configure')).status,405);
    for(const body of [{service:'gitlab'},{service:'gitlab',token:GOOD,extra:1},{service:'nope',token:GOOD},[],'x',{token:GOOD}]){
      const response=await app.post('/api/services/configure',body);assert.equal(response.status,400,JSON.stringify(body));
    }
    assert.equal((await app.post('/api/services/forget',{service:'gitlab',token:GOOD})).status,400);
    const ok=await app.post('/api/services/configure',{service:'gitlab',token:GOOD}),body=await ok.text();
    assert.equal(ok.status,200);assert.deepEqual(JSON.parse(body),{service:'gitlab',configured:true,origin:'app',storage:'encrypted'});assert.ok(!body.includes(GOOD));
    const rejected=await (await app.post('/api/services/configure',{service:'gitlab',token:GOOD})).status;assert.equal(rejected,200);
    const failing=createServiceTokens({stores:{},env:{},fetcher:provider({gitlab:401}).fetcher}),other=await serve(failing);
    try{const response=await other.post('/api/services/configure',{service:'gitlab',token:GOOD}),value=await response.json();assert.equal(response.status,400);assert.equal(value.error,'token_rejected');assert.ok(!JSON.stringify(value).includes(GOOD));}finally{await other.close();}
    assert.deepEqual(await (await app.post('/api/services/forget',{service:'gitlab'})).json(),{service:'gitlab',configured:false,origin:'',storage:''});
  }finally{await app.close();}
});

test('without the desktop app the server reports the missing store instead of accepting a token',async()=>{
  const app=await serve(null);
  try{
    assert.deepEqual(await (await app.get('/api/services/status')).json(),{available:false,services:{}});
    const response=await app.post('/api/services/configure',{service:'gitlab',token:GOOD});assert.equal(response.status,503);assert.equal((await response.json()).error,'not_available');
  }finally{await app.close();}
});

test('a saved token is used by the next feed collection and a forgotten one is not',async()=>{
  const seen=[];
  globalThis.fetch=async(url,options)=>{
    const target=String(url);
    if(target.startsWith('https://git.coco.study')){seen.push(options?.headers?.['PRIVATE-TOKEN']||'');return withHeaders(json(200,target.includes('/user')?{id:7}:[]));}
    return realFetch(url,options);
  };
  const tokens=createServiceTokens({stores:{gitlab:memoryStore()},env:{},fetcher:(url,options)=>globalThis.fetch(url,options)}),app=await serve(tokens);
  try{
    let feed=await (await app.get('/api/notifications')).json();
    assert.equal(feed.sources.find(row=>row.source==='gitlab').status,'not_configured');assert.equal(seen.length,0);
    assert.equal((await app.post('/api/services/configure',{service:'gitlab',token:GOOD})).status,200);
    feed=await (await app.get('/api/notifications')).json();
    assert.equal(feed.sources.find(row=>row.source==='gitlab').status,'connected');assert.ok(seen.length>0&&seen.every(token=>token===GOOD));
    assert.equal((await app.post('/api/services/forget',{service:'gitlab'})).status,200);seen.length=0;
    feed=await (await app.get('/api/notifications')).json();
    assert.equal(feed.sources.find(row=>row.source==='gitlab').status,'not_configured');assert.equal(seen.length,0);
  }finally{globalThis.fetch=realFetch;await app.close();await rm(snapshotDir,{recursive:true,force:true});}
});

test('without a token the app reads through the browser login: checked, stored as a marker, cookies and auth headers never mix',async()=>{
  const calls=[],sessionFetch={mattermost:async(url,options)=>{calls.push({url:String(url),headers:options.headers});return options.loggedOut?withHeaders(json(401,{})):calls.loggedOut?withHeaders(json(401,{})):withHeaders(json(200,{id:'abcdefghijklmnopqrstuvwxyz'}));}};
  const store=memoryStore(),api=provider(),tokens=createServiceTokens({stores:{mattermost:store},env:{},fetcher:api.fetcher,sessionFetch});
  assert.deepEqual(await tokens.configure('mattermost','browser-session'),{configured:true,origin:'browser',storage:'encrypted'});
  assert.equal(calls[0].url,'https://chat.coco.study/api/v4/users/me');assert.equal(store.value,'browser-session');
  assert.equal((await tokens.status()).mattermost.origin,'browser');assert.deepEqual(await tokens.overrides(),{MATTERMOST_TOKEN:'browser-session'});
  // The connector's token header is dropped; the session answers. Other hosts and services keep their normal path.
  await tokens.fetcher('https://chat.coco.study/api/v4/users/me',{headers:{Authorization:'Bearer browser-session',Accept:'application/json'}});
  assert.deepEqual(calls.at(-1).headers,{Accept:'application/json'});
  await tokens.fetcher('https://git.coco.study/api/v4/user',{headers:{'PRIVATE-TOKEN':GOOD}});assert.equal(api.calls.at(-1).headers['PRIVATE-TOKEN'],GOOD);assert.equal(calls.length,2);
  // After a restart the marker is restored.
  const again=createServiceTokens({stores:{mattermost:store},env:{},fetcher:api.fetcher,sessionFetch});assert.equal((await again.status()).mattermost.origin,'browser');
  // Logged out or no desktop app: refused, nothing stored.
  const out=createServiceTokens({stores:{mattermost:memoryStore()},env:{},sessionFetch:{mattermost:async()=>withHeaders(json(401,{}))}});
  await assert.rejects(out.configure('mattermost','browser-session'),{code:'not_logged_in'});assert.equal((await out.status()).mattermost.configured,false);
  await assert.rejects(createServiceTokens({stores:{},env:{}}).configure('mattermost','browser-session'),{code:'not_available'});
  // A real token replaces the session mode and goes through the normal check.
  await tokens.configure('mattermost',MM);assert.equal((await tokens.status()).mattermost.origin,'app');
});
