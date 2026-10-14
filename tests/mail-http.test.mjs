import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequestHandler} from '../server.mjs';
import {createMailClient} from '../connectors/mail.mjs';

test('mail HTTP route enforces local session, exact Origin, explicit JSON and size limits for every operation',{timeout:10000},async()=>{
  const calls=[];const mail=createMailClient({env:{},runner:async payload=>{calls.push(payload);if(payload.action==='connect')return {smtpReady:true,folders:[]};if(payload.action==='attachment')return {name:'Grüße " test.txt',data:Buffer.from('QA attachment').toString('base64')};return {items:[],uidValidity:'123',accepted:1};}});
  const server=createServer(createRequestHandler(()=>server.address().port,async()=>({items:[],sources:[]}),undefined,mail));
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  const request=(path,options={})=>fetch(origin+path,{...options,signal:AbortSignal.timeout(3000)});
  try{
    const index=await request('/');await index.text();const cookie=index.headers.get('set-cookie').split(';')[0];
    const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-Context-Request':'mail-request'};
    const setup=JSON.stringify({user:'qa-user',address:'qa@smail.th-koeln.de',password:'synthetic-private'});
    for(const action of ['connection','folders','list','message','attachment','attachment-link','flag','send']){
      for(const override of [{Cookie:''},{Origin:''},{Origin:'https://evil.example'},{Origin:origin.replace('127.0.0.1','localhost')},{'X-Context-Request':''},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await request('/api/mail/'+action,{method:'POST',headers:{...headers,...override},body:setup})).status,403);
      assert.equal((await request('/api/mail/'+action,{headers:{Cookie:cookie}})).status,405);
    }
    assert.equal(calls.length,0);
    assert.equal((await request('/api/mail/connection',{method:'POST',headers:{...headers,'Content-Type':'text/plain'},body:setup})).status,415);
    assert.equal((await request('/api/mail/connection',{method:'POST',headers,body:'{broken'})).status,400);
    assert.equal((await request('/api/mail/message',{method:'POST',headers,body:' '.repeat(10001)})).status,413);
    const connected=await request('/api/mail/connection',{method:'POST',headers,body:setup});assert.equal(connected.status,200);
    assert.ok(!(await connected.text()).includes('synthetic-private'));
    const status=await request('/api/mail/status',{headers:{Cookie:cookie}});assert.equal(status.headers.get('cache-control'),'private, no-store');assert.ok(!(await status.text()).includes('synthetic-private'));
    const download=await request('/api/mail/attachment',{method:'POST',headers,body:JSON.stringify({folder:'SU5CT1g',uid:'45',uidValidity:'123',part:'2'})});
    assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.ok(download.headers.get('content-disposition').includes('filename*=UTF-8'));assert.equal(await download.text(),'QA attachment');
    const prepare=()=>request('/api/mail/attachment-link',{method:'POST',headers,body:JSON.stringify({folder:'SU5CT1g',uid:'45',uidValidity:'123',part:'2'})});
    const ticket=await (await prepare()).json();assert.match(ticket.url,/^\/api\/mail\/download\/[0-9a-f]{64}$/);
    assert.equal((await request(ticket.url)).status,403);
    assert.equal((await request(ticket.url,{headers:{Cookie:cookie,Origin:'https://evil.example'}})).status,403);
    assert.equal((await request(ticket.url,{method:'HEAD',headers:{Cookie:cookie}})).status,200);
    assert.equal(await (await request(ticket.url,{headers:{Cookie:cookie}})).text(),'QA attachment');
    assert.equal((await request(ticket.url,{headers:{Cookie:cookie}})).status,404);
    const disconnectedTicket=await (await prepare()).json();
    assert.equal((await request('/connectors/mail-client.py')).status,404);
    assert.equal((await request('/api/mail/delete',{method:'POST',headers,body:'{}'})).status,405);
    await request('/api/mail/connection',{method:'POST',headers,body:'{"disconnect":true}'});
    assert.equal((await request(disconnectedTicket.url,{headers:{Cookie:cookie}})).status,404);
    const after=await request('/api/mail/message',{method:'POST',headers,body:JSON.stringify({folder:'SU5CT1g',uid:'45',uidValidity:'123'})});assert.equal(after.status,409);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
