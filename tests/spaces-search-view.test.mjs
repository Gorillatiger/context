import test from 'node:test';
import assert from 'node:assert/strict';
import {createSearchView} from '../dist/search-view.js';

// Synthetic, app-owned DOM only. No Electron, browser, provider or profile IO.
const decode=value=>String(value).replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[key]);
const attrs=value=>Object.fromEntries([...value.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g)].map(m=>[m[1],decode(m[2]??m[3]??m[4]??'')]));
class Node{
  constructor(tag,attributes={},doc){this.tagName=tag.toUpperCase();this.attributes=attributes;this.ownerDocument=doc;this.children=[];this.dataset=Object.fromEntries(Object.entries(attributes).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v]));this.value=attributes.value||'';this.checked='checked' in attributes;this.disabled='disabled' in attributes;this.hidden='hidden' in attributes;this.listeners=new Map();this.classList={add:name=>this.attributes.class=[this.attributes.class,name].filter(Boolean).join(' ')};}
  get id(){return this.attributes.id||'';}
  get isConnected(){return this===this.ownerDocument?.body||!!this.parent?.isConnected;}
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return this.attributes[key]??null;}
  contains(node){return node===this||this.children.some(c=>c.contains(node));}
  matches(selector){return selector.split(',').some(s=>{s=s.trim();return s.startsWith('#')?this.id===s.slice(1):s.startsWith('.')?(this.attributes.class||'').split(' ').includes(s.slice(1)):s.startsWith('[')?Object.hasOwn(this.attributes,s.slice(1,-1)):this.tagName===s.toUpperCase();});}
  closest(selector){return this.matches(selector)?this:this.parent?.closest(selector)||null;}
  querySelectorAll(selector){const found=[];for(const child of this.children){if(child.matches(selector))found.push(child);found.push(...child.querySelectorAll(selector));}return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  set textContent(value){this._text=String(value);this.children=[];this._html='';}
  get textContent(){return (this._text||'')+this.children.map(c=>c.textContent).join('');}
  set innerHTML(value){
    if(this.children.some(c=>c.contains(this.ownerDocument.activeElement)))this.ownerDocument.activeElement=this.ownerDocument.body;
    this.children=[];this._text='';this._html=value;const stack=[this];
    for(const token of value.match(/<\/?[a-zA-Z][^>]*>|[^<]+/g)||[]){
      if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}
      if(token.startsWith('<')){const match=token.match(/^<([\w-]+)\b([^>]*)>/),node=new Node(match[1],attrs(match[2]),this.ownerDocument);node.parent=stack.at(-1);node.parent.children.push(node);if(!token.endsWith('/>')&&!['INPUT','PATH','CIRCLE','RECT','BR','HR'].includes(node.tagName))stack.push(node);}
      else stack.at(-1)._text=(stack.at(-1)._text||'')+decode(token);
    }
  }
  get innerHTML(){return this._html||'';}
  focus(){this.ownerDocument.activeElement=this;}
  scrollIntoView(){}
  addEventListener(name,handler){this.listeners.set(name,[...(this.listeners.get(name)||[]),handler]);}
  removeEventListener(name,handler){this.listeners.set(name,(this.listeners.get(name)||[]).filter(h=>h!==handler));}
  dispatch(name,event={}){const e={target:this,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...event};for(const handler of this.listeners.get(name)||[])handler(e);return e;}
  showModal(){this.open=true;}
  close(){this.open=false;this.dispatch('close');}
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
const project=(id,extra={})=>({id,name:'Kurs '+id,links:[{tool:'spaces',url:'https://spaces.th-koeln.de/'+id+'/'}],...extra});
const item=(id,extra={})=>({id,title:'Beitrag '+id,text:'Ein tatsächlich gefundener Titel.',source:'spaces',kind:'browser',projectId:'alpha',url:'https://spaces.th-koeln.de/alpha/post-'+encodeURIComponent(id)+'/',updatedAt:'2026-10-14T12:00:00Z',status:'metadata',...extra});
const reply=(request,extra={})=>({items:[item(request.query||'initial')],page:request.page,hasMore:false,scope:'published',courses:[{id:'alpha',status:'ok',total:1,totalPages:1},{id:'beta',status:'ok',total:0,totalPages:0}],warnings:[],...extra});
function fixture(t,{search=request=>reply(request),openLive,localDocuments,onRefreshSources}={}){
  t.mock.timers.enable({apis:['setTimeout']});
  const doc={};doc.body=new Node('body',{},doc);const opener=new Node('button',{id:'opener'},doc);opener.parent=doc.body;doc.body.children.push(opener);doc.activeElement=opener;
  const dialog=new Node('dialog',{},doc);dialog.parent=doc.body;doc.body.children.push(dialog);
  const context={workspace:{projects:[project('alpha'),project('beta'),project('archived',{archived:true}),project('unlinked',{links:[]})]}};
  const calls={live:[],open:[],localOpen:[],clients:0,get:0,replace:0,search:0,persist:[],close:0,dispose:0};let notify,local=[];
  const client={stats:()=>({documents:local.length,lastSearch:{totalMatches:local.length},persistence:{enabled:false,state:'off'}}),replace:async docs=>{calls.replace++;local=docs;return client.stats();},search:async()=>{calls.search++;return local;},optPersist:async value=>{calls.persist.push(value);return client.stats();},dispose:()=>calls.dispose++};
  const view=createSearchView({dialog,getContext:()=>context,getDocuments:()=>{calls.get++;return localDocuments?localDocuments():{documents:[{id:'local',title:'Lokale Notiz',text:'Lokaler Text',kind:'notes',source:'context',projectId:'alpha'}]};},onOpen:value=>calls.localOpen.push(value),onLiveSearch:request=>{calls.live.push(request);return search(request);},onOpenLive:async value=>{calls.open.push(value);if(openLive)await openLive(value);},onRefreshSources,onClose:()=>calls.close++,clientFactory:options=>{calls.clients++;notify=options.onStatus;return client;}});
  t.after(()=>view.dispose());
  const node=id=>dialog.querySelector('#'+id),event=(type,target,extra={})=>dialog.dispatch(type,{target,...extra});
  return {view,doc,dialog,calls,context,node,event,emit:value=>notify?.(value),async advance(ms=0){t.mock.timers.tick(ms);await tick();},async open(options){await view.open(options);await tick();},input(value){node('context-search-input').value=value;event('input',node('context-search-input'));},click(id){event('click',node(id));},choose(id,value){node(id).value=value;event('change',node(id));}};
}

