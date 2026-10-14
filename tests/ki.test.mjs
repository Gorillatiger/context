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

test('KI:connect usage exposes only the local user-provided rolling limit while its overall budget remains unknown',async()=>{
  let time=0,calls=0;
  const client=createKIClient({getKey:auth,now:()=>time,fetcher:async url=>{calls++;return url.endsWith('/models')?models():completion();}});
  const empty=await client.usage();
  assert.equal(empty.status,'unknown');assert.equal(empty.reason,'not_exposed');
  assert.deepEqual(empty.rateLimit,{limit:10,windowMs:60000,used:0,remaining:10,retryAfterMs:0,scope:'local-process',basis:'user-provided'});
  assert.equal(calls,0);
  for(let i=0;i<10;i++){time=i*1000;await client.complete(input);}
  const before=calls,full=await client.usage();
  assert.equal(full.status,'unknown');assert.equal(full.rateLimit.used,10);assert.equal(full.rateLimit.remaining,0);assert.equal(full.rateLimit.retryAfterMs,51000);
  await assert.rejects(client.complete(input),error=>error.code==='local_limit'&&error.status===429&&error.retryAfterMs===51000);
  assert.equal(calls,before,'usage and local rejection do not contact the provider');
  full.rateLimit.used=100;assert.equal((await client.usage()).rateLimit.used,10);
  time=59001;assert.equal((await client.usage()).rateLimit.retryAfterMs,1000);
  time=60000;const available=await client.usage();assert.equal(available.rateLimit.used,9);assert.equal(available.rateLimit.remaining,1);assert.equal(available.rateLimit.retryAfterMs,0);
  await client.complete(input);assert.equal((await client.usage()).rateLimit.remaining,0);
  assert.doesNotMatch(JSON.stringify(await client.usage()),/synthetic-test-key|remainingBudget|unlimited|keyBudget/);
});

test('connection attempts retain their existing rate accounting while model and usage reads do not consume messages',async()=>{
  const client=createKIClient({getKey:auth,now:()=>0,fetcher:async url=>url.endsWith('/models')?models():completion()});
  await client.configure({key});await client.models();await client.models();await client.usage();
  assert.equal((await client.usage()).rateLimit.used,1);
  for(let i=0;i<9;i++)await client.complete(input);
  await assert.rejects(client.configure({key}),error=>error.code==='local_limit'&&error.retryAfterMs===60000);
  assert.equal((await client.usage()).rateLimit.used,10);
});

test('a clock rollback cannot reset the existing local message limit or produce an unbounded retry hint',async()=>{
  let time=1000,calls=0;
  const client=createKIClient({getKey:auth,now:()=>time,fetcher:async url=>{calls++;return url.endsWith('/models')?models():completion();}});
  for(let i=0;i<10;i++)await client.complete(input);
  const before=calls;time=0;
  await assert.rejects(client.complete(input),error=>error.code==='local_limit'&&error.retryAfterMs===60000);
  assert.equal((await client.usage()).rateLimit.used,10);assert.equal(calls,before);
});

test('provider 429 Retry-After metadata accepts seconds or HTTP date, clamps bounds and releases the active request',async()=>{
  const time=Date.UTC(2026,9,14,12,0,0);
  for(const [header,expected] of [
    ['5',5000],['0',1000],['9999999999999999999999999999',60000],
    [new Date(time+25000).toUTCString(),25000],[new Date(time-1000).toUTCString(),1000],
    [new Date(time+120000).toUTCString(),60000],[undefined,60000],['garbage PRIVATE_ERROR',60000],['-1',60000],['0.5',60000]
  ]){
    let chats=0;
    const client=createKIClient({getKey:auth,now:()=>time,fetcher:async url=>{
      if(url.endsWith('/models'))return models();
      chats++;return chats===1?new Response('PRIVATE_ERROR '+key,{status:429,headers:header===undefined?{}:{'Retry-After':header}}):completion();
    }});
    await assert.rejects(client.complete(input),error=>{
      assert.equal(error.code,'provider_limit');assert.equal(error.status,429);assert.equal(error.retryAfterMs,expected);
      assert.doesNotMatch(error.message,/PRIVATE_ERROR|synthetic-test-key/);return true;
    });
    assert.equal((await client.complete(input)).content,'Antwort','429 must release the active lock without backend waiting');
    assert.equal(chats,2);
  }
});

test('an uncooperative error-body cancellation cannot hold the active KI slot after a provider limit',async()=>{
  let chats=0,bodyCancelled=false;
  const client=createKIClient({getKey:auth,fetcher:async url=>{
    if(url.endsWith('/models'))return models();
    if(++chats>1)return completion();
    return new Response(new ReadableStream({cancel(){bodyCancelled=true;return new Promise(()=>{});}}),{status:429,headers:{'Retry-After':'3'}});
  }});
  await assert.rejects(client.complete(input),error=>error.code==='provider_limit'&&error.retryAfterMs===3000);
  assert.equal(bodyCancelled,true);assert.equal((await client.complete(input)).content,'Antwort');
});

test('pre-cancel and cancellation during credential lookup cannot start a model/chat call or consume a local message',async()=>{
  let release,lookups=0,calls=0,held=true;
  const gate=new Promise(resolve=>release=resolve);
  const client=createKIClient({getKey:async()=>{lookups++;if(held)await gate;return {key,storage:'session'};},fetcher:async url=>{calls++;return url.endsWith('/models')?models():completion();}});
  await assert.rejects(client.complete(input,AbortSignal.abort()),code('cancelled'));
  await assert.rejects(client.complete(input,{}),code('invalid_request'));assert.equal(lookups,0);assert.equal(calls,0);
  const controller=new AbortController(),pending=client.complete(input,controller.signal);
  controller.abort();held=false;release();await assert.rejects(pending,code('cancelled'));
  assert.equal(calls,0);assert.equal((await client.usage()).rateLimit.used,0);
  assert.equal((await client.complete(input)).content,'Antwort');
});

test('cancellation wins over late model responses from a provider transport that ignores its signal',async()=>{
  let release,started,calls=0;
  const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
  const client=createKIClient({getKey:auth,fetcher:async url=>{
    calls++;if(url.endsWith('/models')){started();await gate;return models();}return completion();
  }});
  const controller=new AbortController(),pending=client.complete(input,controller.signal);
  await ready;controller.abort();release();await assert.rejects(pending,code('cancelled'));
  assert.equal(calls,1);assert.equal((await client.usage()).rateLimit.used,0);
  assert.equal((await client.complete(input)).content,'Antwort');
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
