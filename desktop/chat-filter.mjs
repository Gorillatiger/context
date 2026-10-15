import {createHash,randomUUID} from 'node:crypto';
import * as files from 'node:fs/promises';
import path from 'node:path';

const MAX_SELECTED=100,MAX_CHATS=500,MAX_BYTES=65536;
// User-origin normal CSS loses to author resets (including WhatsApp's). Keep
// every rule scoped to our overlay and important; never style host chat rows.
export const CHAT_FILTER_CSS=`
.context-coco-chat-focus,.context-coco-chat-focus *{box-sizing:border-box!important}
.context-coco-chat-focus{position:fixed!important;z-index:2147483000!important;display:block!important;overflow:auto!important;overscroll-behavior:contain!important;background:#fff!important;color:#24333b!important;padding:20px!important;font:14px/1.5 system-ui,sans-serif!important;text-align:left!important;border:0!important;isolation:isolate!important}
.context-coco-chat-focus[hidden]{display:none!important}
.context-coco-chat-focus h2{display:block!important;font:600 19px/1.3 system-ui,sans-serif!important;color:inherit!important;margin:0 0 8px!important;padding:0!important}
.context-coco-chat-focus p{display:block!important;font:400 12px/1.55 system-ui,sans-serif!important;color:#53636c!important;margin:0 0 16px!important;padding:0!important;white-space:normal!important}
.context-coco-chat-focus button{display:block!important;position:relative!important;width:100%!important;min-height:52px!important;border:1px solid #d7dfe3!important;border-radius:10px!important;background:#f6f8f9!important;color:#24333b!important;text-align:left!important;padding:14px 36px 14px 14px!important;margin:8px 0!important;font:500 14px/1.5 system-ui,sans-serif!important;white-space:normal!important;overflow-wrap:anywhere!important;cursor:pointer!important;appearance:none!important;opacity:1!important}
.context-coco-chat-focus button::after{content:'›'!important;position:absolute!important;right:14px!important;top:50%!important;transform:translateY(-50%)!important;color:#53636c!important;font:400 22px/1 system-ui,sans-serif!important}
.context-coco-chat-focus button:hover{background:#e8f4ef!important;border-color:#6b9d86!important}
.context-coco-chat-focus button:focus-visible{outline:3px solid #00805e!important;outline-offset:2px!important}
.context-coco-chat-focus button:disabled{cursor:wait!important;opacity:.65!important}
.context-coco-chat-focus [role="status"]{margin-top:16px!important;color:#00805e!important}
@media(prefers-color-scheme:dark){.context-coco-chat-focus{background:#111b21!important;color:#e9edef!important}.context-coco-chat-focus p{color:#aebac1!important}.context-coco-chat-focus button{background:#202c33!important;color:#e9edef!important;border-color:#3a454c!important}.context-coco-chat-focus button::after{color:#aebac1!important}.context-coco-chat-focus button:hover{background:#263e38!important;border-color:#5c9884!important}.context-coco-chat-focus [role="status"]{color:#6ad9b1!important}}
@media(max-width:600px){.context-coco-chat-focus{padding:14px!important}}
`;
const jid=/^[0-9]{5,30}(?:-[0-9]{5,30})?@(?:c\.us|s\.whatsapp\.net|g\.us|lid)$/;
const fail=(code,message)=>Object.assign(new Error(message),{code});
export function whatsappFilterURL(value){try{const url=new URL(value);return url.origin==='https://web.whatsapp.com'&&!url.username&&!url.password;}catch{return false;}}
export function normalizedChatTitle(value){return value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();}
export function namedChatId(title){return 'name:'+createHash('sha256').update(normalizedChatTitle(title)).digest('hex');}
function chatEntry(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.id!=='string'||typeof value.title!=='string'||value.title!==value.title.trim()||!value.title||value.title.length>160||/[\x00-\x1f\x7f]/.test(value.title))throw fail('BAD_CHAT_SELECTION','Ungültige Chat-Auswahl.');
 const dom=value.id.startsWith('dom:')&&jid.test(value.id.slice(4)),name=/^name:[a-f0-9]{64}$/.test(value.id)&&value.id===namedChatId(value.title);
 if(!dom&&!name)throw fail('BAD_CHAT_SELECTION','Ungültige Chat-Auswahl.');
 return {id:value.id,title:value.title,identity:dom?'dom':'name'};
}
function selectedEntries(values){
 if(!Array.isArray(values)||values.length>MAX_SELECTED)throw fail('BAD_CHAT_SELECTION','Bis zu 100 CoCo-Chats sind möglich.');
 const result=values.map(chatEntry);if(new Set(result.map(entry=>entry.id)).size!==result.length)throw fail('BAD_CHAT_SELECTION','Ein Chat wurde mehrfach ausgewählt.');return result;
}
export function parseChatFilterSnapshot(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)throw fail('BAD_CHAT_STORE','Ungültige lokale Chat-Auswahl.');
 const value=JSON.parse(text);
 if(!value||Array.isArray(value)||value.version!==1||typeof value.enabled!=='boolean'||Object.keys(value).some(key=>!['version','enabled','selected','assistant'].includes(key))||value.assistant!==undefined&&typeof value.assistant!=='boolean')throw fail('BAD_CHAT_STORE','Ungültige lokale Chat-Auswahl.');
 return {enabled:value.enabled,selected:selectedEntries(value.selected),assistant:value.assistant===true};
}
function request(value){
 const keys={status:['op'],discover:['op','sweep'],set:['op','enabled','selected'],picker:['op','open'],open:['op','id'],assistant:['op','enabled'],read:['op','id']};
 if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(keys,value.op)||Object.keys(value).some(key=>!keys[value.op].includes(key)))throw fail('BAD_CHAT_REQUEST','Unbekannter Chat-Fokusauftrag.');
 if(value.op==='set'&&(value.enabled!==undefined&&typeof value.enabled!=='boolean'||value.enabled===undefined&&value.selected===undefined))throw fail('BAD_CHAT_REQUEST','Ungültiger Chat-Fokusauftrag.');
 if(value.op==='discover'&&value.sweep!==undefined&&typeof value.sweep!=='boolean'||value.op==='assistant'&&typeof value.enabled!=='boolean'||value.op==='read'&&typeof value.id!=='string')throw fail('BAD_CHAT_REQUEST','Ungültiger Chat-Fokusauftrag.');
 if(value.op==='picker'&&typeof value.open!=='boolean'||value.op==='open'&&typeof value.id!=='string')throw fail('BAD_CHAT_REQUEST','Ungültiger Chat-Fokusauftrag.');
 if(value.selected!==undefined)selectedEntries(value.selected);
 return value;
}

