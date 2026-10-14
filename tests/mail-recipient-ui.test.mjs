import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailContacts} from '../dist/mail-contacts.js';
import {createMailRecipientUI} from '../dist/mail-recipient-ui.js';

function fixture(){
  const contacts=createMailContacts();let account='th:synthetic:1',enabled=true;contacts.setAccount(account);
  contacts.ingest([{from:[{name:'Anna Beispiel',address:'anna.maxwell@example.test'},{name:'Anne Beispiel',address:'anne@example.test'},{name:'<img src=x onerror=bad()>',address:'safe@example.test'}]}]);
  const draft={to:'',cc:'',bcc:''},nodes=new Map(),listeners=new Map(),selected=[];
  const doc={getElementById:id=>nodes.get(id),addEventListener:(type,handler)=>listeners.set(type,[...(listeners.get(type)||[]),handler]),removeEventListener:(type,handler)=>listeners.set(type,(listeners.get(type)||[]).filter(value=>value!==handler))};
  for(const field of ['to','cc','bcc']){
    const attributes=new Map(),input={id:'mail-'+field,dataset:{mailField:field,mailContactOwner:'th'},value:'',selectionStart:0,selectionEnd:0,setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key),focus:()=>doc.activeElement=input,setSelectionRange:(a,b)=>{input.selectionStart=a;input.selectionEnd=b;}};
    input.attributes=attributes;nodes.set(input.id,input);nodes.set(input.id+'-contacts',{hidden:true,innerHTML:''});nodes.set(input.id+'-contact-status',{textContent:''});
  }
  const ui=createMailRecipientUI({contacts,owner:'th',getDraft:()=>draft,getAccount:()=>account,enabled:()=>enabled,onSelect:(field,value)=>{selected.push({field,value});draft[field]=value;},document:doc});
  const dispatch=(type,target,patch={})=>{const event={target,...patch,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};for(const handler of listeners.get(type)||[]){handler(event);if(event.stopped)break;}return event;};
  const input=(value,{field='to',cursor=value.length,end=cursor,isComposing=false}={})=>{const node=nodes.get('mail-'+field);draft[field]=value;node.value=value;node.selectionStart=cursor;node.selectionEnd=end;dispatch('input',node,{isComposing});return node;};
  const key=(name,field='to',patch={})=>dispatch('keydown',nodes.get('mail-'+field),{key:name,...patch});
  return {contacts,draft,nodes,ui,listeners,selected,dispatch,input,key,account:value=>{account=value;contacts.setAccount(value);},enabled:value=>enabled=value};
}

test('recipient fields expose named combobox/listbox relationships and escape all displayed metadata',()=>{
  const f=fixture();try{const html=f.ui.render('to','" autofocus onclick=bad()','An');assert.match(html,/role="combobox"/);assert.match(html,/aria-controls="mail-to-contacts"/);assert.match(html,/role="listbox" aria-label="Kontaktvorschläge für An" hidden/);assert.match(html,/value="&quot; autofocus onclick=bad\(\)"/);f.input('safe');const list=f.nodes.get('mail-to-contacts');assert.equal(list.hidden,false);assert.match(list.innerHTML,/&lt;img src=x onerror=bad\(\)&gt;/);assert.doesNotMatch(list.innerHTML,/<img/);assert.match(list.innerHTML,/safe@example.test/);assert.match(list.innerHTML,/type="button" role="option"/);}finally{f.ui.dispose();}
});

test('typing preserves the active input; Enter chooses a real address and consumes the key without a form submission',()=>{
  const f=fixture();try{const input=f.input('anna.maxwell');const node=input;assert.equal(input.attributes.get('aria-expanded'),'true');const event=f.key('Enter');assert.equal(event.prevented,true);assert.equal(event.stopped,true);assert.equal(f.draft.to,'anna.maxwell@example.test');assert.equal(input.value,f.draft.to);assert.equal(f.nodes.get('mail-to'),node);assert.equal(f.nodes.get('mail-to-contacts').hidden,true);assert.equal(f.selected.length,1);assert.equal(input.selectionStart,input.value.length);}finally{f.ui.dispose();}
});

test('multiple matches require explicit arrow selection and Escape leaves the typed text intact',()=>{
  const f=fixture();try{f.input('ann');f.key('Enter');assert.equal(f.selected.length,0);f.key('ArrowDown');assert.equal(f.nodes.get('mail-to').attributes.get('aria-activedescendant'),'mail-to-contact-0');f.key('ArrowUp');assert.equal(f.nodes.get('mail-to').attributes.get('aria-activedescendant'),'mail-to-contact-1');const before=f.draft.to;assert.equal(f.key('Escape').prevented,true);assert.equal(f.draft.to,before);assert.equal(f.nodes.get('mail-to-contacts').hidden,true);assert.equal(f.selected.length,0);}finally{f.ui.dispose();}
});

test('selection replaces only a middle recipient and excludes existing An/Cc/Bcc addresses',()=>{
  const f=fixture();try{const value='first@example.test; anna.maxwell, last@example.test';f.input(value,{cursor:value.indexOf(',')});f.key('Enter');assert.equal(f.draft.to,'first@example.test; anna.maxwell@example.test, last@example.test');f.draft.bcc='anne@example.test';f.input('ann',{field:'cc'});assert.equal(f.nodes.get('mail-cc-contacts').hidden,true);assert.equal(f.draft.bcc,'anne@example.test');}finally{f.ui.dispose();}
});

test('inactive account, changed recipient text or account replacement refuses a previously displayed option',()=>{
  for(const change of ['disabled','draft','account']){const f=fixture();try{f.input('anna.maxwell');if(change==='disabled')f.enabled(false);if(change==='draft')f.draft.to='changed@example.test';if(change==='account')f.account('th:other:2');f.key('Enter');assert.equal(f.selected.length,0);if(change==='draft')assert.equal(f.draft.to,'changed@example.test');}finally{f.ui.dispose();}}
});

test('composition is respected, blank fields do not open a panel, and unselected Enter never submits',()=>{
  const f=fixture();try{const input=f.input('');assert.equal(f.nodes.get('mail-to-contacts').hidden,true);assert.equal(f.key('Enter').prevented,true);f.dispatch('compositionstart',input);f.input('anna',{isComposing:true});assert.equal(f.nodes.get('mail-to-contacts').hidden,true);assert.equal(f.key('Enter','to',{isComposing:true}).prevented,false);f.dispatch('compositionend',input);assert.equal(f.nodes.get('mail-to-contacts').hidden,false);assert.equal(f.selected.length,0);}finally{f.ui.dispose();}
});

test('mouse selection and disposal preserve local draft semantics without retaining event listeners',()=>{
  const f=fixture();f.input('anna.maxwell');const option={dataset:{mailContact:'0',contactField:'to',contactOwner:'th'}};const event=f.dispatch('click',{closest:selector=>selector==='[data-mail-contact]'?option:null});assert.equal(event.prevented,true);assert.equal(f.draft.to,'anna.maxwell@example.test');f.ui.dispose();assert.ok([...f.listeners.values()].every(list=>list.length===0));f.ui.dispose();
});
