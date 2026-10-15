import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import * as files from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createCipheriv,createDecipheriv,randomBytes,webcrypto} from 'node:crypto';
import {createContext,runInContext,runInNewContext} from 'node:vm';
import {CHAT_FILTER_CSS,chatFilterScript,createDesktopChatFilter,namedChatId,parseChatFilterSnapshot,whatsappFilterURL} from '../desktop/chat-filter.mjs';
import {hubURL} from '../desktop/policy.mjs';

function domFixture(t,{titles=['CoCo Team','Private Familie','Projektgruppe'],ids=[],origin='https://web.whatsapp.com'}={}){
 const clicks=[],observers=[],listeners=new Map();let digestHook,timerCalls=0;
 class Element{
  constructor(tag='div',attrs={}){this.tagName=tag;this.attrs=new Map(Object.entries(attrs));this.children=[];this.parentElement=null;this.style={};this.connected=false;this.events=new Map();this.text='';}
  get isConnected(){return this.connected;}
  getAttribute(key){return this.attrs.get(key)??null;}
  setAttribute(key,value){this.attrs.set(key,String(value));}
  set textContent(value){this.text=value;}
  get textContent(){throw new Error('Message/body text must not be read');}
  append(...children){for(const child of children){child.parentElement=this;child.connected=this.connected;this.children.push(child);}}
  replaceChildren(...children){for(const child of this.children){child.connected=false;child.parentElement=null;}this.children=[];this.append(...children);}
  remove(){this.connected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}
  contains(node){for(let current=node;current;current=current.parentElement)if(current===this)return true;return false;}
  closest(selector){for(let current=this;current;current=current.parentElement){if(selector.includes('[role=')&&['row','listitem'].includes(current.getAttribute('role')))return current;if(selector==='[data-chat-id]'&&current.getAttribute('data-chat-id'))return current;}return null;}
  querySelector(){return this.nameNode||null;}
  querySelectorAll(){return this.children.filter(node=>['row','listitem'].includes(node.getAttribute('role')));}
  getBoundingClientRect(){return {left:10,top:130,width:400,height:700};}
  addEventListener(type,callback){this.events.set(type,callback);}
  click(){if(this.parentElement?.getAttribute('role')==='row')clicks.push(this.parentElement.nameNode.getAttribute('title'));return this.events.get('click')?.();}
 }
 const head=new Element('head'),body=new Element('body'),pane=new Element('div',{id:'pane-side'});head.connected=body.connected=true;body.append(pane);
 const rows=titles.map((title,index)=>{const row=new Element('div',{role:'row',...(ids[index]?{'data-id':ids[index]}:{})}),name=new Element('span',{title,dir:'auto'});row.nameNode=name;row.append(name);pane.append(row);name.connected=true;return row;});
 const document={head,body,querySelector:selector=>selector==='#pane-side'?pane:null,createElement:tag=>new Element(tag),addEventListener:(type,callback)=>listeners.set('document:'+type,callback),removeEventListener:type=>listeners.delete('document:'+type)};
 const window={addEventListener:(type,callback)=>listeners.set('window:'+type,callback),removeEventListener:type=>listeners.delete('window:'+type)};
 class Observer{constructor(callback){this.callback=callback;this.disconnected=false;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}trigger(){if(!this.disconnected)this.callback();}}
 const crypto={subtle:{digest:async(...args)=>{digestHook?.();return webcrypto.subtle.digest(...args);}}};
 const sandbox=createContext({document,window,location:{origin},crypto,TextEncoder,MutationObserver:Observer,ResizeObserver:Observer,setTimeout:(...args)=>{timerCalls++;return setTimeout(...args);},clearTimeout});
 const execute=command=>runInContext(chatFilterScript(command),sandbox);
 t.after(()=>execute({op:'cleanup'}));
 return {execute,sandbox,document,pane,rows,clicks,observers,listeners,timerCalls:()=>timerCalls,setDigestHook:callback=>digestHook=callback,overlay:()=>body.children.find(child=>child.className==='context-coco-chat-focus')};
}
function cryptor(){
 const key=randomBytes(32),plaintext=[];return {plaintext,
  isAsyncEncryptionAvailable:async()=>true,
  async encryptStringAsync(text){plaintext.push(text);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);},
  async decryptStringAsync(data){const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));return {result:Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8')};}
 };
}
async function fixture(t,options={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'context-chat-filter-')),dom=domFixture(t,options),crypto=options.crypto||cryptor(),events=[],calls=[];
 const inserted=new Set();let nextCSS=0;
 const webContents={isDestroyed:()=>false,insertCSS:async(css,options)=>{assert.equal(css,CHAT_FILTER_CSS);assert.equal(options.cssOrigin,'user');const key=String(++nextCSS);inserted.add(key);return key;},removeInsertedCSS:async key=>inserted.delete(key),executeJavaScriptInIsolatedWorld:async(world,scripts)=>{assert.equal(world,1002);calls.push(scripts[0].code);return runInContext(scripts[0].code,dom.sandbox);}};
 let active={id:'1',epoch:1,url:'https://web.whatsapp.com/',webContents};
 const filter=createDesktopChatFilter({directory,crypto,getActive:()=>active,emit:event=>events.push(event),platform:options.platform||'darwin',fs:options.fs||files});
 t.after(async()=>{await filter.dispose();await rm(directory,{recursive:true,force:true});});
 return {filter,dom,crypto,directory,events,calls,inserted,setActive:context=>active=context,getActive:()=>active};
}