test('Spaces is the default without constructing, restoring or refreshing a local index',async t=>{
  const f=fixture(t,{localDocuments:()=>{throw new Error('Local data must not be read');}});await f.open();await f.advance(1000);
  assert.equal(f.node('context-search-mode-spaces').getAttribute('aria-pressed'),'true');
  assert.equal(f.node('context-search-mode-local').getAttribute('aria-pressed'),'false');
  assert.equal(f.calls.clients,0);assert.equal(f.calls.get,0);assert.equal(f.calls.live.length,0);
  assert.equal(f.node('context-search-local-storage').hidden,true);assert.equal(f.node('context-search-persist').disabled,true);
  assert.equal(f.node('context-search-source').disabled,true);assert.equal(f.node('context-search-kind').disabled,true);
  assert.match(f.node('context-search-course').innerHTML,/Kurs alpha|Kurs beta/);
  assert.doesNotMatch(f.node('context-search-course').innerHTML,/archived|unlinked/);
  assert.match(f.node('context-search-scope').textContent,/Suchbegriff wird direkt an TH-Spaces gesendet/);
  assert.doesNotMatch(f.node('context-search-scope').textContent,/Suchbegriffe bleiben auf diesem Gerät/);
  f.node('context-search-persist').checked=true;f.event('change',f.node('context-search-persist'));await tick();assert.deepEqual(f.calls.persist,[]);
});

