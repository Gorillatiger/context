import {createHash} from 'node:crypto';
import {whatsappFilterURL,namedChatId} from './chat-filter.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>Object.assign(new Error('WhatsApp-Vorschau konnte nicht gelesen werden.'),{code});

// This reads the user's own account marker and already rendered chat-list
// previews. It does not open chats, scroll, invoke WhatsApp internals or fetch
// messages. The opaque account marker never contains a phone number in IPC.
function readRendered(selected,identityOnly){
  return (async()=>{
    if(location.origin!=='https://web.whatsapp.com')return {state:'login_required'};
    const pane=document.querySelector('#pane-side');if(!pane)return {state:'login_required'};
    let owner;
    for(const key of ['last-wid-md','last-wid']){
      let value;try{value=localStorage.getItem(key);if(!value||value.length>256)continue;try{value=JSON.parse(value);}catch{}}catch{continue;}
      if(typeof value==='string'&&/^\d{5,30}(?::\d{1,5})?@(?:c\.us|s\.whatsapp\.net|lid)$/.test(value)){owner=value.replace(/:\d+(?=@)/,'');break;}
    }
    if(!owner)return {state:'unverified_account'};
    const key='__contextWhatsAppNotificationIdentity_v1',lease=globalThis[key];
    // Shared storage can change before an older tab redraws. A pane already
    // bound to one owner must never be relabelled as another account's data.
    if(lease?.pane===pane&&lease.owner!==owner)return {state:'unverified_account'};
    if(!lease||lease.pane!==pane){
      if(document.visibilityState==='hidden')return {state:'unverified_account'};
      globalThis[key]={pane,owner};
    }
    const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
    const account=await digest(owner);if(identityOnly)return {state:'snapshot',account};
    const normalize=value=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
    const candidates=pane.querySelectorAll('[role="row"],[role="listitem"]'),rows=[],observed=[],ambiguous=[];let inspected=0;
    const matches=new Map();
    for(const row of candidates){
      if(++inspected>200)break;
      const titleNode=row.querySelector('span[title]'),title=(titleNode?.getAttribute('title')||'').trim();if(!title||title.length>160)continue;
      const direct=row.getAttribute('data-id')||row.getAttribute('data-jid')||'';
      const chosen=selected.filter(entry=>entry.id.startsWith('dom:')?direct===entry.id.slice(4):normalize(title)===normalize(entry.title));
      for(const entry of chosen){if(!matches.has(entry.id))matches.set(entry.id,[]);matches.get(entry.id).push({row,title,titleNode});}
    }
    for(const entry of selected){
      const found=matches.get(entry.id)||[];if(found.length>1){ambiguous.push(entry.id);continue;}if(found.length!==1)continue;
      observed.push(entry.id);const {row,title}=found[0];
      const unreadNode=row.querySelector('[data-testid="icon-unread-count"],[aria-label*="unread"],[aria-label*="ungelesen"]');
      const label=unreadNode?.getAttribute('aria-label')||unreadNode?.textContent||'';
      const raw=/^(\d{1,5})$/.exec(label.trim())?.[1]||/(\d{1,5})\s+(?:unread|ungelesen)/i.exec(label)?.[1];
      const count=raw?Number(raw):0;if(!count)continue;
      const secondary=row.querySelector('[data-testid="cell-frame-secondary"],[data-testid="last-msg-text"]');
      const preview=typeof secondary?.innerText==='string'?secondary.innerText.replace(/\s+/g,' ').trim().slice(0,500):'';
      rows.push({selectionId:entry.id,title,preview,count});
    }
    return {state:'snapshot',account,rows,observed,ambiguous,bounded:inspected>200};
  })();
}
export const whatsappNotificationScript=(selected=[],identityOnly=false)=>'('+readRendered.toString()+')('+JSON.stringify(selected)+','+JSON.stringify(identityOnly)+')';

