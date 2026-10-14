import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequestHandler} from '../server.mjs';
const port=4358;
async function fixture(spaces){
  const handler=createRequestHandler(()=>port,async()=>({items:[],sources:[]}),undefined,undefined,undefined,{spaces});
  async function request(path='/',{method='GET',cookie='',headers={},body}={}){
    const req=new EventEmitter();Object.assign(req,{url:path,method,headers:{host:'127.0.0.1:'+port,cookie,...headers}});req[Symbol.asyncIterator]=async function*(){if(body!==undefined)yield Buffer.from(typeof body==='string'?body:JSON.stringify(body));};
    const res=new EventEmitter();Object.assign(res,{status:0,headers:{},body:'',writableEnded:false,writeHead(status,headers={}){this.status=status;this.headers=headers;},end(body=''){this.body=String(body);this.writableEnded=true;}});
    await handler(req,res);return res;
  }
  const cookie=(await request()).headers['Set-Cookie'].split(';')[0];
  return {request,cookie,post:(body,headers={})=>request('/api/spaces/search',{method:'POST',cookie,headers:{'content-type':'application/json','x-context-request':'spaces-search',...headers},body})};
}
test('web adapter uses authenticated session and same narrow service contract',async()=>{
  const seen=[],f=await fixture({handle:async(body)=>{seen.push(body);return {items:[],scope:'published',page:1,hasMore:false};}});const body={op:'search',courseURL:'https://spaces.th-koeln.de/course/',projectId:'course',query:'Miro'};
  const r=await f.post(body);assert.equal(r.status,200);assert.deepEqual(seen,[body]);assert.equal(r.headers['Cache-Control'],'private, no-store');
});
test('unconnected web mode is explicit and does not copy browser cookies',async()=>{
  const f=await fixture(null),r=await f.post({op:'search'});assert.equal(r.status,503);assert.equal(JSON.parse(r.body).error,'spaces_not_connected');
});
test('cross site, foreign origin and unauthenticated callers cannot search',async()=>{
  let calls=0;const f=await fixture({handle:async()=>{calls++;return {};}});
  for(const headers of [{'sec-fetch-site':'cross-site'},{origin:'https://evil.test'}])assert.equal((await f.post({op:'search'},headers)).status,403);
  assert.equal((await f.request('/api/spaces/search',{method:'POST',headers:{'content-type':'application/json','x-context-request':'spaces-search'},body:{op:'search'}})).status,403);assert.equal(calls,0);
});
test('wrong method, missing CSRF marker, query credentials and mismatched op fail before service',async()=>{
  let calls=0;const f=await fixture({handle:async()=>{calls++;return {};}});
  assert.equal((await f.request('/api/spaces/search',{cookie:f.cookie})).status,405);
  assert.equal((await f.post({op:'read'})).status,400);
  assert.equal((await f.post({op:'search'},{'x-context-request':''})).status,400);
  assert.equal((await f.request('/api/spaces/search?nonce=secret',{method:'POST',cookie:f.cookie,headers:{'content-type':'application/json','x-context-request':'spaces-search'},body:{op:'search'}})).status,400);assert.equal(calls,0);
});
test('bad JSON, oversized requests and provider error bodies never leak',async()=>{
  const f=await fixture({handle:async()=>{throw new Error('nonce=private-cookie');}});
  for(const body of ['{','x'.repeat(5000),{op:'search'}]){const r=await f.post(body);assert.equal(r.status,400);assert(!r.body.includes('private-cookie'));}
});
