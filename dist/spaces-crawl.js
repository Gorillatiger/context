import {courseRoot,scopedURL} from './companion-scan.js';
import {redactKnowledge} from './knowledge.js';
import {fingerprint} from './companion-engine.js';
import {miroBoardURL} from './board-index.js';
import {normalizePlatformURL} from './source-catalog.js';

export const CRAWL_LIMITS=Object.freeze({maxViews:300,defaultViews:100,courseViews:500,sources:2000,totalText:20000000,text:60000,chunk:5000,links:500,controls:300,depth:8,attempts:2});
const controlPattern=/^(?:primary-swap-menu-label|secondary-swap-menu-label|accordion-item-[a-zA-Z0-9_-]{1,80})$/;
const limitCodes=new Set(['course-views','total-views','total-text','text','links','controls','depth','board-links','platform-links']);
const clean=(value,max=200)=>redactKnowledge(typeof value==='string'?value:'').replace(/\0/g,'').slice(0,max);
const key=job=>JSON.stringify([job.url,job.controls]);
const invalid=()=>new Error('Der gespeicherte Spaces-Suchstand ist ungültig.');
const failure=(message,code='error')=>Object.assign(new Error(message),{code});
const aborted=()=>new DOMException('Abgebrochen','AbortError');
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const safeID=value=>typeof value==='string'&&/^[-a-zA-Z0-9_]{1,80}$/.test(value);
function boundedText(value,limit){let end=Math.max(0,Math.min(value.length,limit));if(/[\uD800-\uDBFF]/.test(value[end-1]||'')&&/[\uDC00-\uDFFF]/.test(value[end]||''))end--;return value.slice(0,end);}
export function cleanCrawlBoardLinks(value,root){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>100)throw failure('Spaces lieferte ungültige Boardlinks.');
 const found=[];for(const item of value){try{if(!plain(item))continue;const url=miroBoardURL(item.url),sourceURL=scopedURL(item.sourceURL||root.url,root);found.push({url,title:clean(item.title,200),postedBy:clean(item.postedBy,200),postedAt:typeof item.postedAt==='string'&&Number.isFinite(Date.parse(item.postedAt))?new Date(item.postedAt).toISOString():'',sourceTitle:clean(item.sourceTitle,200),sourceURL});}catch{}}return found;
}
export function cleanCrawlPlatformLinks(value,root,pageURL){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>100)throw failure('Spaces lieferte ungültige Plattformlinks.');
 const sourceURL=scopedURL(pageURL,root),found=[],seen=new Set();
 for(const item of value)try{
  if(!plain(item)||scopedURL(item.sourceURL,root)!==sourceURL)continue;
  const url=normalizePlatformURL(item.service,item.url),key=item.service+'\n'+url;if(seen.has(key))continue;seen.add(key);
  found.push({service:item.service,url,title:clean(item.title),sourceURL,sourceTitle:clean(item.sourceTitle),postedBy:clean(item.postedBy),postedAt:typeof item.postedAt==='string'&&Number.isFinite(Date.parse(item.postedAt))?new Date(item.postedAt).toISOString():''});
 }catch{}
 return found;
}
export const emptyCrawlState=()=>({version:1,cursor:0,sessions:[]});

function projectRoots(projects){
 const roots=new Map();
 for(const project of projects||[]){if(!plain(project)||!safeID(project.id)||project.archived)continue;try{const root=courseRoot(project);if(root)roots.set(project.id,root);}catch{}}
 return roots;
}

