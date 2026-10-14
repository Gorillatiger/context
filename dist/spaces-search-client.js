import {spacesSearchCourseURL} from './spaces-search-policy.js';
// Shared by the search dialog and the agent. Only explicit current course
// links are authority; a model cannot supply a URL or authentication material.
import {spaceBrowserURL} from './spaces.js';
import {normalizePlatformURL} from './source-catalog.js';

const aborted=()=>new DOMException('Abgebrochen','AbortError');
const idPattern=/^b:spaces-rest:[a-f0-9]{64}$/;
export function createSpacesSearchClient({getWorkspace=()=>({projects:[]}),transport,fetchImpl=globalThis.fetch}={}){
  let disposed=false,generation=0;
  const pending=new Set(),grants=new Map();
  const courses=()=>getWorkspace().projects?.filter(p=>{if(p.archived)return false;try{return !!spacesSearchCourseURL(spaceBrowserURL(p));}catch{return false;}}).slice(0,300)||[];
  function course(id){const p=courses().find(p=>p.id===id);if(!p)throw new Error('Dieser Spaces-Kurs ist nicht mehr freigegeben.');return {id:p.id,name:p.name,url:spacesSearchCourseURL(spaceBrowserURL(p))};}
  function assertCurrent(p,epoch,signal){if(disposed||generation!==epoch||signal?.aborted)throw aborted();if(course(p.id).url!==p.url)throw aborted();}
  async function request(message,signal){
    if(disposed||signal?.aborted)throw aborted();
    const controller=new AbortController(),cancel=()=>controller.abort();pending.add(controller);signal?.addEventListener('abort',cancel,{once:true});
    try{
      const fn=transport||globalThis.contextDesktop?.spacesSearch;
      if(fn){
        const requestId=crypto.randomUUID(),cancelNative=()=>{void Promise.resolve(fn({op:'cancel',requestId})).catch(()=>{});};
        controller.signal.addEventListener('abort',cancelNative,{once:true});
        try{const reply=await fn({...message,requestId});if(controller.signal.aborted)throw aborted();if(reply?.ok===false)throw new Error(reply.error||'Spaces konnte nicht durchsucht werden.');return reply?.ok===true?reply.value:reply;}
        finally{controller.signal.removeEventListener('abort',cancelNative);}
      }
      const response=await fetchImpl('/api/spaces/'+message.op,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Context-Request':'spaces-search'},body:JSON.stringify(message),signal:controller.signal});
      if(controller.signal.aborted)throw aborted();
      const raw=await response.text();if(raw.length>1000000)throw new Error('Die Suchantwort ist zu groß.');let value;try{value=JSON.parse(raw);}catch{throw new Error('Spaces-Direktsuche benötigt die aktuelle Context-App oder ein verbundenes Web-Backend.');}
      if(!response.ok)throw new Error(value.message||'Spaces konnte nicht durchsucht werden.');return value;
    }finally{pending.delete(controller);signal?.removeEventListener('abort',cancel);}
  }
  function verifyItem(value,p){
    let u;try{u=new URL(value?.url);}catch{}
    if(!idPattern.test(value?.id)||value.projectId!==p.id||typeof value.title!=='string'||value.title.length>500||!u||u.origin!=='https://spaces.th-koeln.de'||u.username||u.password||u.search||u.hash||!u.pathname.startsWith(new URL(p.url).pathname))throw new Error('Die Spaces-Fundstelle konnte nicht sicher zugeordnet werden.');
    const metadata={};
    if(value.revision&&value.contentRevision===value.revision){
      metadata.contentRevision=value.revision;
      metadata.platformLinks=(Array.isArray(value.platformLinks)?value.platformLinks:[]).slice(0,30).flatMap(link=>{
        try{if(!['miro','gitlab','sciebo','mattermost'].includes(link?.service)||link.sourceURL!==u.href)return [];return [{service:link.service,url:normalizePlatformURL(link.service,link.url),title:typeof link.title==='string'?link.title.slice(0,200):'',sourceURL:u.href,sourceTitle:value.title,...(typeof link.postedBy==='string'?{postedBy:link.postedBy.slice(0,200)}:{}),...(typeof link.postedAt==='string'?{postedAt:link.postedAt.slice(0,80)}:{})}];}catch{return [];}
      });
      metadata.platformLinksMore=value.platformLinksMore===true||Array.isArray(value.platformLinks)&&value.platformLinks.length>30;
    }
    return {id:value.id,title:value.title,url:u.href,source:'spaces',kind:'browser',projectId:p.id,projectName:p.name,courseURL:p.url,...metadata,...(typeof value.updatedAt==='string'?{updatedAt:value.updatedAt.slice(0,80)}:{}),...(typeof value.authorName==='string'?{authorName:value.authorName.slice(0,200)}:{}),...(value.revision?{revision:value.revision,offset:value.offset,hasMore:value.hasMore,nextOffset:value.nextOffset}:{}),text:typeof value.text==='string'?value.text.slice(0,4000):'',status:value.status==='full'?'full':value.status==='excerpt'?'excerpt':'metadata'};
  }
  async function searchCourse({query,projectId,page=1,perPage=20,signal}={}){
    if(typeof query!=='string'||!query.trim()||query.length>200||!Number.isSafeInteger(page)||page<1||page>10000||![5,20].includes(perPage))throw new Error('Bitte einen Suchbegriff mit höchstens 200 Zeichen eingeben.');
    const p=course(projectId),epoch=generation;assertCurrent(p,epoch,signal);
    const reply=await request({op:'search',courseURL:p.url,projectId:p.id,query:query.trim(),page,perPage},signal);assertCurrent(p,epoch,signal);
    if(!Array.isArray(reply?.items)||reply.items.length>perPage||reply.page!==page||typeof reply.hasMore!=='boolean')throw new Error('Die Spaces-Suchantwort ist ungültig.');
    const items=reply.items.map(item=>verifyItem(item,p));
    for(const item of items){grants.delete(item.id);grants.set(item.id,{course:p,documentURL:item.url,epoch,at:Date.now()});while(grants.size>200)grants.delete(grants.keys().next().value);}
    return {items,page,perPage,total:reply.total,totalPages:reply.totalPages,hasMore:reply.hasMore,scope:'published'};
  }
  async function read({projectId,id,offset=0,expectedRevision,signal}={}){
    const grant=grants.get(id),p=course(projectId),epoch=generation;
    if(!grant||grant.course.id!==p.id||grant.course.url!==p.url||grant.epoch!==epoch||Date.now()-grant.at>10*60*1000)throw new Error('Suche diese Spaces-Fundstelle zuerst erneut.');
    assertCurrent(p,epoch,signal);
    const value=await request({op:'read',courseURL:p.url,projectId:p.id,id,offset,...(expectedRevision?{expectedRevision}:{})},signal);assertCurrent(p,epoch,signal);
    const document=verifyItem(value,p);if(document.url!==grant.documentURL||expectedRevision&&document.revision!==expectedRevision||document.id!==id||!['full','excerpt'].includes(document.status)||!Number.isSafeInteger(document.offset)||typeof document.hasMore!=='boolean'||!/^[a-f0-9]{64}$/.test(document.revision||''))throw new Error('Der Spaces-Text konnte nicht sicher gelesen werden.');return document;
  }
  async function search({query,projectId='',page=1,signal}={}){
    const selected=projectId?[course(projectId)]:courses().slice(0,12).map(p=>course(p.id));
    if(!selected.length)return {items:[],page,hasMore:false,courses:[],warnings:['Verknüpfe zuerst einen Spaces-Kurs.']};
    const outcomes=new Array(selected.length);let next=0;
    await Promise.all(Array.from({length:Math.min(3,selected.length)},async()=>{
      while(next<selected.length){const i=next++,p=selected[i];try{outcomes[i]={course:p,reply:await searchCourse({query,projectId:p.id,page,signal})};}catch(error){if(error.name==='AbortError')throw error;outcomes[i]={course:p,error:error.message};}}
    }));
    if(signal?.aborted||disposed)throw aborted();
    const failed=outcomes.filter(o=>o.error),items=outcomes.flatMap(o=>o.reply?.items||[]);
    return {items,page,hasMore:outcomes.some(o=>o.reply?.hasMore),scope:'published',courses:outcomes.map(o=>({id:o.course.id,name:o.course.name,status:o.error?'error':'ok',...(o.error?{message:o.error}:{total:o.reply.total,totalPages:o.reply.totalPages})})),warnings:[...failed.map(o=>o.course.name+': '+o.error),...(!projectId&&courses().length>12?['Zwölf Kurse pro Anfrage. Weitere Kurse gezielt im Kursfilter auswählen.']:[])],...(failed.length===selected.length?{error:'Die gewählten Spaces-Kurse konnten nicht durchsucht werden.'}:{})};
  }
  function invalidate(){generation++;grants.clear();for(const c of pending)c.abort();}
  return {search,searchCourse,read,invalidate,dispose(){invalidate();disposed=true;},async tool(name,args,signal){if(name==='search_spaces')return searchCourse({...args,perPage:5,signal});if(name==='read_spaces_result')return read({...args,signal});throw new Error('Unbekanntes Spaces-Suchwerkzeug.');}};
}
