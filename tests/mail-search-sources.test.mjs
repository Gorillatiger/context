import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailView} from '../dist/mail.js';
import {createMailAccounts} from '../dist/mail-accounts.js';

const INBOX='SU5CT1g',OTHER='U2VudA',VALIDITY='111';
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const header=(uid)=>({uid:String(uid),subject:'Synthetic header '+uid,sender:'Synthetic sender',from:[{name:'Synthetic sender',address:'synthetic@example.org'}],date:'2026-10-13T10:00:00Z',unread:true,password:'HEADER_PRIVATE_FIELD',attachments:[{name:'PRIVATE_HEADER_ATTACHMENT'}]});
const list=folder=>({folder,uidValidity:VALIDITY,total:40,matched:40,nextOffset:null,items:Array.from({length:40},(_,i)=>header((folder===INBOX?100:200)+i))});
const message=(uid,patch={})=>({...header(uid),uidValidity:VALIDITY,text:'Opened synthetic body '+uid,attachments:[{part:'2',name:'PRIVATE_MESSAGE_ATTACHMENT',data:'PRIVATE_ATTACHMENT_BYTES'}],password:'MESSAGE_PRIVATE_FIELD',...patch});
function globalValue(t,key,value){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];});}
function fixture(t,{hook,service='th'}={}){
  const handlers=new Map(),calls=[],focused=[],windowHandlers=new Map();
  const document={activeElement:null,addEventListener:(type,fn)=>handlers.set(type,[...(handlers.get(type)||[]),fn]),getElementById:id=>({focus:()=>focused.push(id)})};
  globalValue(t,'document',document);globalValue(t,'window',{addEventListener:(type,fn)=>windowHandlers.set(type,[...(windowHandlers.get(type)||[]),fn])});
  globalValue(t,'fetch',async()=>{throw Error('Real network forbidden');});
  const request=async(action,body)=>{
    calls.push(structuredClone({action,body}));const value=hook?.(action,body);if(value!==undefined)return value;
    if(action==='status')return {configured:true,address:'synthetic@smail.th-koeln.de',accountKey:service==='th'?'':'OPAQUE_CLOUD_ACCOUNT',smtpReady:true,capabilities:{mailRead:true,mailSend:true},token:'ACCOUNT_TOKEN_NOT_PROJECTED'};
    if(action==='folders')return {folders:[{id:INBOX,label:'Inbox',kind:'inbox'},{id:OTHER,label:'Other',kind:'sent'}]};
    if(action==='list')return list(body.folder);
    if(action==='message')return message(body.uid);
    if(action==='connection')return {configured:false};
    throw Error('Unexpected synthetic mail operation '+action);
  };
  const view=createMailView({service,request,onChange(){},onConnection(){}});
  const dispatch=(type,target)=>{for(const handler of handlers.get(type)||[])handler({target,preventDefault(){}});};
  const click=(action,id)=>{const target={dataset:{mailAction:action,id},closest:selector=>selector==='[data-mail-action]'?target:null};dispatch('click',target);};
  const input=(field,value)=>dispatch('input',{id:'mail-'+field,dataset:{mailField:field},value});
  return {view,calls,click,input,focused,dispatch};
}

test('actual mail projection contains only forty loaded headers and one explicitly opened body without getter requests',async t=>{
  const f=fixture(t);assert.deepEqual(f.view.searchSources(),[]);await f.view.load();
  const loaded=f.calls.length,headers=f.view.searchSources();assert.equal(headers.length,40);assert.ok(headers.every(i=>i.status==='metadata'&&!i.text.includes('Opened synthetic body')));assert.equal(f.calls.length,loaded);
  await f.view.open({folder:INBOX,uidValidity:VALIDITY,uid:'100'});const before=f.calls.length,found=f.view.searchSources();
  assert.equal(found.filter(i=>i.status==='full').length,1);assert.match(found.find(i=>i.target.uid==='100').text,/Opened synthetic body 100/);assert.equal(f.calls.length,before);f.view.searchSources();assert.equal(f.calls.length,before);
  assert.doesNotMatch(JSON.stringify(found),/ACCOUNT_TOKEN_NOT_PROJECTED|HEADER_PRIVATE_FIELD|MESSAGE_PRIVATE_FIELD|PRIVATE_(?:HEADER|MESSAGE)_ATTACHMENT|PRIVATE_ATTACHMENT_BYTES/);
  assert.deepEqual(found[0].target,{service:'th',folder:INBOX,uid:'100',uidValidity:VALIDITY});
});