/** Treat decrypted cache data as untrusted. Only a bounded, root-connected graph survives. */
export function validateCrawlState(value,{projects}={}){
 if(!plain(value)||value.version!==1||!Array.isArray(value.sessions)||value.sessions.length>CRAWL_LIMITS.sources||!Number.isSafeInteger(value.cursor)||value.cursor<0)throw invalid();
 if(projects!==undefined&&!Array.isArray(projects))throw invalid();
 const roots=projects===undefined?null:projectRoots(projects),state=emptyCrawlState(),ids=new Set(),sourceIDs=new Set();let views=0,chars=0;
 for(const raw of value.sessions){
  if(!plain(raw)||!safeID(raw.projectId)||ids.has(raw.projectId)||typeof raw.root!=='string')throw invalid();ids.add(raw.projectId);
  let root;try{root=courseRoot({links:[{tool:'spaces',url:raw.root}]});if(!root||root.url!==raw.root)throw invalid();}catch{throw invalid();}
  // A changed root or archived/removed course cannot keep an old navigation lease.
  if(roots&&roots.get(raw.projectId)?.url!==root.url)continue;
  if(!Array.isArray(raw.queue)||!Array.isArray(raw.seen)||!Array.isArray(raw.failed)||!Array.isArray(raw.limits)||raw.limits.some(v=>!limitCodes.has(v))||raw.limits.length>limitCodes.size)throw invalid();
  if([raw.queue,raw.seen,raw.failed].some(a=>a.length>CRAWL_LIMITS.courseViews))throw invalid();
  const normalize=(job,kind)=>{
   if(!plain(job)||!Array.isArray(job.controls)||job.controls.length>CRAWL_LIMITS.depth||job.controls.some(v=>typeof v!=='string'||!controlPattern.test(v))||new Set(job.controls).size!==job.controls.length||!Array.isArray(job.section)||job.section.length!==job.controls.length||job.section.some(v=>typeof v!=='string'||v.length>160)||typeof job.title!=='string'||job.title.length>200||typeof job.offeredBy!=='string'||job.offeredBy.length>4000)throw invalid();
   let url;try{url=scopedURL(job.url,root);}catch{throw invalid();}if(url!==job.url)throw invalid();
   const result={url,controls:[...job.controls],section:job.section.map(v=>clean(v,160)),title:clean(job.title),offeredBy:job.offeredBy,attempts:0};
   if(kind==='seen'){
    if(typeof job.sourceId!=='string'||!/^crawl:[a-f0-9]{64}$/.test(job.sourceId)||!Number.isSafeInteger(job.length)||job.length<0||job.length>CRAWL_LIMITS.text||!['full','excerpt'].includes(job.status))throw invalid();
    Object.assign(result,{sourceId:job.sourceId,length:job.length,status:job.status});
   }else{if(!Number.isSafeInteger(job.attempts)||job.attempts<0||job.attempts>CRAWL_LIMITS.attempts)throw invalid();result.attempts=job.attempts;}
   if(kind==='failed'){if(typeof job.message!=='string'||job.message.length>400)throw invalid();result.message=clean(job.message,400);}
   return result;
  };
  const session={projectId:raw.projectId,root:root.url,queue:raw.queue.map(j=>normalize(j,'queue')),seen:raw.seen.map(j=>normalize(j,'seen')),failed:raw.failed.map(j=>normalize(j,'failed')),limits:[...new Set(raw.limits)]};
  const all=new Map(),seenKeys=new Set();
  for(const kind of ['seen','queue','failed']){
   const own=new Set();for(const job of session[kind]){const k=key(job);if(own.has(k))throw invalid();own.add(k);if(kind==='seen')seenKeys.add(k);const previous=all.get(k);if(previous&&!seenKeys.has(k))throw invalid();all.set(k,previous||job);}
  }
  if(!all.size||all.size>CRAWL_LIMITS.courseViews||session.queue.some(j=>session.failed.some(f=>key(f)===key(j))))throw invalid();
  for(const job of session.seen){if(sourceIDs.has(job.sourceId))throw invalid();sourceIDs.add(job.sourceId);}
  views+=all.size;chars+=session.seen.reduce((n,j)=>n+j.length,0);
  const connected=new Set(),visiting=new Set();
  function visit(k){if(connected.has(k))return;if(visiting.has(k))throw invalid();const job=all.get(k);if(!job)throw invalid();visiting.add(k);
   if(!job.offeredBy){if(job.url!==root.url||job.controls.length)throw invalid();}
   else{if(!seenKeys.has(job.offeredBy)||job.offeredBy===k)throw invalid();visit(job.offeredBy);}
   visiting.delete(k);connected.add(k);
  }
  for(const k of all.keys())visit(k);state.sessions.push(session);
 }
 if(views>CRAWL_LIMITS.sources||chars>CRAWL_LIMITS.totalText)throw invalid();
 state.cursor=state.sessions.length?value.cursor%state.sessions.length:0;return state;
}

