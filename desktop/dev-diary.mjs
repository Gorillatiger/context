import {createHash,randomUUID} from 'node:crypto';
import * as files from 'node:fs/promises';
import path from 'node:path';
import {renderDevDiaryPost} from '../dist/dev-diary-format.js';

const ORIGIN='https://spaces.th-koeln.de',MAX_RESPONSE=2_000_000,MAX_CONTENT=100_000,MAX_JOURNAL=1_000_000,REVIEW_AGE=10*60_000;
const MAX_CONTENT_TEXT=20000;
const error=(code,message)=>Object.assign(new Error(message),{code});
const digest=value=>createHash('sha256').update(value).digest('hex');
const positive=value=>Number.isSafeInteger(value)&&value>0;
export function diaryCourseURL(value){
 if(typeof value!=='string'||value.length>300||/[\x00-\x20]/.test(value))throw error('BAD_DIARY_SCOPE','Wähle einen gültigen Spaces-Kurs.');
 let url;try{url=new URL(value);}catch{throw error('BAD_DIARY_SCOPE','Wähle einen gültigen Spaces-Kurs.');}
 const slug=url.pathname.match(/^\/([a-z0-9][a-z0-9-]{0,100})\/?$/)?.[1];
 if(url.origin!==ORIGIN||url.username||url.password||url.search||url.hash||!slug||['public','home','hilfe','app','wp-json','wp-admin'].includes(slug))throw error('BAD_DIARY_SCOPE','Wähle einen gültigen Spaces-Kurs.');
 return ORIGIN+'/'+slug+'/';
}
function runID(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value))throw error('BAD_DIARY_RUN','Ungültige Dev-Diary-Laufzeit.');return value;}
function attrs(text){const result={};for(const match of text.matchAll(/\s([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g))result[match[1].toLowerCase()]=match[3].replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");return result;}
function assignedJSON(script,name){
 const match=new RegExp('(?:\\b(?:var|let|const)\\s+|\\bwindow\\.)'+name+'\\s*=\\s*').exec(script);if(!match)return null;
 let start=match.index+match[0].length,depth=0,string=false,escape=false;
 if(script[start]!=='{')return null;
 for(let index=start;index<Math.min(script.length,start+20000);index++){
  const char=script[index];if(string){if(escape)escape=false;else if(char==='\\')escape=true;else if(char==='"')string=false;continue;}
  if(char==='"')string=true;else if(char==='{')depth++;else if(char==='}'&&!--depth)return JSON.parse(script.slice(start,index+1));
 }
 return null;
}
// Private authentication context: never return this object through IPC, store it,
// include it in an Error, or log it. Both independent roots must agree.
function authenticationContext(html,courseURL){
 const links=[...html.matchAll(/<link\b[^>]*>/gi)].map(match=>attrs(match[0])).filter(link=>link.rel==='https://api.w.org/'||link.rel==='https://api.w.org');
 const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(match=>attrs('<script '+match[1]).id==='wp-api-request-js-extra');
 if(links.length!==1||scripts.length!==1)throw error('UNVERIFIED_SPACES_API','Die WordPress-Schnittstelle dieses Kurses wurde noch nicht sicher erkannt.');
 let settings;try{settings=assignedJSON(scripts[0][2],'wpApiSettings');}catch{}
 const expected=courseURL+'wp-json/';
 if(links[0].href!==expected||settings?.root!==expected)throw error('UNVERIFIED_SPACES_API','Die Spaces-Schnittstelle gehört nicht eindeutig zum gewählten Kurs.');
 if(typeof settings.nonce!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(settings.nonce))throw error('LOGIN_REQUIRED','Melde dich im Context-Browser bei Spaces an.');
 return {courseURL,apiRoot:expected,nonce:settings.nonce};
}
function methods(route){return new Set([route?.methods,...(route?.endpoints||[]).map(endpoint=>endpoint.methods)].flatMap(value=>Array.isArray(value)?value:typeof value==='string'?value.split(','):value&&typeof value==='object'?Object.keys(value).filter(key=>value[key]):[]));}
function verifiedRoutes(index){
 const routes=index?.routes,collection='/wp/v2/posts',item='/wp/v2/posts/(?P<id>[\\d]+)',categories='/wp/v2/categories',me='/wp/v2/users/me';
 if(!routes||typeof routes!=='object'||![collection,item,categories,me].every(route=>methods(routes[route]).has('GET'))||![collection,item].every(route=>methods(routes[route]).has('POST')))throw error('UNVERIFIED_SPACES_API','Die erforderlichen WordPress-Beitragsfunktionen wurden von diesem Kurs nicht bestätigt.');
 const meta=routes[collection].schema?.properties?.meta?.properties?.scoped_notify_notify_others||(routes[collection].endpoints||[]).filter(endpoint=>methods({methods:endpoint.methods}).has('POST')).map(endpoint=>endpoint.args?.meta?.properties?.scoped_notify_notify_others).find(Boolean);
 const notifyDisabled=meta?.type==='string'&&meta.readonly!==true&&(!Array.isArray(meta.enum)||meta.enum.includes('no'));
 return {collection,item,categories,me,notifyDisabled};
}
function identity(courseURL,runId,authorId){const key=digest(JSON.stringify([courseURL,runId,authorId]));return {key,slug:'context-dev-diary-'+key.slice(0,32),marker:'<!-- context-dev-diary:'+key+' -->'};}
function bodyHash(title,content){return digest(JSON.stringify([title,content]));}
function revision(post){return digest(JSON.stringify([post.id,post.author,post.slug,post.status,[...post.categories].sort((a,b)=>a-b),post.title.raw,post.content.raw,post.modified_gmt]));}
function validatePost(raw,context,id){
 if(!raw||!positive(raw.id)||raw.type!=='post'||raw.author!==context.authorId||!Array.isArray(raw.categories)||!raw.categories.every(positive)||!raw.categories.includes(context.categoryId)||typeof raw.title?.raw!=='string'||typeof raw.content?.raw!=='string'||raw.content.raw.length>MAX_CONTENT*2||!raw.content.raw.includes(id.marker)||typeof raw.modified_gmt!=='string'||typeof raw.slug!=='string'||typeof raw.status!=='string')throw error('DIARY_IDENTITY_MISMATCH','Der gefundene Beitrag ist nicht eindeutig dein Dev Diary im gewählten Kurs. Es wurde nichts überschrieben.');
 let url;try{url=new URL(raw.link);}catch{}
 if(!url||url.origin!==ORIGIN||!url.pathname.startsWith(context.courseURL.slice(ORIGIN.length))||url.username||url.password||url.search||url.hash)throw error('DIARY_IDENTITY_MISMATCH','Der Beitrag gehört nicht zum gewählten Spaces-Kurs.');
 return {...raw,link:url.href,revision:revision(raw),bodyHash:bodyHash(raw.title.raw,raw.content.raw)};
}
export function readableDiaryContent(html){
 const stripped=String(html).replace(/<!--[\s\S]*?(?:-->|$)/g,'').replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,'').replace(/<br\b[^>]*>|<\/(?:p|h[1-6]|li|blockquote|pre|div|ul|ol|section|article)\s*>/gi,'\n').replace(/<li\b[^>]*>/gi,'• ').replace(/<[^>]*>/g,'');
 const decoded=stripped.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(entity,value)=>{
  if(value[0]!=='#')return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[value.toLowerCase()]||entity;
  const point=value[1].toLowerCase()==='x'?parseInt(value.slice(2),16):Number(value.slice(1));
  return point>0&&point<=0x10ffff&&!(point>=0xd800&&point<=0xdfff)?String.fromCodePoint(point):'';
 }).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
 return {contentText:decoded.slice(0,MAX_CONTENT_TEXT),contentTruncated:decoded.length>MAX_CONTENT_TEXT};
}
function publicPost(post){return post?{id:post.id,url:post.link,title:post.title.raw,status:post.status,modified:post.modified_gmt,revision:post.revision,...readableDiaryContent(post.content.raw)}:null;}
function publicationResult(review,post,extra={}){return {status:'published',post:publicPost(post),postId:post.id,postURL:post.link,contentHash:digest(review.content),notifications:review.notifyDisabled?'disabled':'site-default',...extra};}
function diaryRequest(value){
 const allowed={get:['op','courseURL','runId'],prepare:['op','courseURL','runId','title','content','acknowledgeRevision'],publish:['op','reviewToken']};
 if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(allowed,value.op)||Object.keys(value).some(key=>!allowed[value.op].includes(key)))throw error('BAD_DIARY_REQUEST','Ungültiger Dev-Diary-Auftrag.');
 if(value.op==='publish'){if(typeof value.reviewToken!=='string'||!/^[a-f0-9-]{36}$/i.test(value.reviewToken))throw error('BAD_DIARY_REQUEST','Ungültige Freigabe des Dev Diary.');return value;}
 const clean={...value,courseURL:diaryCourseURL(value.courseURL),runId:runID(value.runId)};
 if(value.op==='prepare'&&(typeof value.title!=='string'||!value.title.trim()||value.title.length>200||/[\x00-\x1f\x7f<>]/.test(value.title)||typeof value.content!=='string'||!value.content.trim()||value.content.length>MAX_CONTENT||value.content.includes('\0')))throw error('BAD_DIARY_CONTENT','Prüfe Titel und Inhalt deines Dev Diary.');
 if(value.acknowledgeRevision!==undefined&&(typeof value.acknowledgeRevision!=='string'||!/^[a-f0-9]{64}$/.test(value.acknowledgeRevision)))throw error('BAD_DIARY_ACKNOWLEDGEMENT','Prüfe den externen Beitragsstand erneut.');
 if(value.op==='prepare')clean.title=value.title.trim();return clean;
}
function parseJournal(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>MAX_JOURNAL)throw error('DIARY_JOURNAL_INVALID','Die lokale Beitragszuordnung kann nicht sicher gelesen werden.');
 const value=JSON.parse(text);
 if(!value||value.version!==1||!value.records||Array.isArray(value.records)||typeof value.records!=='object'||Object.keys(value).some(key=>!['version','records'].includes(key))||Object.keys(value.records).length>500)throw error('DIARY_JOURNAL_INVALID','Die lokale Beitragszuordnung kann nicht sicher gelesen werden.');
 for(const [key,record] of Object.entries(value.records)){
  if(!/^[a-f0-9]{64}$/.test(key)||!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).some(field=>!['courseURL','runId','authorId','postId','revision','contentHash','pending'].includes(field))||diaryCourseURL(record.courseURL)!==record.courseURL||!positive(record.authorId)||identity(record.courseURL,runID(record.runId),record.authorId).key!==key||record.postId!==null&&!positive(record.postId)||record.revision!==null&&!/^[a-f0-9]{64}$/.test(record.revision)||record.contentHash!==null&&!/^[a-f0-9]{64}$/.test(record.contentHash))throw error('DIARY_JOURNAL_INVALID','Die lokale Beitragszuordnung kann nicht sicher gelesen werden.');
  if(record.pending!==null&&(!record.pending||!['create','update'].includes(record.pending.action)||!/^[a-f0-9]{64}$/.test(record.pending.desiredHash)||!/^[a-f0-9]{64}$/.test(record.pending.contentHash)||!Number.isSafeInteger(record.pending.at)||Object.keys(record.pending).some(field=>!['action','desiredHash','contentHash','at'].includes(field))))throw error('DIARY_JOURNAL_INVALID','Die lokale Beitragszuordnung kann nicht sicher gelesen werden.');
 }
 return value.records;
}

