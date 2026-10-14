import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailView} from '../dist/mail.js';

// Exercise the real view/contact/combobox boundary using synthetic server data.
// Every request is intercepted; these tests never access an account or send mail.
const tick = () => new Promise(resolve => setImmediate(resolve));
const decode = value => String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[name]);
const attr = (source, name) => decode(source.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] || '');
const person = (address, name='') => ({address, name});
const row = (uid, address, name='', patch={}) => ({uid, subject:'Synthetic '+uid, sender:address, from:[person(address,name)], date:'2026-10-14T12:00:00Z', unread:false, ...patch});
const detail = (uid, address, patch={}) => ({...row(uid,address), uidValidity:'123', to:[], cc:[], replyTo:[], text:'Synthetic body', attachments:[], messageId:`<${uid}@example.test>`, ...patch});
const listing = (items=[]) => ({items, uidValidity:'123', total:items.length, matched:items.length, nextOffset:null});
const status = (service, identity='a') => ({configured:true, address:identity+'@example.test', smtpReady:true, ...(service==='th'?{}:{accountKey:identity.repeat(64), capabilities:{mailSend:true,mailModify:true}})});
function deferred() {let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};}

function fixture(t, providers={th:{}}, initial='th') {
  const previous={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};
  const handlers=new Map(), nodes=new Map(), views=new Map(), requests=[], changes=[];
  let active=initial, html='';
  function makeNode(tag, source, value='') {
    const id=attr(source,'id'),attributes=new Map();
    const element={id,tagName:tag.toUpperCase(),value:decode(value),dataset:{mailField:attr(source,'data-mail-field'),mailContactOwner:attr(source,'data-mail-contact-owner')},hidden:/(?:^|\s)hidden(?:\s|$)/.test(source),selectionStart:decode(value).length,selectionEnd:decode(value).length,textContent:'',
      setAttribute(name,value){attributes.set(name,value);},removeAttribute(name){attributes.delete(name);},attributes,
      focus(){document.activeElement=element;},setSelectionRange(start,end){element.selectionStart=start;element.selectionEnd=end;},
      closest(){return null;}};
    let content='';Object.defineProperty(element,'innerHTML',{get:()=>content,set:value=>{content=value;for(const option of value.matchAll(/<button\b([^>]*)>/g)){const optionId=attr(option[1],'id');if(optionId)nodes.set(optionId,{id:optionId,scrollIntoView(){}});}}});
    if(id)nodes.set(id,element);return element;
  }
  function mount(content) {
    html=content;nodes.clear();
    for(const tag of content.matchAll(/<([a-z][\w-]*)\b([^>]*\sid="[^"]+"[^>]*)>/gi))makeNode(tag[1],tag[2],attr(tag[2],'value'));
    for(const textarea of content.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g))makeNode('textarea',textarea[1],textarea[2]);
  }
  const document={activeElement:null,addEventListener(type,fn){handlers.set(type,[...(handlers.get(type)||[]),fn]);},getElementById:id=>nodes.get(id)||null};
  globalThis.document=document;globalThis.window={addEventListener(){}};
  globalThis.fetch=()=>{throw new Error('Recipient completion must not request the network.');};
  for(const [service,provider] of Object.entries(providers)) {
    let view;
    view=createMailView({service,isActive:()=>active===service,onChange(change){changes.push({service,...change});if(active===service)mount(view.render());},onConnection(){},request:async(action,body)=>{
      requests.push({service,action,body});
      const answer=provider.request?.(action,body,requests);if(answer!==undefined)return answer;
      if(action==='status')return provider.status||status(service);
      if(action==='folders')return {folders:[{id:service==='th'?'SU5CT1g':'INBOX',kind:'inbox',label:'Synthetic Inbox'}]};
      if(action==='list')return listing(provider.items);
      if(action==='message')return detail(body.uid,'reader@example.test');
      if(action==='connection')return {configured:false};
      if(action==='send')return {accepted:1,refused:[],sentCopySaved:true};
      throw new Error('Unexpected synthetic request '+action);
    }});views.set(service,view);
  }
  const dispatch=(type,target,patch={})=>{const event={target,...patch,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};for(const listener of handlers.get(type)||[]){listener(event);if(event.stopped)break;}return event;};
  const click=(action,id)=>{const button={dataset:{mailAction:action,id},closest:selector=>selector==='[data-mail-action]'?button:null};return dispatch('click',button);};
  const input=(field,value,cursor=value.length)=>{const node=nodes.get('mail-'+field);assert.ok(node,'Rendered input '+field);node.value=value;node.selectionStart=node.selectionEnd=cursor;dispatch('input',node);return node;};
  const key=(key,field='to',patch={})=>dispatch('keydown',nodes.get('mail-'+field),{key,...patch});
  const suggestions=(field='to')=>nodes.get('mail-'+field+'-contacts')?.innerHTML||'';
  t.after(()=>{Object.assign(globalThis,previous);});
  return {requests,changes,providers,views,nodes,dispatch,click,input,key,suggestions,
    get html(){return html;},get view(){return views.get(active);},get active(){return active;},
    activate(service){assert.ok(views.has(service));views.get(active).hideRecipientSuggestions();active=service;mount(views.get(service).render());},
    async load(){await views.get(active).load();await tick();},async flush(){await tick();},
    compose(){click('compose');},submit(){dispatch('submit',{id:'mail-compose'});},
  };
}

test('real view completion stays in RAM and selecting by Enter updates the draft without review or send',async t=>{
  const f=fixture(t,{th:{items:[row('1','beispiel@example.test','Alex Beispiel')]}});await f.load();f.compose();
  const calls=f.requests.length,changes=f.changes.length,input=f.input('to','alex bei');
  assert.match(f.suggestions(),/beispiel@example.test/);assert.equal(f.requests.length,calls);assert.equal(f.changes.length,changes,'typing must preserve the existing composer DOM');
  const event=f.key('Enter');assert.equal(event.prevented,true);assert.equal(event.stopped,true);assert.equal(input.value,'beispiel@example.test');assert.equal(f.nodes.get('mail-to'),input);assert.equal(f.suggestions(),'');
  assert.doesNotMatch(f.html,/VOR DEM VERSAND/);assert.equal(f.requests.length,calls);
  f.input('subject','Synthetic subject');f.input('text','Synthetic body');f.submit();
  assert.match(f.html,/VOR DEM VERSAND/);assert.match(f.html,/beispiel@example.test/);assert.equal(f.requests.filter(r=>r.action==='send').length,0);
});

test('the view learns current delivered headers only, never body addresses, Bcc or incomplete TH names',async t=>{
  const message=detail('1','from@example.test',{to:[person('visible@example.test','Visible recipient')],cc:[person('copy@example.test','Copy recipient')],replyTo:[person('reply@example.test','Reply recipient')],text:'body-only@example.test',sender:'firstname.lastname'});
  Object.defineProperty(message,'bcc',{get(){throw new Error('Bcc must never be inspected.');}});
  const f=fixture(t,{th:{items:[row('1','from@example.test')],request:action=>action==='message'?message:undefined}});await f.load();f.click('open','1');await f.flush();f.compose();
  for(const [query,address] of [['Visible','visible@example.test'],['Copy','copy@example.test'],['Reply','reply@example.test']]){f.input('to',query);assert.match(f.suggestions(),new RegExp(address));}
  for(const query of ['body-only','firstname.lastname','no.complete.address']){f.input('to',query);assert.equal(f.suggestions(),'');f.key('Enter');assert.equal(f.nodes.get('mail-to').value,query);}
});

test('a new selection in Cc invalidates an already visible To choice and excludes it from Bcc',async t=>{
  const f=fixture(t,{th:{items:[row('1','alex@example.test','Alex')]}});await f.load();f.compose();f.input('to','alex');assert.match(f.suggestions(),/alex@example.test/);
  // A separate controlled input update can occur before the old option is chosen.
  f.input('cc','ALEX@example.test');const event=f.key('Enter');assert.equal(event.prevented,true);assert.equal(f.nodes.get('mail-to').value,'alex');
  f.input('bcc','alex');assert.equal(f.suggestions('bcc'),'');assert.equal(f.nodes.get('mail-cc').value,'ALEX@example.test');
});

for(const service of ['th','outlook','gmail'])test(`${service} reconnect drops old and late contacts while preserving a local draft`,async t=>{
  const pending=deferred();let held=false,holdNext=false;
  const provider={status:status(service),items:[row('1','old-only@example.test','Old only')],request:action=>{if(action==='list'&&holdNext){holdNext=false;held=true;return pending.promise;}}};
  const f=fixture(t,{[service]:provider},service);await f.load();f.compose();f.input('to','old-only');assert.match(f.suggestions(),/old-only@example.test/);f.input('subject','Keep local draft');
  holdNext=true;const previous=f.view.load(true);await f.flush();assert.equal(held,true);
  provider.status=status(service,'b');provider.items=[row('2','new-only@example.test','New only')];await f.view.refreshConnection();await f.flush();
  pending.resolve(listing([row('stale','stale-only@example.test','Stale only')]));await previous;await f.flush();
  assert.equal(f.nodes.get('mail-subject').value,'Keep local draft');
  for(const query of ['old-only','stale-only']){f.input('to',query);assert.equal(f.suggestions(),'','Previous generation must not repopulate contacts');}
  f.input('to','new-only');assert.match(f.suggestions(),/new-only@example.test/);f.key('Enter');assert.equal(f.nodes.get('mail-to').value,'new-only@example.test');
});

test('late detail headers cannot add contacts after the user returns to composing',async t=>{
  const pending=deferred();const f=fixture(t,{th:{items:[row('1','current@example.test')],request:action=>action==='message'?pending.promise:undefined}});await f.load();f.click('open','1');await f.flush();f.compose();f.input('text','Still typing');
  pending.resolve(detail('1','late-only@example.test',{replyTo:[person('late-reply@example.test')]}));await f.flush();
  assert.equal(f.nodes.get('mail-text').value,'Still typing');for(const query of ['late-only','late-reply']){f.input('to',query);assert.equal(f.suggestions(),'');}
  f.input('to','current');assert.match(f.suggestions(),/current@example.test/);
});

test('TH, Outlook and Gmail views retain independent account suggestions without fetching while switching',async t=>{
  const f=fixture(t,Object.fromEntries(['th','outlook','gmail'].map(service=>[service,{items:[row('1',service+'-contact@example.test','Shared teacher name')]}])));
  for(const service of ['th','outlook','gmail']){f.activate(service);await f.load();f.compose();f.input('to','shared teacher');assert.match(f.suggestions(),new RegExp(service+'-contact@example.test'));for(const other of ['th','outlook','gmail'].filter(value=>value!==service))assert.doesNotMatch(f.suggestions(),new RegExp(other+'-contact@example.test'));}
  const calls=f.requests.length;
  for(const service of ['gmail','outlook','th']){f.activate(service);f.input('to','shared teacher');assert.match(f.suggestions(),new RegExp(service+'-contact@example.test'));f.key('Enter');assert.equal(f.nodes.get('mail-to').value,service+'-contact@example.test');}
  assert.equal(f.requests.length,calls,'Provider switching/completion must not trigger new network calls');
});

test('only accepted To/Cc from a synthetic reviewed send become suggestions, never Bcc or refused recipients',async t=>{
  const f=fixture(t,{th:{items:[],request:action=>action==='send'?{accepted:3,refused:['refused@example.test'],sentCopySaved:true}:undefined}});await f.load();f.compose();
  f.input('to','accepted@example.test, refused@example.test');f.input('cc','copy@example.test');f.input('bcc','hidden-only@example.test');f.input('subject','Synthetic subject');f.input('text','Synthetic body');f.submit();assert.match(f.html,/VOR DEM VERSAND/);f.click('send');await f.flush();
  assert.equal(f.requests.filter(r=>r.action==='send').length,1);assert.equal(f.nodes.get('mail-to').value,'refused@example.test');f.click('discard');
  for(const query of ['hidden-only','refused']){f.input('to',query);assert.equal(f.suggestions(),'');}
  for(const [query,address] of [['accepted','accepted@example.test'],['copy','copy@example.test']]){f.input('to',query);assert.match(f.suggestions(),new RegExp(address));}
  f.click('disconnect');await f.flush();assert.doesNotMatch(f.html,/role="combobox"/);
});

test('a hidden previous provider option cannot mutate the active provider composer',async t=>{
  const f=fixture(t,{th:{items:[row('1','th-only@example.test')]},gmail:{items:[row('2','gmail-only@example.test')]}});await f.load();f.compose();f.input('to','th-only');
  const stale={dataset:{mailContact:'0',contactField:'to',contactOwner:'th'}};f.activate('gmail');await f.load();f.compose();f.input('to','gmail-only');
  f.dispatch('click',{closest:selector=>selector==='[data-mail-contact]'?stale:null});assert.equal(f.nodes.get('mail-to').value,'gmail-only');
  f.input('to','gmail-only');f.key('Enter');assert.equal(f.nodes.get('mail-to').value,'gmail-only@example.test');
});
