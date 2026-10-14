import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once,EventEmitter} from 'node:events';
import {createRequestHandler} from '../server.mjs';
import {createKIClient,KIError} from '../connectors/ki.mjs';

test('KI HTTP route requires a local session, exact Origin and explicit JSON request; output has no credential',{timeout:10000},async()=>{
  let providerCalls=0;
  const client=createKIClient({getKey:async()=>({key:'synthetic-secret',storage:'session'}),fetcher:async(url)=>{providerCalls++;return Response.json(url.endsWith('/models')?{data:[{id:'test-model'}]}:{choices:[{message:{content:'Hallo zurück'},finish_reason:'stop'}]});}});
  const server=createServer(createRequestHandler(()=>server.address().port,async()=>({items:[],sources:[]}),client));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const request=(path,options={})=>fetch(origin+path,{...options,signal:AbortSignal.timeout(3000)});
  try{
    const index=await request('/');await index.text();const cookie=index.headers.get('set-cookie').split(';')[0];
    const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-Context-Request':'ki-request'};
    const body=JSON.stringify({model:'test-model',messages:[{role:'user',content:'Hallo'}]});
    for(const path of ['/api/ai/chat','/api/ai/connection'])for(const override of [{Cookie:''},{Origin:''},{Origin:'https://evil.example'},{Origin:origin.replace('127.0.0.1','localhost')},{'X-Context-Request':''},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await request(path,{method:'POST',headers:{...headers,...override},body})).status,403);
    assert.equal(providerCalls,0);
    assert.equal((await request('/api/ai/chat',{method:'POST',headers:{...headers,'Content-Type':'text/plain'},body})).status,415);
    assert.equal((await request('/api/ai/chat',{method:'POST',headers,body:'{broken'})).status,400);
    assert.equal((await request('/api/ai/chat',{method:'POST',headers,body:' '.repeat(512001)})).status,413);
    assert.equal((await request('/api/ai/chat',{headers:{Cookie:cookie}})).status,405);
    assert.equal((await request('/api/ai/models',{method:'POST',headers,body})).status,405);
    assert.equal((await request('/api/ai/models')).status,403);
    const reply=await request('/api/ai/chat',{method:'POST',headers,body});
    assert.equal(reply.status,200);assert.equal(reply.headers.get('cache-control'),'private, no-store');
    assert.equal((await reply.json()).content,'Hallo zurück');assert.equal(providerCalls,2);
    const status=await request('/api/ai/status',{headers:{Cookie:cookie}});const value=await status.text();
    assert.ok(!value.includes('synthetic-secret'));assert.equal(JSON.parse(value).storage,'session');
    assert.equal((await request('/api/ai/connection',{method:'POST',headers,body:'{"key":""}'})).status,400);
    const connected=await request('/api/ai/connection',{method:'POST',headers,body:'{"key":"replacement-synthetic-secret"}'});
    assert.equal(connected.status,200);const connectionText=await connected.text();assert.ok(!connectionText.includes('replacement-synthetic-secret'));assert.equal(JSON.parse(connectionText).models[0].id,'test-model');
    assert.equal((await request('/connectors/ki.mjs')).status,404);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('KI HTTP disconnect aborts the active provider request',{timeout:7000},async()=>{
  let started,aborted;const ready=new Promise(resolve=>started=resolve),cancelled=new Promise(resolve=>aborted=resolve);
  const client={complete:async(_,signal)=>{started();await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted();resolve();},{once:true}));return {content:'cancelled'};}};
  const server=createServer(createRequestHandler(()=>server.address().port,undefined,client));server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  try{
    const index=await fetch(origin);await index.text();const cookie=index.headers.get('set-cookie').split(';')[0];
    const controller=new AbortController();
    const pending=fetch(origin+'/api/ai/chat',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-Context-Request':'ki-request'},body:'{}',signal:controller.signal});
    await ready;controller.abort();await assert.rejects(pending);await cancelled;
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('KI HTTP errors whitelist bounded numeric retry metadata and never serialize provider bodies or credentials',async()=>{
  class ResponseMock extends EventEmitter{
    destroyed=false;writableEnded=false;status=0;headers={};body='';
    writeHead(status,headers){this.status=status;this.headers=headers;}
    end(body=''){this.body=String(body);this.writableEnded=true;}
  }
  let failure;
  const handler=createRequestHandler(()=>4386,async()=>({items:[],sources:[]}),{complete:async()=>{throw failure;}});
  async function request(url,{cookie,body}={}){
    const res=new ResponseMock(),req={url,method:body?'POST':'GET',headers:{host:'127.0.0.1:4386',...(cookie?{cookie}:{}),origin:'http://127.0.0.1:4386','content-type':'application/json','x-context-request':'ki-request'},
      async *[Symbol.asyncIterator](){if(body)yield Buffer.from(JSON.stringify(body));}};
    await handler(req,res);return res;
  }
  const cookie=(await request('/')).headers['Set-Cookie'].split(';')[0];
  for(const [delay,expected] of [[12500,12500],[0,1000],[1.5,1000],[120000,60000],['10000',undefined],[-1,undefined],[Infinity,undefined],[NaN,undefined],[null,undefined],[{},undefined]]){
    failure=new KIError(429,'provider_limit','PRIVATE_PROVIDER_BODY synthetic-secret');
    Object.assign(failure,{retryAfterMs:delay,key:'synthetic-secret',headers:{Authorization:'Bearer synthetic-secret'},body:'PRIVATE_PROVIDER_BODY'});
    const response=await request('/api/ai/chat',{cookie,body:{model:'fixture',messages:[{role:'user',content:'test'}]}}),value=JSON.parse(response.body);
    assert.equal(response.status,429);assert.equal(value.code,'provider_limit');assert.equal(value.error,'provider_limit');
    assert.equal(value.retryAfterMs,expected);assert.doesNotMatch(response.body,/PRIVATE_PROVIDER_BODY|synthetic-secret|Authorization|headers/);
    assert.ok(Object.keys(value).every(key=>['error','code','message','retryAfterMs'].includes(key)));
  }
  failure=Object.assign(new Error('PRIVATE_INTERNAL_BODY'),{code:'provider_limit',status:429,retryAfterMs:2000,key:'synthetic-secret'});
  const response=await request('/api/ai/chat',{cookie,body:{}}),value=JSON.parse(response.body);
  assert.equal(response.status,502);assert.equal(value.code,'unavailable');assert.equal(Object.hasOwn(value,'retryAfterMs'),false);
  assert.doesNotMatch(response.body,/PRIVATE_INTERNAL_BODY|synthetic-secret/);
});