// This function runs only in a separate isolated world of the active WhatsApp
// main frame. It reads chat-title attributes; message bodies, images, React
// internals, WhatsApp stores and networking are never accessed.
async function chatRuntime(command){
 const slot='__contextCocoChatFocus_v1',navigationSlot='__contextCocoChatNavigation_v1',leaseSlot='__contextCocoChatLease_v1',old=globalThis[slot];
 const cancel=()=>{const lease=globalThis[leaseSlot];if(lease)lease.cancelled=true;globalThis[navigationSlot]?.cancel();};
 if(command.op==='cancel'){cancel();return {opened:false};}
 if(command.op==='cleanup'){cancel();old?.cleanup();delete globalThis[slot];delete globalThis[leaseSlot];return {ready:false,chats:[]};}
 if(location.origin!=='https://web.whatsapp.com'){cancel();old?.cleanup();delete globalThis[slot];delete globalThis[leaseSlot];return {ready:false,chats:[]};}
 const pane=document.querySelector('#pane-side');
 if(old&&command.op==='configure'&&(old.pane!==pane||old.leaseToken!==command.lease||globalThis[leaseSlot]?.cancelled)){old.cleanup();delete globalThis[slot];}
 let lease=globalThis[leaseSlot];
 if(command.op==='configure'&&command.enabled&&!command.pickerOpen&&pane){
  if(!lease||lease.token!==command.lease||lease.cancelled){cancel();lease={token:command.lease,cancelled:false};globalThis[leaseSlot]=lease;}
 }else if(command.op==='open'&&!command.lease&&!lease){lease={token:undefined,cancelled:false};globalThis[leaseSlot]=lease;}
 else if(command.op==='read'){cancel();lease={token:command.lease,cancelled:false};globalThis[leaseSlot]=lease;}
 const normalize=value=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
 const nameId=async title=>'name:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(normalize(title))))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
 const idPattern=/^[0-9]{5,30}(?:-[0-9]{5,30})?@(?:c\.us|s\.whatsapp\.net|g\.us|lid)$/;
 async function collect(alive=()=>true){
  if(!pane||!pane.isConnected)return {ready:false,chats:[],rows:new Map(),named:0,duplicates:0};
  const rows=new Map(),chats=new Map();let named=0,duplicates=0;
  const candidates=Array.from(pane.querySelectorAll('[role="row"],[role="listitem"]')).slice(0,200);
  for(const row of candidates){
   if(!alive())break;
   if(row.parentElement?.closest('[role="row"],[role="listitem"]')&&pane.contains(row.parentElement.closest('[role="row"],[role="listitem"]')))continue;
   const node=row.querySelector('[data-testid="cell-frame-title"] [title],[data-testid="chat-title"][title],[data-testid="chat-title"] [title],span[title][dir="auto"]');
   const title=node?.getAttribute('title')?.trim().replace(/\s+/g,' ');
   if(!title||title.length>160||/[\x00-\x1f\x7f]/.test(title)||node.closest('form,input,textarea,[contenteditable="true"],[data-testid="cell-frame-secondary"],[data-testid="cell-frame-message"],[data-testid="last-msg-status"],[data-testid="msg-container"]'))continue;
   const raw=row.getAttribute('data-chat-id')||row.getAttribute('data-id')||node.closest('[data-chat-id]')?.getAttribute('data-chat-id');
   const alias=await nameId(title),id=idPattern.test(raw||'')?'dom:'+raw:alias,identity=id.startsWith('dom:')?'dom':'name';
   if(!alive())break;
   if(identity==='name')named++;
   if(chats.has(id)){duplicates++;if(identity==='name')rows.set(alias,null);continue;}
   const entry={id,title,identity};chats.set(id,entry);rows.set(id,{row,node,title});
   if(!rows.has(alias))rows.set(alias,{row,node,title});else if(rows.get(alias)?.row!==row)rows.set(alias,null);
  }
  return {ready:true,chats:[...chats.values()],rows,named,duplicates};
 }
 function publicResult(result){return {ready:result.ready,chats:result.chats,named:result.named||0,duplicates:result.duplicates||0};}
 // A sweep scrolls the chat list once from top to bottom (bounded) so chats outside the rendered window are found.
 async function sweep(){
  const first=await collect();if(!pane||!pane.isConnected)return first;
  const height=Number(pane.clientHeight),total=Number(pane.scrollHeight);
  if(!Number.isFinite(height)||height<1||!Number.isFinite(total)||total<=height)return first;
  const initialTop=Number(pane.scrollTop)||0,start=Date.now(),merged=new Map(first.chats.map(chat=>[chat.id,chat]));let named=first.named||0,duplicates=first.duplicates||0;
  try{
   pane.scrollTop=0;await new Promise(resolve=>setTimeout(resolve,120));
   for(let step=0;step<80&&Date.now()-start<8000&&merged.size<500;step++){
    const result=await collect();for(const chat of result.chats)merged.set(chat.id,chat);named=Math.max(named,result.named||0);duplicates=Math.max(duplicates,result.duplicates||0);
    const top=Number(pane.scrollTop),max=Math.max(0,Number(pane.scrollHeight)-height);if(top>=max-2)break;
    pane.scrollTop=Math.min(max,top+Math.max(1,Math.floor(height*.8)));await new Promise(resolve=>setTimeout(resolve,120));
    if(Number(pane.scrollTop)<=top+1)break;
   }
  }finally{if(pane.isConnected&&location.origin==='https://web.whatsapp.com')pane.scrollTop=initialTop;}
  return {ready:true,chats:[...merged.values()].slice(0,500),named,duplicates};
 }
 if(command.op==='discover')return publicResult(command.sweep===true?await sweep():await collect());
 async function openChat(id){
  if(!pane||!lease||lease.cancelled||globalThis[leaseSlot]!==lease||command.lease&&command.lease!==lease.token||globalThis[navigationSlot]?.busy)return false;
  const initialTop=Number(pane.scrollTop)||0,start=Date.now();let opened=false,cancelled=false;
  const navigation={busy:true,cancel(){cancelled=true;navigation.busy=false;window.removeEventListener('pagehide',navigation.cancel);document.removeEventListener('visibilitychange',onHide);if(globalThis[navigationSlot]===navigation){delete globalThis[navigationSlot];if(pane.isConnected&&location.origin==='https://web.whatsapp.com')pane.scrollTop=initialTop;}}};globalThis[navigationSlot]=navigation;
  const alive=()=>!cancelled&&!lease.cancelled&&globalThis[leaseSlot]===lease&&globalThis[navigationSlot]===navigation&&pane.isConnected&&location.origin==='https://web.whatsapp.com'&&document.visibilityState!=='hidden';
  const onHide=()=>{if(document.visibilityState==='hidden')navigation.cancel();};
  window.addEventListener('pagehide',navigation.cancel);document.addEventListener('visibilitychange',onHide);
  const matches=found=>!!found&&found.row.isConnected&&found.node.isConnected&&pane.contains(found.row)&&normalize(found.node.getAttribute('title')||'')===normalize(found.title)&&(!id.startsWith('dom:')||'dom:'+(found.row.getAttribute('data-chat-id')||found.row.getAttribute('data-id')||found.node.closest('[data-chat-id]')?.getAttribute('data-chat-id'))===id);
  const click=found=>{if(!alive()||!matches(found))return false;found.node.click();opened=true;return true;};
  const settle=()=>new Promise(resolve=>setTimeout(resolve,70));
  try{
   let result=await collect(alive);if(!alive()||result.rows.get(id)===null)return false;
   // A stable exposed chat ID can be opened directly. Title-only identities
   // must first be checked for ambiguity across the available virtual list.
   if(id.startsWith('dom:')&&result.rows.get(id))return click(result.rows.get(id));
   const height=Number(pane.clientHeight),total=Number(pane.scrollHeight);
   if(!Number.isFinite(height)||height<1||!Number.isFinite(total)||total<=height)return click(result.rows.get(id));
   const occurrences=new Map();let reachedEnd=false,steps=0;
   pane.scrollTop=0;await settle();
   while(alive()&&steps++<80&&Date.now()-start<8000){
    result=await collect(alive);if(!alive()||result.rows.get(id)===null)return false;
    const found=result.rows.get(id);
    if(matches(found)){
     const raw=found.row.getAttribute('data-chat-id')||found.row.getAttribute('data-id');
     const index=found.row.getAttribute('aria-rowindex');
     const offset=Math.round(found.row.getBoundingClientRect().top-pane.getBoundingClientRect().top+Number(pane.scrollTop));
     const key=idPattern.test(raw||'')?'dom:'+raw:/^[0-9]+$/.test(index||'')?'row:'+index:'offset:'+offset;
     occurrences.set(key,{top:Number(pane.scrollTop)});if(occurrences.size>1)return false;
    }
    const top=Number(pane.scrollTop),max=Math.max(0,Number(pane.scrollHeight)-height);
    if(!Number.isFinite(top)||!Number.isFinite(max))return false;
    if(top>=max-2){await settle();if(!alive())return false;if(Math.abs(Number(pane.scrollHeight)-height-max)>2)continue;reachedEnd=true;break;}
    pane.scrollTop=Math.min(max,top+Math.max(1,Math.floor(height*.8)));await settle();
    if(Number(pane.scrollTop)<=top+1)return false;
   }
   if(!alive()||!reachedEnd||occurrences.size!==1)return false;
   pane.scrollTop=[...occurrences.values()][0].top;await settle();
   result=await collect(alive);return click(result.rows.get(id));
  }finally{
   if(!opened&&(!globalThis[navigationSlot]||globalThis[navigationSlot]===navigation)&&pane.isConnected&&location.origin==='https://web.whatsapp.com')pane.scrollTop=initialTop;
   navigation.busy=false;window.removeEventListener('pagehide',navigation.cancel);document.removeEventListener('visibilitychange',onHide);
   if(globalThis[navigationSlot]===navigation)delete globalThis[navigationSlot];
  }
 }
 if(command.op==='open')return {opened:await openChat(command.id)};
 // Explicit, separate from the focus list: the person allowed the assistant to read this chat. Reads the
 // visible message text of the chat after verifying that exactly this chat is open. No images, no media.
 if(command.op==='read'){
  const opened=await openChat(command.id);if(!opened)return {opened:false,messages:[]};
  const header=()=>document.querySelector('#main header [data-testid="conversation-info-header-chat-title"],#main header span[dir="auto"][title],#main header span[title]');
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let title='';for(let i=0;i<30;i++){await wait(150);const node=header();title=(node?.getAttribute('title')||node?.innerText||'').trim();if(title&&normalize(title)===normalize(command.title))break;title='';}
  if(!title)return {opened:true,verified:false,messages:[]};
  await wait(600);
  const nodes=Array.from(document.querySelectorAll('#main [data-pre-plain-text]')).slice(-40),messages=[];
  for(const node of nodes){
   const meta=String(node.getAttribute('data-pre-plain-text')||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,120);
   const body=node.querySelector('span.selectable-text,[data-testid="selectable-text"]'),text=String(body?.innerText||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,600);
   if(text)messages.push({meta,text});
  }
  return {opened:true,verified:true,title,messages};
 }
 if(!command.enabled||command.pickerOpen||!pane){cancel();old?.cleanup();delete globalThis[slot];delete globalThis[leaseSlot];return publicResult(await collect());}
 let state=globalThis[slot];
 if(!state){
  const overlay=document.createElement('section');
  overlay.className='context-coco-chat-focus';overlay.setAttribute('aria-label','CoCo-Chats · lokaler Fokus');
  const heading=document.createElement('h2'),hint=document.createElement('p'),list=document.createElement('div'),status=document.createElement('p'),identityHint=document.createElement('p');
  heading.textContent='Deine CoCo-Chats';hint.textContent='Deine Kurschats und Gruppen. Auswahl ändern oder alle Chats anzeigen: CoCo-Fokus neben der Adresszeile.';status.setAttribute('role','status');status.setAttribute('aria-live','polite');list.setAttribute('aria-label','Ausgewählte Chats');
  overlay.append(heading,hint,list,status,identityHint);document.body.append(overlay);
  let timer,disposed=false,refreshing=false,pending=false;
  const position=()=>{if(disposed)return;const bounds=pane.getBoundingClientRect();for(const [name,value]of Object.entries({left:bounds.left,top:bounds.top,width:bounds.width,height:bounds.height})){if(overlay.style.setProperty)overlay.style.setProperty(name,value+'px','important');else overlay.style[name]=value+'px';}overlay.hidden=!pane.isConnected||bounds.width<1||bounds.height<1;};
  state={pane,overlay,list,status,leaseToken:command.lease,selected:[],last:'',result:null,async refresh(){
   if(disposed)return; if(refreshing){pending=true;return;} refreshing=true;
   try{
    const result=await collect();if(disposed)return;state.result=result;position();
    const labels=state.selected.map(entry=>({id:entry.id,title:result.rows.get(entry.id)?.title||entry.title}));
    const key=JSON.stringify(labels);
    if(key!==state.last){state.last=key;list.replaceChildren();for(const entry of labels){const button=document.createElement('button');button.type='button';button.textContent=entry.title;button.disabled=state.opening===true;button.addEventListener('click',async()=>{if(disposed||state.opening)return;state.opening=true;overlay.setAttribute('aria-busy','true');for(const item of list.children)item.disabled=true;status.textContent='Chat wird in WhatsApp gesucht …';try{const opened=await openChat(entry.id);if(!disposed)status.textContent=opened?'':'Dieser Chat konnte nicht eindeutig geöffnet werden. Nutze die WhatsApp-Suche oben oder zeige im Context-Browser alle Chats.';}catch{if(!disposed)status.textContent='Die WhatsApp-Suche wurde unterbrochen. Bitte erneut versuchen.';}finally{state.opening=false;if(!disposed){overlay.setAttribute('aria-busy','false');for(const item of list.children)item.disabled=false;}}});list.append(button);}}
    if(!labels.length)status.textContent='Wähle deine CoCo-Chats im Context-Browser aus.';
    identityHint.textContent=state.selected.some(entry=>entry.id.startsWith('name:'))?'Zuordnung über Chatnamen. Gleiche Namen werden zusammengefasst; nach Umbenennen bitte neu auswählen.':'';
   }finally{refreshing=false;if(pending&&!disposed){pending=false;schedule();}}
  },cleanup(){disposed=true;cancel();clearTimeout(timer);observer.disconnect();resize?.disconnect();window.removeEventListener('resize',position);document.removeEventListener('scroll',position,true);overlay.remove();}};
  const schedule=()=>{if(disposed||timer)return;timer=setTimeout(()=>{timer=null;void state.refresh().catch(()=>{});},120);};
  const observer=new MutationObserver(schedule);observer.observe(pane,{childList:true,subtree:true,attributes:true,attributeFilter:['title','data-id','data-chat-id','role']});
  const resize=typeof ResizeObserver==='function'?new ResizeObserver(position):null;resize?.observe(pane);
  window.addEventListener('resize',position);document.addEventListener('scroll',position,true);globalThis[slot]=state;
 }
 state.selected=command.selected;await state.refresh();return publicResult(state.result||await collect());
}
export function chatFilterScript(command){return '('+chatRuntime.toString()+')('+JSON.stringify(command)+')';}

