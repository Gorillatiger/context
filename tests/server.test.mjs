import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestHandler } from '../server.mjs';

test('actual request handler enforces sessions, origin, DNS rebinding, read-only methods and static containment',async()=>{
  const port=4317;let calls=0;
  const handler=createRequestHandler(()=>port,async()=>{calls++;return {items:[],sources:[{source:'gitlab',status:'not_configured'}]};});
  async function request(url='/',headers={},method='GET') {
    const res={status:0,headers:{},body:'',writeHead(status,headers={}){this.status=status;this.headers=headers;},end(body=''){this.body=String(body);}};
    await handler({url,method,headers:{host:'127.0.0.1:'+port,...headers}},res);return res;
  }
  const first=await request();assert.equal(first.status,200);const setCookie=first.headers['Set-Cookie'];assert.ok(setCookie.includes('HttpOnly'));assert.ok(setCookie.includes('SameSite=Strict'));assert.ok(first.headers['Content-Security-Policy'].includes("frame-ancestors 'none'"));
  const cookie=setCookie.split(';')[0];
  assert.equal((await request('/api/notifications')).status,403);
  assert.equal((await request('/api/notifications',{cookie,origin:'https://evil.example'})).status,403);
  assert.equal((await request('/api/notifications',{cookie,'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await request('/api/notifications',{cookie},'POST')).status,405);
  assert.equal((await request('/',{host:'evil.example'})).status,403);
  assert.equal((await request('/api/notifications',{cookie:'context_session=invalid'})).status,403);
  const api=await request('/api/notifications',{cookie});assert.equal(api.status,200);assert.ok(api.headers['Cache-Control'].includes('no-store'));assert.equal(JSON.parse(api.body).sources[0].status,'not_configured');
  await request('/api/notifications',{cookie});assert.equal(calls,1,'cache avoids repeated provider requests');
  for(const path of ['/server.mjs','/.env','/connectors/mail-reader.py','/%2e%2e%2fpackage.json'])assert.ok((await request(path)).status>=400);
});
