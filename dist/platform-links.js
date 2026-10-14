import {courseRoot,scopedURL} from './companion-scan.js';
import {normalizePlatformURL,validPlatformProjectId} from './source-catalog.js';
import {boardKnowledgeKey} from './board-index.js';
import {redactKnowledge} from './knowledge.js';

export const PLATFORM_FINDING_LIMITS=Object.freeze({findings:500,pageLinks:100});
const services=['miro','gitlab','sciebo','mattermost'];
const labels={miro:'Miro-Board',gitlab:'GitLab',sciebo:'Sciebo',mattermost:'Mattermost'};
const fields=['id','projectId','courseURL','url','service','title','sourceURL','sourceTitle','postedBy','postedAt','foundAt'];
const failure=()=>new Error('Ungültige Plattform-Fundstelle.');
const plain=(value,max=200)=>redactKnowledge(typeof value==='string'?value.trim().replace(/<[^>]*>/g,'').slice(0,max):'').slice(0,max).replace(/[\uD800-\uDBFF]$/,'');
function stamp(value){
  if(typeof value!=='string'||value.length>80||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))return '';
  const day=new Date(value.slice(0,10)+'T12:00:00Z');if(!Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==value.slice(0,10))return '';
  return new Date(value).toISOString();
}
function rootForSaved(courseURL){
  const root=courseRoot({links:[{tool:'spaces',url:courseURL}]});if(!root)throw failure();return root;
}
function identity(value){const json=JSON.stringify([value.projectId,value.courseURL,value.service,value.url,value.sourceURL]);return 'platform-link:'+boardKnowledgeKey(json).slice(6)+boardKnowledgeKey('platform-link-v1:'+json).slice(6);}
function finding(value){
  if(!value||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key))||!value.projectId||!validPlatformProjectId(value.projectId)||!services.includes(value.service)||typeof value.id!=='string'||!/^platform-link:[a-f0-9]{32}$/.test(value.id))throw failure();
  for(const key of ['title','sourceTitle','postedBy'])if(typeof value[key]!=='string'||value[key].length>200)throw failure();
  const root=rootForSaved(value.courseURL),sourceURL=scopedURL(value.sourceURL,root),url=normalizePlatformURL(value.service,value.url),foundAt=stamp(value.foundAt),postedAt=value.postedAt===''?'':stamp(value.postedAt);
  if(!foundAt||value.postedAt!==''&&!postedAt)throw failure();
  const clean={projectId:value.projectId,courseURL:root.url,url,service:value.service,title:plain(value.title)||labels[value.service],sourceURL,sourceTitle:plain(value.sourceTitle)||'Kurs-Space',postedBy:plain(value.postedBy),postedAt,foundAt};
  if(value.id!==identity(clean))throw failure();return {id:value.id,...clean};
}
/** Backups preserve valid historical provenance; current grants are checked below. */
export function validatePlatformFindings(values=[]){
  if(!Array.isArray(values)||values.length>PLATFORM_FINDING_LIMITS.findings)throw failure();
  const ids=new Set();return values.map(value=>{const clean=finding(value);if(ids.has(clean.id))throw failure();ids.add(clean.id);return clean;});
}
function current(value,workspace){
  const project=workspace?.projects?.find(project=>project.id===value.projectId&&!project.archived);if(!project)return false;
  try{return courseRoot(project)?.url===value.courseURL&&scopedURL(value.sourceURL,courseRoot(project))===value.sourceURL;}catch{return false;}
}
export function currentPlatformFindings(workspace={}){
  const values=Array.isArray(workspace.platformFindings)?workspace.platformFindings:[];const result=[],seen=new Set();
  for(const value of values.slice(0,PLATFORM_FINDING_LIMITS.findings))try{const clean=finding(value);if(current(clean,workspace)&&!seen.has(clean.id)){result.push(clean);seen.add(clean.id);}}catch{}
  return result;
}
/** Only links actually supplied by the native reader's current course page. */
export function coursePlatformFindings(page,{workspace={},projectId,now=new Date().toISOString()}={}){
  const project=workspace.projects?.find(project=>project.id===projectId&&!project.archived);if(!project||!projectId||!validPlatformProjectId(projectId))throw failure();
  const root=courseRoot(project);if(!root)throw failure();
  if(page?.loginRequired===true||page?.permissionRequired===true||page?.navigationBlocked===true)return [];
  if(!page||Array.isArray(page)||!Array.isArray(page.platformLinks)&&page.platformLinks!==undefined||page.platformLinks?.length>PLATFORM_FINDING_LIMITS.pageLinks)throw failure();
  const sourceURL=scopedURL(page.url,root),foundAt=stamp(typeof now==='function'?now():now);if(!foundAt)throw failure();
  const rows=new Map();
  for(const link of page.platformLinks||[])try{
    if(!link||Array.isArray(link)||!services.includes(link.service))continue;
    // The new reader assigns page.url, not an inferred article/creator URL.
    if(link.sourceURL!==undefined&&scopedURL(link.sourceURL,root)!==sourceURL)continue;
    const value={projectId,courseURL:root.url,url:normalizePlatformURL(link.service,link.url),service:link.service,title:plain(link.title)||labels[link.service],sourceURL,sourceTitle:plain(link.sourceTitle||page.title)||'Kurs-Space',postedBy:plain(link.postedBy),postedAt:stamp(link.postedAt),foundAt};
    const id=identity(value);if(!rows.has(id))rows.set(id,{id,...value});
  }catch{}
  return [...rows.values()];
}
export function mergePlatformFindings(previous,fresh,{workspace}={}){
  const rows=new Map(validatePlatformFindings(previous).map(value=>[value.id,value]));
  for(const value of validatePlatformFindings(fresh)){
    if(workspace&&!current(value,workspace))throw new Error('Der Kurslink wurde geändert. Bitte den Kurs erneut lesen.');
    const old=rows.get(value.id);rows.set(value.id,{...value,foundAt:old?.foundAt||value.foundAt});
  }
  if(rows.size>PLATFORM_FINDING_LIMITS.findings)throw new Error('Das Verzeichnis der Plattformlinks ist voll. Entferne alte Fundstellen vor dem nächsten Einlesen.');
  return [...rows.values()];
}