/** Read-only adapter for an existing WhatsApp tab and the existing CoCo selection. */
export function createWhatsAppNotifications({getContext=()=>null,getSelection=()=>[],now=Date.now,onAccountChange=()=>{},timers=globalThis}){
  let disposed=false,lastAccount='',timer;
  function selection(){
    const entries=getSelection();if(!Array.isArray(entries)||entries.length>100)throw fail('INVALID_SELECTION');
    const result=entries.map(entry=>{
      if(!entry||typeof entry.id!=='string'||typeof entry.title!=='string'||!entry.title.trim()||entry.title.length>160||/[\x00-\x1f\x7f]/.test(entry.title)||!(entry.id.startsWith('name:')?entry.id===namedChatId(entry.title):/^dom:\d{5,30}(?:-\d{5,30})?@(?:c\.us|s\.whatsapp\.net|g\.us|lid)$/.test(entry.id)))throw fail('INVALID_SELECTION');
      return {id:entry.id,title:entry.title};
    });
    if(new Set(result.map(entry=>entry.id)).size!==result.length)throw fail('INVALID_SELECTION');return result;
  }
  async function readDOM(identityOnly){
    const context=getContext();if(!context||!whatsappFilterURL(context.url)||context.webContents.isDestroyed())return {state:'not_open'};
    const before=context.epoch,url=context.url;
    const value=await context.webContents.executeJavaScriptInIsolatedWorld(1008,[{code:whatsappNotificationScript(identityOnly?[]:selection(),identityOnly)}]);
    const current=getContext();if(disposed||!current||current.id!==context.id||current.epoch!==before||current.url!==url||context.webContents.getURL()!==url)throw fail('ACCOUNT_CHANGED');
    if(!value||!['snapshot','login_required','unverified_account'].includes(value.state)||value.state==='snapshot'&&!/^[a-f0-9]{64}$/.test(value.account||''))throw fail('INVALID_RESPONSE');
    return value;
  }
  async function account(){
    const value=await readDOM(true),next=hash([value.account||value.state,selection()]);
    if(lastAccount&&lastAccount!==next)onAccountChange('whatsapp');lastAccount=next;return next;
  }
  async function read({previous=[],signal}={}){
    if(signal?.aborted)throw fail('ACCOUNT_CHANGED');
    if(!selection().length)return {items:[],status:'not_configured',complete:false,message:'Wähle und aktiviere deine CoCo-Chats im WhatsApp-Browser.'};
    const value=await readDOM(false);if(signal?.aborted)throw fail('ACCOUNT_CHANGED');
    if(value.state==='not_open')return {items:[],status:'not_configured',complete:false,message:'Öffne WhatsApp Web in einem Context-Browser-Tab für Chatlisten-Vorschauen.'};
    if(value.state==='login_required')return {items:[],status:'login_required',complete:false,message:'Öffne und entsperre WhatsApp Web.'};
    if(value.state==='unverified_account')return {items:[],status:'not_configured',complete:false,message:'Die WhatsApp-Kontoidentität konnte nicht bestätigt werden. Es wurden keine Vorschauen gelesen.'};
    if(!Array.isArray(value.rows)||value.rows.length>100||!Array.isArray(value.observed)||value.observed.length>100||!Array.isArray(value.ambiguous)||value.ambiguous.length>100)throw fail('INVALID_RESPONSE');
    const allowed=new Map(selection().map(entry=>[entry.id,entry])),capturedAt=new Date(now()).toISOString(),items=[];
    for(const row of value.rows){
      if(!allowed.has(row.selectionId)||typeof row.title!=='string'||row.title.length>160||typeof row.preview!=='string'||row.preview.length>500||!Number.isSafeInteger(row.count)||row.count<1||row.count>99999)throw fail('INVALID_RESPONSE');
      const group=hash(row.selectionId).slice(0,32);
      items.push({id:'whatsapp_'+value.account.slice(0,20)+'_'+group,revision:hash([row.count,row.preview]),source:'whatsapp',title:row.title,summary:row.count+' ungelesene Nachrichten · Browser-Vorschau',content:row.preview,contentStatus:'excerpt',url:'https://web.whatsapp.com/',createdAt:'',observedAt:capturedAt,capturedAt,timeKind:'observed',groupId:group,groupName:row.title,selectionId:group,kind:'chat-preview',mode:'snapshot'});
    }
    if([...value.observed,...value.ambiguous].some(id=>!allowed.has(id)))throw fail('INVALID_RESPONSE');
    const observed=new Set([...value.observed,...value.ambiguous].map(id=>hash(id).slice(0,32))),allowedGroups=new Set([...allowed.keys()].map(id=>hash(id).slice(0,32)));
    // A virtualized list omits off-screen chats. Preserve their last preview as
    // stale instead of claiming that the provider deleted/read their messages.
    for(const item of previous)if(item.source==='whatsapp'&&item.id.startsWith('whatsapp_'+value.account.slice(0,20)+'_')&&allowedGroups.has(item.selectionId)&&!observed.has(item.selectionId))items.push({...item,stale:true});
    const unseen=[...allowed.keys()].filter(id=>!value.observed.includes(id)).length;
    return {items,status:'snapshot',complete:false,capturedAt,message:'Vorschauen aus der gerenderten Liste deiner ausgewählten CoCo-Chats. Kein vollständiger Chatverlauf.',warnings:[...(unseen?[unseen+' ausgewählte Chats sind nicht eindeutig in der gerenderten Liste sichtbar.']:[]),...(value.bounded?['Es wurden höchstens 200 gerenderte Chatzeilen geprüft.']:[])]};
  }
  // Poll only the account marker; a logout must revoke previews even while the
  // feed's normal refresh interval is waiting. Never queries provider APIs.
  function watch(){if(disposed)return;timer=timers.setTimeout(async()=>{timer=undefined;try{if(getContext()||lastAccount)await account();}catch{}watch();},2000);timer?.unref?.();}
  watch();
  return {account,read,scope:()=>selection(),dispose(){disposed=true;if(timer!==undefined)timers.clearTimeout(timer);}};
}
