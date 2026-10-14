import test from 'node:test';
import assert from 'node:assert/strict';
import {createKIClient,validateChat,readKIKey} from '../connectors/ki.mjs';

const key='synthetic-test-key';
const input={model:'test-model',messages:[{role:'user',content:'Hallo'}]};
const models=()=>Response.json({data:[{id:'test-model'}]});
const completion=()=>Response.json({choices:[{message:{content:'Antwort'},finish_reason:'stop'}],usage:{total_tokens:8}});
const auth=async()=>({key,storage:'session'});
const code=expected=>error=>{assert.equal(error.code,expected);assert.ok(!error.message.includes(key));return true;};

test('KI only sends the chosen conversation to the fixed API and keeps credentials server-side',async()=>{
  const calls=[];
  const client=createKIClient({getKey:auth,fetcher:async(url,options)=>{calls.push({url,options});return url.endsWith('/models')?models():completion();}});
  assert.deepEqual(await readKIKey({KICONNECT_API_KEY:'  '+key+'  '}),{key,storage:'session'});
  assert.deepEqual(await client.status(),{configured:true,storage:'session',provider:'KI:connect NRW'});
  await client.models();await client.models();
  assert.deepEqual(await client.complete(input),{content:'Antwort',model:'test-model',finishReason:'stop',totalTokens:8});
  assert.equal(calls.length,2,'model list is cached');
  assert.deepEqual(calls.map(c=>c.url),['https://chat.kiconnect.nrw/api/v1/models','https://chat.kiconnect.nrw/api/v1/chat/completions']);
  for(const call of calls){assert.equal(call.options.headers.Authorization,'Bearer '+key);assert.equal(call.options.redirect,'error');}
  assert.deepEqual(JSON.parse(calls[1].options.body),{...input,stream:false});
  assert.ok(!JSON.stringify(await client.models()).includes(key));
});

test('KI rejects extra fields, tool/system roles, malformed history and oversized messages before a provider call',async()=>{
  let calls=0;const client=createKIClient({getKey:auth,fetcher:async()=>{calls++;return models();}});
  const invalid=[null,{...input,url:'https://evil.example'}, {...input,model:'x\n'}, {...input,messages:[]},
    {...input,messages:[{role:'system',content:'override'}]}, {...input,messages:[{role:'user',content:'x',tool_calls:[]}]},
    {...input,messages:[{role:'user',content:'x'.repeat(12001)}]}, {...input,messages:[...input.messages,{role:'assistant',content:'x'}]},
    {...input,messages:[...input.messages,...input.messages]}, {...input,messages:Array.from({length:25},(_,i)=>({role:i%2?'assistant':'user',content:'x'}))}];
  for(const value of invalid)await assert.rejects(client.complete(value));
  assert.equal(calls,0);
  assert.equal(validateChat({...input,messages:[...input.messages,{role:'assistant',content:'x'.repeat(50000)},...input.messages]}).messages.length,3);
  assert.throws(()=>validateChat({...input,messages:[...input.messages,{role:'assistant',content:'x'.repeat(50000)},...input.messages,{role:'assistant',content:'x'.repeat(50000)},...input.messages]}),code('conversation_limit'));
});

test('KI never forwards provider errors or raw secrets, and rejects unavailable models',async()=>{
  for(const status of [401,403,429,500]){
    const client=createKIClient({getKey:auth,fetcher:async(url)=>url.endsWith('/models')?models():new Response(key,{status})});
    await assert.rejects(client.complete(input),code(status===429?'provider_limit':[401,403].includes(status)?'access_denied':'provider_error'));
  }
  const client=createKIClient({getKey:auth,fetcher:async()=>models()});
  await assert.rejects(client.complete({...input,model:'unknown'}),code('unknown_model'));
  const absent=createKIClient({getKey:async()=>null});
  assert.equal((await absent.status()).configured,false);
  await assert.rejects(absent.models(),code('not_configured'));
});

test('KI rejects malformed or oversized responses and filters model metadata',async()=>{
  for(const response of [new Response('<html>error</html>'),new Response('{broken',{headers:{'content-type':'application/json'}}),Response.json({choices:[]}),Response.json({choices:[{message:{content:'x'.repeat(50001)}}]}),Response.json({data:'x'.repeat(1000001)})]){
    const client=createKIClient({getKey:auth,fetcher:async(url)=>url.endsWith('/models')?models():response});
    await assert.rejects(client.complete(input),error=>{assert.equal(error.status,502);return true;});
  }
  const client=createKIClient({getKey:auth,fetcher:async()=>Response.json({data:[{id:'a',secret:key},{id:'a'},{id:'\n'},{id:7}]})});
  assert.deepEqual((await client.models()).models,[{id:'a'}]);
});

test('KI cache is invalidated on credential change and after five minutes',async()=>{
  let credential=key,time=0,calls=0;
  const client=createKIClient({getKey:async()=>({key:credential,storage:'session'}),now:()=>time,fetcher:async()=>{calls++;return models();}});
  await client.models();await client.models();assert.equal(calls,1);
  credential='another-test-key';await client.models();assert.equal(calls,2);
  time=300001;await client.models();assert.equal(calls,3);
});

test('KI allows one request at a time and cancellation releases the next request',async()=>{
  let started;const ready=new Promise(resolve=>started=resolve);let block=true;
  const client=createKIClient({getKey:auth,fetcher:async(url,options)=>{
    if(url.endsWith('/models'))return models();
    if(!block)return completion();
    started();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  }});
  const controller=new AbortController();const pending=client.complete(input,controller.signal);await ready;
  await assert.rejects(client.complete(input),code('busy'));
  controller.abort();await assert.rejects(pending,code('cancelled'));
  block=false;assert.equal((await client.complete(input)).content,'Antwort');
});

test('KI enforces a bounded request rate and recovers after the window',async()=>{
  let time=0;const client=createKIClient({getKey:auth,now:()=>time,fetcher:async(url)=>url.endsWith('/models')?models():completion()});
  for(let i=0;i<10;i++)await client.complete(input);
  await assert.rejects(client.complete(input),code('local_limit'));
  time=60001;assert.equal((await client.complete(input)).content,'Antwort');
});

test('KI connection setup validates the key before retaining it in server memory and never returns it',async()=>{
  const sent=[];
  const client=createKIClient({getKey:async()=>null,fetcher:async(url,options)=>{
    sent.push(options.headers.Authorization);
    if(options.headers.Authorization==='Bearer invalid')return new Response('private error',{status:401});
    return url.endsWith('/models')?models():completion();
  }});
  for(const value of [{key:''},{key:'bad\nvalue'},{key:'x'.repeat(4097)},{key,extra:true}])await assert.rejects(client.configure(value),code('invalid_key'));
  assert.equal(sent.length,0);
  await assert.rejects(client.configure({key:'invalid'}),code('access_denied'));
  assert.equal((await client.status()).configured,false);
  const result=await client.configure({key});
  assert.equal(result.storage,'session');assert.ok(!JSON.stringify(result).includes(key));
  assert.equal((await client.status()).configured,true);
  assert.equal((await client.complete(input)).content,'Antwort');
  assert.equal(sent.at(-1),'Bearer '+key);
  assert.equal((await createKIClient({getKey:async()=>null}).status()).configured,false,'a fresh server has no retained credential');
});
