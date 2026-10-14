import {courseRoot,scopedURL} from './companion-scan.js';
import {fingerprint} from './companion-engine.js';
import {boardFinding} from './board-index.js';
const allowedControl=/^(?:primary-swap-menu-label|secondary-swap-menu-label|accordion-item-[a-zA-Z0-9_-]{1,80})$/;
// Queue only URLs actually observed in this course, using the existing read-only policy.
// Resume queues stay in RAM; only extracted link metadata enters the workspace.
export async function scanBoardSpaces({projects,request,signal,onProgress=()=>{},sessions=new Map(),maxPages=60,onFindings=()=>{},prioritize}){
 if(!Array.isArray(projects)||typeof request!=='function'||!(sessions instanceof Map)||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>120)throw new Error('Ungültige Board-Suche.');
 const findings=[],coverage=[],courses=projects.filter(p=>!p.archived),perCourse=Math.max(1,Math.floor(maxPages/Math.max(1,courses.length)));let used=0,interrupted=false;
 for(const p of courses){
  const row={projectId:p.id,status:'pending',pages:0,message:''};coverage.push(row);
  if(signal?.aborted||interrupted){interrupted=true;row.message='Angehalten.';continue;}
  let root;try{root=courseRoot(p);if(!root){row.status='not_linked';row.message='Kurs-Space fehlt.';continue;}}catch(e){row.status='error';row.message=e.message;continue;}
  let session=sessions.get(p.id);if(!session||session.root!==root.url){session={root:root.url,queue:[{url:root.url,controls:[],title:p.name}],seen:new Set(),queued:new Set([root.url+'|']),limited:false};sessions.set(p.id,session);}
  let courseUsed=0;
  while(session.queue.length&&used<maxPages&&courseUsed<perCourse&&!signal?.aborted){
   const job=session.queue[0],key=job.url+'|'+job.controls.join(',');
   if(session.seen.has(key)){session.queue.shift();continue;}
   try{
    onProgress({projectId:p.id,pages:used,message:job.controls.length?'Kursabschnitt lesen …':'Kursseite lesen …'});
    used++;courseUsed++;
    let page=await request({command:'start',url:scopedURL(job.url,root),background:true,scan:true},{signal});
    if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');
    if(page.loginRequired){row.status='login_required';row.message='Bitte zuerst bei Spaces anmelden.';break;}
    if(scopedURL(page.url,root)!==job.url)throw new Error('Spaces hat auf eine andere Seite umgeleitet.');
    for(const controlId of job.controls){if(!Array.isArray(page.controls)||!page.controls.some(c=>c.id===controlId))throw new Error('Der gespeicherte Kursabschnitt ist nicht mehr verfügbar.');page=await request({command:'click',controlId,background:true,scan:true},{signal});if(page.loginRequired)break;if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');if(scopedURL(page.url,root)!==job.url)throw new Error('Der Kursabschnitt hat die Seite gewechselt.');}
    if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');
    if(page.loginRequired){row.status='login_required';row.message='Spaces-Anmeldung abgelaufen.';break;}
    if(scopedURL(page.url,root)!==job.url)throw new Error('Der Kursabschnitt hat die Seite gewechselt.');
    if(!Array.isArray(page.boardLinks)){row.status='update_required';row.message='Die Board-Suche benötigt Context Browser 0.13.0. Lokale Quellen bleiben durchsuchbar.';break;}
    if(page.boardLinks.length>100||!Array.isArray(page.links)||page.links.length>45)throw new Error('Ungültige Browser-Antwort.');
    const fresh=[];
    for(const l of page.boardLinks)try{const sourceURL=scopedURL(l.sourceURL||page.url,root);fresh.push(boardFinding({...l,sourceURL},{id:sourceURL.length>200?'spaces:'+await fingerprint([sourceURL]):sourceURL,projectId:p.id,projectTitle:p.name,kind:'spaces',url:page.url,title:page.title}));}catch{}
    await onFindings(fresh);findings.push(...fresh);session.queue.shift();session.seen.add(key);row.pages++;
    session.limited ||= page.boardLinksMore===true||page.links.length===45;
    session.limited ||= (page.controls||[]).some(c=>allowedControl.test(c.id)&&!job.controls.includes(c.id)&&!c.id.endsWith('-swap-menu-label')&&job.controls.length>=4);
    const sections=(page.controls||[]).filter(c=>allowedControl.test(c.id)&&!job.controls.includes(c.id)).map(c=>({url:page.url,controls:c.id.endsWith('-swap-menu-label')?[c.id]:[...job.controls,c.id],title:typeof c.title==='string'?c.title.slice(0,200):'Kursabschnitt'})).filter(j=>j.controls.length<=4);
    const offered=[...sections,...page.links.flatMap(l=>{try{return [{url:scopedURL(l.url,root),controls:[],title:typeof l.title==='string'?l.title.slice(0,200):'Kurs-Unterseite'}];}catch{return [];}})],nested=[];
    for(const next of offered){const k=next.url+'|'+next.controls.join(',');if(session.queued.has(k))continue;if(session.queued.size>=300){session.limited=true;break;}session.queued.add(k);if(next.controls.length>job.controls.length&&next.url===job.url)nested.push(next);else session.queue.push(next);}
    // Expand observed sections before the chronological post archive. This reaches
    // nested resources without letting a long home feed consume the course budget.
    session.queue.unshift(...nested);
    if(typeof prioritize==='function'&&session.queue.length>1){
     const candidates=session.queue.slice(0,20).map((j,i)=>({id:'v'+i,title:j.title||'Kurs-Unterseite',kind:j.controls.length?'section':'page',depth:j.controls.length}));
     const order=await prioritize({projectId:p.id,projectTitle:p.name,pageTitle:page.title,visited:row.pages,candidates});
     if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');
     // A model may only reorder these host-created jobs. No URLs, controls or
     // inferred board metadata are ever accepted from its answer.
     if(Array.isArray(order)&&order.length<=candidates.length&&order.every(id=>typeof id==='string'&&candidates.some(c=>c.id===id))&&new Set(order).size===order.length){
      const ranked=order.map(id=>session.queue[candidates.findIndex(c=>c.id===id)]),rest=session.queue.filter((_,i)=>!order.includes(candidates[i]?.id));session.queue=[...ranked,...rest];
     }
    }
   }catch(e){if(signal?.aborted||e.name==='AbortError'){interrupted=true;row.message='Angehalten; gespeicherte Fundstellen bleiben erhalten.';break;}row.status='error';row.message=e.message;break;}
  }
  if(signal?.aborted)interrupted=true;
  if(row.status==='pending'){row.status=session.queue.length?'partial':session.limited?'partial':'read';row.message=session.queue.length?`${session.queue.length} angebotene Ansichten warten auf die Fortsetzung.`:session.limited?'Eine Begrenzung wurde erreicht. Weitere Inhalte können fehlen.':'Alle angebotenen lesbaren Links geprüft. Dateien, versteckte und später geladene Inhalte können fehlen.';}
  onProgress(row);
 }
 return {findings,coverage,interrupted,pages:used};
}
