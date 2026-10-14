import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';

test('real localhost HTTP boundary rejects foreign requests and exposes only a read-only session feed',{timeout:12000},async()=>{
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',GITLAB_TOKEN:'',MATTERMOST_TOKEN:'',TH_MAIL_USER:'',TH_MAIL_PASSWORD:'',CONTEXT_SNAPSHOT_PATH:new URL('./fixtures-no-private-snapshot.json',import.meta.url).pathname},stdio:['ignore','pipe','pipe']});
  let startupTimer;let stderr='';child.stderr.on('data',d=>stderr=(stderr+String(d)).slice(-2000));
  try{
    const output=await Promise.race([once(child.stdout,'data').then(([d])=>String(d)),once(child,'exit').then(()=>{throw Error('Test server failed to start: '+stderr);}),new Promise((_,reject)=>{startupTimer=setTimeout(()=>reject(Error('Test server startup timed out')),5000);})]);clearTimeout(startupTimer);
    const port=Number(output.match(/:(\d+)/)[1]);const origin='http://127.0.0.1:'+port;const get=(path='',opts={})=>fetch(origin+path,{...opts,signal:AbortSignal.timeout(4000)});
    const first=await get();assert.equal(first.status,200);await first.text();const cookie=first.headers.get('set-cookie').split(';')[0];
    assert.equal((await get('/api/notifications')).status,403);
    assert.equal((await get('/api/notifications',{headers:{Cookie:cookie,Origin:'https://evil.example'}})).status,403);
    assert.equal((await get('/api/notifications',{method:'POST',headers:{Cookie:cookie}})).status,405);
    const feed=await get('/api/notifications',{headers:{Cookie:cookie}});assert.equal(feed.status,200);assert.equal(feed.headers.get('cache-control'),'private, no-store');assert.ok((await feed.json()).sources.every(s=>s.status==='not_configured'));
    const rebinding=await new Promise((resolve,reject)=>{const req=http.get(origin,{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)});req.setTimeout(4000,()=>req.destroy(Error('HTTP timeout')));req.on('error',reject);});assert.equal(rebinding,403);
    assert.equal((await get('/server.mjs')).status,404);
  }finally{clearTimeout(startupTimer);if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}
});