const snapshot=state=>JSON.parse(JSON.stringify(state));
function coverageOf(state,projects,notes=new Map()){
 const sessions=new Map(state.sessions.map(s=>[s.projectId,s]));
 return projects.filter(p=>plain(p)&&!p.archived).map(p=>{
  const s=sessions.get(p.id),note=notes.get(p.id);if(!s)return {projectId:p.id,status:note?.status||'not_linked',views:0,pending:0,failed:0,limits:[],message:note?.message||'Für diesen Kurs fehlt ein lesender Spaces-Link.'};
  const incomplete=s.seen.some(j=>j.status==='excerpt')||s.failed.length||s.limits.length;
  return {projectId:p.id,status:note?.status||(s.queue.length||incomplete?'partial':'read'),views:s.seen.length,pending:s.queue.length,failed:s.failed.length,limits:[...s.limits],message:note?.message||(s.queue.length?`${s.queue.length} gefundene Ansichten warten auf die Fortsetzung.`:incomplete?'Die gefundenen Ansichten wurden mit Zugriffslücken oder Begrenzungen geprüft.':'Alle gefundenen lesbaren HTML-Ansichten geprüft. Dateien und versteckte Inhalte gehören nicht zu dieser Suche.')};
 });
}

function pageData(value,root,job,offset=0,linkOffset=0,controlOffset=0,reference){
 if(!plain(value))throw failure('Spaces lieferte keine lesbare Ansicht.');
 if(value.loginRequired===true)throw failure('Bitte zuerst bei Spaces anmelden. Anmeldeseiten werden nicht gelesen.','login_required');
 if(value.permissionRequired===true||value.accessDenied===true)throw failure('Der Kursabschnitt ist für dieses Konto nicht freigegeben.','permission_required');
 let url;try{url=scopedURL(value.url,root);}catch{throw failure('Spaces hat den lesenden Kursbereich verlassen.','unsafe_redirect');}
 if(url!==job.url)throw failure('Spaces hat auf eine andere Ansicht umgeleitet.','unsafe_redirect');
 if(!/^[a-f0-9]{64}$/.test(value.contentRevision||'')||!Number.isSafeInteger(value.epoch)||value.epoch<0)throw failure('Die Suche benötigt die aktuelle Context-Browser-Version.','update_required');
 if(typeof value.text!=='string'||value.text.length>CRAWL_LIMITS.chunk||value.offset!==offset||!Number.isSafeInteger(value.nextOffset)||value.nextOffset!==offset+value.text.length||value.nextOffset>CRAWL_LIMITS.text||typeof value.hasMore!=='boolean'||!Number.isSafeInteger(value.totalLength)||value.totalLength<value.nextOffset||value.totalLength>CRAWL_LIMITS.text||typeof value.textTruncated!=='boolean'||!Array.isArray(value.links)||value.links.length>45||!Array.isArray(value.controls)||value.controls.length>30||value.linkOffset!==linkOffset||value.controlOffset!==controlOffset||!Number.isSafeInteger(value.totalLinks)||value.totalLinks<0||value.totalLinks>CRAWL_LIMITS.links||!Number.isSafeInteger(value.totalControls)||value.totalControls<0||value.totalControls>CRAWL_LIMITS.controls||typeof value.linksHasMore!=='boolean'||typeof value.controlsMore!=='boolean')throw failure('Spaces lieferte einen ungültigen Text- oder Linkabschnitt.');
 if(value.hasMore&&(value.nextOffset<=offset||value.text.length<CRAWL_LIMITS.chunk-1))throw failure('Spaces lieferte einen unvollständigen Textabschnitt.');
 if(linkOffset>value.totalLinks||value.links.length!==Math.min(45,value.totalLinks-linkOffset)||value.linksHasMore!==(linkOffset+value.links.length<value.totalLinks)||controlOffset>value.totalControls||value.controls.length!==Math.min(30,value.totalControls-controlOffset)||value.controlsMore!==(controlOffset+value.controls.length<value.totalControls)||value.hasMore!==(value.nextOffset<value.totalLength))throw failure('Spaces lieferte unvollständige Seiten- oder Navigationsgrenzen.');
 if(reference&&(value.contentRevision!==reference.contentRevision||value.epoch!==reference.epoch||value.totalLength!==reference.totalLength||value.totalLinks!==reference.totalLinks||value.totalControls!==reference.totalControls))throw failure('Die Kursansicht hat sich während des Lesens geändert.','changed');
 if(value.boardLinksMore!==undefined&&typeof value.boardLinksMore!=='boolean')throw failure('Spaces lieferte ungültige Boardgrenzen.');
 if(value.platformLinksMore!==undefined&&typeof value.platformLinksMore!=='boolean')throw failure('Spaces lieferte ungültige Plattformgrenzen.');
 return {...value,url,boardLinks:cleanCrawlBoardLinks(value.boardLinks,root),platformLinks:cleanCrawlPlatformLinks(value.platformLinks,root,url),title:clean(value.title),metadata:plain(value.metadata)?value.metadata:{}};
}

