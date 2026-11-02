import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {createWhatsAppNotifications,whatsappNotificationScript} from '../desktop/whatsapp-notifications.mjs';
import {namedChatId} from '../desktop/chat-filter.mjs';
const entry=title=>({id:namedChatId(title),title});
const selection=[entry('Course group')];
function domRow(title,{count=1,preview='Selected preview',privateBody=false}={}){
 return {getAttribute:()=>'',querySelector:selector=>{
  if(selector==='span[title]')return {getAttribute:()=>title};
  if(selector.includes('icon-unread-count'))return count?{getAttribute:()=>count+' ungelesene Nachrichten',textContent:String(count)}:null;
  if(selector.includes('cell-frame-secondary')){if(privateBody)throw Error('An unselected private body was accessed');return {innerText:preview};}return null;
 }};
}
function dom({rows=[domRow('Course group'),domRow('Private person',{privateBody:true})],owner='"123456789:0@c.us"',pane=true}={}){
 return {location:{origin:'https://web.whatsapp.com'},document:{querySelector:()=>pane?{querySelectorAll:()=>rows}:null},localStorage:{getItem:()=>owner},crypto:webcrypto,TextEncoder,Uint8Array};
}
test('isolated WhatsApp reader accesses only selected chat previews and hashes its own identity',async()=>{
 const value=await vm.runInNewContext(whatsappNotificationScript(selection),dom());assert.equal(value.state,'snapshot');assert.equal(value.rows.length,1);assert.equal(value.rows[0].preview,'Selected preview');assert.equal(value.rows[0].count,1);assert.match(value.account,/^[a-f0-9]{64}$/);assert(!JSON.stringify(value).includes('123456789'));assert(!JSON.stringify(value).includes('Private person'));
});
test('missing account proof and a logged-out chatlist never expose previews',async()=>{
 for(const options of [{owner:'unknown'},{pane:false}]){const value=await vm.runInNewContext(whatsappNotificationScript(selection),dom(options));assert.equal(value.rows,undefined);assert.notEqual(value.state,'snapshot');}
});
test('same-name rows are explicitly ambiguous instead of guessing a private conversation',async()=>{
 const value=await vm.runInNewContext(whatsappNotificationScript(selection),dom({rows:[domRow('Course group'),domRow('Course group')]}));assert.equal(value.rows.length,0);assert.equal(value.ambiguous.length,1);
});
test('WhatsApp reader does not click, navigate, scroll, or query a provider API',async()=>{
 const context=dom();context.fetch=()=>{throw Error('Unexpected provider request');};context.document.querySelector=()=>({querySelectorAll:()=>[{...domRow('Course group'),click(){throw Error('Unexpected chat open');}}]});
 const value=await vm.runInNewContext(whatsappNotificationScript(selection),context);assert.equal(value.rows.length,1);
});
function nativeFixture(){
 let context={id:'wa',epoch:1,url:'https://web.whatsapp.com/'},owner='"123456789@c.us"',rows=[domRow('Course group')],selected=selection;
 const changes=[],timers={setTimeout:()=>({unref(){}}),clearTimeout(){}};
 const contents={isDestroyed:()=>false,getURL:()=>context?.url||'',executeJavaScriptInIsolatedWorld:async(_world,scripts)=>vm.runInNewContext(scripts[0].code,dom({owner,rows}))};context.webContents=contents;
 const adapter=createWhatsAppNotifications({getContext:()=>context,getSelection:()=>selected,timers,onAccountChange:value=>changes.push(value),now:()=>Date.parse('2026-10-14T12:00:00Z')});
 return {adapter,changes,setRows:value=>rows=value,setOwner:value=>owner=value,setSelection:value=>selected=value,close:()=>context=null,navigate:()=>context.epoch++};
}
test('normalized WhatsApp snapshots contain opaque stable groups and no raw phone/chat identifiers',async()=>{
 const f=nativeFixture(),one=await f.adapter.read(),two=await f.adapter.read();assert.equal(one.status,'snapshot');assert.equal(one.complete,false);assert.equal(one.items[0].id,two.items[0].id);assert.equal(one.items[0].revision,two.items[0].revision);assert.equal(one.items[0].createdAt,'');assert.equal(one.items[0].timeKind,'observed');assert.match(one.items[0].selectionId,/^[a-f0-9]{32}$/);assert(!JSON.stringify(one).includes('123456789'));f.adapter.dispose();
});
test('off-screen previews remain stale while observed zero-unread chats are removed',async()=>{
 const f=nativeFixture(),one=await f.adapter.read();f.setRows([]);const offscreen=await f.adapter.read({previous:one.items});assert.equal(offscreen.items.length,1);assert.equal(offscreen.items[0].stale,true);
 f.setRows([domRow('Course group',{count:0})]);const read=await f.adapter.read({previous:one.items});assert.equal(read.items.length,0);f.adapter.dispose();
});
test('account switching or closing a tab revokes the previous identity and cannot retain old preview rows',async()=>{
 const f=nativeFixture();await f.adapter.account();const one=await f.adapter.read();f.setOwner('"987654321@c.us"');await f.adapter.account();assert.deepEqual(f.changes,['whatsapp']);f.setRows([]);assert.equal((await f.adapter.read({previous:one.items})).items.length,0);f.close();await f.adapter.account();assert.equal(f.changes.length,2);assert.equal((await f.adapter.read()).status,'not_configured');f.adapter.dispose();
});
test('deselection and invalid selection cannot widen read scope to other conversations',async()=>{
 const f=nativeFixture(),one=await f.adapter.read();f.setSelection([]);assert.equal((await f.adapter.read({previous:one.items})).items.length,0);f.setSelection([{id:'name:bad',title:'Private person'}]);await assert.rejects(f.adapter.read(),{code:'INVALID_SELECTION'});f.adapter.dispose();
});
test('navigation during the isolated-world response rejects the old view snapshot',async()=>{
 const f=nativeFixture(),read=f.adapter.read();f.navigate();await assert.rejects(read,{code:'ACCOUNT_CHANGED'});f.adapter.dispose();
});
test('a storage account switch cannot relabel a stale existing DOM pane as the new owner',async()=>{
 const pane={querySelectorAll:()=>[domRow('Course group')]};let owner='"123456789@c.us"';const context=dom();context.document.querySelector=()=>pane;context.localStorage.getItem=()=>owner;vm.createContext(context);
 assert.equal((await vm.runInContext(whatsappNotificationScript(selection),context)).state,'snapshot');owner='"987654321@c.us"';const changed=await vm.runInContext(whatsappNotificationScript(selection),context);assert.equal(changed.state,'unverified_account');assert.equal(changed.rows,undefined);
});
test('a hidden tab without an observed owner binding cannot admit old rendered conversations',async()=>{
 const context=dom();context.document.visibilityState='hidden';const value=await vm.runInNewContext(whatsappNotificationScript(selection),context);assert.equal(value.state,'unverified_account');assert.equal(value.rows,undefined);
});