test('WhatsApp focus is restricted to the exact HTTPS origin',()=>{
 for(const url of ['https://web.whatsapp.com/','https://web.whatsapp.com/?app=desktop'])assert.equal(whatsappFilterURL(url),true);
 for(const url of ['http://web.whatsapp.com/','https://web.whatsapp.com.evil.test/','https://whatsapp.com/','https://web.whatsapp.com:444/','https://x:y@web.whatsapp.com/','file:///web.whatsapp.com','not a URL'])assert.equal(whatsappFilterURL(url),false);
});
test('discovery reads only chat title attributes, prefers DOM IDs and marks name matching honestly',async t=>{
 const f=domFixture(t,{titles:['CoCo Team','Privat'],ids:['123456789012345@g.us']});
 const result=await f.execute({op:'discover'});
 assert.equal(result.chats[0].id,'dom:123456789012345@g.us');assert.equal(result.chats[0].identity,'dom');
 assert.equal(result.chats[1].id,namedChatId('Privat'));assert.equal(result.chats[1].identity,'name');assert.equal(result.named,1);
 assert.equal(f.overlay(),undefined);assert.equal(f.clicks.length,0);
 assert.equal(namedChatId('  CoCo  Team '),namedChatId('coco team'));
});
test('compact overlay leaves original rows unchanged and recycled rows cannot open a stale chat',async t=>{
 const f=domFixture(t),entry={id:namedChatId('CoCo Team'),title:'CoCo Team'};
 const original=f.rows.map(row=>[...row.attrs]);
 await f.execute({op:'configure',enabled:true,selected:[entry]});
 const overlay=f.overlay();assert(overlay);const list=overlay.children[2];assert.equal(list.children.length,1);assert.equal(list.children[0].text,'CoCo Team');
 assert.deepEqual(f.rows.map(row=>[...row.attrs]),original);assert(f.rows.every(row=>Object.keys(row.style).length===0));assert.equal(f.pane.children.length,3);
 await list.children[0].click();assert.deepEqual(f.clicks,['CoCo Team']);
 f.rows[0].nameNode.setAttribute('title','Anderer privater Chat');
 await list.children[0].click();assert.equal(f.clicks.length,1);assert.match(overlay.children[3].text,/WhatsApp-Suche/);
 await f.execute({op:'cleanup'});assert.equal(f.overlay(),undefined);assert(f.observers.every(observer=>observer.disconnected));assert.equal(f.listeners.size,0);
});
test('duplicate title fallback is grouped and cannot arbitrarily open one of two different chats',async t=>{
 const f=domFixture(t,{titles:['CoCo','CoCo']});
 const result=await f.execute({op:'discover'});assert.equal(result.chats.length,1);assert.equal(result.duplicates,1);
 assert.equal((await f.execute({op:'open',id:namedChatId('CoCo')})).opened,false);assert.equal(f.clicks.length,0);
});
test('row recycling during asynchronous discovery is rechecked immediately before a chat click',async t=>{
 const f=domFixture(t,{titles:['CoCo Team']});
 f.setDigestHook(()=>f.rows[0].nameNode.setAttribute('title','Privater Chat'));
 const result=await f.execute({op:'open',id:namedChatId('CoCo Team')});
 assert.equal(result.opened,false);assert.equal(f.clicks.length,0);
});
test('mutations are throttled, update stable-ID names and leave host row geometry untouched',async t=>{
 const f=domFixture(t,{titles:['CoCo'],ids:['123456789012345@g.us']});
 await f.execute({op:'configure',enabled:true,selected:[{id:'dom:123456789012345@g.us',title:'CoCo'}]});
 f.rows[0].nameNode.setAttribute('title','CoCo Neuer Name');
 for(let i=0;i<20;i++)f.observers[0].trigger();assert.equal(f.timerCalls(),1);
 await new Promise(resolve=>setTimeout(resolve,160));
 assert.equal(f.overlay().children[2].children[0].text,'CoCo Neuer Name');assert.deepEqual(f.rows[0].style,{});
 f.observers[0].trigger();await f.execute({op:'cleanup'});const before=f.timerCalls();f.observers[0].trigger();assert.equal(f.timerCalls(),before);assert.equal(f.overlay(),undefined);
});
test('focus selection is encrypted separately; picker is transient and restores the original list',async t=>{
 const f=await fixture(t);const discovered=await f.filter.handle({op:'discover'});assert.equal(discovered.supported,true);assert.equal(discovered.chats.length,3);assert.match(discovered.warning,/Chatnamen/);
 const selected=[discovered.chats[0]];const focused=await f.filter.handle({op:'set',enabled:true,selected});assert.equal(focused.storage,'encrypted');assert(f.dom.overlay());
 const data=await readFile(path.join(f.directory,'whatsapp-focus.enc'));assert.equal(data.includes(Buffer.from('CoCo')),false);assert.deepEqual(await readdir(f.directory),['whatsapp-focus.enc']);
 const saved=parseChatFilterSnapshot((await f.crypto.decryptStringAsync(data)).result);assert.equal(saved.enabled,true);assert.equal(saved.selected.length,1);assert.equal(saved.selected[0].title,'CoCo Team');
 assert(f.crypto.plaintext.every(text=>!text.includes('Private Familie')));
 const opened=await f.filter.handle({op:'picker',open:true});assert.equal(opened.pickerOpen,true);assert.equal(f.dom.overlay(),undefined);assert.equal(f.inserted.size,0);
 const closed=await f.filter.handle({op:'picker',open:false});assert.equal(closed.pickerOpen,false);assert(f.dom.overlay());
 assert.deepEqual(await readFile(path.join(f.directory,'whatsapp-focus.enc')),data);
 await f.filter.handle({op:'set',enabled:false});assert.equal(f.dom.overlay(),undefined);assert.equal(f.inserted.size,0);
});
test('changing active tab or origin restores the previous overlay and omits chat metadata elsewhere',async t=>{
 const f=await fixture(t);const found=await f.filter.handle({op:'discover'});await f.filter.handle({op:'set',enabled:true,selected:[found.chats[0]]});
 f.setActive({...f.getActive(),id:'2',url:'https://example.org/'});const result=await f.filter.handle({op:'status'});
 assert.equal(result.supported,false);assert.equal(result.enabled,false);assert.deepEqual(result.selected,[]);assert.deepEqual(result.chats,[]);assert.equal(f.dom.overlay(),undefined);
 await assert.rejects(f.filter.handle({op:'discover'}),{code:'CHAT_NOT_SUPPORTED'});
});
test('a tab change while discovery is pending cannot publish the previous tab metadata',async t=>{
 const f=await fixture(t);let release,entered;const gate=new Promise(resolve=>release=resolve),atExecution=new Promise(resolve=>entered=resolve),original=f.getActive().webContents.executeJavaScriptInIsolatedWorld;
 f.getActive().webContents.executeJavaScriptInIsolatedWorld=async(...args)=>{const result=await original(...args);entered();await gate;return result;};
 const pending=f.filter.handle({op:'discover'});await atExecution;
 f.setActive({...f.getActive(),id:'2',epoch:2});release();const result=await pending;
 assert.deepEqual(result.chats,[]);assert.equal(result.ready,false);assert.match(result.warning,/Tab/);
});
test('a later startup restores only the explicitly selected encrypted names',async t=>{
 const f=await fixture(t);const found=await f.filter.handle({op:'discover'});await f.filter.handle({op:'set',enabled:true,selected:[found.chats[0]]});await f.filter.dispose();
 const restarted=createDesktopChatFilter({directory:f.directory,crypto:f.crypto,getActive:f.getActive,platform:'darwin'});t.after(()=>restarted.dispose());
 const result=await restarted.handle({op:'status'});assert.equal(result.enabled,true);assert.equal(result.storage,'encrypted');assert.equal(result.selected.length,1);assert.equal(result.selected[0].title,'CoCo Team');assert(f.dom.overlay());
});
test('dispose drains an immediately preceding accepted write before removing overlay and CSS',async t=>{
 const f=await fixture(t),found=await f.filter.handle({op:'discover'});
 await f.filter.handle({op:'set',enabled:true,selected:[found.chats[0]]});
 let release,entered,disposed=false;const gate=new Promise(resolve=>release=resolve),atEncryption=new Promise(resolve=>entered=resolve),encrypt=f.crypto.encryptStringAsync;
 f.crypto.encryptStringAsync=async text=>{entered();await gate;return encrypt.call(f.crypto,text);};
 const pending=f.filter.handle({op:'set',enabled:false});
 const quitting=f.filter.dispose().then(()=>{disposed=true;});
 try{
  await atEncryption;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(disposed,false,'dispose must wait for the accepted encrypted write');
 }finally{release();await Promise.all([pending,quitting]);}
 const data=await readFile(path.join(f.directory,'whatsapp-focus.enc')),saved=parseChatFilterSnapshot((await f.crypto.decryptStringAsync(data)).result);
 assert.equal(saved.enabled,false);assert.equal(saved.selected[0].id,found.chats[0].id);
 assert.deepEqual(await readdir(f.directory),['whatsapp-focus.enc']);assert.equal(data.includes(Buffer.from('CoCo')),false);
 assert.equal(f.dom.overlay(),undefined);assert.equal(f.inserted.size,0);assert.equal(f.dom.listeners.size,0);assert(f.dom.observers.every(observer=>observer.disconnected));
});
test('IPC received after dispose is rejected without encryption, writes or DOM work',async t=>{
 const f=await fixture(t),found=await f.filter.handle({op:'discover'});
 await f.filter.handle({op:'set',enabled:true,selected:[found.chats[0]]});await f.filter.dispose();
 const data=await readFile(path.join(f.directory,'whatsapp-focus.enc')),encrypted=f.crypto.plaintext.length,calls=f.calls.length;
 for(const message of [{op:'status'},{op:'discover'},{op:'set',enabled:false},{op:'picker',open:true},{op:'open',id:found.chats[0].id}])await assert.rejects(f.filter.handle(message),{code:'CHAT_FILTER_CLOSED'});
 f.filter.schedule();await f.filter.flush();
 assert.equal(f.crypto.plaintext.length,encrypted);assert.equal(f.calls.length,calls);assert.deepEqual(await readFile(path.join(f.directory,'whatsapp-focus.enc')),data);
 assert.deepEqual(await readdir(f.directory),['whatsapp-focus.enc']);assert.equal(f.dom.overlay(),undefined);assert.equal(f.inserted.size,0);
});
test('native requests reject unobserved chats, invalid IDs and arbitrary paths/operations',async t=>{
 const f=await fixture(t);
 for(const value of [{op:'execute',code:'alert(1)'},{op:'picker',open:'yes'},{op:'status',path:'/etc/passwd'},{op:'set',enabled:'yes'},null])await assert.rejects(f.filter.handle(value),{code:'BAD_CHAT_REQUEST'});
 await assert.rejects(f.filter.handle({op:'set',selected:[{id:'name:invalid',title:'CoCo'}]}),{code:'BAD_CHAT_SELECTION'});
 await assert.rejects(f.filter.handle({op:'open',id:namedChatId('CoCo Team')}),{code:'BAD_CHAT_SELECTION'});
 assert.equal(f.dom.clicks.length,0);assert.deepEqual(await readdir(f.directory),[]);
});
test('unavailable encryption keeps a working session filter without writing plaintext',async t=>{
 const f=await fixture(t,{crypto:{isAsyncEncryptionAvailable:async()=>false,encryptStringAsync:async()=>{throw new Error('must not encrypt');}}});
 const found=await f.filter.handle({op:'discover'});const result=await f.filter.handle({op:'set',enabled:true,selected:[found.chats[0]]});
 assert.equal(result.storage,'session');assert.match(result.warning,/Sitzung/);assert(f.dom.overlay());assert.deepEqual(await readdir(f.directory),[]);
});
test('encrypted write failure removes temporary files, keeps session focus and allows a later retry',async t=>{
 let broken=true;const fs={...files,rename:async(...args)=>{if(broken)throw new Error('disk path');return files.rename(...args);}};
 const f=await fixture(t,{fs});const found=await f.filter.handle({op:'discover'});
 const first=await f.filter.handle({op:'set',enabled:true,selected:[found.chats[0]]});assert.equal(first.storage,'session');assert.deepEqual(await readdir(f.directory),[]);assert(f.dom.overlay());
 broken=false;const second=await f.filter.handle({op:'set',enabled:true});assert.equal(second.storage,'encrypted');assert.deepEqual(await readdir(f.directory),['whatsapp-focus.enc']);
});
test('stored selection is bounded and invalid or duplicate records are rejected',()=>{
 const selected=[{id:namedChatId('CoCo'),title:'CoCo'}];assert.equal(parseChatFilterSnapshot(JSON.stringify({version:1,enabled:true,selected})).selected[0].identity,'name');
 for(const data of [{version:2,enabled:true,selected},{version:1,enabled:'yes',selected},{version:1,enabled:true,selected:[...selected,...selected]},{version:1,enabled:true,selected:[{id:namedChatId('Other'),title:'CoCo'}]},{version:1,enabled:true,selected,path:'/tmp'}])assert.throws(()=>parseChatFilterSnapshot(JSON.stringify(data)));
 assert.throws(()=>parseChatFilterSnapshot(' '.repeat(65537)));
});
test('the bridge retains the trusted main-frame guard and DOM script contains no messages, storage or network access',async()=>{
 const main=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8'),preload=await readFile(new URL('../desktop/preload.cjs',import.meta.url),'utf8');
 assert.match(preload,/chatFilter:message=>ipcRenderer\.invoke\('context:chat-filter',message\)/);assert.match(main,/\['chat-filter',desktopChatFilter\.handle\]/);
 const expression=main.match(/const trusted=([\s\S]*?);\nfunction state/)[1],frame={url:'http://127.0.0.1:4318/'},webContents={mainFrame:frame},win={webContents};
 const trusted=runInNewContext('('+expression+')',{win,hubURL});assert.doesNotThrow(()=>trusted({sender:webContents,senderFrame:frame}));
 for(const event of [{sender:{},senderFrame:frame},{sender:webContents,senderFrame:{url:frame.url}}])assert.throws(()=>trusted(event),/Zugriff/);
 const script=chatFilterScript({op:'discover'});assert.doesNotMatch(script,/fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|\.innerHTML|\.textContent\s*[;)]|\.src\b|window\.Store|__react|display\s*:\s*none|visibility\s*:\s*hidden/);
 assert.match(script,/document\.querySelector\('#pane-side'\)/);assert.match(script,/getAttribute\('title'\)/);
});

