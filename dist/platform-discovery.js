import {courseRoot,scopedURL} from './companion-scan.js';
import {coursePlatformFindings,mergePlatformFindings} from './platform-links.js';
import {platformCatalog} from './source-catalog.js';

const aborted=()=>new DOMException('Abgebrochen','AbortError');
const check=signal=>{if(signal?.aborted)throw aborted();};

// An explicit course may contain an observed global Spaces permalink. For a
// currently open page without course context, only a unique course subtree
// proves the assignment; a shared/global blog page cannot establish it.
export function discoveryCourse(page,{workspace={},projectId='',courseURL=''}={}){
  if(page?.loginRequired||page?.permissionRequired||page?.accessDenied||page?.navigationBlocked)return null;
  const candidates=(workspace.projects||[]).filter(project=>!project.archived&&(!projectId||project.id===projectId));
  const matches=[];
  for(const project of candidates)try{
    const root=courseRoot(project);if(!root||courseURL&&root.url!==courseURL)continue;
    const url=scopedURL(page?.url,root);
    if(!projectId){const path=new URL(url).pathname,base=new URL(root.url).pathname.replace(/\/$/,'');if(path!==base&&!path.startsWith(base+'/'))continue;}
    matches.push({projectId:project.id,courseURL:root.url});
  }catch{}
  if(matches.length!==1){if(projectId||courseURL)throw new Error('Die gelesene Seite gehört nicht mehr zum gewählten Kurs.');return null;}
  return matches[0];
}

export function pagePlatformDiscovery(page,{workspace={},projectId='',courseURL='',now}={}){
  const scope=discoveryCourse(page,{workspace,projectId,courseURL});
  if(!scope||!page?.platformLinks?.length)return {scope,findings:[]};
  if(!/^[a-f0-9]{64}$/.test(page.contentRevision||''))throw new Error('Plattformlinks benötigen eine bestätigte aktuelle Spaces-Ansicht.');
  return {scope,findings:coursePlatformFindings(page,{workspace,projectId:scope.projectId,...(now?{now}:{})})};
}

/** Save provenance first, then register read scopes. Never imports remote text,
 * authenticates an account, or turns a model-provided URL into a grant. */
export function createPlatformDiscovery({getWorkspace,onSave,onCatalog=()=>{},now}={}){
  if(typeof getWorkspace!=='function'||typeof onSave!=='function'||typeof onCatalog!=='function')throw new Error('Plattform-Quellenfindung fehlt.');
  return {
    async discover(page,{projectId='',courseURL='',signal}={}){
      check(signal);
      const workspace=getWorkspace(),{scope,findings}=pagePlatformDiscovery(page,{workspace,projectId,courseURL,now});
      if(!findings.length)return {projectId:scope?.projectId||'',sources:[],added:0,complete:page?.platformLinksMore!==true};
      const previous=workspace.platformFindings||[],next=mergePlatformFindings(previous,findings,{workspace});
      const added=next.length-previous.length,changed=JSON.stringify(next)!==JSON.stringify(previous);
      check(signal);
      if(changed&&await onSave(next,{workspace,scope,signal})===false)throw new Error('Die gefundenen Kurslinks konnten nicht lokal gespeichert werden.');
      check(signal);
      const current=getWorkspace();
      discoveryCourse(page,{workspace:current,...scope});
      const confirmed=new Set((current.platformFindings||[]).map(row=>row.id));
      if(findings.some(row=>!confirmed.has(row.id)))throw new Error('Die gefundenen Kurslinks sind nicht dauerhaft bestätigt.');
      await onCatalog();check(signal);
      discoveryCourse(page,{workspace:getWorkspace(),...scope});
      const urls=new Set(findings.map(row=>row.service+'\n'+row.url));
      const sources=platformCatalog(getWorkspace()).filter(row=>row.projectId===scope.projectId&&urls.has(row.service+'\n'+row.url));
      return {projectId:scope.projectId,sources,added,complete:page.platformLinksMore!==true&&sources.length===urls.size};
    },
  };
}
