import test from 'node:test';
import assert from 'node:assert/strict';
import {createKIView} from '../dist/ki.js';
import {platformCatalog} from '../dist/source-catalog.js';
// Minimal DOM for event/markup regressions against real render output.
// Layout, CSS cascade and browser accessibility are checked in the browser fixture.
const decode=value=>String(value).replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[key]);
const voidTags=new Set(['input','br','hr','img','meta','link','source','area','wbr']);
class FixtureElement {
 constructor(tag,attrs={},document){this.tagName=tag.toUpperCase();this.attrs=attrs;this.document=document;this.children=[];this.parentElement=null;this.data='';this.dataset=Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));this.selectionStart=0;this.selectionEnd=0;this.selectionDirection='none';this.scrollTop=0;this.scrollHeight=1200;this.clientHeight=420;this.classList={toggle:(name,on)=>{const rows=new Set((this.attrs.class||'').split(' '));if(on)rows.add(name);else rows.delete(name);this.attrs.class=[...rows].join(' ');},add:name=>{this.attrs.class=(this.attrs.class||'')+' '+name;}};}
 get id(){return this.attrs.id||'';} get hidden(){return 'hidden' in this.attrs;} set hidden(value){if(value)this.attrs.hidden='';else delete this.attrs.hidden;}
 get disabled(){return 'disabled' in this.attrs;} get type(){return this.attrs.type||'';} get checked(){return this._checked??('checked' in this.attrs);} set checked(value){this._checked=value;}
 get value(){if(this._value!==undefined)return this._value;if(this.tagName==='TEXTAREA')return this.textContent;if(this.tagName==='SELECT')return (this.children.find(child=>'selected' in child.attrs)||this.children[0])?.value||'';return this.attrs.value||'';} set value(value){this._value=String(value);}
 get textContent(){return decode(this.data)+this.children.map(child=>child.textContent).join('');} set textContent(value){this.data=String(value);this.children=[];}
 getAttribute(name){return this.attrs[name]??null;} setAttribute(name,value){this.attrs[name]=String(value);} removeAttribute(name){delete this.attrs[name];}
 focus(){this.document.activeElement=this;} setSelectionRange(start,end,direction='none'){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}
 matches(selector){return selector.split(',').some(part=>{part=part.trim();const id=part.match(/#([\w-]+)/)?.[1],className=part.match(/\.([\w-]+)/)?.[1],attr=part.match(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/),tag=part.match(/^[a-z][\w-]*/i)?.[0];return (!id||this.id===id)&&(!className||(this.attrs.class||'').split(' ').includes(className))&&(!tag||this.tagName===tag.toUpperCase())&&(!attr||(attr[1] in this.attrs&&(attr[2]===undefined||this.attrs[attr[1]]===attr[2])));});}
 closest(selector){for(let current=this;current;current=current.parentElement)if(current.matches(selector))return current;return null;}
 querySelectorAll(selector){const matches=[];for(const child of this.children){if(child.matches(selector))matches.push(child);matches.push(...child.querySelectorAll(selector));}return matches;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;} contains(node){for(let current=node;current;current=current.parentElement)if(current===this)return true;return false;}
 click(){this.document.clicked.push(this.id||this.dataset.kiAction||this.dataset.speechAction);return this.document.dispatch('click',this);}
 scrollTo({top}){this.scrollTop=Math.max(0,Math.min(top,this.scrollHeight-this.clientHeight));}
}
function parseHTML(html,document){
 const root=new FixtureElement('fixture-root',{},document),stack=[root];let offset=0;
 for(const match of html.matchAll(/<\/?[a-zA-Z][^>]*>/g)){
  stack.at(-1).data+=html.slice(offset,match.index);offset=match.index+match[0].length;
  if(match[0].startsWith('</')){const tag=match[0].slice(2,-1).trim().toUpperCase();for(let i=stack.length-1;i>0;i--)if(stack[i].tagName===tag){stack.length=i;break;}continue;}
  const tag=match[0].match(/^<([\w-]+)/)[1],attrs={};
  for(const row of match[0].slice(tag.length+1,-1).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g))attrs[row[1]]=decode(row[2]??row[3]??row[4]??'');
  const node=new FixtureElement(tag,attrs,document);node.parentElement=stack.at(-1);node.parentElement.children.push(node);
  if(!voidTags.has(tag)&&!match[0].endsWith('/>'))stack.push(node);
 }
 stack.at(-1).data+=html.slice(offset);return root;
}
function createFixtureDocument(){
 const listeners=new Map(),document={clicked:[],activeElement:null,visibilityState:'visible',addEventListener(type,handler,capture=false){listeners.set(type,[...(listeners.get(type)||[]),{handler,capture:capture===true}]);},removeEventListener(type,handler){listeners.set(type,(listeners.get(type)||[]).filter(row=>row.handler!==handler));},querySelector(selector){return document.root?.querySelector(selector)||null;},querySelectorAll(selector){return document.root?.querySelectorAll(selector)||[];},getElementById(id){return document.querySelector('#'+id);},createElement(tag){return new FixtureElement(tag,{},document);},mount(html){document.root=parseHTML(html,document);document.body=document.root;},dispatch(type,target,extra={}){
  let stopped=false;const event={type,target,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){stopped=true;},...extra};
  const rows=listeners.get(type)||[];for(const row of [...rows.filter(row=>row.capture),...rows.filter(row=>!row.capture)]){if(stopped)break;row.handler(event);}return event;
 }};
 document.mount('');document.activeElement=document.body;return document;
}
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function replaceGlobal(t,key,value){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];});}


