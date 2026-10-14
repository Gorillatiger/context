import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestHandler} from '../server.mjs';
test('manual same-origin checks refresh stale cache, throttle rapid clicks, and coalesce concurrent reads',async()=>{
  let clock=0,calls=0,block,release;
  const collect=async()=>{calls++;if(block)await block;return {items:[],sources:[],checkedAt:new Date(clock).toISOString()};};
  const handler=createRequestHandler(()=>4345,collect,undefined,undefined,undefined,{now:()=>clock});
  async function request(url='/',extra={}){const res={status:0,headers:{},body:'',writeHead(status,headers={}){this.status=status;this.headers=headers;},end(body=''){this.body=String(body);}};await handler({url,method:'GET',headers:{host:'127.0.0.1:4345',...extra}},res);return res;}
  const cookie=(await request()).headers['Set-Cookie'].split(';')[0];
  assert.equal((await request('/api/notifications?refresh=1',{cookie,origin:'https://foreign.example'})).status,403);assert.equal(calls,0);
  await request('/api/notifications',{cookie});assert.equal(calls,1);
  clock=9999;await request('/api/notifications?refresh=1',{cookie});assert.equal(calls,1);
  clock=10000;await request('/api/notifications?refresh=1',{cookie});assert.equal(calls,2);
  clock=20000;await request('/api/notifications',{cookie});assert.equal(calls,2);
  clock=70000;block=new Promise(r=>release=r);const one=request('/api/notifications',{cookie}),two=request('/api/notifications?refresh=1',{cookie});assert.equal(calls,3);release();assert.equal((await one).status,200);assert.equal((await two).status,200);assert.equal(calls,3);
});
