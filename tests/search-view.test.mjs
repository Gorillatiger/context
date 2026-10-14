import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createSearchView} from '../dist/search-view.js';

const decode=value=>String(value).replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>','quot':'"','#39':"'"})[key]);
const attrs=value=>Object.fromEntries([...value.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g)].map(m=>[m[1],decode(m[2]??m[3]??m[4]??'')]));
class Node{
  constructor(tag,attributes={},doc){this.tagName=tag.toUpperCase();this.attributes=attributes;this.ownerDocument=doc;this.children=[];this.dataset=Object.fromEntries(Object.entries(attributes).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v]));this.value=attributes.value||'';this.checked='checked' in attributes;this.disabled='disabled' in attributes;this.hidden='hidden' in attributes;this.listeners=new Map();this.classList={add:name=>this.attributes.class=[this.attributes.class,name].filter(Boolean).join(' ')};}
  get id(){return this.attributes.id||'';}
  get isConnected(){return this===this.ownerDocument?.body||!!this.parent?.isConnected;}
  setAttribute(key,value){this.attributes[key]=value;}
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
  focus(){this.ownerDocument.activeElement=this;this.ownerDocument.focused.push(this.id);}
  scrollIntoView(){this.ownerDocument.scrolled.push(this.id);}
  addEventListener(name,handler){this.listeners.set(name,[...(this.listeners.get(name)||[]),handler]);}
  removeEventListener(name,handler){this.listeners.set(name,(this.listeners.get(name)||[]).filter(h=>h!==handler));}
  dispatch(name,event={}){const e={target:this,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...event};for(const handler of this.listeners.get(name)||[])handler(e);return e;}
  showModal(){this.open=true;}
  close(){this.open=false;this.dispatch('close');}
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const entry=(id,title,extra={})=>({id,title,kind:'notes',text:'Synthetic searchable text',projectId:'alpha',source:'context',route:{type:'note',id},...extra});
function fixture(t,{items=[entry('first','First synthetic result')],getDocuments,search,replace,onCrawl,onRefreshSources,onAgentSearch,realClient=false}={}){
  const doc={focused:[],scrolled:[]};doc.body=new Node('body',{},doc);const opener=new Node('button',{id:'search-trigger'},doc);opener.parent=doc.body;doc.body.children.push(opener);doc.activeElement=opener;
  const dialog=new Node('dialog',{id:'search-modal'},doc);dialog.parent=doc.body;doc.body.children.push(dialog);
  const context={workspace:{activeCourse:'alpha',projects:[{id:'alpha',name:'Synthetic Alpha'},{id:'beta',name:'Synthetic Beta'}]},sources:[{source:'spaces',status:'snapshot',complete:false,message:'Teilstand der gespeicherten Quellen.'}]};
  let collection={documents:items,complete:false,warnings:['Nur bereits erfasste Inhalte.']},notify,index=[];const calls={replace:[],search:[],persist:[],open:[],close:0,dispose:0,get:0,status:[]};
  let stats={documents:0,status:'ready',omitted:0,truncated:false,persistence:{enabled:false,state:'off'}};
  const client={stats:()=>stats,replace:async docs=>{calls.replace.push(docs);notify({status:'indexing',...stats});if(replace)await replace(docs);index=docs;stats={...stats,documents:docs.length,status:'ready'};notify(stats);return stats;},search:async(query,options)=>{calls.search.push({query,options});if(search)return search(query,options);const matching=index.filter(i=>(!options.projectId||i.projectId===options.projectId)&&(!options.kinds?.length||options.kinds.includes(i.kind))&&(!options.sources?.length||options.sources.includes(i.source))&&(!query||[i.title,i.text].join(' ').toLowerCase().includes(query.toLowerCase()))),result=matching.slice(options.offset||0,(options.offset||0)+options.limit);stats={...stats,lastSearch:{mode:query?'and':'empty',totalMatches:matching.length,offset:options.offset||0,returned:result.length}};return result;},optPersist:async enabled=>{calls.persist.push(enabled);stats={...stats,persistence:{enabled,state:enabled?'stored':'off'}};notify(stats);return stats;},dispose:()=>calls.dispose++};
  const view=createSearchView({dialog,getContext:()=>context,getDocuments:()=>{calls.get++;return getDocuments?getDocuments():collection;},onOpen:item=>calls.open.push(item),onCrawl,onRefreshSources,onAgentSearch,onClose:()=>calls.close++,onStatus:status=>calls.status.push(status),...(realClient?{}:{clientFactory:options=>{notify=options.onStatus;return client;}})});
  t.after(()=>view.dispose());
  const node=id=>dialog.querySelector('#'+id),event=(type,target,extra={})=>dialog.dispatch(type,{target,...extra});
  return {doc,dialog,view,calls,client,context,node,event,setCollection:value=>collection=value,emit:status=>{stats={...stats,...status};notify(stats);},async open(){await view.open();await delay(10);},async input(value){node('context-search-input').value=value;event('input',node('context-search-input'));await delay(115);},async choose(id,value){node(id).value=value;event('change',node(id));await delay(10);}};
}