function fixture(t,{ai,usageRequest,models=true,speechInstalled=true,platformSources=[],onPlatform,workspacePatch={}}={}){
 const document=createFixtureDocument(),events=new Map(),calls=[],speechCalls=[],sources=[],notes=[],saved=new Map([['context-ai-provider','local']]);let view,compact=false,paints=0,callback,captureStarts=0,captureCloses=0;
 const window={addEventListener(type,handler){events.set(type,[...(events.get(type)||[]),handler]);},removeEventListener(type,handler){events.set(type,(events.get(type)||[]).filter(next=>next!==handler));},dispatchEvent(event){for(const handler of events.get(event.type)||[])handler(event);return true;},contextDesktop:{
  ai:async message=>{calls.push(message);if(message.action==='models')return models?{ok:true,value:{models:Array.isArray(models)?models:[{id:'synthetic-model'}]}}:{ok:false,error:'Synthetic model offline'};if(message.action==='cancel')return {ok:true,value:{}};if(message.action==='usage')return usageRequest?usageRequest(message):{ok:true,value:{provider:message.provider,status:message.provider==='local'?'not_applicable':'unknown'}};return ai?ai(message):{ok:true,value:{content:JSON.stringify({type:'answer',text:'Synthetic answer',citations:[]})}};},
  ocr:async()=>({ok:true,value:{text:'Synthetic timetable'}}),
  speech:async message=>{speechCalls.push(message);return {ok:true,value:message.type==='status'?{available:true,state:speechInstalled?'ready':'idle',model:'small',models:[{id:'small',available:speechInstalled,bytes:500000000}]}:{}};},
  onEvent(handler){callback=handler;return ()=>{callback=undefined;};}
 }};
 t.after(async()=>{window.dispatchEvent({type:'pagehide'});await settle();});
 replaceGlobal(t,'document',document);replaceGlobal(t,'window',window);replaceGlobal(t,'localStorage',{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)});replaceGlobal(t,'indexedDB',undefined);replaceGlobal(t,'fetch',async()=>{throw new Error('Network forbidden in chat UI fixture');});replaceGlobal(t,'getComputedStyle',()=>({overflowY:'auto'}));
 const workspace={activeCourse:'alpha',projects:[{id:'alpha',name:'Synthetic course',links:[]}],notes:[{id:'note',projectId:'alpha',title:'Synthetic course note',content:'Source content for QA.'}],tasks:[],bookmarks:[],calendarEvents:[],...workspacePatch};
 const mount=()=>{paints++;document.mount(view.render({compact}));};
 view=createKIView({onChange:()=>{if(view)mount();},getContext:()=>({workspace,updates:[],platformSources}),onPlatform,onSource:value=>sources.push(value),onNote:value=>notes.push(value),speechCaptureFactory:async()=>({start:async()=>{captureStarts++;},close:async()=>{captureCloses++;}})});
 mount();
 const find=selector=>{const node=document.querySelector(selector);assert(node,`missing actual rendered selector ${selector}`);return node;};
 return {view,document,calls,speechCalls,sources,notes,find,workspace,mount,async ready(){await settle();await view.load();await settle();},compact(value){compact=value;mount();},click:selector=>find(selector).click(),input(value){const node=find('#ki-prompt');node.value=value;document.dispatch('input',node);return node;},change(selector,value){const node=find(selector);if(node.type==='checkbox')node.checked=value;else node.value=value;document.dispatch('change',node);return node;},emitSpeech(detail){callback?.({type:'context-speech',detail});},get paints(){return paints;},get captureStarts(){return captureStarts;},get captureCloses(){return captureCloses;}};
}

