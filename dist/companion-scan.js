import {safeSpacesURL} from './agent-browser.js';
import {spaceBrowserURL} from './spaces.js';
import {redactKnowledge} from './knowledge.js';
import {fingerprint} from './companion-engine.js';

const controlPattern=/^(?:primary-swap-menu-label|secondary-swap-menu-label|accordion-item-[a-zA-Z0-9_-]{1,80})$/;
const excludedPath=/(?:^|\/)(?:members?|users?|profiles?|people|persons?|participants?|students?|staff|directory|contacts?|community|groups?|wp-admin|wp-json|wp-content|wp-includes|feed|comments?|trackback|attachment|embed)(?:\/|$)|(?:^|\/)xmlrpc\.php$/i;
const downloadExtension=/\.(?:pdf|zip|gz|tar|docx?|xlsx?|pptx?|od[tpst]|csv|txt|json|xml|js|css|exe|dmg|pkg|apk|jpe?g|png|gif|webp|avif|svg|ico|heic|mp[34]|m4a|mov|webm|wav|ogg|woff2?|ttf)(?:\/|$)/i;

function decodedPath(url){
  let path=new URL(url).pathname;
  for(let i=0;i<3;i++){
    const decoded=decodeURIComponent(path);
    if(decoded===path)break;
    path=decoded;
  }
  if(/[%\\\x00-\x20]/.test(path)||/(?:^|\/)\.{1,2}(?:\/|$)/.test(path))throw new Error('Der Spaces-Link ist kein lesender Kursinhalt.');
  return path;
}

export function courseRoot(project){
  const linked=spaceBrowserURL(project);
  if(!linked)return '';
  const url=safeSpacesURL(linked),path=decodedPath(url);
  if(path==='/'||excludedPath.test(path)||downloadExtension.test(path)||new URL(url).searchParams.has('s'))throw new Error('Verknüpfe eine konkrete Spaces-Kursseite.');
  return {url,path:path.replace(/\/$/,'')};
}

// Global blog/date permalinks are only eligible when the current course page
// actually offers them. Generic root pages, people and other course slugs stay out.
export function scopedURL(value,root){
  if(typeof value!=='string'||value.length>2000)throw new Error('Ungültiger Spaces-Link.');
  const url=safeSpacesURL(value),parsed=new URL(url),path=decodedPath(url);
  if(excludedPath.test(path)||downloadExtension.test(path)||parsed.searchParams.has('s'))throw new Error('Dieser Link liegt außerhalb lesender Kursinhalte.');
  const within=path===root.path||path.startsWith(root.path+'/');
  const blog=/^\/(?:wp\/)?blog\/[a-zA-Z0-9_\p{L}\p{N}-]+(?:\/[a-zA-Z0-9_\p{L}\p{N}-]+)*\/?$/u.test(path);
  const permalink=/^\/(?:wp\/|blog\/|wp\/blog\/)?20\d{2}\/\d{1,2}\/\d{1,2}\/[a-zA-Z0-9_\p{L}\p{N}-]+\/?$/u.test(path);
  if(!within&&!blog&&!permalink)throw new Error('Der Link gehört nicht zum gewählten Kurs.');
  return url;
}

function pageData(value,root,offset=0,expectedURL=''){
  if(!value||typeof value!=='object')throw new Error('Spaces lieferte keine lesbare Seite.');
  if(value.loginRequired===true)return {loginRequired:true};
  const url=scopedURL(value.url,root);
  if(expectedURL&&url!==expectedURL)throw new Error('Die Spaces-Seite hat sich während des Lesens geändert.');
  if(typeof value.text!=='string'||value.text.length>5000||!Array.isArray(value.links)||value.links.length>45||value.offset!==undefined&&value.offset!==offset||value.controls!==undefined&&(!Array.isArray(value.controls)||value.controls.length>30)||value.hasMore!==undefined&&typeof value.hasMore!=='boolean')throw new Error('Spaces lieferte einen ungültigen Textabschnitt.');
  return {url,title:redactKnowledge(typeof value.title==='string'?value.title:'').slice(0,200),text:redactKnowledge(value.text),hasMore:value.hasMore===true,links:value.links,controls:value.controls||[],loginRequired:false};
}

function candidate(page,root,visited,clicked){
  const controls=page.controls.filter(c=>c&&typeof c.id==='string'&&controlPattern.test(c.id)&&!clicked.has(c.id));
  const orga=controls.find(c=>c.id==='secondary-swap-menu-label');
  if(orga)return {command:'click',controlId:orga.id};
  for(const link of page.links){
    try{
      const url=scopedURL(link?.url,root);
      if(!visited.has(url))return {command:'open',url};
    }catch{}
  }
  const control=controls.find(c=>c.id.startsWith('accordion-item-'))||controls.find(c=>c.id==='primary-swap-menu-label');
  return control?{command:'click',controlId:control.id}:null;
}