test('global search indexes once, focuses the field and includes other courses without a hidden default filter',async t=>{
  const f=fixture(t,{items:[entry('a','Alpha'),entry('b','Beta',{projectId:'beta'})]});await f.open();
  assert.equal(f.dialog.open,true);assert.equal(f.doc.activeElement.id,'context-search-input');assert.equal(f.calls.get,1);assert.equal(f.calls.replace.length,1);assert.equal(f.calls.search[0].options.projectId,'');
  assert.match(f.node('context-search-results').innerHTML,/Alpha/);assert.match(f.node('context-search-results').innerHTML,/Beta/);
  assert.match(f.node('context-search-index').textContent,/2 Inhalte.*Teilindex.*Arbeitsspeicher/);assert.match(f.node('context-search-scope').innerHTML,/Teilstand der gespeicherten Quellen/);
  assert.deepEqual(f.calls.persist,[]);assert.match(f.dialog.innerHTML,/Suchinhalte, auch private Nachrichten, werden lokal verschlüsselt gespeichert/);
  await f.input('Synthetic');assert.equal(f.calls.replace.length,1);assert.equal(f.calls.get,1);
});

test('dynamic course, kind and provider filters are combined without replacing the index',async t=>{
  const items=[entry('a','Local'),entry('b','Mail',{kind:'mail',source:'gmail',projectId:'beta'}),entry('c','Course board',{kind:'boards',source:'miro',projectId:'beta'})];
  const f=fixture(t,{items});await f.open();assert.match(f.node('context-search-kind').innerHTML,/Mail|Boards/);assert.match(f.node('context-search-source').innerHTML,/Gmail|Miro/);
  await f.choose('context-search-course','');assert.equal(f.calls.search.at(-1).options.projectId,'');
  await f.choose('context-search-kind','mail');await f.choose('context-search-source','gmail');
  assert.deepEqual(f.calls.search.at(-1).options.kinds,['mail']);assert.deepEqual(f.calls.search.at(-1).options.sources,['gmail']);assert.match(f.node('context-search-results').innerHTML,/Mail/);assert.doesNotMatch(f.node('context-search-results').innerHTML,/Course board/);
  assert.equal(f.calls.replace.length,1);
});

test('late search responses cannot replace a newer query and typing is debounced',async t=>{
  const slow=deferred(),f=fixture(t,{search:query=>query==='old'?slow.promise:Promise.resolve([entry(query||'initial',query||'Initial')])});await f.open();
  await f.input('old');const staleSignal=f.calls.search.at(-1).options.signal;
  f.node('context-search-input').value='n';f.event('input',f.node('context-search-input'));f.node('context-search-input').value='new';f.event('input',f.node('context-search-input'));await delay(115);
  assert.equal(staleSignal.aborted,true);assert.equal(f.calls.search.filter(c=>c.query==='n').length,0);assert.match(f.node('context-search-results').innerHTML,/new/);
  slow.resolve([entry('old','Stale private result')]);await delay(10);assert.doesNotMatch(f.node('context-search-results').innerHTML,/Stale private result/);
});

test('closing during search suppresses late results, restores focus and calls onClose once',async t=>{
  const waiting=deferred(),f=fixture(t,{search:query=>query?waiting.promise:[]});await f.open();await f.input('pending');
  const signal=f.calls.search.at(-1).options.signal;f.view.close();assert.equal(signal.aborted,true);assert.equal(f.dialog.open,false);assert.equal(f.doc.activeElement.id,'search-trigger');assert.equal(f.calls.close,1);
  waiting.resolve([entry('late','Late result')]);await delay(10);assert.doesNotMatch(f.node('context-search-results').innerHTML,/Late result/);assert.equal(f.calls.close,1);
});