test('actual full and compact chat icon controls retain accessible names and decorative SVG semantics',async t=>{
 const f=fixture(t);await f.ready();
 for(const compact of [false,true]){
  f.compact(compact);const controls=f.document.querySelectorAll('.ki-icon-action');assert(controls.length>=8);
  for(const node of controls){assert(node.getAttribute('aria-label')?.trim(),`unnamed ${node.dataset.kiAction||node.dataset.speechAction}`);assert(node.getAttribute('title')?.trim());for(const svg of node.querySelectorAll('svg'))assert.equal(svg.getAttribute('aria-hidden'),'true');}
  assert.equal(f.find('#ki-menu-history').getAttribute('aria-controls'),'ki-history-panel');assert.equal(f.find('#ki-menu-settings').getAttribute('aria-controls'),'ki-settings-panel');
  assert.equal(f.find('#ki-history-panel').getAttribute('role'),'dialog');assert.equal(f.find('#ki-settings-panel').getAttribute('role'),'dialog');
 }
});

test('composer has one prompt, a real label, independent history/settings and reachable photo/microphone/send actions',async t=>{
 const f=fixture(t);await f.ready();
 assert.equal(f.document.querySelectorAll('#ki-prompt').length,1);assert.equal(f.document.querySelectorAll('#ki-form').length,1);assert(f.find('#ki-prompt').closest('#ki-form'));
 assert(f.document.querySelector('label[for="ki-prompt"]')?.textContent.trim());assert.equal(f.find('#ki-prompt').getAttribute('maxlength'),'6000');
 for(const id of ['ki-history','ki-provider','ki-model','ki-photo','ki-archive-import','ki-kind-notes','ki-browser-enabled','ki-calendar-direct','ki-auto-actions','ki-speech-pauseMs','ki-speech-autoSend','ki-speech-saveTranscript'])f.find('#'+id);
 assert.equal(f.find('[data-ki-action="photo"]').disabled,false);assert.equal(f.find('.ki-mic').disabled,false);assert.equal(f.find('.ki-send').disabled,false);
 for(const id of ['ki-menu-history','ki-menu-settings'])assert.equal(f.find('#'+id).closest('#ki-form'),null);
});

test('opening, switching and closing chat menus preserves the live composer and restores focus',async t=>{
 const f=fixture(t);await f.ready();const prompt=f.input('Ein ungesendeter deutscher Entwurf.');prompt.setSelectionRange(4,16,'backward');prompt.focus();const paints=f.paints;
 f.click('#ki-menu-history');assert.equal(f.find('#ki-history-panel').hidden,false);assert.equal(f.find('#ki-menu-history').getAttribute('aria-expanded'),'true');assert.equal(f.document.activeElement.dataset.kiAction,'menu-close');
 f.click('#ki-menu-settings');assert.equal(f.find('#ki-history-panel').hidden,true);assert.equal(f.find('#ki-settings-panel').hidden,false);assert.equal(f.find('#ki-menu-history').getAttribute('aria-expanded'),'false');
 f.find('#ki-settings-panel').querySelector('[data-ki-action="menu-close"]').click();assert.equal(f.find('#ki-settings-panel').hidden,true);assert.equal(f.document.activeElement.id,'ki-menu-settings');
 assert.equal(f.paints,paints,'menus must not repaint the composer');assert.equal(f.find('#ki-prompt'),prompt);assert.deepEqual([prompt.value,prompt.selectionStart,prompt.selectionEnd,prompt.selectionDirection],['Ein ungesendeter deutscher Entwurf.',4,16,'backward']);assert.equal(f.calls.filter(call=>call.action==='chat').length,0);
});

