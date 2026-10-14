import {brandLogo} from './brand-logos.js';

export const INVENTORY_URL='https://inventory.coco.study/';
export function isInventoryEntryURL(value){try{return new URL(value).href===INVENTORY_URL;}catch{return false;}}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={back:'M14 6l-6 6 6 6',forward:'M10 6l6 6-6 6',reload:'M20 7v5h-5M19 12a7 7 0 1 1-2-5',stop:'M6 6l12 12M6 18L18 6',home:'M3 11l9-8 9 8M5 10v11h14V10M9 21v-7h6v7',lock:'M8 10V7a4 4 0 0 1 8 0v3M5 10h14v11H5z',agent:'M12 3v18M3 12h18M6 6l12 12M6 18L18 6'};
const icon=name=>`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]}"/></svg>`;

export function createInventoryView({bridge=globalThis.window?.contextDesktop,eventTarget=globalThis.window,document=globalThis.document,onChange=()=>{},onError=()=>{},Resize=globalThis.ResizeObserver,Mutation=globalThis.MutationObserver}={}){
 let tabId='',surfaceToken,browser={active:'',tabs:[]},mounted=false,busy=false,error='',generation=0,cleanup,lastFrame='',slot,attempted=false,wasBlocked=false;
 const available=()=>bridge?.inventoryBrowser===true&&typeof bridge?.browser==='function';
 const tab=()=>browser.tabs.find(t=>String(t.id)===tabId);
 const notify=()=>{if(mounted)onChange();};
 async function send(message){const reply=await bridge.browser(message);if(reply?.ok===false||reply?.error)throw new Error(reply.error||'Das Inventar konnte nicht geöffnet werden.');return reply?.ok===true?reply.value:reply;}
 function frame(){
  if(!mounted||!slot?.isConnected||!available())return;
  const r=slot.getBoundingClientRect(),blocked=!!document.querySelector('dialog[open]')||document.body.classList.contains('nav-open')||document.visibilityState==='hidden';
  if(blocked)wasBlocked=true;
  else if(!busy&&!error&&(!attempted||wasBlocked&&browser.active!==tabId)){wasBlocked=false;void attach();return;}
  else wasBlocked=false;
  if(busy||!tabId||error)return;
  const visible=browser.active===tabId&&r.width>0&&r.height>0&&!blocked;
  const message={type:'frame',owner:'inventory',id:tabId,surfaceToken,visible,current:visible||!blocked&&browser.active===tabId,rect:{x:r.x,y:r.y,width:r.width,height:r.height},clip:{x:0,y:0,width:eventTarget.innerWidth,height:eventTarget.innerHeight}};
  const signature=JSON.stringify(message);if(signature===lastFrame)return;lastFrame=signature;
  const token=generation;
  void send(message).catch(e=>{if(mounted&&token===generation&&error!==e.message){error=e.message;void send({type:'detach',owner:'inventory',id:tabId}).catch(()=>{});notify();}});
 }
 async function attach(action='attach'){
  if(!mounted||busy||!available())return;
  const token=generation;busy=true;error='';attempted=true;lastFrame='';
  try{const result=await send({type:'inventory',action});if(!mounted||token!==generation||result?.detached)return;
   if(typeof result?.tabId!=='string'||!result.tabId||!Number.isSafeInteger(result.surfaceToken))throw new Error('Die Inventar-Ansicht braucht die aktualisierte Context-App.');
   tabId=result.tabId;surfaceToken=result.surfaceToken;
  }catch(e){if(mounted&&token===generation)error=e.message;}
  finally{if(mounted&&token===generation){busy=false;notify();frame();}}
 }
 const receive=detail=>{
  browser={active:String(detail?.active||''),tabs:Array.isArray(detail?.tabs)?detail.tabs:[],session:detail?.session};
  if(mounted){notify();frame();}
 };
 eventTarget?.addEventListener('context-browser-state',event=>receive(event.detail));
 function render(){
  const t=tab(),loadError=error||t?.error||'';
  if(!available())return `<div class="inventory-surface"><header class="inventory-heading"><div>${brandLogo('inventory')}<div><p class="eyebrow">STUDIO CODE · INVENTAR</p><h1>Dein Studio-Inventar.</h1></div></div></header><section class="empty-state"><h2>Direkt in Context Browser.</h2><p>Die aktualisierte Mac-App zeigt das Inventar hier auf dieser Seite, mit deiner bestehenden Website-Anmeldung.</p><a class="button secondary" data-inventory-separate href="${INVENTORY_URL}" target="_blank" rel="noopener noreferrer">Inventar separat öffnen ↗</a></section></div>`;
  return `<div class="browser-surface inventory-surface"><header class="inventory-heading"><div>${brandLogo('inventory')}<div><p class="eyebrow">STUDIO CODE · INVENTAR</p><h1>Dein Studio-Inventar.</h1><p>Geräte finden. Ausleihe verwalten.</p></div></div></header><div class="browser-workbench inventory-workbench"><section class="context-browser inventory-browser" aria-label="Studio-Inventar im Browser"><div class="browser-controls inventory-controls"><div class="browser-history-controls"><button type="button" data-inventory-action="back" aria-label="Im Inventar zurück" ${!t?.back||busy?'disabled':''}>${icon('back')}</button><button type="button" data-inventory-action="forward" aria-label="Im Inventar vorwärts" ${!t?.forward||busy?'disabled':''}>${icon('forward')}</button><button type="button" data-inventory-action="${t?.loading?'stop':'reload'}" aria-label="${t?.loading?'Inventar-Laden anhalten':'Inventar neu laden'}" ${!t||busy?'disabled':''}>${icon(t?.loading?'stop':'reload')}</button><button type="button" data-inventory-action="home" aria-label="Inventar-Startseite öffnen" ${busy?'disabled':''}>${icon('home')}</button></div><div class="inventory-address" aria-label="Aktuelle Inventar-Webseite">${icon('lock')}<span>${esc(t?.url||INVENTORY_URL)}</span></div><button type="button" class="browser-assistant-button" data-action="context-agent" aria-label="Kontextassistent öffnen">${icon('agent')}<span>Assistent</span></button></div>${loadError?`<div class="inventory-error" role="alert"><span>${esc(loadError)}</span><button type="button" class="text-link" data-inventory-action="${error?'retry':'reload'}" ${busy?'disabled':''}>Erneut versuchen</button></div>`:''}<div id="inventory-page-slot" class="browser-page-slot inventory-page-slot" aria-label="Inventar-Webseite">${!t&&!error?'<p class="inventory-loading" role="status">Inventar wird geöffnet …</p>':''}</div><div class="browser-footer"><span class="browser-page-status" role="status">${loadError?'Verbindung prüfen':t?.loading?'Inventar wird geladen …':t?esc(t.title||'Studio-Inventar'):'Browser wird geöffnet …'}</span><span class="browser-session-status">Gemeinsame Website-Sitzung</span></div></section><aside id="browser-agent-slot"></aside></div></div>`;
 }
 function mount(){
  cleanup?.();cleanup=undefined;slot=document.querySelector('#inventory-page-slot');
  if(!available()||!slot){hide();return;}
  if(!mounted){mounted=true;generation++;attempted=false;lastFrame='';wasBlocked=false;}
  let released=false,pending=false;
  const schedule=()=>{if(released||pending)return;pending=true;queueMicrotask(()=>{pending=false;if(!released)frame();});};
  const resize=new Resize(schedule);resize.observe(slot);
  const mutation=new Mutation(schedule);mutation.observe(document.body,{attributes:true,attributeFilter:['class']});document.querySelectorAll('dialog').forEach(dialog=>mutation.observe(dialog,{attributes:true,attributeFilter:['open']}));
  for(const type of ['resize','context-agent-layout','context-browser-layout'])eventTarget.addEventListener(type,schedule);
  document.addEventListener('scroll',schedule,true);document.addEventListener('visibilitychange',schedule);
  cleanup=()=>{released=true;resize.disconnect();mutation.disconnect();for(const type of ['resize','context-agent-layout','context-browser-layout'])eventTarget.removeEventListener(type,schedule);document.removeEventListener('scroll',schedule,true);document.removeEventListener('visibilitychange',schedule);};
  schedule();
 }
 function hide(){
  if(!mounted)return;mounted=false;generation++;busy=false;cleanup?.();cleanup=undefined;slot=undefined;lastFrame='';wasBlocked=false;
  void send({type:'inventory',action:'detach'}).catch(()=>{});
  void send({type:'detach',owner:'inventory',id:tabId}).catch(()=>{});
 }
 async function click(action){
  if(!mounted||busy||!available())return;
  if(action==='home'||action==='retry'){await attach(action==='home'?'home':'attach');return;}
  if(!['back','forward','reload','stop'].includes(action)||!tabId)return;
  try{await send({type:action,id:tabId});}catch(e){onError(e.message);}
 }
 return {render,mount,hide,click,receive,available,state:()=>({tabId,mounted,busy,error,browser})};
}
