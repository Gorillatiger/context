import test from 'node:test';
import assert from 'node:assert/strict';
import {captureMailViewport,restoreMailViewport} from '../dist/mail-layout.js';
function fixture({listKey='INBOX:123::false:0',readerKey='INBOX:123:45',focus=''}={}){
 const elements=new Map();
 const add=(id,k,top=0)=>{const e={id,dataset:{mailScrollKey:k},scrollTop:top,scrollLeft:0,disabled:false,focus(o){this.focusOptions=o;doc.activeElement=this;},closest(s){if(s==='[data-mail-scroll-key]')return this.id==='mail-text'?elements.get('mail-reader'):this;if(s==='.mail-workspace,.mail-heading,.mail-setup')return{};return null;},setSelectionRange(a,b,d){this.selectionStart=a;this.selectionEnd=b;this.selectionDirection=d;this.scrollTop=999;}};elements.set(id,e);return e;};
 const doc={getElementById:id=>elements.get(id),querySelector:()=>null,querySelectorAll:()=>[...elements.values()],activeElement:null};
 add('mail-folder-nav','folders',76);add('mail-list',listKey,540);add('mail-reader',readerKey,1250);
 const t=add('mail-text','',90);t.selectionStart=22;t.selectionEnd=29;t.selectionDirection='backward';doc.activeElement=elements.get(focus)||null;
 return{doc,elements,add};
}
test('passive repaint keeps folder, list and reader positions and draft caret without copying text',()=>{
 const a=fixture({readerKey:'draft',focus:'mail-text'}),saved=captureMailViewport(a.doc);
 const b=fixture({readerKey:'draft'});for(const e of b.elements.values())e.scrollTop=0;
 restoreMailViewport(saved,b.doc);
 assert.equal(b.elements.get('mail-reader').scrollTop,1250);assert.equal(b.elements.get('mail-list').scrollTop,540);assert.equal(b.elements.get('mail-folder-nav').scrollTop,76);assert.equal(b.elements.get('mail-text').scrollTop,90);
 assert.equal(b.doc.activeElement.id,'mail-text');assert.deepEqual(b.doc.activeElement.focusOptions,{preventScroll:true});assert.deepEqual([b.doc.activeElement.selectionStart,b.doc.activeElement.selectionEnd,b.doc.activeElement.selectionDirection],[22,29,'backward']);
 assert.equal(JSON.stringify(saved).includes('value'),false);
});
test('a different folder, page or message starts fresh instead of inheriting unrelated scroll and focus',()=>{
 const a=fixture({focus:'mail-reader'}),saved=captureMailViewport(a.doc),b=fixture({listKey:'OTHER:123::false:40',readerKey:'OTHER:123:46'});
 for(const e of b.elements.values())e.scrollTop=0;
 restoreMailViewport(saved,b.doc);
 assert.equal(b.elements.get('mail-list').scrollTop,0);assert.equal(b.elements.get('mail-reader').scrollTop,0);assert.equal(b.doc.activeElement,null);assert.equal(b.elements.get('mail-folder-nav').scrollTop,76);
});
test('moving from draft to review resets the reading pane and does not restore an obsolete textarea focus',()=>{
 const a=fixture({readerKey:'draft',focus:'mail-text'}),saved=captureMailViewport(a.doc),b=fixture({readerKey:'review'});
 b.elements.delete('mail-text');b.elements.get('mail-reader').scrollTop=0;restoreMailViewport(saved,b.doc);
 assert.equal(b.elements.get('mail-reader').scrollTop,0);assert.equal(b.doc.activeElement,null);
});
test('an unlabelled mail action keeps focus through a refresh only in the same message',()=>{
 const a=fixture(),button=a.add('','INBOX:123:45');button.dataset={mailAction:'download',id:'2'};button.closest=s=>s==='[data-mail-scroll-key]'?a.elements.get('mail-reader'):{};a.doc.activeElement=button;
 const saved=captureMailViewport(a.doc),b=fixture(),replacement=b.add('','');replacement.dataset={mailAction:'download',id:'2'};restoreMailViewport(saved,b.doc);
 assert.equal(b.doc.activeElement,replacement);
 replacement.disabled=true;b.doc.activeElement=null;restoreMailViewport(saved,b.doc);assert.equal(b.doc.activeElement,null);
});
test('leaving mail or removing an area is harmless; no global scroll changes are made',()=>{
 const doc={getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],activeElement:null};
 assert.equal(captureMailViewport(doc),null);restoreMailViewport(null,doc);restoreMailViewport({areas:[{id:'mail-reader',key:'old',top:50,left:0}],focus:null},doc);
});
test('mobile hide/read/back keeps the previous list position even when hidden elements report zero',()=>{
 const a=fixture({listKey:'mobile-list'}),first=captureMailViewport(a.doc),hidden=fixture({listKey:'mobile-list'});
 hidden.elements.get('mail-list').getClientRects=()=>[];hidden.elements.get('mail-list').scrollTop=0;
 restoreMailViewport(first,hidden.doc);hidden.elements.get('mail-list').scrollTop=0;
 const next=captureMailViewport(hidden.doc),visible=fixture({listKey:'mobile-list'});visible.elements.get('mail-list').scrollTop=0;
 restoreMailViewport(next,visible.doc);assert.equal(visible.elements.get('mail-list').scrollTop,540);
});
test('a loading placeholder cannot overwrite the last list position during a refresh',()=>{
 const a=fixture({listKey:'refresh-list'}),first=captureMailViewport(a.doc),pending=fixture({listKey:'refresh-list'});
 pending.elements.get('mail-list').getAttribute=()=> 'true';pending.elements.get('mail-list').scrollTop=0;
 restoreMailViewport(first,pending.doc);pending.elements.get('mail-list').scrollTop=0;
 const next=captureMailViewport(pending.doc),loaded=fixture({listKey:'refresh-list'});loaded.elements.get('mail-list').scrollTop=0;
 restoreMailViewport(next,loaded.doc);assert.equal(loaded.elements.get('mail-list').scrollTop,540);
});