test('Escape closes only the open chat menu before global shortcuts and returns focus to its toggle',async t=>{
 const f=fixture(t);await f.ready();let globalEscapes=0;f.document.addEventListener('keydown',()=>globalEscapes++);f.click('#ki-menu-settings');
 const event=f.document.dispatch('keydown',f.document.activeElement,{key:'Escape'});assert.equal(event.defaultPrevented,true);assert.equal(globalEscapes,0);assert.equal(f.find('#ki-settings-panel').hidden,true);assert.equal(f.document.activeElement.id,'ki-menu-settings');
 f.document.dispatch('keydown',f.find('#ki-prompt'),{key:'Escape'});assert.equal(globalEscapes,1,'without an open menu the global handler must remain available');
});

test('outside click and keyboard focus leaving a menu close it without stealing composer focus',async t=>{
 const f=fixture(t);await f.ready();
 for(const type of ['click','focusin']){f.click('#ki-menu-history');const prompt=f.find('#ki-prompt');prompt.focus();f.document.dispatch(type,prompt);assert.equal(f.find('#ki-history-panel').hidden,true);assert.equal(f.document.activeElement,prompt);}
});

test('changing the selected knowledge starts a fresh scoped chat while retaining draft and text selection',async t=>{
 const f=fixture(t);await f.ready();const before=f.find('.ki-thread').dataset.viewportKey,prompt=f.input('Mein eigener Entwurf bleibt bestehen.');prompt.setSelectionRange(3,12,'forward');f.click('#ki-menu-settings');
 f.change('#ki-kind-notes',false);await settle();const replacement=f.find('#ki-prompt');assert.equal(replacement.value,prompt.value);assert.deepEqual([replacement.selectionStart,replacement.selectionEnd,replacement.selectionDirection],[3,12,'forward']);assert.notEqual(f.find('.ki-thread').dataset.viewportKey,before);assert.equal(f.find('#ki-kind-notes').checked,false);assert.equal(f.calls.filter(call=>call.action==='chat').length,0);
});

test('provider discovery preserves a draft and selection across the temporary absence of the composer',async t=>{
 const f=fixture(t);await f.ready();const prompt=f.input('Entwurf vor dem Anbieterwechsel.');prompt.setSelectionRange(8,18,'backward');f.click('#ki-menu-settings');
 f.change('#ki-provider','openrouter');await settle();const replacement=f.find('#ki-prompt');assert.equal(replacement.value,prompt.value);assert.deepEqual([replacement.selectionStart,replacement.selectionEnd,replacement.selectionDirection],[8,18,'backward']);assert.equal(f.view.configuration().provider,'openrouter');assert(f.calls.some(call=>call.provider==='openrouter'&&call.action==='models'));assert.equal(f.calls.filter(call=>call.action==='chat').length,0);
});

test('photo and archive import icon paths activate their actual file inputs without sending a chat',async t=>{
 const f=fixture(t);await f.ready();f.click('[data-ki-action="photo"]');assert(f.document.clicked.includes('ki-photo'));f.click('#ki-menu-history');f.click('[data-ki-action="import"]');assert(f.document.clicked.includes('ki-archive-import'));assert.equal(f.calls.filter(call=>call.action==='chat').length,0);
});

test('microphone icon starts the existing local speech controller and final text becomes an editable draft once',async t=>{
 const f=fixture(t);await f.ready();f.click('.ki-mic');await settle();assert.equal(f.captureStarts,1);const start=f.speechCalls.find(call=>call.type==='start');assert(start);
 f.emitSpeech({type:'interim',id:start.id,text:'Vorläufige Worte'});assert.match(f.find('.ki-live-status').textContent,/Vorläufige Worte/);assert.equal(f.find('.ki-mic').dataset.speechAction,'stop');
 f.emitSpeech({type:'final',id:start.id,text:'Ein endgültiger deutscher Beitrag.'});await settle();f.emitSpeech({type:'final',id:start.id,text:'Ein endgültiger deutscher Beitrag.'});await settle();
 assert.equal(f.find('#ki-prompt').value,'Ein endgültiger deutscher Beitrag.');assert.equal(f.document.activeElement.id,'ki-prompt');assert.equal(f.captureCloses,1);assert.equal(f.calls.filter(call=>call.action==='chat').length,0,'speech defaults must allow reviewing text before sending');
});

