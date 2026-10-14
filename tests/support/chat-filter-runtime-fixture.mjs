import {createContext,runInContext} from 'node:vm';
import {webcrypto} from 'node:crypto';

// Synthetic title-only DOM. Reading content is deliberately forbidden so the
// tests catch a regression that starts scraping message previews or bodies.
export function runtimeFixture(t,chatFilterScript,{titles=['CoCo Team','Private synthetic chat']}={}) {
 const clicks=[],observers=[],listeners=new Map();let digestHook;
 class Element {
  constructor(tag='div',attrs={}){this.tagName=tag;this.attrs=new Map(Object.entries(attrs));this.children=[];this.parentElement=null;this.style={};this.connected=false;this.events=new Map();this.text='';this.disabled=false;}
  get isConnected(){return this.connected;}
  getAttribute(key){return this.attrs.get(key)??null;}
  setAttribute(key,value){this.attrs.set(key,String(value));}
  removeAttribute(key){this.attrs.delete(key);}
  set textContent(value){this.text=String(value);}
  get textContent(){throw new Error('Message/body text must not be read');}
  append(...children){for(const child of children){child.parentElement=this;child.connected=this.connected;this.children.push(child);}}
  replaceChildren(...children){for(const child of this.children){child.connected=false;child.parentElement=null;}this.children=[];this.append(...children);}
  remove(){this.connected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}
  contains(node){for(let current=node;current;current=current.parentElement)if(current===this)return true;return false;}
  closest(selector){for(let current=this;current;current=current.parentElement){if(selector.includes('[role=')&&['row','listitem'].includes(current.getAttribute('role')))return current;if(selector==='[data-chat-id]'&&current.getAttribute('data-chat-id'))return current;}return null;}
  querySelector(){return this.nameNode||null;}
  querySelectorAll(){return this.children.filter(node=>['row','listitem'].includes(node.getAttribute('role')));}
  getBoundingClientRect(){return {left:10,top:130,width:400,height:700};}
  addEventListener(type,callback){this.events.set(type,callback);}
  removeEventListener(type){this.events.delete(type);}
  click(){if(this.parentElement?.getAttribute('role')==='row')clicks.push(this.parentElement.nameNode.getAttribute('title'));return this.events.get('click')?.();}
 }
 const head=new Element('head'),body=new Element('body'),pane=new Element('div',{id:'pane-side'});head.connected=body.connected=true;body.append(pane);
 const rows=titles.map(title=>{const row=new Element('div',{role:'row'}),name=new Element('span',{title,dir:'auto'});row.nameNode=name;row.append(name);pane.append(row);name.connected=true;return row;});
 const document={head,body,visibilityState:'visible',querySelector:selector=>selector==='#pane-side'?pane:null,createElement:tag=>new Element(tag),addEventListener:(type,callback)=>listeners.set('document:'+type,callback),removeEventListener:type=>listeners.delete('document:'+type)};
 const window={addEventListener:(type,callback)=>listeners.set('window:'+type,callback),removeEventListener:type=>listeners.delete('window:'+type)};
 class Observer {constructor(callback){this.callback=callback;this.disconnected=false;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}
 const crypto={subtle:{digest:async(...args)=>{await digestHook?.();return webcrypto.subtle.digest(...args);}}};
 const sandbox=createContext({document,window,location:{origin:'https://web.whatsapp.com'},crypto,TextEncoder,MutationObserver:Observer,ResizeObserver:Observer,setTimeout,clearTimeout,requestAnimationFrame:callback=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,performance,AbortController});
 const execute=command=>runInContext(chatFilterScript(command),sandbox);
 t.after(()=>execute({op:'cleanup'}));
 const descend=node=>[node,...node.children.flatMap(descend)];
 const overlay=()=>body.children.find(child=>child.className==='context-coco-chat-focus');
 return {execute,runScript:script=>runInContext(script,sandbox),sandbox,document,pane,rows,clicks,observers,listeners,setDigestHook:callback=>{digestHook=callback;},overlay,buttons:()=>overlay()?descend(overlay()).filter(node=>node.tagName==='button'):[]};
}