// A narrow publisher, never a write tool of the generic AI/browser reader.
// main.mjs must bind handle to its trusted workspace main frame.
export function createDesktopDevDiary({providerSession,directory,fs=files,now=Date.now}){
 const target=path.join(directory,'dev-diary-publisher.json'),reviews=new Map();
 let records={},initialization,queue=Promise.resolve(),disposed=false;
 function initialize(){if(initialization)return initialization;initialization=(async()=>{try{const stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_JOURNAL)throw new Error();records=parseJournal(await fs.readFile(target,'utf8'));}catch(cause){if(cause.code!=='ENOENT')throw error('DIARY_JOURNAL_INVALID','Die lokale Beitragszuordnung kann nicht sicher gelesen werden. Veröffentlichen ist angehalten.');}})();return initialization;}
 async function save(key,record){
  const next={...records,[key]:record},temporary=path.join(directory,'dev-diary-publisher.'+randomUUID()+'.tmp'),text=JSON.stringify({version:1,records:next})+'\n';
  if(Object.keys(next).length>500||Buffer.byteLength(text)>MAX_JOURNAL)throw error('DIARY_JOURNAL_UNAVAILABLE','Die lokale Beitragszuordnung ist voll.');
  try{await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.writeFile(temporary,text,{mode:0o600,flag:'wx'});await fs.rename(temporary,target);records=next;}
  catch{throw error('DIARY_JOURNAL_UNAVAILABLE','Die lokale Beitragszuordnung konnte nicht gesichert werden.');}
  finally{await fs.unlink(temporary).catch(()=>{});}
 }
 async function fetchText(url,{nonce,method='GET',body}={}){
  const parsed=new URL(url);if(parsed.origin!==ORIGIN||parsed.username||parsed.password||parsed.hash)throw error('BAD_DIARY_SCOPE','Die Anfrage gehört nicht zu Spaces.');
  let response;try{response=await providerSession.fetch(url,{method,credentials:'include',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Accept:body?'application/json':'application/json, text/html',...(nonce?{'X-WP-Nonce':nonce}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
  catch{throw error('DIARY_NETWORK_ERROR','Spaces konnte nicht sicher erreicht werden.');}
  // Electron's response.url may be incorrect. Never follow redirects, especially
  // when a nonce is present, and never disclose a server error body through IPC.
  if(response.status>=300&&response.status<400||response.status===401||response.status===403)throw error('LOGIN_REQUIRED','Melde dich im Context-Browser bei Spaces an und prüfe deine Kursberechtigung.');
  if(!response.ok)throw error('DIARY_SERVER_ERROR','Spaces hat die Anfrage nicht bestätigt.');
  if(Number(response.headers?.get('content-length')||0)>MAX_RESPONSE)throw error('DIARY_RESPONSE_INVALID','Die Spaces-Antwort ist zu groß.');
  let text;try{text=await response.text();}catch{throw error('DIARY_NETWORK_ERROR','Spaces konnte nicht sicher erreicht werden.');}
  if(Buffer.byteLength(text)>MAX_RESPONSE)throw error('DIARY_RESPONSE_INVALID','Die Spaces-Antwort ist zu groß.');
  return {text,headers:response.headers};
 }
 async function api(context,route,params={},options={}){
  const url=new URL(context.apiRoot+route.replace(/^\//,''));
  if(url.origin!==ORIGIN||!url.pathname.startsWith(context.apiRoot.slice(ORIGIN.length)))throw error('BAD_DIARY_SCOPE','Die Anfrage gehört nicht zum gewählten Kurs.');
  for(const [key,value] of Object.entries(params)){if(Array.isArray(value))for(const item of value)url.searchParams.append(key+'[]',String(item));else url.searchParams.set(key,String(value));}
  const response=await fetchText(url.href,{nonce:context.nonce,...options});let value;try{value=JSON.parse(response.text);}catch{throw error('DIARY_RESPONSE_INVALID','Die Spaces-Schnittstelle hat keine gültige Antwort geliefert.');}
  return {value,headers:response.headers};
 }
 async function context(courseURL){
  const page=await fetchText(courseURL),privateContext=authenticationContext(page.text,courseURL);
  const indexResponse=await fetchText(privateContext.apiRoot,{nonce:privateContext.nonce});let index;try{index=JSON.parse(indexResponse.text);}catch{throw error('UNVERIFIED_SPACES_API','Die WordPress-Schnittstelle wurde nicht bestätigt.');}
  privateContext.routes=verifiedRoutes(index);
  const me=(await api(privateContext,privateContext.routes.me,{context:'edit',_fields:'id,capabilities'})).value;
  if(!positive(me?.id))throw error('LOGIN_REQUIRED','Melde dich im Context-Browser bei Spaces an.');
  if(me.capabilities?.edit_posts!==true||me.capabilities?.publish_posts!==true)throw error('DIARY_PERMISSION_REQUIRED','Du darfst in diesem Kurs keine eigenen Beiträge veröffentlichen.');
  privateContext.authorId=me.id;
  const categories=(await api(privateContext,privateContext.routes.categories,{search:'DevDiary',per_page:100,context:'view',_fields:'id,name'})).value;
  if(!Array.isArray(categories))throw error('UNVERIFIED_SPACES_API','Die DevDiary-Kategorie wurde nicht bestätigt.');
  const matched=categories.filter(term=>positive(term?.id)&&typeof term.name==='string'&&term.name.replace(/[\s-]/g,'').toLowerCase()==='devdiary');
  if(matched.length!==1)throw error('DIARY_CATEGORY_REQUIRED','Wähle einen Kurs mit einer eindeutigen DevDiary-Kategorie.');
  privateContext.categoryId=matched[0].id;return privateContext;
 }
 async function findPost(ctx,id,record){
  const found=new Map();
  const fields='id,type,author,categories,title,content,modified_gmt,slug,status,link';
  if(record?.postId){const raw=(await api(ctx,ctx.routes.collection+'/'+record.postId,{context:'edit',_fields:fields})).value;const post=validatePost(raw,ctx,id);found.set(post.id,post);}
  for(const params of [{slug:id.slug},{search:id.key}]){
   const response=await api(ctx,ctx.routes.collection,{...params,author:ctx.authorId,status:['publish','draft','pending','private','future'],per_page:100,context:'edit',_fields:fields});
   if(!Array.isArray(response.value)||Number(response.headers?.get('x-wp-totalpages')||1)>1)throw error('DIARY_LOOKUP_INCOMPLETE','Die vorhandenen Beiträge konnten nicht vollständig geprüft werden.');
   for(const raw of response.value){if(raw?.content?.raw?.includes(id.marker)||raw?.slug===id.slug){const post=validatePost(raw,ctx,id);found.set(post.id,post);}}
  }
  if(found.size>1)throw error('DIARY_AMBIGUOUS_POST','Mehrere eigene Beiträge gehören zu dieser Laufzeit. Bitte prüfe sie in Spaces.');
  return [...found.values()][0]||null;
 }
 function emptyRecord(ctx,runId){return {courseURL:ctx.courseURL,runId,authorId:ctx.authorId,postId:null,revision:null,contentHash:null,pending:null};}
 async function reconcile(ctx,id,record,post){
  if(!record?.pending)return record;
  if(post&&post.bodyHash===record.pending.desiredHash&&post.status==='publish'){const confirmed={...record,postId:post.id,revision:post.revision,contentHash:record.pending.contentHash,pending:null};await save(id.key,confirmed);return confirmed;}
  return record;
 }
 async function inspect(message){
  const ctx=await context(message.courseURL),id=identity(ctx.courseURL,message.runId,ctx.authorId);
  let record=records[id.key]||null;const post=await findPost(ctx,id,record);record=await reconcile(ctx,id,record,post);
  return {ctx,id,record,post};
 }
 async function get(message){
  try{const value=await inspect(message);return {supported:true,loginRequired:false,courseURL:message.courseURL,runId:message.runId,category:{id:value.ctx.categoryId,name:'DevDiary'},post:publicPost(value.post),postId:value.post?.id||'',postURL:value.post?.link||'',contentHash:value.record?.contentHash||'',status:value.record?.pending?'unknown':value.post?'published':'unpublished',remoteChanged:!!value.post&&!!value.record?.revision&&value.post.revision!==value.record.revision,concurrency:'preflight'};}
  catch(cause){if(['LOGIN_REQUIRED','UNVERIFIED_SPACES_API','DIARY_PERMISSION_REQUIRED','DIARY_CATEGORY_REQUIRED'].includes(cause.code))return {supported:false,loginRequired:cause.code==='LOGIN_REQUIRED',courseURL:message.courseURL,runId:message.runId,code:cause.code,reason:cause.message};throw cause;}
 }
 async function prepare(message){
  const {ctx,id,record,post}=await inspect(message);
  if(record?.pending)throw error('DIARY_OUTCOME_UNKNOWN','Der letzte Veröffentlichungsversuch ist noch unklar. Es wird kein zweiter Beitrag erstellt; prüfe den Stand in Spaces.');
  if(record?.postId&&!post)throw error('DIARY_POST_MISSING','Der bereits angelegte Beitrag wurde nicht gefunden. Es wird kein neuer Beitrag erstellt.');
  if(message.acknowledgeRevision!==undefined&&(!post||message.acknowledgeRevision!==post.revision))throw error('DIARY_REMOTE_CHANGED','Der bestätigte externe Stand ist nicht mehr aktuell. Prüfe den Beitrag erneut.');
  if(post&&record?.revision&&post.revision!==record.revision&&message.acknowledgeRevision!==post.revision)throw error('DIARY_REMOTE_CHANGED','Dein Beitrag wurde außerhalb von Context verändert. Sichere und prüfe diese Änderungen zuerst in Spaces.');
  if(post&&post.status!=='publish')throw error('DIARY_REMOTE_CHANGED','Der vorhandene Beitrag ist nicht veröffentlicht. Prüfe seinen Status zuerst in Spaces.');
  const html=renderDevDiaryPost(message.content)+'\n'+id.marker,desiredHash=bodyHash(message.title,html),reviewToken=randomUUID();
  for(const [token,review] of reviews)if(now()-review.at>REVIEW_AGE)reviews.delete(token);
  if(reviews.size>=100)throw error('DIARY_REVIEW_LIMIT','Schließe ältere Dev-Diary-Vorschauen und versuche es erneut.');
  const action=post?post.bodyHash===desiredHash?'unchanged':'update':'create';
  reviews.set(reviewToken,{courseURL:message.courseURL,runId:message.runId,authorId:ctx.authorId,categoryId:ctx.categoryId,notifyDisabled:ctx.routes.notifyDisabled,id,postId:post?.id||null,baseRevision:post?.revision||null,title:message.title,content:message.content,html,desiredHash,action,at:now(),result:null});
  return {reviewToken,action,courseURL:message.courseURL,runId:message.runId,preview:{title:message.title,content:message.content,postURL:post?.link||'',baseRevision:post?.revision||null},notifications:ctx.routes.notifyDisabled?'disabled':'site-default',warning:ctx.routes.notifyDisabled?'':'Spaces entscheidet über Benachrichtigungen; E-Mail-Mitteilungen an Kursmitglieder können über diese Schnittstelle nicht sicher ausgeschaltet werden.',concurrency:'preflight'};
 }
 async function publish(message){
  const review=reviews.get(message.reviewToken);if(!review||now()-review.at>REVIEW_AGE)throw error('DIARY_REVIEW_EXPIRED','Prüfe das Dev Diary erneut, bevor du es veröffentlichst.');if(review.result)return review.result;
  const {ctx,id,record,post}=await inspect(review);
  if(ctx.authorId!==review.authorId||ctx.categoryId!==review.categoryId||ctx.routes.notifyDisabled!==review.notifyDisabled)throw error('DIARY_IDENTITY_CHANGED','Anmeldung, Kurskategorie oder Benachrichtigungseinstellung hat sich geändert. Prüfe die Vorschau erneut.');
  if(record?.pending){
   if(post&&post.bodyHash===review.desiredHash&&post.status==='publish'){review.result=publicationResult(review,post,{recovered:true});return review.result;}
   throw error('DIARY_OUTCOME_UNKNOWN','Der letzte Versuch ist noch unklar. Es wird kein weiterer Schreibauftrag gesendet.');
  }
  // Reconcile a confirmed result even after IPC delivery failed or a second
  // identical preview was approved. Never create another copy of a run.
  if(post&&post.bodyHash===review.desiredHash){review.result=publicationResult(review,post,{recovered:true});return review.result;}
  if((post?.id||null)!==review.postId||(post?.revision||null)!==review.baseRevision)throw error('DIARY_REMOTE_CHANGED','Der Beitrag hat sich seit der Vorschau geändert. Es wurde nichts überschrieben.');
  if(review.action==='unchanged'){review.result=publicationResult(review,post,{unchanged:true});return review.result;}
  const pending={...(record||emptyRecord(ctx,review.runId)),postId:post?.id||null,revision:post?.revision||null,pending:{action:review.action,desiredHash:review.desiredHash,contentHash:digest(review.content),at:now()}};
  await save(id.key,pending); // Durable BEFORE the request: a lost reply cannot cause a retry-create.
  try{
   const body={title:review.title,content:review.html,...(review.notifyDisabled?{meta:{scoped_notify_notify_others:'no'}}:{}),...(!post?{slug:id.slug,status:'publish',author:ctx.authorId,categories:[ctx.categoryId]}:{})};
   const raw=(await api(ctx,ctx.routes.collection+(post?'/'+post.id:''),{}, {method:'POST',body})).value;
   const confirmed=validatePost(raw,ctx,id);
   if(confirmed.bodyHash!==review.desiredHash||confirmed.status!=='publish')throw error('DIARY_RESPONSE_INVALID','Der veröffentlichte Inhalt wurde nicht unverändert bestätigt.');
   await save(id.key,{...pending,postId:confirmed.id,revision:confirmed.revision,contentHash:digest(review.content),pending:null});
   review.result=publicationResult(review,confirmed,{recovered:false});return review.result;
  }catch{
   // No automatic retry, even after HTTP errors: WP plugins can return an error
   // after creating a post. Only a subsequent authenticated GET may reconcile it.
   throw error('DIARY_OUTCOME_UNKNOWN','Spaces hat den Schreibauftrag nicht eindeutig bestätigt. Es wird kein zweiter Beitrag erstellt. Prüfe den Stand erneut.');
  }
 }
 async function handle(value){
  if(disposed)throw error('DIARY_PUBLISHER_CLOSED','Der Dev-Diary-Publisher wird geschlossen.');
  const message=diaryRequest(value),pending=queue.then(async()=>{await initialize();return message.op==='get'?get(message):message.op==='prepare'?prepare(message):publish(message);});queue=pending.catch(()=>{});return pending;
 }
 return Object.freeze({handle,initialize,flush:()=>queue,dispose:async()=>{disposed=true;await queue;reviews.clear();}});
}