test('typing waits 350ms, coalesces changes and passes the current query, course and cancellable signal only',async t=>{
  const f=fixture(t);await f.open();f.input('old');await f.advance(200);f.input('  neue Frage  ');
  await f.advance(349);assert.equal(f.calls.live.length,0);await f.advance(1);
  assert.equal(f.calls.live.length,1);const request=f.calls.live[0];assert.deepEqual(Object.keys(request).sort(),['page','projectId','query','signal']);
  assert.equal(request.query,'neue Frage');assert.equal(request.projectId,'');assert.equal(request.page,1);assert.equal(request.signal.aborted,false);
  assert.match(f.node('context-search-results').innerHTML,/Beitrag neue Frage/);assert.equal(f.calls.clients,0);
});

test('provider pages remain per-course pages and never imply a combined number of pages',async t=>{
  const f=fixture(t,{search:request=>reply(request,{items:[item('page-'+request.page)],hasMore:request.page<3,totalMatches:101})});
  await f.open({query:'Prototyp'});await f.advance(350);
  assert.equal(f.node('context-search-page').textContent,'Seite 1 je Kurs');assert.equal(f.node('context-search-next').disabled,false);
  assert.doesNotMatch(f.node('context-search-count').textContent,/101|von/);
  f.click('context-search-next');await f.advance();assert.equal(f.calls.live.at(-1).page,2);assert.equal(f.doc.activeElement.id,'context-search-result-0');
  assert.equal(f.node('context-search-page').textContent,'Seite 2 je Kurs');
  f.click('context-search-next');await f.advance();assert.equal(f.node('context-search-next').disabled,true);
  f.click('context-search-next');await f.advance();assert.equal(f.calls.live.at(-1).page,3);
  f.click('context-search-previous');await f.advance();assert.equal(f.calls.live.at(-1).page,2);
  f.choose('context-search-course','alpha');await f.advance();assert.equal(f.calls.live.at(-1).page,1);assert.equal(f.calls.live.at(-1).projectId,'alpha');
  assert.equal(f.node('context-search-page').textContent,'Seite 1');assert.match(f.node('context-search-count').textContent,/101 insgesamt/);
});

test('course access failures and absent course reports stay visible beside accepted published metadata',async t=>{
  const f=fixture(t,{search:request=>reply(request,{items:[item('one')],courses:[{id:'alpha',status:'ok',total:1},{id:'beta',status:'login_required',total:0}],warnings:['Nur veröffentlichte Inhalte.']})});
  await f.open({query:'Aufgabe'});await f.advance(350);
  const coverage=f.node('context-search-live-coverage');assert.equal(coverage.hidden,false);assert.match(coverage.textContent,/Kurs beta: Anmeldung erforderlich/);
  assert.match(f.node('context-search-results').innerHTML,/Nur Metadaten/);assert.match(f.node('context-search-scope').textContent,/Nur veröffentlichte Inhalte/);
  f.context.workspace.projects.push(project('new-course'));f.click('context-search-refresh');await f.advance();
  assert.match(coverage.textContent,/Kurs new-course: Status unbekannt/);
});

test('live rows and warnings are escaped, filtered to current courses and opened through the live callback',async t=>{
  let f;f=fixture(t,{openLive:async()=>assert.equal(f.dialog.open,false),search:request=>reply(request,{items:[
    item('safe',{title:'<img src=x onerror=alert(1)>',text:'<script>private</script>',secret:'not-forwarded'}),
    item('outside',{url:'https://evil.example/post'}),item('credentials',{url:'https://user:pass@spaces.th-koeln.de/alpha/'}),
    item('old',{projectId:'archived'}),item('other',{projectId:'beta'}),
  ],warnings:['<svg onload="bad">']})});
  await f.open({query:'Suche',projectId:'alpha'});await f.advance(350);
  const html=f.node('context-search-results').innerHTML;assert.doesNotMatch(html,/<img src=x|<script|outside|credentials|Beitrag old|Beitrag other/);
  assert.match(html,/&lt;img/);assert.match(html,/rel="noopener noreferrer"/);assert.equal(f.node('context-search-results').querySelectorAll('.context-search-original').length,1);
  assert.match(f.node('context-search-scope').innerHTML,/&lt;svg/);assert.doesNotMatch(f.node('context-search-scope').innerHTML,/<svg onload/);
  f.event('keydown',f.node('context-search-input'),{key:'ArrowDown'});assert.equal(f.doc.activeElement.id,'context-search-result-0');
  f.event('keydown',f.doc.activeElement,{key:'Enter'});await tick();assert.equal(f.calls.open.length,1);assert.equal(f.calls.localOpen.length,0);assert.equal(f.doc.activeElement.id,'opener');
  assert.equal(f.calls.open[0].status,'metadata');assert.ok(!Object.hasOwn(f.calls.open[0],'secret'));
});