export function createDesktopChatFilter({directory,crypto,getActive,emit=()=>{},fs=files,platform=process.platform}){
 const target=path.join(directory,'whatsapp-focus.enc');
 let enabled=false,assistant=false,selected=[],pickerOpen=false,storage='session',storageWarning='',warning='',ready=false,known=new Map(),contextKey='',lease=randomUUID(),attached,executing,insertedCSS,initialization,queue=Promise.resolve(),timer,poll,disposed=false,last='';
 const current=()=>{const context=getActive();return context&&context.webContents&&!context.webContents.isDestroyed()&&whatsappFilterURL(context.url)?context:null;};
 function snapshot(){const context=current(),same=!!context&&context.id+':'+context.epoch===contextKey;return {supported:!!context,assistant:assistant,enabled:!!context&&enabled,pickerOpen:!!context&&pickerOpen,selected:context?selected.map(entry=>({...entry})):[],chats:same?[...known.values()]:[],ready:same&&ready,storage,limited:true,warning:context?[storageWarning,warning].filter(Boolean).join(' '):''};}
 function publish(){if(disposed)return;const value=snapshot(),key=JSON.stringify(value);if(key!==last){last=key;emit(value);}}
 async function available(){if(platform==='linux')return false;return !!await crypto.isAsyncEncryptionAvailable();}
 function initialize(){if(initialization)return initialization;initialization=(async()=>{
  try{
   if(!await available())throw new Error('unavailable');storage='encrypted';
   let buffer;try{const stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES+4096)throw new Error('invalid');buffer=await fs.readFile(target);}catch(error){if(error.code!=='ENOENT')throw error;}
   if(buffer){const decoded=await crypto.decryptStringAsync(buffer),value=parseChatFilterSnapshot(decoded.result);enabled=value.enabled;selected=value.selected;assistant=value.assistant;}
  }catch{storage='session';storageWarning='Die Auswahl gilt für diese Sitzung; verschlüsseltes Speichern ist momentan nicht verfügbar.';}
  publish();return snapshot();
 })();return initialization;}
 async function persist(){
  const temporary=path.join(directory,'whatsapp-focus.'+randomUUID()+'.tmp');
  try{
   if(!await available())throw new Error('unavailable');
   const buffer=await crypto.encryptStringAsync(JSON.stringify({version:1,enabled,selected,assistant}));
   if(!Buffer.isBuffer(buffer)||buffer.length>MAX_BYTES+4096)throw new Error('invalid');
   await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.writeFile(temporary,buffer,{flag:'wx',mode:0o600});await fs.rename(temporary,target);storage='encrypted';storageWarning='';
  }catch{storage='session';storageWarning='Die Auswahl gilt für diese Sitzung; verschlüsseltes Speichern ist momentan nicht verfügbar.';}
  finally{await fs.unlink(temporary).catch(()=>{});}
 }
 async function removeCSS(){const previous=insertedCSS;insertedCSS=null;if(previous&&!previous.context.webContents.isDestroyed())await previous.context.webContents.removeInsertedCSS(previous.key).catch(()=>{});}
 // Cancellation must run outside the operation queue: a queued refresh cannot
 // stop the click inside an already awaiting isolated-world operation.
 function cancelRuntime(){
  const contexts=new Set([attached,executing,insertedCSS?.context].filter(Boolean));
  for(const context of contexts)if(!context.webContents.isDestroyed())void context.webContents.executeJavaScriptInIsolatedWorld(1002,[{code:chatFilterScript({op:'cancel'})}]).catch(()=>{});
 }
 async function cleanup(){const previous=attached||insertedCSS?.context;attached=null;if(previous&&!previous.webContents.isDestroyed())await previous.webContents.executeJavaScriptInIsolatedWorld(1002,[{code:chatFilterScript({op:'cleanup'})}]).catch(()=>{});await removeCSS();}
 function assertCurrent(context){const after=current();if(!after||after.id!==context.id||after.epoch!==context.epoch||after.url!==context.url)throw fail('CHAT_PAGE_CHANGED','Der Browser-Tab hat sich geändert. Bitte erneut auswählen.');}
 async function ensureCSS(context){
  if(insertedCSS&&insertedCSS.context.id===context.id&&insertedCSS.context.epoch===context.epoch)return;
  await removeCSS();assertCurrent(context);
  const key=await context.webContents.insertCSS(CHAT_FILTER_CSS,{cssOrigin:'user'});insertedCSS={key,context};assertCurrent(context);
 }
 async function execute(context,command,limit=11000){
  assertCurrent(context);
  if(disposed)throw fail('CHAT_FILTER_CLOSED','Der Chat-Fokus wird geschlossen.');
  executing=context;let timeout;
  try{
   const pending=context.webContents.executeJavaScriptInIsolatedWorld(1002,[{code:chatFilterScript({...command,lease})}]);
   const result=await Promise.race([pending,new Promise((_,reject)=>{timeout=setTimeout(()=>{cancelRuntime();reject(fail('CHAT_TIMEOUT','Die WhatsApp-Suche dauert zu lange. Bitte die normale Suche benutzen.'));},limit);timeout.unref?.();})]);
   assertCurrent(context);return result;
  }finally{clearTimeout(timeout);if(executing===context)executing=null;}
 }
 function accept(result){
  if(!result||!Array.isArray(result.chats)||result.chats.length>500)throw fail('BAD_CHAT_DOM','Die WhatsApp-Chatliste konnte nicht sicher gelesen werden.');
  for(const raw of result.chats){const entry=chatEntry(raw);if(!known.has(entry.id)&&known.size>=MAX_CHATS)continue;known.set(entry.id,entry);}
  ready=result.ready===true;
  warning=!ready?'Öffne und entsperre WhatsApps Chatliste.':result.named>0||selected.some(entry=>entry.identity==='name')?'Zuordnung über sichtbare Chatnamen: gleiche Namen werden zusammengefasst; nach Umbenennen bitte neu auswählen.':'';
  if(ready&&!result.chats.length)warning='Keine Chatnamen in der gerenderten Liste erkannt. Nutze WhatsApps normale Liste und Suche.';
 }
 async function refresh(discover=false){
  await initialize();if(disposed)return snapshot();
  const context=current(),key=context?context.id+':'+context.epoch:'';
  if(key!==contextKey){cancelRuntime();lease=randomUUID();contextKey=key;known=new Map();ready=false;warning='';pickerOpen=false;await cleanup();}
  clearTimeout(poll);poll=null;
  if(!context){await cleanup();publish();return snapshot();}
  if(enabled||discover||attached){
   try{if(enabled&&!pickerOpen)await ensureCSS(context);const result=await execute(context,{op:'configure',enabled,pickerOpen,selected});accept(result);attached=enabled&&!pickerOpen?context:null;if(!attached)await removeCSS();}
   catch(error){await cleanup();ready=false;warning=error.code==='CHAT_PAGE_CHANGED'?'Der Browser-Tab hat sich geändert.':'Die WhatsApp-Chatliste konnte nicht sicher gelesen werden. Fokus ausschalten und erneut versuchen.';}
  }
  if(enabled&&!disposed){poll=setTimeout(()=>{void enqueue(()=>refresh()).catch(()=>{});},900);poll.unref?.();}
  publish();return snapshot();
 }
 function enqueue(fn){const pending=queue.then(fn);queue=pending.catch(()=>{});return pending;}
 function schedule(){if(disposed)return;const context=current();if((context?context.id+':'+context.epoch:'')!==contextKey)cancelRuntime();if(timer)return;timer=setTimeout(()=>{timer=null;void enqueue(()=>refresh()).catch(()=>{});},100);timer.unref?.();}
 async function handle(value){
  if(disposed)throw fail('CHAT_FILTER_CLOSED','Der Chat-Fokus wird geschlossen.');
  const message=request(value);
  if(message.op==='picker'||message.op==='set')cancelRuntime();
  // Enqueue before yielding so dispose waits for every accepted IPC request.
  return enqueue(async()=>{
   await initialize();
   if(message.op==='status')return refresh();
   if(!current())throw fail('CHAT_NOT_SUPPORTED','Öffne WhatsApp Web im aktiven Context-Browser-Tab.');
   await refresh();
   if(message.op==='discover'){
    if(message.sweep){try{accept(await execute(current(),{op:'discover',sweep:true},20000));}catch(error){warning=error.code==='CHAT_TIMEOUT'?error.message:warning;}publish();return snapshot();}
    return refresh(true);
   }
   if(message.op==='assistant'){assistant=message.enabled;await persist();publish();return snapshot();}
   if(message.op==='read'){
    // The assistant may read only chats the person selected AND explicitly released for it.
    if(!assistant)throw fail('ASSISTANT_NOT_ALLOWED','Du hast dem Assistenten das Lesen deiner CoCo-Chats nicht erlaubt. Schalte es im CoCo-Fokus ein.');
    const entry=selected.find(item=>item.id===message.id);if(!entry)throw fail('BAD_CHAT_SELECTION','Dieser Chat gehört nicht zu deinem CoCo-Fokus.');
    lease=randomUUID();
    const result=await execute(current(),{op:'read',id:entry.id,title:entry.title},24000);
    if(!result||typeof result!=='object'||!Array.isArray(result.messages)||result.messages.length>40||result.messages.some(m=>!m||typeof m.text!=='string'||m.text.length>600||typeof m.meta!=='string'||m.meta.length>120))throw fail('BAD_CHAT_DOM','Die WhatsApp-Nachrichten konnten nicht sicher gelesen werden.');
    return {...snapshot(),read:{opened:result.opened===true,verified:result.verified===true,title:entry.title,messages:result.messages.map(m=>({meta:m.meta,text:m.text}))}};
   }
   if(message.op==='picker'){lease=randomUUID();pickerOpen=message.open;return refresh(true);}
   if(message.op==='open'){
    if(!selected.some(entry=>entry.id===message.id))throw fail('BAD_CHAT_SELECTION','Wähle diesen Chat zuerst für deinen CoCo-Fokus aus.');
    const result=await execute(current(),{op:'open',id:message.id});return {...snapshot(),opened:result?.opened===true};
   }
   lease=randomUUID();
   if(message.selected!==undefined){const next=selectedEntries(message.selected);selected=next.map(entry=>{const existing=known.get(entry.id)||selected.find(saved=>saved.id===entry.id);if(!existing){if(entry.identity==='name')return {...entry};throw fail('CHAT_NOT_DISCOVERED','Dieser Chat wurde noch nicht in der gerenderten WhatsApp-Liste gefunden.');}return {...existing};});}
   if(message.enabled!==undefined)enabled=message.enabled;
   pickerOpen=false;await persist();return refresh(true);
  });
 }
 return Object.freeze({initialize,handle,schedule,flush:()=>queue,dispose:async()=>{disposed=true;clearTimeout(timer);clearTimeout(poll);cancelRuntime();await queue;await cleanup();}});
}
