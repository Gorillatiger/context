import test from 'node:test';import assert from 'node:assert/strict';
import {captureChatViewport,restoreChatViewport,scrollChatViewport} from '../dist/chat-viewport.js';
function fixture(key='chat-a@course-a',overflow='auto'){
 const moves=[],host={scrollTop:120,clientHeight:300,scrollHeight:1000,scrollTo:args=>{moves.push(args.top);host.scrollTop=args.top;}};
 const thread={...host,dataset:{viewportKey:key},closest:()=>host};
 if(overflow!=='visible')Object.assign(host,{dataset:thread.dataset,closest:()=>host});
 const doc={querySelector:()=>overflow==='visible'?thread:host},style=()=>({overflowY:overflow});return {host,doc,style,moves};
}
test('passive rerender keeps a reader above the bottom at the same position',()=>{const before=fixture(),after=fixture();const saved=captureChatViewport(before.doc,before.style);after.host.scrollHeight=1400;restoreChatViewport(saved,after.doc,after.style);scrollChatViewport(false,after.doc,after.style);assert.equal(after.host.scrollTop,120);assert.deepEqual(after.moves,[]);});
test('a reader at the bottom follows appended messages and work steps',()=>{const before=fixture(),after=fixture();before.host.scrollTop=700;const saved=captureChatViewport(before.doc,before.style);after.host.scrollHeight=1400;restoreChatViewport(saved,after.doc,after.style);assert.equal(after.host.scrollTop,1400);});
test('only an explicit send forces the chat to the latest message',()=>{const f=fixture();scrollChatViewport(true,f.doc,f.style);assert.deepEqual(f.moves,[1000]);});
test('a different course or chat does not inherit another chat reading position',()=>{const before=fixture(),after=fixture('chat-b@course-b');after.host.scrollTop=0;restoreChatViewport(captureChatViewport(before.doc,before.style),after.doc,after.style);assert.equal(after.host.scrollTop,0);});
test('mobile flow preserves the workspace scroller when the thread overflow is visible',()=>{const before=fixture('chat-a','visible'),after=fixture('chat-a','visible');restoreChatViewport(captureChatViewport(before.doc,before.style),after.doc,after.style);assert.equal(after.host.scrollTop,120);scrollChatViewport(false,after.doc,after.style);assert.deepEqual(after.moves,[]);});
test('expanded source and work-step details survive passive rendering only in the same chat',()=>{
 const before=fixture(),after=fixture();const old={dataset:{chatDetail:'step-source-1'},open:true},next={dataset:{chatDetail:'step-source-1'},open:false};
 before.host.querySelectorAll=()=>[old];after.host.querySelectorAll=()=>[next];
 const saved=captureChatViewport(before.doc,before.style);restoreChatViewport(saved,after.doc,after.style);assert.equal(next.open,true);
 next.open=false;after.host.dataset.viewportKey='different-chat';restoreChatViewport(saved,after.doc,after.style);assert.equal(next.open,false);
});
