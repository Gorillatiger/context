import test from 'node:test';
import assert from 'node:assert/strict';
import {createFloatingAgent} from '../dist/floating-agent.js';
import {createKIView} from '../dist/ki.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
function replace(t,key,value){const descriptor=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>{if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});}
const decode=value=>String(value).replace(/&(amp|lt|gt|quot|#39);/g,(_,name)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[name]);

function fixture(t,{visibleOverflow=false}={}){
  const listeners=new Map(),nodes=new Map(),surfaces=[];
  const state={scope:'alpha',chatId:'chat-alpha',height:1200,client:400,rows:true};
  let panel,document;
  class Textarea {
    constructor(id,value=''){this.id=id;this.value=value;this.selectionStart=0;this.selectionEnd=0;this.selectionDirection='none';}
    focus(){document.activeElement=this;}
    setSelectionRange(start,end,direction){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}
  }
  const geometry=()=>{
    let top=0;
    return {clientHeight:state.client,scrollHeight:state.height,scrollLeft:0,get scrollTop(){return top;},set scrollTop(value){top=Math.max(0,Math.min(Number(value)||0,Math.max(0,this.scrollHeight-this.clientHeight)));},scrollTo({top:value}){this.scrollTop=value;}};
  };
  function element(){
    const value={id:'',hidden:false,isConnected:true,parentElement:null,classList:{add(){},toggle(){}},setAttribute(){},addEventListener(){},focus(){document.activeElement=value;},closest(){return null;},append(child){child.parentElement=this;},contains(node){return node?.owner===value;},querySelector(selector){
      if(selector==='.ki-thread')return value.thread||null;
      if(selector==='.ki-message,.ki-thinking')return value.hasRows?{}:null;
      if(selector==='.ki-context-options')return value.options||null;
      if(selector==='#ki-history')return value.history||null;
      if(selector==='#ki-prompt,#ki-key')return nodes.get('ki-prompt')||null;
      return null;
    },querySelectorAll(selector){return selector==='details[data-chat-detail]'?value.details||[]:[];}};
    let html='';Object.defineProperty(value,'innerHTML',{get:()=>html,set:content=>{
      html=content;
      if(value.id!=='context-agent-panel')return;
      for(const [id,node] of nodes)if(node.owner===value)nodes.delete(id);
      value.thread=null;value.history=null;value.options=null;value.hasRows=false;
      if(!content.includes('ki-thread'))return;
      const host=geometry(),thread=visibleOverflow?{closest:()=>host}:host;value.thread=thread;surfaces.push(host);
      value.hasRows=/class="ki-message|class="ki-thinking/.test(content);
      value.history={value:decode(content.match(/<select[^>]*id="ki-history"[^>]*>[\s\S]*?<option value="([^"]*)"/)?.[1]||state.chatId)};
      value.options={open:false};
      value.details=[...content.matchAll(/<details\b([^>]*)>/g)].map(m=>({dataset:{chatDetail:decode(m[1].match(/data-chat-detail="([^"]*)"/)?.[1]||'')},open:/\bopen\b/.test(m[1])})).filter(d=>d.dataset.chatDetail);
      for(const text of content.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)){
        const id=text[1].match(/id="([^"]*)"/)?.[1];if(id){const node=new Textarea(id,decode(text[2]));node.owner=value;nodes.set(id,node);}
      }
    }});
    return value;
  }
  const body=element(),modal=element();
  document={body,activeElement:body,createElement:()=>{const created=element();if(!panel)queueMicrotask(()=>{if(created.id==='context-agent-panel')panel=created;});return created;},
    querySelector:selector=>selector==='#modal'?modal:selector==='.ki-thread'?panel?.thread||null:selector==='#ki-prompt'?nodes.get('ki-prompt')||null:null,
    querySelectorAll:()=>[],getElementById:id=>nodes.get(id)||null,
    addEventListener(type,handler){listeners.set(type,[...(listeners.get(type)||[]),handler]);},
    dispatch(type,target){for(const handler of listeners.get(type)||[])handler({target,preventDefault(){}});},
  };
  replace(t,'document',document);replace(t,'window',{addEventListener(){},dispatchEvent(){}});replace(t,'HTMLTextAreaElement',Textarea);replace(t,'getComputedStyle',()=>({overflowY:visibleOverflow?'visible':'auto'}));
  const make=agent=>{
    const view=createFloatingAgent({agent,getContext:()=>({projectId:state.scope,projectName:state.scope,label:'Synthetic context'}),onOpenChange(){}});
    return view;
  };
  const synthetic={isBusy:()=>false,stop(){},load:async()=>{},newChat(){},render:()=>`<select id="ki-history"><option value="${state.chatId}">Current</option></select><div class="ki-thread">${state.rows?'<article class="ki-message assistant">Synthetic</article>':''}</div>`};
  return {state,document,synthetic,make,get host(){return surfaces.at(-1);},get panel(){return panel;},async settle(){await tick();},surfaces};
}

for(const visibleOverflow of [false,true])test(`passive repaint preserves an older reading position with ${visibleOverflow?'outer workspace':'thread'} scrolling`,async t=>{
  const f=fixture(t,{visibleOverflow}),view=f.make(f.synthetic);await f.settle();view.toggle(true);f.host.scrollTop=210;f.host.scrollLeft=12;
  f.state.height=1800;view.render();assert.equal(f.host.scrollTop,210);assert.equal(f.host.scrollLeft,12);
});

test('a reader at or near the bottom follows new content without moving someone reading above it',async t=>{
  const f=fixture(t),view=f.make(f.synthetic);await f.settle();view.toggle(true);assert.equal(f.host.scrollTop,800);
  f.host.scrollTop=780;f.state.height=1600;view.render();assert.equal(f.host.scrollTop,1200);
  f.host.scrollTop=200;f.state.height=1900;view.render();assert.equal(f.host.scrollTop,200);
});

test('closing/reopening and revisiting another chat keep separate course/chat reading positions',async t=>{
  const f=fixture(t),view=f.make(f.synthetic);await f.settle();view.toggle(true);f.host.scrollTop=190;view.toggle(false);view.toggle(true);assert.equal(f.host.scrollTop,190);
  f.state.chatId='second-alpha';view.render();assert.equal(f.host.scrollTop,800);f.host.scrollTop=330;
  f.state.scope='beta';f.state.chatId='chat-beta';view.render();assert.equal(f.host.scrollTop,800);f.host.scrollTop=450;
  f.state.scope='alpha';f.state.chatId='chat-alpha';view.render();assert.equal(f.host.scrollTop,190);
  f.state.chatId='second-alpha';view.render();assert.equal(f.host.scrollTop,330);
});

test('hidden zero-height geometry cannot erase a remembered position; shorter content clamps safely',async t=>{
  const f=fixture(t),view=f.make(f.synthetic);await f.settle();view.toggle(true);f.host.scrollTop=650;view.render();
  f.host.clientHeight=0;f.host.scrollTop=0;view.render();assert.equal(f.host.scrollTop,650);
  f.state.height=700;view.render();assert.equal(f.host.scrollTop,300);
});

test('a fresh empty chat starts at the top rather than inheriting an old reading offset',async t=>{
  const f=fixture(t),view=f.make(f.synthetic);await f.settle();view.toggle(true);f.host.scrollTop=210;
  f.state.chatId='empty-chat';f.state.rows=false;view.render();assert.equal(f.host.scrollTop,0);
});

test('passive floating renders preserve disclosed source details alongside the reading position',async t=>{
  const f=fixture(t);f.synthetic.render=()=>`<select id="ki-history"><option value="chat-alpha">Current</option></select><div class="ki-thread"><article class="ki-message assistant"><details data-chat-detail="message:citations"><summary>Sources</summary>Synthetic source excerpt</details></article></div>`;
  const view=f.make(f.synthetic);await f.settle();view.toggle(true);f.panel.details[0].open=true;f.host.scrollTop=190;
  f.state.height=1500;view.render();assert.equal(f.panel.details[0].open,true);assert.equal(f.host.scrollTop,190);
  f.panel.details[0].open=false;view.render();assert.equal(f.panel.details[0].open,false);
});

test('changing knowledge starts a fresh safe chat while preserving the typed draft and backward selection',async t=>{
  const f=fixture(t);let floating;
  replace(t,'indexedDB',undefined);replace(t,'localStorage',{getItem:key=>key==='context-ai-provider'?'local':null,setItem(){}});
  window.contextDesktop={ai:async request=>{assert.equal(request.action,'models');return {ok:true,value:{models:[{id:'synthetic-local-model'}]}};}};
  const agent=createKIView({onChange:()=>floating?.render(),getContext:()=>({workspace:{activeCourse:'alpha',projects:[{id:'alpha',name:'Alpha',links:[]}],notes:[],tasks:[],bookmarks:[]},updates:[]})});
  floating=f.make(agent);await f.settle();floating.toggle(true);await f.settle();
  const input=document.querySelector('#ki-prompt');input.value='Noch ungesendeter Entwurf';document.dispatch('input',input);input.focus();input.setSelectionRange(5,16,'backward');
  const oldChat=f.panel.history.value;document.dispatch('change',{id:'ki-kind-notes',dataset:{kiKind:'notes'},checked:false});
  const next=document.querySelector('#ki-prompt');assert.equal(next.value,'Noch ungesendeter Entwurf');assert.deepEqual([next.selectionStart,next.selectionEnd,next.selectionDirection],[5,16,'backward']);assert.notEqual(f.panel.history.value,oldChat);
  f.state.height=1600;floating.render();assert.equal(document.querySelector('#ki-prompt').value,next.value);assert.equal(document.querySelector('#ki-prompt').selectionDirection,'backward');
  await f.settle();
});

test('actual KI onStep/finally callbacks preserve reading position, while explicit send follows its new message',async t=>{
  const f=fixture(t),toolGate=deferred(),answerGate=deferred();let floating,calls=0;
  replace(t,'indexedDB',undefined);replace(t,'localStorage',{getItem:key=>key==='context-ai-provider'?'local':null,setItem(){}});
  window.contextDesktop={ai:async request=>{
    if(request.action==='models')return {ok:true,value:{models:[{id:'synthetic-local-model'}]}};
    assert.equal(request.action,'chat');calls++;
    if(calls===1)return toolGate.promise;if(calls===2)return answerGate.promise;
    return {ok:true,value:{content:JSON.stringify({type:'answer',text:'Synthetic second reply',citations:[]})}};
  }};
  const agent=createKIView({onChange:()=>floating?.render(),getContext:()=>({workspace:{activeCourse:'alpha',projects:[{id:'alpha',name:'Alpha',links:[]}],notes:[],tasks:[],bookmarks:[]},updates:[]})});
  floating=f.make(agent);await f.settle();floating.toggle(true);await f.settle();assert.equal(agent.configuration().ready,true);
  document.querySelector('#ki-prompt').value='Prüfe meine lokalen Aufgaben.';document.dispatch('submit',{id:'ki-form'});await f.settle();assert.equal(calls,1);
  f.host.scrollTop=140;
  toolGate.resolve({ok:true,value:{content:JSON.stringify({type:'tool',tool:'list_tasks',args:{}})}});await f.settle();assert.equal(calls,2);assert.equal(f.host.scrollTop,140,'onStep must not override the restored reading position');
  answerGate.resolve({ok:true,value:{content:JSON.stringify({type:'answer',text:'Synthetic answer',citations:[]})}});await f.settle();assert.equal(f.host.scrollTop,140,'finally must not override the restored reading position');
  document.querySelector('#ki-prompt').value='Eine ausdrücklich neue Frage.';document.dispatch('submit',{id:'ki-form'});await f.settle();assert.equal(calls,3);assert.equal(f.host.scrollTop,f.host.scrollHeight-f.host.clientHeight,'the explicit send intent may follow its new message');
});