/** Sequential, bounded read-only course scan. This never asks a model what to open. */
export async function scanCourseSpaces({projects,request,signal,onProgress=()=>{},maxPages=12}){
  if(!Array.isArray(projects)||typeof request!=='function'||typeof onProgress!=='function'||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>12)throw new Error('Ungültiger Auftrag für die Spaces-Kursprüfung.');
  const courses=projects.filter(p=>p&&typeof p==='object'&&!p.archived);
  const coverage=courses.map(p=>({projectId:typeof p.id==='string'?p.id:'',status:'not_scanned',pages:0,message:'Noch nicht geprüft.'}));
  const sources=new Map(),views=new Map();let used=0,interrupted=false;
  const progress=(row,stage='done')=>onProgress({...row,totalPages:used,stage});
  const cancelled=()=>signal?.aborted===true;
  const assertActive=()=>{if(cancelled())throw new DOMException('Abgebrochen','AbortError');};
  const call=async command=>{assertActive();const value=await request(command,{signal});assertActive();return value;};

  async function savePage(page,projectId,courseURL,extraText='',excerpt=page.hasMore){
    const id='live:'+await fingerprint([page.url,projectId]),existing=sources.get(id);
    const text=page.text+extraText;
    if(!views.has(id))views.set(id,new Map());
    views.get(id).set(used,{text,excerpt});
    const parts=[...views.get(id).values()],unique=[...new Set(parts.map(part=>part.text))],combined=unique.join('\n\n');
    sources.set(id,{id,kind:'browser',projectId,courseURL,title:page.title||existing?.title||'Kurs-Space',url:page.url,text:combined.slice(0,10000),status:parts.some(part=>part.excerpt)||combined.length>10000?'excerpt':'full',updatedAt:new Date().toISOString()});
  }

  for(let i=0;i<courses.length;i++){
    const project=courses[i],row=coverage[i];let root;
    try{
      if(!row.projectId||row.projectId.length>80)throw new Error('Dieser Kurs hat keine gültige Kennung.');
      root=courseRoot(project);
      if(!root){row.status='not_linked';row.message='Für diesen Kurs fehlt eine gültige Spaces-Verbindung.';progress(row);continue;}
    }catch(error){row.status='error';row.message=redactKnowledge(error?.message||'Die Spaces-Verbindung ist ungültig.').slice(0,400);progress(row);continue;}
    if(cancelled()){interrupted=true;row.message='Prüfung angehalten.';break;}
    if(used>=maxPages){row.message='Das Seitenbudget ist erreicht; dieser Kurs wurde noch nicht geprüft.';progress(row);continue;}
    const visited=new Set(),clicked=new Set(['primary-swap-menu-label']);let command={command:'start',url:root.url},page,partial=false;
    try{
      while(command&&row.pages<3&&used<maxPages){
        used++;progress({...row,message:'Lesende Kursansicht wird geöffnet.'},'reading');
        const raw=await call(command);
        page=pageData(raw,root,0,command.url||page?.url||root.url);
        if(page.loginRequired){row.status='login_required';row.message='Spaces benötigt deine Anmeldung. Anmeldeseiten werden nicht gelesen.';break;}
        if(command.command==='click')clicked.add(command.controlId);
        visited.add(page.url);row.pages++;
        await savePage(page,row.projectId,root.url);
        if(page.hasMore){
          const tail=pageData(await call({command:'read',offset:5000}),root,5000,page.url);
          if(tail.loginRequired){row.status='login_required';row.message='Die Spaces-Anmeldung ist während der Prüfung abgelaufen.';break;}
          await savePage(page,row.projectId,root.url,tail.text,tail.hasMore);
          page={...tail,text:page.text+tail.text};
        }
        partial=[...sources.values()].some(source=>source.projectId===row.projectId&&source.status==='excerpt');
        command=candidate(page,root,visited,clicked);
        row.status=partial||command?'partial':'read';
        row.message=`${row.pages} lesende Ansicht${row.pages===1?'':'en'} lokal geprüft. Das ist eine Momentaufnahme, keine vollständige Kursprüfung.`;
        progress(row,'read');
      }
      if(row.status!=='login_required'){
        if(command||partial){row.status='partial';row.message=`${row.pages} lesende Ansicht${row.pages===1?'':'en'} geprüft; weitere Inhalte oder Ansichten wurden durch das Seitenbudget nicht gelesen.`;}
        else if(row.pages){row.status='read';}
      }
    }catch(error){
      if(cancelled()||error?.name==='AbortError'){interrupted=true;row.status=row.pages?'partial':'not_scanned';row.message='Prüfung angehalten. Bereits gelesene Quellen bleiben erhalten.';progress(row);break;}
      row.status='error';row.message=redactKnowledge(error?.message||'Spaces konnte nicht gelesen werden.').slice(0,400);
    }
    progress(row);
  }
  if(interrupted)for(const row of coverage)if(row.status==='not_scanned'&&row.message==='Noch nicht geprüft.')row.message='Prüfung angehalten; dieser Kurs wurde noch nicht geprüft.';
  return {sources:[...sources.values()],coverage,interrupted};
}

// Resume course coverage before revisiting already sampled courses.
export function pendingCourseOrder(projects,coverage=[]){
 const checked=new Map(coverage.map(c=>[c.projectId,c]));
 return [...projects].sort((a,b)=>{
  const x=checked.get(a.id),y=checked.get(b.id);
  const priority=c=>!c||c.status==='not_scanned'?0:1;
  return priority(x)-priority(y)||(x?.checkedAt||'').localeCompare(y?.checkedAt||'');
 });
}