test('actual completed answer keeps source preview and save-as-note actions reachable',async t=>{
 let chats=0;const f=fixture(t,{ai:async()=>({ok:true,value:{content:JSON.stringify(++chats===1?{type:'tool',tool:'read_source',args:{id:'n:note'}}:{type:'answer',text:'Aus der Quelle [n:note].',citations:['n:note']})}})});await f.ready();f.input('Lies meine Kursnotiz.');f.document.dispatch('submit',f.find('#ki-form'));await settle();
 assert.equal(chats,2);assert(f.find('[data-ki-action="source"]').closest('details'));f.click('[data-ki-action="source"]');assert.equal(f.sources[0].id,'n:note');f.click('[data-ki-action="note"]');assert.equal(f.notes.length,1);assert.match(f.notes[0].content,/Synthetic course note/);
});

test('Enter submits one chat while Shift+Enter and composing IME input retain the draft',async t=>{
 const f=fixture(t);await f.ready();const prompt=f.input('Kurzer deutscher Auftrag.');
 for(const extra of [{shiftKey:true},{isComposing:true}]){const event=f.document.dispatch('keydown',prompt,{key:'Enter',...extra});assert.equal(event.defaultPrevented,false);}assert.equal(f.calls.filter(call=>call.action==='chat').length,0);
 const event=f.document.dispatch('keydown',prompt,{key:'Enter',shiftKey:false,isComposing:false});assert.equal(event.defaultPrevented,true);await settle();assert.equal(f.calls.filter(call=>call.action==='chat').length,1);
});

test('connection failure keeps provider settings and history accessible with a reviewable retry',async t=>{
 const f=fixture(t,{models:false});await f.ready();assert.match(f.find('.ki-error').textContent,/Synthetic model offline/);f.find('[data-ki-action="retry"]');assert.equal(f.document.querySelector('#ki-form'),null);f.click('#ki-menu-settings');assert.equal(f.find('#ki-settings-panel').hidden,false);assert.equal(f.find('#ki-provider').disabled,false);f.click('#ki-menu-history');assert.equal(f.find('#ki-history-panel').hidden,false);
});

test('busy chat disables conflicting controls, sends once and retains the icon stop action',async t=>{
 let release;const waiting=new Promise(resolve=>{release=resolve;});const f=fixture(t,{ai:()=>waiting});await f.ready();f.input('Längerer Auftrag mit Stopp.');const form=f.find('#ki-form');f.document.dispatch('submit',form);f.document.dispatch('submit',form);await settle();
 assert.equal(f.calls.filter(call=>call.action==='chat').length,1);assert.equal(f.find('[data-ki-action="new"]').disabled,true);assert.equal(f.find('[data-ki-action="photo"]').disabled,true);assert.equal(f.find('.ki-mic').disabled,true);assert.notEqual(f.find('#ki-prompt').getAttribute('readonly'),null);
 f.click('#ki-menu-settings');assert.equal(f.find('#ki-provider').disabled,true);assert.equal(f.find('#ki-kind-notes').closest('fieldset').disabled,true);f.click('[data-ki-action="stop"]');assert(f.calls.some(call=>call.action==='cancel'));
 release({ok:true,value:{content:JSON.stringify({type:'answer',text:'Diese verspätete Antwort darf nicht erscheinen.',citations:[]})}});await settle();assert.equal(f.view.isBusy(),false);assert.equal(f.find('.ki-mic').disabled,false);assert(!f.document.root.textContent.includes('Diese verspätete Antwort darf nicht erscheinen.'));assert.match(f.find('.ki-error').textContent,/Auftrag angehalten/);
});

test('disabling a knowledge kind removes prior answers and their stale source controls from the new chat',async t=>{
 let chats=0;const f=fixture(t,{ai:async()=>({ok:true,value:{content:JSON.stringify(++chats===1?{type:'tool',tool:'read_source',args:{id:'n:note'}}:{type:'answer',text:'Antwort aus der alten Notiz [n:note].',citations:['n:note']})}})});await f.ready();f.input('Lies die Notiz.');f.document.dispatch('submit',f.find('#ki-form'));await settle();const source=f.find('[data-ki-action="source"]');source.click();assert.equal(f.sources.length,1);
 f.input('Neuer Entwurf ohne Notizen.');f.click('#ki-menu-settings');f.change('#ki-kind-notes',false);await settle();assert.equal(f.document.querySelectorAll('.ki-message').length,0);assert.equal(f.document.querySelector('[data-ki-action="source"]'),null);assert.equal(f.find('#ki-prompt').value,'Neuer Entwurf ohne Notizen.');source.click();assert.equal(f.sources.length,1,'a stale source target cannot disclose the previous chat after the scope reset');
});

