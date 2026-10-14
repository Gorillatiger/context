import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatFilter,whatsappFilterURL,chatFilterSnapshot} from '../dist/chat-filter.js';
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
const rows=[{id:'one',title:'Code & Context',identity:'name'},{id:'two',title:'CoCo Gen 8',identity:'name'},{id:'private',title:'Familie',identity:'name'}];
function fixture({handler}={}){
 const calls=[];let value={supported:true,enabled:false,pickerOpen:false,selected:[],chats:rows,storage:'encrypted'};
 const bridge={chatFilter:async message=>{calls.push(message);if(handler)return handler(message,value);
  if(message.op==='picker')value={...value,pickerOpen:message.open};
  if(message.op==='set')value={...value,enabled:message.enabled,selected:message.selected};
  return {ok:true,value};
 }};
 const view=createChatFilter({bridge});view.setContext({id:'1',url:'https://web.whatsapp.com/'});
 return {view,calls};
}
test('filter is offered only on the exact HTTPS WhatsApp Web origin',()=>{
 assert.equal(whatsappFilterURL('https://web.whatsapp.com/'),true);
 for(const url of ['http://web.whatsapp.com/','https://web.whatsapp.com.evil.test/','https://web.whatsapp.com:444/','https://user@web.whatsapp.com/','https://spaces.th-koeln.de/','javascript:alert(1)'])assert.equal(whatsappFilterURL(url),false);
});
test('snapshot bounds untrusted metadata and never includes preview/message fields',()=>{
 const result=chatFilterSnapshot({chats:[{id:'a',title:'  Kurs\nA ',preview:'private content',message:'secret'},{id:'a',title:'Kurs B'},{id:'bad\0',title:'bad'},null],selected:[]});
 assert.deepEqual(result.chats,[{id:'a',title:'Kurs B',identity:'name'}]);assert.doesNotMatch(JSON.stringify(result),/secret|private content|preview|message/);
});
test('explicit selection commits once and temporarily restores the full WhatsApp list while editing',async()=>{
 const f=fixture();await tick();f.view.click('show');await tick();
 assert.equal(f.view.isOpen(),true);assert.equal(f.view.state().pickerOpen,true);
 f.view.change('one',true);f.view.click('apply');await tick();
 const writes=f.calls.filter(c=>c.op==='set');assert.equal(writes.length,1);assert.equal(writes[0].enabled,true);assert.deepEqual(writes[0].selected.map(r=>r.id),['one']);
 assert.equal(f.view.isOpen(),false);assert.equal(f.view.state().enabled,true);assert.deepEqual(f.calls.at(-1),{op:'picker',open:false});
});
test('CoCo suggestions are user-triggered, keep private chats unchecked and reject unknown checkbox IDs',async()=>{
 const f=fixture();await tick();assert.equal(f.view.state().draft.length,0);f.view.click('show');await tick();f.view.click('suggest');f.view.change('unknown',true);
 assert.deepEqual(f.view.state().draft.map(r=>r.id),['one','two']);assert.equal(f.calls.filter(c=>c.op==='set').length,0);
});
test('closing the picker discards uncommitted changes and keeps the saved focus',async()=>{
 const f=fixture();await tick();f.view.click('show');await tick();f.view.change('one',true);await f.view.hide();
 assert.equal(f.calls.filter(c=>c.op==='set').length,0);assert.equal(f.view.state().enabled,false);assert.equal(f.view.isOpen(),false);
 f.view.click('show');await tick();assert.equal(f.view.state().draft.length,0);
});
test('empty selection cannot activate focus; all chats disables filtering without deleting the selection',async()=>{
 const f=fixture();await tick();f.view.click('show');await tick();f.view.click('apply');await tick();assert.equal(f.calls.filter(c=>c.op==='set').length,0);
 f.view.change('one',true);f.view.click('apply');await tick();f.view.click('all');await tick();
 const last=f.calls.filter(c=>c.op==='set').at(-1);assert.equal(last.enabled,false);assert.equal(last.selected[0].id,'one');
});
test('late discovery cannot put WhatsApp metadata onto a different tool',async()=>{
 let release;const f=fixture({handler:async(message,value)=>message.op==='discover'?new Promise(resolve=>{release=resolve;}):({ok:true,value})});
 await tick();f.view.click('show');await tick();f.view.setContext({id:'2',url:'https://git.coco.study/'});release({ok:true,value:{supported:true,chats:rows}});await tick();
 assert.equal(f.view.renderPanel(),'');assert.equal(f.view.renderButton(),'');assert.equal(f.view.state().chats.length,0);
});
test('an old opening cannot close a newly reopened picker after rapid open-close-open',async()=>{
 let queue=Promise.resolve(),release,first=true,picker=false;
 const f=fixture({handler:(message,value)=>{
  const result=queue.then(async()=>{
   if(message.op==='picker'){
    if(message.open&&first){first=false;await new Promise(resolve=>{release=resolve;});}
    picker=message.open;
   }
   return {ok:true,value:{...value,pickerOpen:picker}};
  });queue=result.catch(()=>{});return result;
 }});
 await tick();f.view.click('show');await tick();void f.view.hide();f.view.click('show');release();await tick();
 assert.equal(f.view.isOpen(),true);assert.equal(picker,true);assert.deepEqual(f.calls.filter(c=>c.op==='picker').map(c=>c.open),[true,false,true]);
});
test('a same-URL reload or native picker reset closes the host picker instead of covering the normal list',async()=>{
 const f=fixture();await tick();f.view.click('show');await tick();assert.equal(f.view.isOpen(),true);
 f.view.setContext({id:'1',url:'https://web.whatsapp.com/',loading:true});await tick();assert.equal(f.view.isOpen(),false);
 f.view.setContext({id:'1',url:'https://web.whatsapp.com/',loading:false});await tick();f.view.click('show');await tick();
 f.view.receive({supported:true,enabled:true,pickerOpen:false,selected:[],chats:rows});assert.equal(f.view.isOpen(),false);
});
test('UI escapes chat names and metadata attributes; local search does not make native requests',async()=>{
 const f=fixture({handler:async(message,value)=>({ok:true,value:{...value,chats:[{id:'a" onclick="bad',title:'<img src=x onerror=bad>'}]}})});
 await tick();f.view.click('show');await tick();const before=f.calls.length;f.view.search('<img');assert.equal(f.calls.length,before);
 const html=f.view.renderPanel();assert.doesNotMatch(html,/<img src=x|data-cf-chat="a" onclick=/);assert.match(html,/&lt;img/);
});
test('failed commit remains reviewable and can be retried; it never sends a chat message',async()=>{
 let failed=true;const f=fixture({handler:async(message,value)=>message.op==='set'&&failed?{ok:false,error:'Nicht gespeichert'}:{ok:true,value}});
 await tick();f.view.click('show');await tick();f.view.change('one',true);f.view.click('apply');await tick();assert.equal(f.view.isOpen(),true);assert.match(f.view.renderPanel(),/Nicht gespeichert/);
 failed=false;f.view.click('apply');await tick();assert.equal(f.view.isOpen(),false);
 assert.ok(f.calls.every(call=>['status','picker','discover','set'].includes(call.op)));
});
