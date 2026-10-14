import {validateCalendarTool} from './calendar-agent.js';
import {cleanBoardShot,limitShotBudget,SHOT_LIMITS} from './board-shot.js';
// Assistant records only. No account configuration, API keys or browser cookies.
const text=(v,max=16000)=>typeof v==='string'?v.slice(0,max):'';
const bool=v=>v===true;
const provider=v=>['kiconnect','openrouter','local'].includes(v)?v:'kiconnect';
const array=(v,max)=>Array.isArray(v)?v.slice(0,max):[];
const fields=(v,keys)=>Object.fromEntries(keys.filter(k=>typeof v?.[k]==='string').map(k=>[k,text(v[k],k==='content'?50000:2000)]));
export function archiveSource(v){
  if(!v||typeof v!=='object')throw new Error('Ungültige Chatquelle.');
  const out=fields(v,['id','kind','title','text','status','targetId','projectId','source','updatedAt','postedAt','due','taskStatus']);out.text=text(v.text,70000);
  if(v.url){const u=new URL(v.url);if(u.protocol!=='https:'||u.username||u.password||/[\x00-\x20]/.test(v.url))throw new Error('Ungültiger Quellenlink.');out.url=u.href;}
  if(Number.isSafeInteger(v.offset))out.offset=v.offset;
  return out;
}
function result(v){return {...fields(v,['id','itemId','title','kind']),saved:bool(v?.saved),duplicate:bool(v?.duplicate),eventIds:array(v?.eventIds,80).filter(id=>typeof id==='string'&&/^[-\w]{1,160}$/.test(id)),count:Number.isSafeInteger(v?.count)&&v.count>=0?v.count:0};}
function proposal(v){
  if(!['create_note','create_task','create_calendar'].includes(v?.tool))throw new Error('Unbekannter gespeicherter Vorschlag.');
  const args=v.tool==='create_calendar'?structuredClone(validateCalendarTool(v.args)):fields(v.args,['title','content','projectId','due']);
  return {id:text(v.id,160),tool:v.tool,scope:text(v.scope,160),args,sources:array(v.sources,80).map(archiveSource),applied:bool(v.applied),undone:bool(v.undone),...(v.result?{result:result(v.result)}:{})};
}
function clarification(v){
  const options=array(v?.options,6).filter(o=>typeof o==='string'&&o.trim()).map(o=>text(o,120));
  return typeof v?.question==='string'&&v.question.trim()&&options.length>=2?{question:text(v.question,300),options,multiple:bool(v.multiple),answer:text(v.answer,1500)}:null;
}
// A damaged picture is dropped instead of making the whole chat unreadable.
function shots(list){return array(list,12).flatMap(v=>{try{return [cleanBoardShot(v)];}catch{return [];}}).slice(0,SHOT_LIMITS.perMessage);}
function step(v){return {id:Number.isSafeInteger(v?.id)?v.id:0,...fields(v,['tool','label','detail']),status:['running','done','error'].includes(v?.status)?v.status:'done',undone:bool(v?.undone),sources:array(v?.sources,100).map(archiveSource),...(v?.action?{action:result(v.action)}:{})};}
export function cleanChat(v){
  if(!v||v.version!==1||!/^[-\w]{1,160}$/.test(v.id)||!Array.isArray(v.messages)||v.messages.length>100)throw new Error('Ungültiges Chatarchiv.');
  const messages=v.messages.map(m=>{if(!['user','assistant'].includes(m?.role)||typeof m.content!=='string'||m.content.length>50000)throw new Error('Ungültige Chatnachricht.');return {id:text(m.id,160),role:m.role,content:m.content,model:text(m.model,200),provider:provider(m.provider),failed:bool(m.failed),unverifiedCitations:bool(m.unverifiedCitations),totalTokens:Number.isFinite(m.totalTokens)?m.totalTokens:0,citations:array(m.citations,100).map(archiveSource),sources:array(m.sources,100).map(archiveSource),steps:array(m.steps,50).map(step),proposals:array(m.proposals,20).map(proposal),...(m.role==='assistant'&&shots(m.shots).length?{shots:shots(m.shots)}:{}),...(m.role==='assistant'&&Array.isArray(m.shotNotes)&&m.shotNotes.some(n=>typeof n==='string'&&n.trim())?{shotNotes:m.shotNotes.filter(n=>typeof n==='string'&&n.trim()).slice(0,SHOT_LIMITS.notes).map(n=>text(n,300))}:{}),...(m.role==='assistant'&&clarification(m.clarification)?{clarification:clarification(m.clarification)}:{})};});
  limitShotBudget(messages);
  return {version:1,id:v.id,title:text(v.title,200),scope:text(v.scope,160),projectName:text(v.projectName,200),createdAt:text(v.createdAt,80),updatedAt:text(v.updatedAt,80),messages,draft:text(v.draft,6000),model:text(v.model,200),provider:provider(v.provider),steps:array(v.steps,50).map(step),interrupted:bool(v.interrupted),enabled:{...Object.fromEntries(['projects','notes','tasks','updates','calendar'].map(k=>[k,bool(v.enabled?.[k])])),bookmarks:v.enabled?.bookmarks!==false,browser:v.enabled?.browser!==false,platforms:v.enabled?.platforms!==false},browserEnabled:v.browserEnabled!==false,calendarDirect:v.calendarDirect!==false,attachments:array(v.attachments,1).map(archiveSource).filter(d=>d.kind==='photo'&&d.id&&d.text)};
}
export function recoverChat(v){const c=cleanChat(v);if(c.interrupted||c.steps.length){c.messages.push({id:crypto.randomUUID(),role:'assistant',content:'Der Auftrag wurde durch Neuladen oder Schließen unterbrochen. Es werden keine Werkzeuge automatisch fortgesetzt.',failed:true,citations:[],proposals:[],steps:c.steps.map(s=>({...s,status:s.status==='running'?'error':s.status,detail:s.status==='running'?'Beim Schließen unterbrochen':s.detail}))});c.steps=[];c.interrupted=false;}return c;}
export async function encryptChat(record,key,cryptoAPI=globalThis.crypto){const c=cleanChat(record),iv=cryptoAPI.getRandomValues(new Uint8Array(12));const cipher=await cryptoAPI.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(c.id)},key,new TextEncoder().encode(JSON.stringify(c)));return {id:c.id,iv,cipher};}
export async function decryptChat(record,key,cryptoAPI=globalThis.crypto){const bytes=await cryptoAPI.subtle.decrypt({name:'AES-GCM',iv:record.iv,additionalData:new TextEncoder().encode(record.id)},key,record.cipher);const c=cleanChat(JSON.parse(new TextDecoder().decode(bytes)));if(c.id!==record.id)throw new Error('Archivkennung stimmt nicht überein.');return c;}
const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Speichern abgebrochen.'));});
export function createChatArchive(){
  let db,key,opening;
  async function open(){if(opening)return opening;opening=(async()=>{
    if(!globalThis.indexedDB||!globalThis.crypto?.subtle)throw new Error('Lokales Chatarchiv ist in diesem Browser nicht verfügbar.');
    const req=indexedDB.open('context-assistant-archive',1);req.onupgradeneeded=()=>{req.result.createObjectStore('keys');req.result.createObjectStore('chats',{keyPath:'id'});};db=await request(req);db.onversionchange=()=>db.close();
    key=await request(db.transaction('keys').objectStore('keys').get('aes'));
    if(!key){const candidate=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);const tx=db.transaction('keys','readwrite'),store=tx.objectStore('keys');const finished=complete(tx);store.get('aes').onsuccess=e=>{key=e.target.result||candidate;if(!e.target.result)store.add(candidate,'aes');};await finished;}
  })();return opening;}
  async function list(){await open();const rows=await request(db.transaction('chats').objectStore('chats').getAll());return Promise.all(rows.map(async row=>({chat:await decryptChat(row,key),revision:row.revision})));}
  async function save(chat,expected=0){await open();const encrypted=await encryptChat(chat,key);return new Promise((resolve,reject)=>{const tx=db.transaction('chats','readwrite'),store=tx.objectStore('chats');let conflict=false;store.get(chat.id).onsuccess=e=>{if((e.target.result?.revision||0)!==expected){conflict=true;tx.abort();return;}store.put({...encrypted,revision:expected+1});};tx.oncomplete=()=>resolve(expected+1);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(conflict?new Error('Ein anderer Tab hat diesen Chat geändert. Exportiere deinen Verlauf und lade neu.'):tx.error||new Error('Das Chatarchiv konnte nicht gespeichert werden.'));});}
  async function importChats(chats){await open();const rows=await Promise.all(chats.map(c=>encryptChat(c,key)));const tx=db.transaction('chats','readwrite'),finished=complete(tx),store=tx.objectStore('chats');rows.forEach(row=>store.add({...row,revision:1}));await finished;}
  return {list,save,importChats};
}