function platformFixture(t,{disable,live=false}={}){
 const url='https://miro.com/app/board/uXjVChatUITest=/',workspacePatch={projects:[{id:'alpha',name:'Synthetic course',links:[{id:'board',tool:'miro',title:'Course board',url}]}]},catalog=platformCatalog(workspacePatch),source=catalog[0],doc={id:'miro:'+'a'.repeat(64)+':part0',kind:'miro',service:'miro',source:'Miro',sourceId:source.id,projectId:'alpha',title:'Miro-Aufgabenstellung',text:'PLATFORM_PRIVATE_KNOWLEDGE_MARKER',status:'full',boardURL:url,boardId:'uXjVChatUITest=',itemId:'1001',url:url+'?moveToWidget=1001'},calls=[];let turns=0;
 const f=fixture(t,{workspacePatch,platformSources:[doc],onPlatform:async(...args)=>{calls.push(args);return {documents:[doc],result:{results:[{id:doc.id,title:doc.title,text:doc.text,status:'full'}]}};},ai:async message=>{
  if(disable==='platforms')assert.doesNotMatch(JSON.stringify(message.body.messages),/PLATFORM_PRIVATE_KNOWLEDGE_MARKER/);
  return {ok:true,value:{content:JSON.stringify(++turns===1?{type:'tool',tool:'read_platform',args:{sourceId:source.id}}:{type:'answer',text:'Belegt ['+doc.id+']',citations:[doc.id]})}};
 }});
 return {f,doc,calls,live};
}
test('platform knowledge group counts actual Miro sources and labels source controls clearly',async t=>{
 const {f,doc,calls}=platformFixture(t);await f.ready();const label=f.find('#ki-kind-platforms').closest('label');assert.equal(label.querySelector('strong').textContent,'1');assert.match(label.textContent,/Boards & Kursdienste/);
 f.input('Lies die Miro-Aufgabenstellung.');f.document.dispatch('submit',f.find('#ki-form'));await settle();assert.equal(calls.length,1);
 const control=f.document.querySelectorAll('[data-ki-action="source"]').find(node=>node.dataset.id===doc.id);assert(control);assert.match(control.textContent,/Miro/);assert.doesNotMatch(control.textContent,/undefined/);control.click();assert.equal(f.sources.at(-1).url,doc.url);
});
test('platform opt-out keeps a draft but removes its knowledge and blocks native platform callbacks',async t=>{
 const {f,calls}=platformFixture(t,{disable:'platforms'});await f.ready();const old=f.find('.ki-thread').dataset.viewportKey,prompt=f.input('Mein Entwurf bleibt.');prompt.setSelectionRange(2,8,'forward');
 f.click('#ki-menu-settings');f.change('#ki-kind-platforms',false);await settle();assert.notEqual(f.find('.ki-thread').dataset.viewportKey,old);assert.equal(f.find('#ki-prompt').value,'Mein Entwurf bleibt.');assert.deepEqual([f.find('#ki-prompt').selectionStart,f.find('#ki-prompt').selectionEnd],[2,8]);
 f.document.dispatch('submit',f.find('#ki-form'));await settle();assert.equal(calls.length,0);assert.equal(f.document.querySelector('[data-ki-action="source"]'),null);
});
test('live platform opt-out keeps cached knowledge available but never starts a native read',async t=>{
 const {f,calls}=platformFixture(t,{disable:'live'});await f.ready();f.input('Lies die bekannte Miro-Aufgabenstellung.');f.click('#ki-menu-settings');f.change('#ki-browser-enabled',false);await settle();
 assert.equal(f.find('#ki-kind-platforms').checked,true);f.document.dispatch('submit',f.find('#ki-form'));await settle();assert.equal(calls.length,0);assert(f.document.querySelector('[data-ki-action="source"]'));
});

