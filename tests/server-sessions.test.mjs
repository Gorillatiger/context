import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestHandler} from '../server.mjs';
function endpoint(port,collect=async()=>({items:[],sources:[]})){
 const handler=createRequestHandler(()=>port,collect);
 return async(url='/',cookie='')=>{
  const res={status:0,headers:{},body:'',writeHead(status,headers={}){this.status=status;this.headers=headers;},end(body=''){this.body=String(body);}};
  await handler({url,method:'GET',headers:{host:'127.0.0.1:'+port,cookie}},res);return res;
 };
}
test('two local ports can coexist in the browser cookie jar without invalidating either session',async()=>{
 const a=endpoint(4331),b=endpoint(4332);
 const cookieA=(await a()).headers['Set-Cookie'].split(';')[0],cookieB=(await b()).headers['Set-Cookie'].split(';')[0];
 assert.notEqual(cookieA.split('=')[0],cookieB.split('=')[0]);
 const jar=cookieA+'; '+cookieB;
 assert.equal((await a('/api/mail/status',jar)).status,200);assert.equal((await b('/api/mail/status',jar)).status,200);
 assert.equal((await a('/api/mail/status',cookieB)).status,403);assert.equal((await b('/api/mail/status',cookieA)).status,403);
 assert.equal((await a('/api/mail/status','context_session=invalid')).status,403);
});
test('another handler on the same port cannot reuse an old session after restart',async()=>{
 const old=endpoint(4331),next=endpoint(4331),cookie=(await old()).headers['Set-Cookie'].split(';')[0];
 const denied=await next('/api/mail/status',cookie);assert.equal(denied.status,403);
 assert.equal(JSON.parse(denied.body).error,'session_expired');
 const fresh=(await next()).headers['Set-Cookie'].split(';')[0];assert.equal((await next('/api/mail/status',fresh)).status,200);
});
test('notifications and pending provider reads are cached within their own handler only',async()=>{
 let release;const a=endpoint(4331,()=>new Promise(r=>release=r)),b=endpoint(4332,async()=>({items:[{id:'only-b'}],sources:[]}));
 const ca=(await a()).headers['Set-Cookie'].split(';')[0],cb=(await b()).headers['Set-Cookie'].split(';')[0];
 const pending=a('/api/notifications',ca);
 const other=await b('/api/notifications',cb);assert.equal(JSON.parse(other.body).items[0].id,'only-b');
 release({items:[{id:'only-a'}],sources:[]});const first=await pending;assert.equal(JSON.parse(first.body).items[0].id,'only-a');
 assert.equal(JSON.parse((await b('/api/notifications',cb)).body).items[0].id,'only-b');
});