test('composer recipients, body and attachment bytes never enter the loaded-mail projection',async t=>{
  const f=fixture(t);await f.view.load();await f.view.open({folder:INBOX,uidValidity:VALIDITY,uid:'100'});f.click('compose');
  for(const field of ['to','cc','bcc','subject','text'])f.input(field,'UNSENT_PRIVATE_'+field);
  f.dispatch('change',{id:'mail-files',value:'file',files:[{name:'UNSENT_PRIVATE_FILE',size:3,arrayBuffer:async()=>new Uint8Array([65,66,67]).buffer}]});await settle();
  const before=f.calls.length,projected=f.view.searchSources();assert.equal(projected.length,40);assert.doesNotMatch(JSON.stringify(projected),/UNSENT_PRIVATE_|QUJD|attachments|password|token/);assert.equal(f.calls.length,before);
});

test('switching folders suppresses the old list while the replacement is pending, then publishes only the new folder',async t=>{
  const waiting=deferred(),f=fixture(t,{hook:(action,body)=>action==='list'&&body.folder===OTHER?waiting.promise:undefined});await f.view.load();
  f.click('folder',OTHER);assert.deepEqual(f.view.searchSources(),[],'old Inbox headers must not acquire the pending Other-folder target');
  waiting.resolve(list(OTHER));await settle();const found=f.view.searchSources();assert.equal(found.length,40);assert.ok(found.every(i=>i.target.folder===OTHER&&Number(i.target.uid)>=200));assert.ok(!found.some(i=>i.text.includes('Opened synthetic body')));
});

test('disconnect immediately withdraws loaded search sources and rejects an accepted stale body response',async t=>{
  const body=deferred(),disconnect=deferred(),f=fixture(t,{hook:(action)=>action==='message'?body.promise:action==='connection'?disconnect.promise:undefined});await f.view.load();
  const opening=f.view.open({folder:INBOX,uidValidity:VALIDITY,uid:'100'});await settle();f.click('disconnect');assert.deepEqual(f.view.searchSources(),[]);
  body.resolve(message('100',{text:'LATE_BODY_AFTER_DISCONNECT'}));disconnect.resolve({configured:false});await opening;await settle();assert.deepEqual(f.view.searchSources(),[]);assert.doesNotMatch(JSON.stringify(f.view.searchSources()),/LATE_BODY/);
});

test('a deferred old message cannot appear under the newer selected mail target',async t=>{
  const first=deferred(),second=deferred(),f=fixture(t,{hook:(action,body)=>action==='message'?(body.uid==='100'?first.promise:second.promise):undefined});await f.view.load();
  f.click('open','100');f.click('open','101');second.resolve(message('101',{text:'CURRENT_SELECTED_BODY'}));await settle();first.resolve(message('100',{text:'STALE_PREVIOUS_BODY'}));await settle();
  const found=f.view.searchSources();assert.match(found.find(i=>i.target.uid==='101').text,/CURRENT_SELECTED_BODY/);assert.doesNotMatch(JSON.stringify(found),/STALE_PREVIOUS_BODY/);assert.equal(found.find(i=>i.target.uid==='100').status,'metadata');
});

test('a mismatched message UID cannot be projected into the requested header merely because it is selected',async t=>{
  const f=fixture(t,{hook:action=>action==='message'?message('999',{text:'WRONG_TARGET_BODY'}):undefined});await f.view.load();f.click('open','100');await settle();
  const found=f.view.searchSources();assert.doesNotMatch(JSON.stringify(found),/WRONG_TARGET_BODY/);assert.equal(found.find(i=>i.target.uid==='100').status,'metadata');
});

test('cloud account change invalidates all old projected bodies and publishes the new binding only after reload',async t=>{
  let generation=1;const reload=deferred();const f=fixture(t,{service:'outlook',hook:(action,body)=>action==='status'?{configured:true,address:'synthetic@example.org',accountKey:'account-'+generation,capabilities:{mailRead:true},smtpReady:false}:action==='list'&&generation===2?reload.promise:undefined});
  await f.view.load();f.click('open','100');await settle();assert.match(JSON.stringify(f.view.searchSources()),/Opened synthetic body/);
  generation=2;const pending=f.view.refreshConnection();await settle();assert.deepEqual(f.view.searchSources(),[]);reload.resolve(list(INBOX));await pending;assert.ok(f.view.searchSources().every(i=>i.status==='metadata'));assert.doesNotMatch(JSON.stringify(f.view.searchSources()),/Opened synthetic body/);
});

test('mail-account aggregation reads each loaded view projection without loading or opening another account',()=>{
  const created=[],operations=[];
  const accounts=createMailAccounts({onChange(){},onConnection(){},createView:options=>{created.push(options.service);return {render:()=>'',load:()=>operations.push('load'),open:()=>operations.push('open'),searchSources:()=>options.service==='gmail'?[{service:'gmail',title:'Already loaded synthetic Gmail header'}]:[]};}});
  assert.deepEqual(created,['th','outlook','gmail']);assert.deepEqual(accounts.searchSources(),[{service:'gmail',title:'Already loaded synthetic Gmail header'}]);assert.deepEqual(operations,[]);assert.equal(accounts.active(),'th');
});