function priority(job){if(job.controls.some(id=>id==='secondary-swap-menu-label'))return 0;if(job.controls.length)return 1;if(/\b(?:orga|resources?|ressourcen|material|aufgaben?|termin|plan)\b/i.test(job.title))return 2;return /\/(?:wp\/)?(?:blog\/|20\d{2}\/)/.test(new URL(job.url).pathname)?4:3;}
function uniqueJobs(session){return new Map([...session.seen,...session.queue,...session.failed].map(j=>[key(j),j]));}

/** One sequential, read-only lease per view; no model, network fetch, or external write. */
export async function crawlSpaces({projects,state=emptyCrawlState(),request,maxViews=CRAWL_LIMITS.defaultViews,signal,onProgress=()=>{},onSource=()=>{}}){
 if(!Array.isArray(projects)||typeof request!=='function'||typeof onProgress!=='function'||typeof onSource!=='function'||!Number.isSafeInteger(maxViews)||maxViews<1||maxViews>CRAWL_LIMITS.maxViews)throw new Error('Ungültiger Auftrag für die Spaces-Suche.');
 const current=validateCrawlState(state,{projects}),sources=[],notes=new Map(),paused=new Set();let views=0,interrupted=signal?.aborted===true;
 const roots=projectRoots(projects),projectMap=new Map(projects.map(p=>[p?.id,p]));
 for(const project of projects.filter(p=>plain(p)&&!p.archived)){
  if(!safeID(project.id)){notes.set(project.id,{status:'error',message:'Dieser Kurs hat keine gültige Kennung.'});continue;}
  if(!roots.has(project.id)){try{if(courseRoot(project))throw new Error('Ungültiger Kurs-Link.');}catch(e){notes.set(project.id,{status:'error',message:clean(e.message,400)});}continue;}
  if(!current.sessions.some(s=>s.projectId===project.id)){
   if(current.sessions.reduce((n,s)=>n+uniqueJobs(s).size,0)>=CRAWL_LIMITS.sources){notes.set(project.id,{status:'partial',message:'Die globale Begrenzung von 2.000 Ansichten ist erreicht.'});continue;}
   current.sessions.push({projectId:project.id,root:roots.get(project.id).url,queue:[{url:roots.get(project.id).url,controls:[],section:[],title:clean(project.name),offeredBy:'',attempts:0}],seen:[],failed:[],limits:[]});
  }
 }
 if(current.sessions.length>CRAWL_LIMITS.sources)throw invalid();current.cursor%=Math.max(1,current.sessions.length);
 const assertActive=()=>{if(signal?.aborted)throw aborted();};
 const report=async message=>onProgress({state:snapshot(current),coverage:coverageOf(current,projects,notes),views,message});
 const limit=(session,code)=>{if(!session.limits.includes(code))session.limits.push(code);};
 const usage=()=>({count:current.sessions.reduce((n,s)=>n+uniqueJobs(s).size,0),chars:current.sessions.reduce((n,s)=>n+s.seen.reduce((m,j)=>m+j.length,0),0)});

 while(!interrupted&&views<maxViews){
  const length=current.sessions.length;let session,index=-1;
  for(let i=0;i<length;i++){const candidateIndex=(current.cursor+i)%length,candidate=current.sessions[candidateIndex];if(candidate.queue.length&&!paused.has(candidate.projectId)){session=candidate;index=candidateIndex;break;}}
  if(!session)break;current.cursor=(index+1)%length;
  const job=session.queue[0],root=roots.get(session.projectId),jobKey=key(job),jobId=crypto.randomUUID(),flags={scan:true,background:true,crawler:true,jobId};
  if(usage().chars>=CRAWL_LIMITS.totalText&&!session.seen.some(j=>key(j)===jobKey&&j.length>0)){
   limit(session,'total-text');paused.add(session.projectId);notes.set(session.projectId,{status:'partial',message:'Die lokale Textgrenze von 20 Millionen Zeichen ist erreicht; weitere Ansichten bleiben vorgemerkt.'});continue;
  }
  const call=async command=>{assertActive();const result=await request({...flags,...command},{signal});assertActive();return result;};
  let first,text='',page,readError=null,discoveryLinks=[],discoveryControls=[];views++;
  try{
   await report('Lesende Kursansicht wird geprüft.');
   page=pageData(await call({command:'start',url:job.url,courseURL:root.url}),root,job);
   for(const [controlIndex,controlId] of job.controls.entries()){
    // Replay only controls from the current, genuinely observed view, including paged controls.
    let controls=[...page.controls],offset=page.controlOffset;
    while(page.controlsMore&&!controls.some(c=>c?.id===controlId)){
     offset+=page.controls.length;if(!page.controls.length||offset>=CRAWL_LIMITS.controls)break;
     page=pageData(await call({command:'read',offset:0,controlOffset:offset,expectedRevision:page.contentRevision}),root,job,0,0,offset,page);controls.push(...page.controls);
    }
    const observed=controls.find(c=>c?.id===controlId&&controlPattern.test(c.id));
    if(!observed)throw failure('Der gespeicherte Kursabschnitt ist nicht mehr verfügbar.','missing_control');
    job.section[controlIndex]=clean(observed.title,160)||job.section[controlIndex];
    page=pageData(await call({command:'click',controlId,expectedRevision:page.contentRevision}),root,job);
   }
   first=page;text=first.text;discoveryLinks=[...first.links];discoveryControls=[...first.controls];
   while(page.hasMore&&page.nextOffset<CRAWL_LIMITS.text){page=pageData(await call({command:'read',offset:page.nextOffset,expectedRevision:first.contentRevision}),root,job,page.nextOffset,0,0,first);text+=page.text;}
   let lastLinks=first,lastControls=first;
   while(lastLinks.linksHasMore){const offset=lastLinks.linkOffset+lastLinks.links.length;if(!lastLinks.links.length||offset>=CRAWL_LIMITS.links){limit(session,'links');break;}lastLinks=pageData(await call({command:'read',offset:0,linkOffset:offset,expectedRevision:first.contentRevision}),root,job,0,offset,0,first);discoveryLinks.push(...lastLinks.links);}
   while(lastControls.controlsMore){const offset=lastControls.controlOffset+lastControls.controls.length;if(!lastControls.controls.length||offset>=CRAWL_LIMITS.controls){limit(session,'controls');break;}lastControls=pageData(await call({command:'read',offset:0,controlOffset:offset,expectedRevision:first.contentRevision}),root,job,0,0,offset,first);discoveryControls.push(...lastControls.controls);}
   if(text.length>first.text.length||discoveryLinks.length>first.links.length||discoveryControls.length>first.controls.length){const confirmed=pageData(await call({command:'read',offset:0,expectedRevision:first.contentRevision}),root,job,0,0,0,first);if(confirmed.text!==first.text)throw failure('Der erste Textabschnitt hat sich während des Lesens geändert.','changed');}
  }catch(error){readError=error;if(first){text=first.text;discoveryLinks=[];discoveryControls=[];}}
  finally{
   // Release must run even after AbortSignal fires; it never navigates or changes content.
   try{await request({...flags,command:'release'},{});}catch{}
  }
  let commitError=null;
  if(first){
   const id='crawl:'+await fingerprint([session.projectId,session.root,job.url,job.controls]),previous=session.seen.find(j=>key(j)===jobKey),budget=usage(),room=CRAWL_LIMITS.totalText-budget.chars+(previous?.length||0);
   const redacted=redactKnowledge(text),quotaTruncated=room<redacted.length;
   if(quotaTruncated){limit(session,'total-text');paused.add(session.projectId);}
   const body=boundedText(redacted,Math.min(room,CRAWL_LIMITS.text)),truncated=!!readError||signal?.aborted===true||first.textTruncated||first.totalLength>text.length||first.hasMore&&text.length===first.text.length||body.length<redacted.length||quotaTruncated;
   if(first.boardLinksMore)limit(session,'board-links');if(first.platformLinksMore)limit(session,'platform-links');if(first.textTruncated)limit(session,'text');if(first.linksTruncated)limit(session,'links');if(first.controlsTruncated)limit(session,'controls');
   const posts=first.metadata.posts,post=Array.isArray(posts)&&posts.length===1&&posts[0]?.sourceURL===job.url?posts[0]:null;
   const postedAt=post&&typeof post.postedAt==='string'&&Number.isFinite(Date.parse(post.postedAt))?new Date(post.postedAt).toISOString():'';
   const source={id,kind:'browser',projectId:session.projectId,courseURL:session.root,title:job.controls.length?`${first.title||projectMap.get(session.projectId)?.name||'Kurs-Space'} · ${job.section.join(' / ')}`.slice(0,200):first.title||clean(job.title)||'Kurs-Space',url:job.url,text:body,status:truncated?'excerpt':'full',updatedAt:new Date().toISOString(),section:[...job.section],boardLinks:cleanCrawlBoardLinks(first.boardLinks,root),platformLinks:readError?[]:cleanCrawlPlatformLinks(first.platformLinks,root,first.url),platformLinksMore:first.platformLinksMore===true,contentRevision:first.contentRevision,postedBy:post?clean(post.postedBy):'',postedAt};
   try{
    await onSource(source);sources.push(source);const record={...job,sourceId:id,length:body.length,status:source.status};delete record.message;
    if(previous)Object.assign(previous,record);else session.seen.push(record);
   }catch(error){commitError=error;}
  }
  if(commitError){notes.set(session.projectId,{status:'error',message:clean(commitError.message||'Die lokale Quelle konnte nicht gespeichert werden.',400)});paused.add(session.projectId);await report('Lokales Speichern fehlgeschlagen; die Ansicht bleibt vorgemerkt.');continue;}
  if(signal?.aborted||readError?.name==='AbortError'){interrupted=true;notes.set(session.projectId,{status:'partial',message:'Suche angehalten; bestätigte Auszüge und Warteschlange bleiben erhalten.'});await report('Suche angehalten.');break;}
  if(readError){
   const status=readError.code||'error';notes.set(session.projectId,{status,message:clean(readError.message,400)});paused.add(session.projectId);
   if(!['login_required','permission_required','update_required'].includes(status)){
    job.attempts++;if(job.attempts>=CRAWL_LIMITS.attempts||['missing_control','unsafe_redirect'].includes(status)){session.queue.shift();session.failed.push({...job,message:clean(readError.message,400)});}
   }
   await report('Ein Kursabschnitt konnte nicht gelesen werden.');continue;
  }
  session.queue.shift();notes.delete(session.projectId);
  const offered=[];
  for(const control of discoveryControls){if(!plain(control)||!controlPattern.test(control.id||'')||job.controls.includes(control.id)||control.expanded===true||control.selected===true)continue;
   const swap=control.id.endsWith('-swap-menu-label'),controls=swap?[control.id]:[...job.controls,control.id],section=swap?[clean(control.title,160)]:[...job.section,clean(control.title,160)];
   if(controls.length>CRAWL_LIMITS.depth){limit(session,'depth');continue;}offered.push({url:job.url,controls,section,title:clean(control.title),offeredBy:jobKey,attempts:0});
  }
  for(const link of discoveryLinks){try{const url=scopedURL(link?.url,root);offered.push({url,controls:[],section:[],title:clean(link.title)||'Kurs-Unterseite',offeredBy:jobKey,attempts:0});}catch{}}
  const known=uniqueJobs(session);for(const next of offered.sort((a,b)=>priority(a)-priority(b))){const k=key(next);if(known.has(k))continue;if(known.size>=CRAWL_LIMITS.courseViews){limit(session,'course-views');break;}if(usage().count>=CRAWL_LIMITS.sources){limit(session,'total-views');break;}session.queue.push(next);known.set(k,next);}
  session.queue.sort((a,b)=>priority(a)-priority(b));
  if(usage().chars>=CRAWL_LIMITS.totalText){limit(session,'total-text');paused.add(session.projectId);}
  await report('Kursansicht lokal übernommen.');
 }
 if(signal?.aborted)interrupted=true;
 // A structurally valid snapshot is safe to hand to the encrypted store, including interrupted jobs.
 const finalState=validateCrawlState(current,{projects});return {state:finalState,sources,coverage:coverageOf(finalState,projects,notes),interrupted,views};
}
