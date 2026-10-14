import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,stat,symlink,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDesktopKeyStore} from '../desktop/key-store.mjs';
import {createDesktopAI} from '../desktop/ai.mjs';
import {createKIClient} from '../connectors/ki.mjs';
import {createRequestHandler} from '../server.mjs';
import {aiRequest} from '../dist/ai-client.js';

const KEY='sk-or-synthetic-PRIVATE-1234567890',OTHER='kc-synthetic-PRIVATE-0987654321';
function fakeCrypto({available=true,shouldReEncrypt=false}={}){
  const key=Buffer.alloc(32,31),plaintext=[];
  return {plaintext,crypto:{isAsyncEncryptionAvailable:async()=>available,
    async encryptStringAsync(text){plaintext.push(text);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(text,'utf8'),cipher.final(),cipher.getAuthTag()]);},
    async decryptStringAsync(bytes){const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return {result:Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8'),shouldReEncrypt};}}};
}
const temp=()=>mkdtemp(path.join(tmpdir(),'context-ai-keys-'));
const provider=(handler=()=>{})=>{const calls=[];return {calls,fetcher:async(url,options)=>{calls.push({url:String(url),auth:options?.headers?.Authorization});handler(url,options);
  if(String(url).endsWith('/key'))return Response.json({data:{is_free_tier:false}});
  return Response.json(String(url).endsWith('/models')?{data:[{id:'test-model'}]}:{choices:[{message:{content:'Antwort'},finish_reason:'stop'}],usage:{total_tokens:3}});}};};

test('keys are stored only OS-encrypted, with private permissions, restored after a restart and removable per provider',async()=>{
  const directory=await temp(),{crypto,plaintext}=fakeCrypto();
  try{
    const store=createDesktopKeyStore({directory,crypto,platform:'darwin'}),or=store.forProvider('openrouter'),kc=store.forProvider('kiconnect');
    assert.equal(await or.load(),'');
    assert.equal(await or.save(KEY),true);assert.equal(await kc.save(OTHER),true);
    assert.deepEqual(await readdir(directory),['ai-keys.enc']);
    const file=path.join(directory,'ai-keys.enc'),disk=await readFile(file);
    assert.ok(!disk.includes(KEY)&&!disk.includes(OTHER)&&!disk.includes('openrouter'));assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(directory)).mode&0o777,0o700);
    assert.ok(plaintext.at(-1).includes(KEY));
    const restarted=createDesktopKeyStore({directory,crypto,platform:'darwin'});
    assert.equal(await restarted.forProvider('openrouter').load(),KEY);assert.equal(await restarted.forProvider('kiconnect').load(),OTHER);
    await restarted.forProvider('openrouter').clear();
    const third=createDesktopKeyStore({directory,crypto,platform:'darwin'});assert.equal(await third.forProvider('openrouter').load(),'');assert.equal(await third.forProvider('kiconnect').load(),OTHER);
    await third.forProvider('kiconnect').clear();assert.deepEqual(await readdir(directory),[]);
    assert.throws(()=>store.forProvider('local'),TypeError);assert.throws(()=>store.forProvider('__proto__'),TypeError);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('without OS encryption nothing is written; hostile values, symlinks and corrupt files never leak or crash',async()=>{
  const directory=await temp();
  try{
    for(const options of [{platform:'linux',...fakeCrypto()},{platform:'darwin',...fakeCrypto({available:false})},{platform:'darwin',crypto:undefined}]){
      const store=createDesktopKeyStore({directory,crypto:options.crypto,platform:options.platform}).forProvider('openrouter');
      assert.equal(await store.save(KEY),false);assert.equal(await store.load(),'');assert.deepEqual(await readdir(directory),[]);
    }
    const {crypto}=fakeCrypto(),store=createDesktopKeyStore({directory,crypto,platform:'darwin'}).forProvider('openrouter');
    for(const bad of ['',' '.repeat(0),'a\nb','x'.repeat(4097),42,null,undefined])assert.equal(await store.save(bad),false);
    assert.deepEqual(await readdir(directory),[]);
    await writeFile(path.join(directory,'ai-keys.enc'),Buffer.from('not encrypted'));
    assert.equal(await createDesktopKeyStore({directory,crypto,platform:'darwin'}).forProvider('openrouter').load(),'');
    assert.equal(await createDesktopKeyStore({directory,crypto,platform:'darwin'}).forProvider('openrouter').save(KEY),true);
    const real=await mkdtemp(path.join(tmpdir(),'context-ai-keys-real-')),link=path.join(directory,'sub');await mkdir(link);await symlink(path.join(real,'x'),path.join(link,'ai-keys.enc'));
    await writeFile(path.join(real,'x'),Buffer.from('x'));
    assert.equal(await createDesktopKeyStore({directory:link,crypto,platform:'darwin'}).forProvider('openrouter').load(),'');await rm(real,{recursive:true,force:true});
    // A failing write keeps the key out of the store and reports it, so the connector falls back to memory.
    const failing={...crypto,encryptStringAsync:async()=>{throw new Error('keychain locked');}};
    const broken=createDesktopKeyStore({directory:await temp(),crypto:failing,platform:'darwin'}).forProvider('kiconnect');assert.equal(await broken.save(KEY),false);assert.equal(await broken.load(),'');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('connector persists only a key the provider accepted, reports where it lives and restores it without a new entry',async()=>{
  const saved=[],store={load:async()=>'',save:async key=>{saved.push(key);return true;},clear:async()=>{saved.push('cleared');}};
  const rejecting=createKIClient({provider:'openrouter',credentialStore:store,getKey:async()=>null,fetcher:async()=>new Response('{}',{status:401,headers:{'content-type':'application/json'}})});
  await assert.rejects(rejecting.configure({key:KEY}));assert.deepEqual(saved,[]);
  const p=provider(),client=createKIClient({provider:'openrouter',credentialStore:store,getKey:async()=>null,fetcher:p.fetcher});
  assert.equal((await client.status()).configured,false);
  const connected=await client.configure({key:KEY});assert.equal(connected.storage,'encrypted');assert.deepEqual(saved,[KEY]);assert.ok(!JSON.stringify(connected).includes(KEY));
  assert.equal((await client.status()).storage,'encrypted');
  // New process: the store has the key, no entry needed.
  const restored=createKIClient({provider:'openrouter',credentialStore:{load:async()=>KEY,save:async()=>true,clear:async()=>{}},getKey:async()=>null,fetcher:p.fetcher});
  const status=await restored.status();assert.deepEqual(status,{configured:true,storage:'encrypted',provider:'OpenRouter'});
  assert.equal((await restored.models()).models[0].id,'test-model');assert.equal((await restored.complete({model:'test-model',messages:[{role:'user',content:'Hallo'}]})).content,'Antwort');
  assert.ok(p.calls.filter(call=>call.auth).every(call=>call.auth==='Bearer '+KEY));
  // A store that cannot save leaves the key in memory and says so.
  const memoryOnly=createKIClient({provider:'kiconnect',credentialStore:{load:async()=>'',save:async()=>false,clear:async()=>{}},getKey:async()=>null,fetcher:p.fetcher});
  assert.equal((await memoryOnly.configure({key:OTHER})).storage,'session');assert.equal((await memoryOnly.status()).storage,'session');
  const throwing=createKIClient({provider:'kiconnect',credentialStore:{load:async()=>{throw new Error('boom');},save:async()=>{throw new Error('boom');},clear:async()=>{}},getKey:async()=>null,fetcher:p.fetcher});
  assert.equal((await throwing.status()).configured,false);assert.equal((await throwing.configure({key:OTHER})).storage,'session');
  // Environment key stays the fallback behind stored and session keys.
  const env=createKIClient({provider:'kiconnect',credentialStore:{load:async()=>'',save:async()=>true,clear:async()=>{}},getKey:async()=>({key:'env-key',storage:'session'}),fetcher:p.fetcher});
  assert.equal((await env.status()).configured,true);
});

test('forgetting removes the saved and the in-memory key and stops using it',async()=>{
  const p=provider();let stored=KEY,cleared=0;
  const store={load:async()=>stored,save:async key=>{stored=key;return true;},clear:async()=>{stored='';cleared++;}};
  const client=createKIClient({provider:'openrouter',credentialStore:store,getKey:async()=>null,fetcher:p.fetcher});
  await client.configure({key:'sk-or-replacement-PRIVATE'});assert.equal(stored,'sk-or-replacement-PRIVATE');
  const result=await client.forget();assert.deepEqual(result,{configured:false,storage:null,provider:'OpenRouter'});assert.equal(cleared,1);assert.equal(stored,'');
  await assert.rejects(client.models(),{code:'not_configured'});
  await assert.rejects(client.complete({model:'test-model',messages:[{role:'user',content:'Hallo'}]}),{code:'not_configured'});
  const failing=createKIClient({provider:'openrouter',credentialStore:{load:async()=>KEY,save:async()=>true,clear:async()=>{throw new Error('disk');}},getKey:async()=>null,fetcher:p.fetcher});
  await assert.rejects(failing.forget(),{code:'forget_failed'});
  const env=createKIClient({provider:'kiconnect',getKey:async()=>({key:'env-key',storage:'session'}),fetcher:p.fetcher});
  assert.equal((await env.forget()).configured,true);
});

test('HTTP forget route needs the same session, Origin and JSON proof as connecting, takes no fields and returns no key',{timeout:10000},async()=>{
  const p=provider(),store={load:async()=>'',save:async()=>true,clear:async()=>{}},client=createKIClient({credentialStore:store,getKey:async()=>null,fetcher:p.fetcher});
  const server=createServer(createRequestHandler(()=>server.address().port,async()=>({items:[],sources:[]}),client));server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port,request=(route,options={})=>fetch(origin+route,{...options,signal:AbortSignal.timeout(3000)});
  try{
    const index=await request('/');await index.text();const cookie=index.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-Context-Request':'ki-request'};
    const connected=await request('/api/ai/connection',{method:'POST',headers,body:JSON.stringify({key:OTHER})});assert.equal((await connected.json()).storage,'encrypted');
    for(const override of [{Cookie:''},{Origin:''},{Origin:'https://evil.example'},{'X-Context-Request':''},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await request('/api/ai/forget',{method:'POST',headers:{...headers,...override},body:'{}'})).status,403);
    assert.equal((await request('/api/ai/forget',{method:'POST',headers,body:'{"key":"x"}'})).status,400);
    assert.equal((await request('/api/ai/forget',{headers:{Cookie:cookie}})).status,405);
    assert.equal((await request('/api/ai/status',{headers:{Cookie:cookie}}).then(r=>r.json())).configured,true);
    const forgotten=await request('/api/ai/forget',{method:'POST',headers,body:'{}'}),text=await forgotten.text();assert.equal(forgotten.status,200);assert.ok(!text.includes(OTHER));assert.equal(JSON.parse(text).configured,false);
    assert.equal((await request('/api/ai/status',{headers:{Cookie:cookie}}).then(r=>r.json())).configured,false);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('desktop bridge forgets only cloud keys with an empty body; the local provider and extra fields are refused',async()=>{
  const forgotten=[],cloud={forget:async()=>{forgotten.push('openrouter');return {configured:false};},configure:async()=>({}),status:async()=>({})},local={configure:async()=>({}),status:async()=>({})};
  const bridge=createDesktopAI(cloud,local);
  assert.deepEqual(await bridge({action:'forget',provider:'openrouter',body:{}}),{configured:false});assert.deepEqual(forgotten,['openrouter']);
  for(const message of [{action:'forget',provider:'openrouter'},{action:'forget',provider:'openrouter',body:{key:'x'}},{action:'forget',provider:'local',body:{}},{action:'forget',provider:'kiconnect',body:{}}])await assert.rejects(bridge(message));
  assert.equal(forgotten.length,1);
});

test('the UI client sends forget only as an empty request for a cloud provider',async()=>{
  const sent=[];globalThis.window={contextDesktop:{ai:async message=>{sent.push(message);return {ok:true,value:{configured:false}};}}};
  try{
    assert.deepEqual(await aiRequest('openrouter','forget',{body:{}}),{configured:false});assert.equal(sent[0].action,'forget');assert.equal(sent[0].provider,'openrouter');
    for(const body of [undefined,{key:'x'}])await assert.rejects(aiRequest('openrouter','forget',{body}),/Ungültige KI-Verbindung/);
    await assert.rejects(aiRequest('local','forget',{body:{}}),/Ungültige KI-Verbindung/);assert.equal(sent.length,1);
  }finally{delete globalThis.window;}
});