test('a slow response cannot overwrite a newer query or its page controls',async t=>{
  const slow=deferred(),f=fixture(t,{search:request=>request.query==='old'?slow.promise:reply(request)});await f.open({query:'old'});await f.advance(350);
  const signal=f.calls.live[0].signal;f.input('new');assert.equal(signal.aborted,true);await f.advance(350);
  slow.resolve(reply({query:'old',page:1},{items:[item('OLD PRIVATE RESULT')],hasMore:true}));await tick();
  assert.match(f.node('context-search-results').innerHTML,/Beitrag new/);assert.doesNotMatch(f.node('context-search-results').innerHTML,/OLD PRIVATE RESULT/);
  assert.equal(f.node('context-search-next').disabled,true);
});

test('stop and close abort work and reject late success or error after a new interaction',async t=>{
  const first=deferred(),second=deferred(),f=fixture(t,{search:request=>request.query==='first'?first.promise:request.query==='second'?second.promise:reply(request)});
  await f.open({query:'first'});await f.advance(350);assert.equal(f.node('context-search-stop').hidden,false);
  f.click('context-search-stop');assert.equal(f.calls.live[0].signal.aborted,true);assert.match(f.node('context-search-count').textContent,/angehalten/);
  first.resolve(reply({query:'first',page:1},{items:[item('stale')]}));await tick();assert.doesNotMatch(f.node('context-search-results').innerHTML,/Beitrag stale/);
  f.input('second');await f.advance(350);const signal=f.calls.live.at(-1).signal;f.view.close();assert.equal(signal.aborted,true);assert.equal(f.doc.activeElement.id,'opener');
  await f.open({query:'current'});await f.advance(350);second.reject(Error('PRIVATE OLD FAILURE'));await tick();
  assert.match(f.node('context-search-results').innerHTML,/Beitrag current/);assert.equal(f.dialog.querySelector('.context-search-error').hidden,true);
});

test('switching to Local aborts Spaces, lazily initializes the old local path and cannot leak late provider rows',async t=>{
  const slow=deferred(),f=fixture(t,{search:request=>request.query==='old'?slow.promise:reply(request)});await f.open({query:'old'});await f.advance(350);
  f.click('context-search-mode-local');await tick();await f.advance();assert.equal(f.calls.live[0].signal.aborted,true);
  assert.equal(f.calls.clients,1);assert.equal(f.calls.get,1);assert.equal(f.calls.replace,1);assert.match(f.node('context-search-results').innerHTML,/Lokale Notiz/);
  assert.equal(f.node('context-search-source').disabled,false);assert.equal(f.node('context-search-local-storage').hidden,false);
  slow.resolve(reply({query:'old',page:1},{items:[item('PRIVATE LATE')]}));await tick();assert.doesNotMatch(f.node('context-search-results').innerHTML,/PRIVATE LATE/);
  f.input('current');f.click('context-search-mode-spaces');await f.advance(350);
  assert.match(f.node('context-search-results').innerHTML,/Beitrag current/);assert.equal(f.calls.clients,1);
  f.emit({status:'error',error:'PRIVATE WORKER ERROR'});assert.match(f.node('context-search-results').innerHTML,/Beitrag current/);assert.equal(f.dialog.querySelector('.context-search-error').hidden,true);
  assert.deepEqual(f.calls.persist,[]);
});

