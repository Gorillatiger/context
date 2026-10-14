import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDesktopNango} from '../desktop/nango.mjs';
import {miroProxyRoute,miroProxyParams} from '../desktop/nango-miro-policy.mjs';

async function fixture(t,{boardRead=true,provider='miro'}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'context-miro-nango-qa-')),calls=[];
  const fetchImpl=async(raw,options)=>{
    const url=new URL(raw);calls.push({url,options});
    let data;
    if(url.pathname==='/integrations')data={data:[{unique_key:'miro-integration',provider}]};
    else if(url.pathname==='/connections')data={connections:[{provider:'miro',provider_config_key:'miro-integration',connection_id:'miro-one',errors:[]}]};
    else if(url.pathname.startsWith('/proxy/'))data={id:'uXjVBoardTest=',name:'Aufgaben',data:[]};
    else throw Error('Unexpected fixture path');
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const nango=createDesktopNango({directory,crypto:{isEncryptionAvailable:()=>false},fetchImpl});
  t.after(async()=>{await nango.dispose();await rm(directory,{recursive:true,force:true});});
  const configure=()=>nango.handle({action:'configure',body:{baseURL:'https://api.nango.dev',secretKey:'synthetic-miro-nango-key',integrations:{miro:'miro-integration'},capabilities:{miro:{boardRead}}}});
  return {nango,calls,configure};
}
test('Miro integration requires official provider and only read capability',async t=>{
  const f=await fixture(t);const status=await f.configure();const miro=status.services.find(service=>service.service==='miro');assert.ok(miro);assert.deepEqual(miro.capabilities,{boardRead:true});assert.equal(miro.connected,false);assert.doesNotMatch(JSON.stringify(status),/synthetic-miro-nango-key/);
  await assert.rejects(f.nango.handle({action:'configure',body:{baseURL:'https://api.nango.dev',secretKey:'synthetic-key',integrations:{miro:'miro-integration'},capabilities:{miro:{boardWrite:true}}}}),{code:'invalid_request'});
  const wrong=await fixture(t,{provider:'miro-scim'});await assert.rejects(wrong.configure(),{code:'integration_mismatch'});
});
test('Miro proxy fixes api.miro.com origin, GET route and bounded cursor parameters',async t=>{
  const f=await fixture(t);await f.configure();await f.nango.handle({action:'connection',service:'miro',body:{connectionId:'miro-one'}});
  const result=await f.nango.proxy('miro',{method:'GET',path:'/v2/boards/uXjVBoardTest%3D/items',params:{limit:50,cursor:'opaque+cursor='},identity:{integrationId:'miro-integration',connectionId:'miro-one',revision:f.nango.localStatus('miro').revision,capabilities:{boardRead:true}}});
  assert.equal(result.status,200);const call=f.calls.at(-1);assert.equal(call.url.pathname,'/proxy/v2/boards/uXjVBoardTest%3D/items');assert.equal(call.options.headers['Base-Url-Override'],'https://api.miro.com');assert.equal(call.url.searchParams.get('cursor'),'opaque+cursor=');assert.equal(call.options.headers.Retries,'0');
});
test('Miro policy rejects account-wide listing, writes, foreign paths, encoded separators and arbitrary params before network',async t=>{
  const f=await fixture(t);await f.configure();await f.nango.handle({action:'connection',service:'miro',body:{connectionId:'miro-one'}});const before=f.calls.length;
  const bad=[
    {method:'POST',path:'/v2/boards/uXjVBoardTest%3D/items',body:{data:{content:'Must not write'}}},
    {method:'PATCH',path:'/v2/boards/uXjVBoardTest%3D',body:{name:'Must not update'}},
    {method:'GET',path:'/v2/boards'},
    {method:'GET',path:'/v2/boards/uXjVBoardTest%3D/members'},
    {method:'GET',path:'/v2/boards/uXjV%2FBoardTest/items'},
    {method:'GET',path:'/v2/boards/uXjVBoardTest%253D/items'},
    {method:'GET',path:'/v2/boards/uXjVBoardTest%3D/items',params:{limit:51}},
    {method:'GET',path:'/v2/boards/uXjVBoardTest%3D/items',params:{url:'https://evil.test'}},
    {method:'GET',path:'/v2/boards/uXjVBoardTest%3D',params:{cursor:'not valid here'}},
    {method:'GET',path:'/v2/boards/uXjVBoardTest%3D/items',params:{cursor:'x'.repeat(2049)}},
    {method:'GET',path:'https://evil.test/v2/boards/uXjVBoardTest%3D'},
  ];
  for(const request of bad)await assert.rejects(f.nango.proxy('miro',request));assert.equal(f.calls.length,before);
});
test('disabled read or stale Miro connection identity cannot proxy board contents',async t=>{
  const disabled=await fixture(t,{boardRead:false});await disabled.configure();await disabled.nango.handle({action:'connection',service:'miro',body:{connectionId:'miro-one'}});
  await assert.rejects(disabled.nango.proxy('miro',{method:'GET',path:'/v2/boards/uXjVBoardTest%3D'}),{code:'permission_denied'});assert.ok(!disabled.calls.some(call=>call.url.pathname.startsWith('/proxy')));
  const f=await fixture(t);await f.configure();await f.nango.handle({action:'connection',service:'miro',body:{connectionId:'miro-one'}});
  await assert.rejects(f.nango.proxy('miro',{method:'GET',path:'/v2/boards/uXjVBoardTest%3D',identity:{integrationId:'miro-integration',connectionId:'other-account',capabilities:{boardRead:true}}}),{code:'connection_mismatch'});assert.ok(!f.calls.some(call=>call.url.pathname.startsWith('/proxy')));
});
test('standalone typed Miro policy rejects raw URL or double encoded board paths',()=>{
  assert.equal(miroProxyRoute('GET','/v2/boards/uXjVBoardTest%3D'),'boardRead');assert.equal(miroProxyRoute('GET','/v2/boards/uXjVBoardTest%3D/items'),'boardRead');
  for(const route of ['/v2/boards','/v2/boards/uXjV%2FBoardTest/items','/v2/boards/uXjVBoardTest%253D/items','//evil.test/items'])assert.equal(miroProxyRoute('GET',route),null);
  assert.equal(miroProxyParams('/v2/boards/uXjVBoardTest%3D/items',{limit:50,cursor:'next=='}),true);assert.equal(miroProxyParams('/v2/boards/uXjVBoardTest%3D',{limit:50}),false);
});