test('keyboard arrows, Enter and Escape act on the current typed route',async t=>{
  const f=fixture(t,{items:[entry('a','One'),entry('b','Two',{route:{type:'source',id:'b'}})]});await f.open();
  f.event('keydown',f.node('context-search-input'),{key:'ArrowDown'});assert.equal(f.doc.activeElement.id,'context-search-result-0');
  f.event('keydown',f.doc.activeElement,{key:'ArrowDown'});assert.equal(f.doc.activeElement.id,'context-search-result-1');
  f.event('keydown',f.doc.activeElement,{key:'Enter'});await delay(5);assert.deepEqual(f.calls.open[0].route,{type:'source',id:'b'});assert.equal(f.dialog.open,false);
  await f.open();f.event('keydown',f.node('context-search-input'),{key:'Escape'});assert.equal(f.dialog.open,false);assert.equal(f.calls.close,2);
});

test('titles, snippets and metadata stay escaped while valid absolute excerpt offsets highlight matches',async t=>{
  const f=fixture(t,{items:[entry('safe','<img src=x onerror=alert(1)>',{text:'<script>synthetic</script>',excerptOffset:100,matchedRanges:[{start:108,end:117}],source:'<svg onload=x>',url:'https://chat.coco.study/students/pl/synthetic'}),entry('unsafe','Unsafe original',{url:'javascript:alert(1)'})]});await f.open();
  const html=f.node('context-search-results').innerHTML;assert.doesNotMatch(html,/<img|<script|onload=x>/);assert.match(html,/&lt;img/);assert.match(html,/<mark>synthetic<\/mark>/);assert.match(html,/href="https:\/\/chat.coco.study\/students\/pl\/synthetic"/);assert.doesNotMatch(html,/href="javascript:/);
  assert.match(html,/rel="noopener noreferrer"/);assert.match(html,/aria-label="Original öffnen:/);
});

test('missing, relative and credentialed URLs never create original-link controls',async t=>{
  const f=fixture(t,{items:[entry('abs','Valid',{url:'https://spaces.th-koeln.de/synthetic/'}),... [undefined,null,'','   ','undefined','/undefined','//evil.example/path','https://user:pass@example.test/'].map((url,i)=>entry('bad-'+i,'No original '+i,{url}))]});await f.open();
  const originals=f.node('context-search-results').querySelectorAll('.context-search-original');assert.equal(originals.length,1);assert.equal(originals[0].getAttribute('href'),'https://spaces.th-koeln.de/synthetic/');
});

test('an older asynchronous document collection never replaces the current source snapshot',async t=>{
  const old=deferred();let n=0;const f=fixture(t,{getDocuments:()=>++n===1?old.promise:{documents:[entry('new','Current source')],complete:false,warnings:[]}});
  const opening=f.view.open();const refreshing=f.view.refresh();await refreshing;await delay(10);old.resolve({documents:[entry('old','Old private account')],complete:true});await opening;await delay(10);
  assert.equal(f.calls.replace.length,1);assert.match(f.node('context-search-results').innerHTML,/Current source/);assert.doesNotMatch(f.node('context-search-results').innerHTML,/Old private account/);
});

test('failed refresh blocks stale search data until a successful index replacement',async t=>{
  let fail=false;const f=fixture(t,{getDocuments:()=>{if(fail)throw Error('RAW_PRIVATE_ERROR');return {documents:[entry('old','Old source')],complete:false};}});await f.open();
  fail=true;await f.view.refresh();const before=f.calls.search.length;await f.input('old');assert.equal(f.calls.search.length,before);assert.doesNotMatch(f.node('context-search-results').innerHTML,/Old source/);assert.doesNotMatch(f.node('context-search-scope').innerHTML,/RAW_PRIVATE_ERROR/);
  assert.equal(f.dialog.querySelector('.context-search-error').hidden,false);
  fail=false;await f.view.refresh();await delay(10);assert.match(f.node('context-search-results').innerHTML,/Old source/);
});

test('optional encrypted persistence is explicit and switching it off updates the real status',async t=>{
  const f=fixture(t);await f.open();const checkbox=f.node('context-search-persist');assert.equal(checkbox.checked,false);assert.deepEqual(f.calls.persist,[]);
  checkbox.checked=true;f.event('change',checkbox);await delay(5);assert.deepEqual(f.calls.persist,[true]);assert.match(f.node('context-search-index').textContent,/Lokal verschlüsselt gespeichert/);
  checkbox.checked=false;f.event('change',checkbox);await delay(5);assert.deepEqual(f.calls.persist,[true,false]);assert.match(f.node('context-search-index').textContent,/Arbeitsspeicher/);
});

test('index limits, worker errors and disposal are visible and never leave accepted late UI updates',async t=>{
  const f=fixture(t);await f.open();f.emit({documents:3,omitted:2,truncated:1,lastSearch:{omittedCandidates:2}});
  assert.match(f.node('context-search-index').textContent,/3 Inhalte.*Teilindex/);assert.match(f.node('context-search-scope').innerHTML,/2 Inhalte wurden.*ausgelassen/);assert.match(f.node('context-search-scope').innerHTML,/Suchgrenze/);
  f.emit({status:'error',error:'RAW_WORKER_ERROR'});assert.match(f.node('context-search-index').textContent,/nicht verfügbar/);assert.equal(f.dialog.querySelector('.context-search-error').hidden,false);assert.doesNotMatch(f.dialog.querySelector('.context-search-error').textContent,/RAW_WORKER_ERROR/);
  f.view.dispose();assert.equal(f.calls.dispose,1);assert.ok([...f.dialog.listeners.values()].every(list=>list.length===0));await f.view.open();await f.view.refresh();assert.equal(f.calls.replace.length,1);
});

test('the actual client and local index integrate with the dialog without a provider request',async t=>{
  const f=fixture(t,{realClient:true,items:[entry('note-one','Synthetische Recherche',{text:'Lokale Erkenntnisse zum Projekt und Prototyping.',status:'excerpt'}),entry('mail-one','Synthetic Mail',{kind:'mail',source:'webmail',route:{type:'mail',id:'mail-one'},text:'Already loaded synthetic header.',status:'metadata'})]});
  await f.open();assert.match(f.node('context-search-index').textContent,/2 Inhalte.*Arbeitsspeicher/);assert.equal(f.calls.get,1);
  assert.match(f.node('context-search-results').innerHTML,/\.\/brands\/webmail\.svg/);assert.match(f.node('context-search-results').innerHTML,/Nur Metadaten/);
  await f.input('Erkenntnisse');assert.match(f.node('context-search-results').innerHTML,/<mark>Erkenntnisse<\/mark>/);assert.match(f.node('context-search-results').innerHTML,/Quellenauszug/);assert.doesNotMatch(f.node('context-search-results').innerHTML,/Synthetic Mail/);assert.equal(f.calls.get,1);
  const checkbox=f.node('context-search-persist');checkbox.checked=true;f.event('change',checkbox);await delay(5);
  assert.match(f.node('context-search-index').textContent,/Arbeitsspeicher.*Speicherfehler/);assert.equal(f.dialog.querySelector('.context-search-error').hidden,false);
  await f.input('Synthetic Mail');f.event('keydown',f.node('context-search-input'),{key:'Enter'});await delay(5);assert.deepEqual(f.calls.open[0].route,{type:'mail',id:'mail-one'});
});


test('partial word fallback is labelled instead of claiming all search terms matched',async t=>{
  const f=fixture(t,{realClient:true,items:[entry('one','Kalender',{text:'Lokale Dokumentation und Planung.'})]});await f.open();await f.input('Kalender unmöglicheswort');
  assert.match(f.node('context-search-count').textContent,/ähnliche Treffer.*nicht alle Suchwörter gefunden/);
});

test('the actual client/index exposes all 500 results through 24-row pages with a truthful total and final boundary',async t=>{
  const items=Array.from({length:500},(_,i)=>entry('paged-'+String(i).padStart(3,'0'),'Synthetic item '+String(i).padStart(3,'0'))),f=fixture(t,{realClient:true,items});
  await f.open();assert.equal(f.node('context-search-count').textContent,'1–24 von 500 Treffern');assert.equal(f.node('context-search-page').textContent,'Seite 1 von 21');assert.equal(f.node('context-search-previous').disabled,true);assert.equal(f.node('context-search-next').disabled,false);
  assert.equal(f.node('context-search-pages').getAttribute('aria-label'),'Trefferseiten');assert.equal(f.node('context-search-next').getAttribute('aria-label'),'Nächste Trefferseite');assert.equal(f.node('context-search-previous').getAttribute('aria-label'),'Vorherige Trefferseite');
  assert.doesNotMatch(f.node('context-search-count').textContent,/Anzeige begrenzt/);const visited=[];
  for(let page=0;page<21;page++){
    const rows=f.node('context-search-results').querySelectorAll('.context-search-result');assert.ok(rows.length<=24);visited.push(...rows.map(row=>row.getAttribute('aria-label')));
    assert.equal(f.node('context-search-results').getAttribute('start'),String(page*24+1));
    if(page<20){f.event('click',f.node('context-search-next'));assert.equal(f.node('context-search-next').disabled,true);await delay(10);assert.equal(f.doc.activeElement.id,'context-search-result-0');}
  }
  assert.equal(visited.length,500);assert.equal(new Set(visited).size,500);assert.equal(f.node('context-search-count').textContent,'481–500 von 500 Treffern');assert.equal(f.node('context-search-page').textContent,'Seite 21 von 21');assert.equal(f.node('context-search-next').disabled,true);
  f.event('click',f.node('context-search-next'));await delay(5);assert.equal(f.node('context-search-page').textContent,'Seite 21 von 21');
  f.event('click',f.node('context-search-previous'));await delay(10);assert.equal(f.node('context-search-count').textContent,'457–480 von 500 Treffern');
  f.event('keydown',f.doc.activeElement,{key:'Enter'});await delay(5);assert.equal(f.calls.open[0].id,'paged-456');assert.equal(f.calls.get,1);
});

test('query, composition, each filter, refresh and reopen reset pagination to the first current page',async t=>{
  const items=Array.from({length:150},(_,i)=>entry('reset-'+i,'Common searchable title',{projectId:i<125?'alpha':'beta',kind:i%2?'mail':'notes',source:i%2?'gmail':'context'})),f=fixture(t,{items});await f.open();
  const next=async()=>{f.event('click',f.node('context-search-next'));await delay(10);assert.equal(f.calls.search.at(-1).options.offset,24);};
  await next();await f.input('Common');assert.equal(f.calls.search.at(-1).options.offset,0);
  await next();f.node('context-search-input').value='searchable';f.event('compositionend',f.node('context-search-input'));await delay(115);assert.equal(f.calls.search.at(-1).options.offset,0);
  await next();await f.choose('context-search-course','');assert.equal(f.calls.search.at(-1).options.offset,0);
  await next();await f.choose('context-search-kind','mail');assert.equal(f.calls.search.at(-1).options.offset,0);
  await next();await f.choose('context-search-source','gmail');assert.equal(f.calls.search.at(-1).options.offset,0);
  await next();await f.view.refresh();await delay(10);assert.equal(f.calls.search.at(-1).options.offset,0);
  await next();f.view.close();await f.open();assert.equal(f.calls.search.at(-1).options.offset,0);assert.equal(f.calls.search.at(-1).query,'');
});

test('a slow page cannot overwrite a newer query/filter or reopen stale page controls',async t=>{
  const slow=deferred(),f=fixture(t,{search:(query,options)=>{
    if(!query&&options.offset===24)return slow.promise;
    f.emit({lastSearch:{mode:'and',totalMatches:query?1:500,offset:options.offset,returned:query?1:24}});
    return Promise.resolve(query?[entry('new','New current result')]:Array.from({length:24},(_,i)=>entry('first-'+i,'First page '+i)));
  }});await f.open();f.event('click',f.node('context-search-next'));await delay(10);const stale=f.calls.search.at(-1).options.signal;
  await f.input('new');assert.equal(stale.aborted,true);await f.choose('context-search-source','context');assert.equal(f.calls.search.at(-1).options.offset,0);
  slow.resolve([entry('stale','Stale old page')]);await delay(10);
  assert.match(f.node('context-search-results').innerHTML,/New current result/);assert.doesNotMatch(f.node('context-search-results').innerHTML,/Stale old page/);assert.equal(f.node('context-search-count').textContent,'1–1 von 1 Treffern');assert.equal(f.node('context-search-pages').hidden,true);
});

test('quoted-phrase totals and partial-word labels remain correct on every accepted page',async t=>{
  const items=Array.from({length:80},(_,i)=>entry('phrase-'+String(i).padStart(3,'0'),'Synthetic source',{text:i<30?'Wichtige Abgabe':i<60?'Wichtige ausführliche Abgabe':'Wichtige Erkenntnisse'})),f=fixture(t,{realClient:true,items});
  await f.open();await f.input('"wichtige abgabe"');assert.equal(f.node('context-search-count').textContent,'1–24 von 30 Treffern');
  f.event('click',f.node('context-search-next'));await delay(10);assert.equal(f.node('context-search-count').textContent,'25–30 von 30 Treffern');assert.equal(f.node('context-search-next').disabled,true);
  await f.input('wichtige zqyxwunbekannt');assert.match(f.node('context-search-count').textContent,/1–24 von 80 Treffern.*ähnliche Treffer.*nicht alle Suchwörter gefunden/);
  f.event('click',f.node('context-search-next'));await delay(10);assert.match(f.node('context-search-count').textContent,/25–48 von 80 Treffern.*ähnliche Treffer.*nicht alle Suchwörter gefunden/);
  await f.input('wichtige');assert.doesNotMatch(f.node('context-search-count').textContent,/ähnliche Treffer/);
});

test('a refreshed smaller snapshot resets an obsolete last page and keeps current rows reachable',async t=>{
  const f=fixture(t,{realClient:true,items:Array.from({length:55},(_,i)=>entry('old-'+i,'Old synthetic source'))});await f.open();
  f.event('click',f.node('context-search-next'));await delay(10);f.event('click',f.node('context-search-next'));await delay(10);assert.match(f.node('context-search-count').textContent,/49–55 von 55/);
  f.setCollection({documents:[entry('current','Current account source')],complete:true});await f.view.refresh();await delay(10);
  assert.equal(f.node('context-search-count').textContent,'1–1 von 1 Treffern');assert.equal(f.node('context-search-pages').hidden,true);assert.match(f.node('context-search-results').innerHTML,/Current account source/);assert.doesNotMatch(f.node('context-search-results').innerHTML,/Old synthetic source/);
});

test('the optional Spaces action is named, appears once, and closes search before invoking the explicit callback',async t=>{
  let invoked=0,f;f=fixture(t,{onCrawl:async()=>{assert.equal(f.dialog.open,false);assert.equal(f.calls.close,1);invoked++;}});await f.open();
  const button=f.node('context-search-crawl');assert.equal(button.getAttribute('aria-label'),'Spaces indexieren');assert.equal(button.getAttribute('title'),'Spaces-Kursseiten einlesen');assert.match(f.dialog.innerHTML,/brands\/spaces\.svg/);
  assert.equal(f.dialog.querySelectorAll('[data-search-action]').filter(node=>node.dataset.searchAction==='crawl').length,1);assert.equal(invoked,0);
  button.focus();f.event('click',button);await delay(5);assert.equal(invoked,1);assert.equal(f.dialog.open,false);assert.equal(f.doc.activeElement.id,'search-trigger');
  const plain=fixture(t);await plain.open();assert.equal(plain.node('context-search-crawl'),null);
});

test('late crawler-dialog failures do not reopen or overwrite a newly opened search',async t=>{
  const pending=deferred(),f=fixture(t,{onCrawl:()=>pending.promise});await f.open();f.event('click',f.node('context-search-crawl'));await f.open();await f.input('new query');
  pending.reject(new Error('Synthetic private failure'));await delay(10);assert.equal(f.node('context-search-input').value,'new query');assert.equal(f.dialog.querySelector('.context-search-error').hidden,true);
});

test('an explicitly scoped search shows the course constraint and removing it restores all courses and keyboard focus',async t=>{
  const f=fixture(t,{items:[entry('a','Current course'),entry('b','Other course',{projectId:'beta'})]});
  await f.view.open({projectId:'alpha'});await delay(10);
  assert.equal(f.node('context-search-course').value,'alpha');assert.equal(f.node('context-search-filter-label').textContent,'Filter · 1');
  const strip=f.node('context-search-active-filters');assert.equal(strip.hidden,false);assert.match(strip.innerHTML,/Synthetic Alpha/);assert.doesNotMatch(f.node('context-search-results').innerHTML,/Other course/);
  const chip=strip.querySelector('button');chip.focus();f.event('click',chip);await delay(10);
  assert.equal(f.node('context-search-course').value,'');assert.equal(strip.hidden,true);assert.equal(f.node('context-search-filter-label').textContent,'Filter');
  assert.match(f.node('context-search-results').innerHTML,/Other course/);assert.equal(f.doc.activeElement.id,'context-search-input');
});

test('filter controls stay optional and Escape dismisses the open filter before dismissing search',async t=>{
  const f=fixture(t);await f.open();const menu=f.node('context-search-filter-menu');
  assert.notEqual(menu.open,true);assert.equal(f.node('context-search-active-filters').hidden,true);
  menu.open=true;f.node('context-search-course').focus();f.event('keydown',f.node('context-search-course'),{key:'Escape'});
  assert.equal(menu.open,false);assert.equal(f.dialog.open,true);assert.equal(f.doc.activeElement.tagName,'SUMMARY');
  f.event('keydown',f.doc.activeElement,{key:'Escape'});assert.equal(f.dialog.open,false);assert.equal(f.doc.activeElement.id,'search-trigger');
});

test('resetting combined filters removes every active constraint and starts at the first page',async t=>{
  const f=fixture(t,{items:Array.from({length:60},(_,i)=>entry('row-'+i,'Searchable row '+i,{source:'spaces',kind:'sources'}))});await f.open();
  await f.choose('context-search-course','alpha');await f.choose('context-search-source','spaces');await f.choose('context-search-kind','sources');
  assert.equal(f.node('context-search-filter-label').textContent,'Filter · 3');assert.equal(f.node('context-search-active-filters').querySelectorAll('button').length,3);
  f.event('click',f.node('context-search-next'));await delay(10);
  const reset=f.node('context-search-filter-menu').querySelectorAll('[data-search-action]')[0];f.event('click',reset);await delay(10);
  assert.equal(f.calls.search.at(-1).options.offset,0);assert.equal(f.calls.search.at(-1).options.projectId,'');assert.equal(f.calls.search.at(-1).options.sources,undefined);assert.equal(f.calls.search.at(-1).options.kinds,undefined);
  assert.equal(f.node('context-search-active-filters').hidden,true);
});

test('source refresh and AI handoff never run merely because search opens or the user types',async t=>{
  const refresh=[],agents=[],f=fixture(t,{onRefreshSources:args=>refresh.push(args),onAgentSearch:args=>agents.push(args)});await f.open();
  assert.equal(f.node('context-search-agent').disabled,true);assert.deepEqual(refresh,[]);assert.deepEqual(agents,[]);
  await f.input('Aufgabenstellung Miro');assert.equal(f.node('context-search-agent').disabled,false);assert.deepEqual(refresh,[]);assert.deepEqual(agents,[]);
  const plain=fixture(t);await plain.open();assert.equal(plain.node('context-search-refresh'),null);assert.equal(plain.node('context-search-agent'),null);
});

test('explicit source refresh is coalesced and indexes the accepted new source snapshot exactly once',async t=>{
  const waiting=deferred(),reads=[];let f;f=fixture(t,{onRefreshSources:async args=>{reads.push(args);await waiting.promise;f.setCollection({documents:[entry('fresh','Fresh source')],complete:false});}});await f.open();await f.input('Fresh');await f.choose('context-search-source','context');
  const refresh=f.node('context-search-refresh');f.event('click',refresh);f.event('click',refresh);assert.equal(reads.length,1);assert.equal(refresh.disabled,true);assert.equal(refresh.getAttribute('aria-busy'),'true');
  assert.equal(reads[0].query,'Fresh');assert.equal(reads[0].source,'context');assert.equal(reads[0].signal.aborted,false);assert.match(f.node('context-search-index').textContent,/Quellen werden aktualisiert/);
  waiting.resolve();const deadline=Date.now()+2000;while(!/Fresh source/.test(f.node('context-search-results').innerHTML)&&Date.now()<deadline)await delay(5);assert.equal(f.calls.replace.length,2);assert.match(f.node('context-search-results').innerHTML,/Fresh source/);assert.equal(refresh.disabled,false);assert.equal(refresh.getAttribute('aria-busy'),'false');
});

test('closing a source refresh aborts it and its late result cannot refresh a newly reopened search',async t=>{
  const waiting=deferred(),reads=[],f=fixture(t,{onRefreshSources:args=>{reads.push(args);return waiting.promise;}});await f.open();
  f.event('click',f.node('context-search-refresh'));f.view.close();assert.equal(reads[0].signal.aborted,true);await f.open();await f.input('current');
  waiting.resolve();await delay(15);assert.equal(f.calls.replace.length,1);assert.equal(f.node('context-search-input').value,'current');assert.equal(f.dialog.querySelector('.context-search-error').hidden,true);
});

test('a failed source refresh reports an actionable safe error without losing searchable existing documents',async t=>{
  const f=fixture(t,{onRefreshSources:()=>Promise.reject(Error('PRIVATE_PROVIDER_TOKEN'))});await f.open();f.event('click',f.node('context-search-refresh'));await delay(10);
  const alert=f.dialog.querySelector('.context-search-error');assert.equal(alert.hidden,false);assert.match(alert.textContent,/bisherige lokale Stand/);assert.doesNotMatch(alert.textContent,/PRIVATE_PROVIDER_TOKEN/);assert.match(f.node('context-search-results').innerHTML,/First synthetic result/);
  await f.input('synthetic');assert.match(f.node('context-search-results').innerHTML,/First synthetic result/);assert.equal(f.calls.replace.length,1);
});

test('AI handoff carries only the explicit search question and visible filters after closing search',async t=>{
  const requests=[];let f;f=fixture(t,{onAgentSearch:args=>{assert.equal(f.dialog.open,false);requests.push(args);}});await f.open();await f.input('  Aufgabe erklären  ');await f.choose('context-search-course','alpha');await f.choose('context-search-source','context');await f.choose('context-search-kind','notes');
  f.event('click',f.node('context-search-agent'));await delay(5);
  assert.deepEqual(requests,[{query:'Aufgabe erklären',projectId:'alpha',source:'context',kind:'notes'}]);assert.equal(f.calls.close,1);assert.equal(f.doc.activeElement.id,'search-trigger');
});

test('a late failed AI handoff cannot reopen or replace a new search interaction',async t=>{
  const waiting=deferred(),f=fixture(t,{onAgentSearch:()=>waiting.promise});await f.open();await f.input('old question');f.event('click',f.node('context-search-agent'));await f.open();await f.input('new question');
  waiting.reject(Error('RAW_PRIVATE_AGENT_ERROR'));await delay(10);assert.equal(f.node('context-search-input').value,'new question');assert.equal(f.dialog.querySelector('.context-search-error').hidden,true);
});

test('provider logos and original links remain bundled while malformed or private timestamps never become attributes',async t=>{
  const f=fixture(t,{items:[entry('mail','Mail result',{source:'webmail',updatedAt:'2026-10-14T10:20:00Z'}),entry('date','Unsafe date',{source:'drive',updatedAt:'" onmouseover="PRIVATE_RAW_TIMESTAMP'}),entry('invalid','Invalid date',{updatedAt:'2026-99-99T25:00:00Z'})]});await f.open();
  const html=f.node('context-search-results').innerHTML;assert.match(html,/brands\/webmail\.svg/);assert.match(html,/brands\/googledrive\.svg/);assert.doesNotMatch(html,/brand-pair/);assert.match(html,/<time datetime="2026-10-14T10:20:00\.000Z">/);assert.doesNotMatch(html,/PRIVATE_RAW_TIMESTAMP|onmouseover|2026-99-99/);
  assert.equal(f.node('context-search-results').querySelectorAll('time').length,1);
});

test('opening from the home search preserves its explicit question, executes it once and visibly respects its requested course',async t=>{
  const f=fixture(t,{items:[entry('a','Miro Aufgabenstellung',{text:'Barrierefreiheit untersuchen'}),entry('b','Miro Aufgabenstellung anderer Kurs',{projectId:'beta'})]});
  await f.view.open({query:'Miro Aufgabenstellung',projectId:'alpha'});await delay(10);
  assert.equal(f.node('context-search-input').value,'Miro Aufgabenstellung');assert.equal(f.doc.activeElement.id,'context-search-input');assert.equal(f.calls.search.length,1);assert.equal(f.calls.search[0].query,'Miro Aufgabenstellung');assert.equal(f.calls.search[0].options.projectId,'alpha');
  assert.match(f.node('context-search-results').innerHTML,/Miro Aufgabenstellung/);assert.doesNotMatch(f.node('context-search-results').innerHTML,/anderer Kurs/);assert.equal(f.node('context-search-active-filters').hidden,false);
  f.view.close();await f.view.open({query:'x'.repeat(800)});await delay(10);assert.equal(f.node('context-search-input').value.length,500);assert.equal(f.calls.search.at(-1).query.length,500);assert.equal(f.calls.search.at(-1).options.projectId,'');assert.equal(f.calls.replace.length,1);
});