test('missing local speech model reveals settings and the download action without starting capture',async t=>{
 const f=fixture(t,{speechInstalled:false});await f.ready();f.click('.ki-mic');await settle();assert.equal(f.captureStarts,0);assert.equal(f.find('#ki-settings-panel').hidden,false);assert.equal(f.find('#ki-menu-settings').getAttribute('aria-expanded'),'true');assert.notEqual(f.find('#ki-speech-settings').getAttribute('open'),null);f.find('[data-speech-action="download"]');assert.match(f.find('.ki-live-status').textContent,/Lade zuerst das Sprachmodell/);assert.equal(f.calls.filter(call=>call.action==='chat').length,0);
});

test('usage discovery is read-only and a provider failure leaves the live composer and draft usable',async t=>{
 const f=fixture(t,{usageRequest:async()=>({ok:false,error:'PRIVATE provider error'})});await f.ready();
 assert(f.calls.some(call=>call.action==='usage'&&call.provider==='local'&&/^[a-f0-9-]{36}$/i.test(call.id)));
 assert.equal(f.calls.filter(call=>call.action==='chat').length,0);assert.match(f.find('#ki-usage-toggle').textContent,/Limit nicht abrufbar/);assert.equal(f.find('.ki-send').disabled,false);
 const prompt=f.input('Mein Entwurf bleibt trotz Limitfehler.');prompt.setSelectionRange(3,12);f.click('#ki-usage-toggle');await settle();
 assert.equal(f.find('#ki-prompt').value,prompt.value);assert.deepEqual([f.find('#ki-prompt').selectionStart,f.find('#ki-prompt').selectionEnd],[3,12]);assert.equal(f.find('#ki-usage-panel').hidden,false);assert.doesNotMatch(f.find('#ki-usage-panel').textContent,/PRIVATE/);assert.equal(f.calls.filter(call=>call.action==='chat').length,0);
 f.document.dispatch('keydown',f.document.activeElement,{key:'Escape'});assert.equal(f.find('#ki-usage-panel').hidden,true);assert.equal(f.document.activeElement.id,'ki-usage-toggle');
});

test('actual model selection uses the free counter only for free variants and the budget for paid models',async t=>{
 const f=fixture(t,{models:[{id:'paid/model'},{id:'test/model:free'}],usageRequest:async message=>({ok:true,value:message.provider==='local'?{provider:'local',status:'not_applicable'}:{provider:'openrouter',status:'available',checkedAt:'2026-10-14T12:00:00Z',keyBudget:{limit:10,remaining:5,resetInterval:'monthly'},freeRequests:{used:12,limit:50,remaining:38}}})});await f.ready();
 f.click('#ki-menu-settings');f.change('#ki-provider','openrouter');await settle();assert.match(f.find('#ki-usage-toggle').textContent,/5,00 US\$/);
 const before=f.calls.filter(call=>call.action==='usage').length;f.change('#ki-model','test/model:free');assert.match(f.find('#ki-usage-toggle').textContent,/38 \/ 50 frei/);assert.equal(f.calls.filter(call=>call.action==='usage').length,before,'model selection reuses the provider metadata');
 f.click('#ki-usage-toggle');await settle();assert.equal(f.find('#ki-usage-panel').hidden,false);assert.match(f.find('#ki-usage-panel').textContent,/kein Kontoguthaben/);assert.equal(f.find('#ki-usage-refresh').disabled,false);f.find('#ki-usage-panel').querySelector('[data-ki-action="menu-close"]').click();assert.equal(f.document.activeElement.id,'ki-usage-toggle');
});

test('provider change clears the old dollar budget before the next model discovery finishes',async t=>{
 let pending;const f=fixture(t,{usageRequest:async message=>({ok:true,value:message.provider==='openrouter'?{provider:'openrouter',status:'available',keyBudget:{limit:10,remaining:5,resetInterval:null}}:{provider:message.provider,status:'unknown'}})});await f.ready();
 f.click('#ki-menu-settings');f.change('#ki-provider','openrouter');await settle();assert.match(f.find('#ki-usage-toggle').textContent,/5,00 US\$/);
 f.change('#ki-provider','kiconnect');assert.equal(f.view.configuration().provider,'kiconnect');assert.doesNotMatch(f.find('#ki-usage-toggle').textContent,/US\$|Cloud-Limit/);await settle();assert.match(f.find('#ki-usage-toggle').textContent,/Limit unbekannt/);
});
