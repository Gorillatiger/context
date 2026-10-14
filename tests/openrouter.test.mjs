import test from 'node:test';
import assert from 'node:assert/strict';
import {createKIClient} from '../connectors/ki.mjs';
import {createDesktopAI} from '../desktop/ai.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequestHandler} from '../server.mjs';
const body={model:'test/model',messages:[{role:'user',content:'Synthetic task review'}]};
const auth=async()=>({key:'synthetic-openrouter-secret',storage:'session'});
const mock=async(url)=>Response.json(url.endsWith('/models')?{data:[{id:'test/model'}]}:{choices:[{message:{content:'Answer'}}]});
test('OpenRouter calls only its fixed API, enforces privacy and output bounds and never returns credentials',async()=>{
 const calls=[];const client=createKIClient({provider:'openrouter',getKey:auth,fetcher:async(url,options)=>{calls.push({url,options});return mock(url);}});
 assert.equal((await client.status()).provider,'OpenRouter');await client.complete(body);
 assert.deepEqual(calls.map(c=>c.url),['https://openrouter.ai/api/v1/models','https://openrouter.ai/api/v1/chat/completions']);
 const request=JSON.parse(calls[1].options.body);assert.deepEqual(request.provider,{data_collection:'deny',zdr:true});assert.equal(request.max_tokens,3000);assert.equal(request.stream,false);assert.equal(calls[1].options.redirect,'error');
 assert.ok(!JSON.stringify(await client.models()).includes('secret'));await assert.rejects(client.complete({...body,provider:{zdr:false}}));
});
test('OpenRouter model catalog is bounded but supports catalogs larger than KI:connect',async()=>{
 const client=createKIClient({provider:'openrouter',getKey:auth,fetcher:async()=>Response.json({data:Array.from({length:600},(_,i)=>({id:'test/'+i,name:'ignored',secret:'not-returned'}))})});assert.equal((await client.models()).models.length,600);
 await assert.rejects(createKIClient({provider:'openrouter',getKey:auth,fetcher:async()=>Response.json({data:Array(3001).fill({id:'test/model'})})}).models());
});
test('provider errors and missing credit remain safe; failed privacy routing never falls back to KI:connect',async()=>{
 for(const [status,code] of [[402,'credits_required'],[401,'access_denied'],[404,'provider_error'],[429,'provider_limit']]){
  const client=createKIClient({provider:'openrouter',getKey:auth,fetcher:async(url)=>url.endsWith('/models')?mock(url):new Response('synthetic-secret',{status})});
  await assert.rejects(client.complete(body),e=>e.code===code&&!e.message.includes('synthetic-secret'));
 }
 assert.throws(()=>createKIClient({provider:'evil'}));
});
test('desktop AI bridge accepts a bounded action set and cancels only its matching request',async()=>{
 let aborted=false;const bridge=createDesktopAI({status:async()=>({provider:'OpenRouter'}),models:async()=>({models:[]}),configure:async()=>({configured:true}),complete:async(_body,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'));},{once:true}))});
 assert.equal((await bridge({action:'status'})).provider,'OpenRouter');
 for(const message of [{action:'fetch',url:'https://evil.test/'},{action:'chat',id:'x'},{action:'shell',id:crypto.randomUUID()}])await assert.rejects(bridge(message));
 const id=crypto.randomUUID(),pending=bridge({action:'chat',body,id});await bridge({action:'cancel',id});await assert.rejects(pending);assert.equal(aborted,true);
});
test('HTTP provider routing separates keys and models and rejects unknown providers or cross-origin writes',async()=>{
 const router=createKIClient({provider:'openrouter',getKey:auth,fetcher:mock});const ki=createKIClient({getKey:async()=>null});
 const server=createServer(createRequestHandler(()=>server.address().port,async()=>({items:[],sources:[]}),ki,undefined,router));server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin='http://127.0.0.1:'+server.address().port;
 try{
  const index=await fetch(origin+'/');await index.text();const cookie=index.headers.get('set-cookie').split(';')[0];const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-Context-Request':'ki-request'};
  assert.equal((await (await fetch(origin+'/api/ai/status',{headers})).json()).configured,false);
  assert.equal((await (await fetch(origin+'/api/ai/status?provider=openrouter',{headers})).json()).configured,true);
  assert.equal((await fetch(origin+'/api/ai/models?provider=evil',{headers})).status,400);
  const send=(value,override={})=>fetch(origin+'/api/ai/chat',{method:'POST',headers:{...headers,...override},body:JSON.stringify(value)});
  assert.equal((await send({...body,provider:'openrouter'})).status,200);assert.equal((await send({...body,provider:'evil'})).status,400);assert.equal((await send({...body,provider:'openrouter'},{Origin:'https://evil.test'})).status,403);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('OpenRouter setup verifies the actual key endpoint before retaining a credential',async()=>{
 const calls=[];const client=createKIClient({provider:'openrouter',getKey:async()=>null,fetcher:async(url,options)=>{calls.push(url);if(url.endsWith('/key'))return options.headers.Authorization.endsWith('invalid')?new Response('private',{status:401}):Response.json({data:{is_free_tier:false,label:'private',limit_remaining:5}});return mock(url);}});
 await assert.rejects(client.configure({key:'invalid'}));assert.equal((await client.status()).configured,false);assert.deepEqual(calls,['https://openrouter.ai/api/v1/key']);
 const result=await client.configure({key:'synthetic-secret'});assert.equal(result.provider,'OpenRouter');assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('synthetic-secret'));assert.equal((await client.status()).configured,true);
});