test('offline and provider failures report unavailability rather than a successful empty search',async t=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:false}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;});
  const f=fixture(t,{search:()=>{throw new Error('PRIVATE PROVIDER TOKEN');}});await f.open({query:'Aufgabe'});await f.advance(350);
  assert.equal(f.calls.live.length,0);assert.match(f.dialog.querySelector('.context-search-error').textContent,/offline/);assert.doesNotMatch(f.node('context-search-count').textContent,/Keine Treffer/);
  globalThis.navigator.onLine=true;f.click('context-search-refresh');await f.advance();assert.equal(f.calls.live.length,1);
  assert.match(f.dialog.querySelector('.context-search-error').textContent,/Prüfe Verbindung und Anmeldung/);assert.doesNotMatch(f.dialog.textContent,/PRIVATE PROVIDER TOKEN/);
});

test('removed or changed course grants invalidate in-flight results without broadening an explicit course filter',async t=>{
  const slow=deferred(),f=fixture(t,{search:()=>slow.promise});await f.open({query:'Aufgabe',projectId:'alpha'});await f.advance(350);
  f.context.workspace.projects[0].links[0].url='https://spaces.th-koeln.de/different-course/';
  slow.resolve(reply({query:'Aufgabe',page:1}));await tick();assert.doesNotMatch(f.node('context-search-results').innerHTML,/Beitrag Aufgabe/);assert.equal(f.dialog.querySelector('.context-search-error').hidden,false);
  f.context.workspace.projects[0].archived=true;f.input('erneut');await f.advance(350);
  assert.equal(f.calls.live.length,1);assert.match(f.dialog.querySelector('.context-search-error').textContent,/Kurs.*nicht mehr verfügbar/);
});

test('unknown coverage cannot masquerade as no matches and draft content is not sent before composition ends',async t=>{
  const f=fixture(t,{search:request=>reply(request,{items:[],courses:[]})});await f.open();
  f.node('context-search-input').value='unfertig';f.event('input',f.node('context-search-input'),{isComposing:true});await f.advance(1000);assert.equal(f.calls.live.length,0);
  f.event('compositionend',f.node('context-search-input'));await f.advance(350);
  assert.match(f.node('context-search-count').textContent,/Kurszugriff prüfen/);assert.match(f.node('context-search-live-coverage').textContent,/Status unbekannt/);
  await f.view.refresh();await f.advance();assert.equal(f.calls.clients,0);assert.equal(f.calls.get,0);assert.equal(f.calls.live.length,2);
});

test('a rejected old preview does not reopen or replace a new live search',async t=>{
  const slow=deferred(),f=fixture(t,{openLive:()=>slow.promise});await f.open({query:'old'});await f.advance(350);
  f.click('context-search-result-0');await f.open({query:'current'});await f.advance(350);slow.reject(Error('PRIVATE PREVIEW ERROR'));await tick();
  assert.equal(f.node('context-search-input').value,'current');assert.match(f.node('context-search-results').innerHTML,/Beitrag current/);assert.equal(f.dialog.querySelector('.context-search-error').hidden,true);
});

test('wrong page, missing publication scope or wholly invalid URLs are reported as failed reads',async t=>{
  const variants=[{page:99},{scope:'all'},{items:'PRIVATE BAD RESPONSE'},{items:[item('invalid',{url:'https://spaces.th-koeln.de/alpha/\nwrong'})]}];
  let variant=0;const f=fixture(t,{search:request=>reply(request,variants[variant])});await f.open();
  for(;variant<variants.length;variant++){
    f.input('Query '+variant);await f.advance(350);
    assert.equal(f.dialog.querySelector('.context-search-error').hidden,false);
    assert.equal(f.node('context-search-count').textContent,'Suche nicht verfügbar');
    assert.doesNotMatch(f.node('context-search-results').innerHTML,/Beitrag invalid|PRIVATE BAD RESPONSE/);
  }
});