test('a chat can be added by its name even if WhatsApp has not rendered it; foreign ids still need discovery',async t=>{
 const f=await fixture(t);
 const added=await f.filter.handle({op:'set',enabled:true,selected:[{id:namedChatId('Users and Situated Action'),title:'Users and Situated Action'}]});
 assert.deepEqual(added.selected.map(row=>[row.title,row.identity]),[['Users and Situated Action','name']]);
 await assert.rejects(f.filter.handle({op:'set',selected:[{id:'dom:491234567890@g.us',title:'Nie gesehen'}]}),{code:'CHAT_NOT_DISCOVERED'});
});

test('the assistant may read only chats that are selected and explicitly released, and the release is stored',async t=>{
 const f=await fixture(t);const found=await f.filter.handle({op:'discover'}),chat=found.chats[0];
 await assert.rejects(f.filter.handle({op:'read',id:chat.id}),{code:'ASSISTANT_NOT_ALLOWED'});
 await f.filter.handle({op:'set',enabled:true,selected:[chat]});
 await assert.rejects(f.filter.handle({op:'read',id:chat.id}),{code:'ASSISTANT_NOT_ALLOWED'},'selected alone is not a release');
 assert.equal((await f.filter.handle({op:'assistant',enabled:true})).assistant,true);
 await assert.rejects(f.filter.handle({op:'read',id:namedChatId('Private Familie')}),{code:'BAD_CHAT_SELECTION'},'unselected chats stay closed');
 for(const bad of [{op:'assistant'},{op:'assistant',enabled:'yes'},{op:'read'},{op:'read',id:7},{op:'read',id:chat.id,limit:5},{op:'discover',sweep:'yes'}])await assert.rejects(f.filter.handle(bad),{code:'BAD_CHAT_REQUEST'},JSON.stringify(bad));
 await f.filter.flush();
 assert.equal(parseChatFilterSnapshot(JSON.stringify({version:1,enabled:true,selected:[{id:chat.id,title:chat.title}],assistant:true})).assistant,true);
 assert.equal(parseChatFilterSnapshot(JSON.stringify({version:1,enabled:true,selected:[]})).assistant,false);
 assert.throws(()=>parseChatFilterSnapshot(JSON.stringify({version:1,enabled:true,selected:[],assistant:'yes'})),{code:'BAD_CHAT_STORE'});
 assert.equal((await f.filter.handle({op:'assistant',enabled:false})).assistant,false);
});
