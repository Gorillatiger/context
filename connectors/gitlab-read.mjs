import {SERVICE_ORIGINS} from './notifications.mjs';

// Read-only access to the person's own GitLab (git.coco.study) for the assistant: their projects,
// a folder listing, one text file and the latest commits. Fixed host, GET only, bounded sizes.
// Everything returned is untrusted repository text, never instructions.
export const GITLAB_LIMITS=Object.freeze({projects:10,entries:60,fileChars:12000,commits:10,results:15,snippet:400,bytes:600000,timeoutMs:15000});
const SEARCH_SCOPES=Object.freeze({global:['projects','issues','merge_requests','milestones'],project:['blobs','commits','issues','merge_requests','milestones','wiki_blobs']});
const ORIGIN=SERVICE_ORIGINS.gitlab;
export class GitlabReadError extends Error{constructor(status,code,message){super(message);this.name='GitlabReadError';this.status=status;this.code=code;}}
const fail=(status,code,message)=>new GitlabReadError(status,code,message);
const text=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max):'';
const PATH=/^[^\u0000-\u001f\\]{0,300}$/;

async function bounded(response){
  const reader=response.body?.getReader();if(!reader)return '';
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>GITLAB_LIMITS.bytes){await reader.cancel().catch(()=>{});break;}chunks.push(Buffer.from(value));}
  return Buffer.concat(chunks).toString('utf8');
}
async function get(path,{fetcher,token,raw=false,signal}){
  const headers={Accept:raw?'text/plain,*/*':'application/json',...(token?{'PRIVATE-TOKEN':token}:{})};
  let response;
  try{response=await fetcher(ORIGIN+path,{method:'GET',headers,credentials:'omit',redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(GITLAB_LIMITS.timeoutMs),...(signal?[signal]:[])])});}
  catch{throw fail(502,'unreachable','GitLab ist gerade nicht erreichbar.');}
  if(response.status===401||response.status===403)throw fail(401,'login_required','GitLab hat die Anmeldung abgelehnt. Verbinde GitLab unter Mitteilungen → Quellen & Status neu.');
  if(response.status===404)throw fail(404,'not_found','Nicht gefunden oder kein Zugriff.');
  if(!response.ok)throw fail(502,'provider_error','GitLab konnte nicht gelesen werden.');
  const body=await bounded(response);
  if(raw)return body;
  try{return JSON.parse(body);}catch{throw fail(502,'invalid_response','GitLab hat keine gültige Antwort geliefert.');}
}
const project=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0||typeof value==='string'&&/^\d{1,12}$/.test(value)?String(value):(()=>{throw fail(400,'invalid_request','Ungültiges Projekt.');})();
const safePath=value=>{const path=value===undefined?'':String(value).replace(/^\/+/,'');if(!PATH.test(path)||path.split('/').includes('..'))throw fail(400,'invalid_request','Ungültiger Pfad.');return path;};
const issue=i=>({title:text(i?.title,200),state:text(i?.state,20),due:text(i?.due_date,20),labels:Array.isArray(i?.labels)?i.labels.slice(0,6).map(l=>text(typeof l==='string'?l:l?.name,40)):[],project:Number.isSafeInteger(i?.project_id)?i.project_id:undefined,url:text(i?.web_url,300),updated:text(i?.updated_at,40),description:text(i?.description,300)});
const row=p=>({id:p.id,path:text(p.path_with_namespace,200),name:text(p.name,120),description:text(p.description,200),url:text(p.web_url,300),lastActivity:text(p.last_activity_at,40),forkedFrom:text(p.forked_from_project?.path_with_namespace,200)});

/** One read operation; returns plain bounded data. */
export async function gitlabRead(op,args={},{fetcher=fetch,token='',signal}={}){
  const ctx={fetcher,token,signal};
  if(op==='projects'){
    const query=typeof args.query==='string'?args.query.trim().slice(0,100):'';
    const list=await get('/api/v4/projects?membership=true&simple=true&order_by=last_activity_at&per_page='+GITLAB_LIMITS.projects+(query?'&search='+encodeURIComponent(query):''),ctx);
    if(!Array.isArray(list))throw fail(502,'invalid_response','GitLab hat keine gültige Antwort geliefert.');
    return {projects:list.slice(0,GITLAB_LIMITS.projects).filter(p=>Number.isSafeInteger(p?.id)).map(row)};
  }
  if(op==='me'){
    const user=await get('/api/v4/user',ctx);
    if(!Number.isSafeInteger(user?.id))throw fail(502,'invalid_response','GitLab hat keine gültige Antwort geliefert.');
    return {username:text(user.username,80),name:text(user.name,120),url:text(user.web_url,300)};
  }
  if(op==='tasks'){
    // What is open for the person: assigned issues and merge requests, plus pending to-dos.
    const scope=args.projectId!==undefined?`/api/v4/projects/${project(args.projectId)}`:'/api/v4';
    const [issues,mrs,todos]=await Promise.all([get(scope+'/issues?scope=assigned_to_me&state=opened&per_page='+GITLAB_LIMITS.results,ctx),get(scope+'/merge_requests?scope=assigned_to_me&state=opened&per_page='+GITLAB_LIMITS.results,ctx),args.projectId!==undefined?Promise.resolve([]):get('/api/v4/todos?state=pending&per_page='+GITLAB_LIMITS.results,ctx)]);
    if(![issues,mrs,todos].every(Array.isArray))throw fail(502,'invalid_response','GitLab hat keine gültige Antwort geliefert.');
    return {issues:issues.slice(0,GITLAB_LIMITS.results).map(issue),mergeRequests:mrs.slice(0,GITLAB_LIMITS.results).map(issue),todos:todos.slice(0,GITLAB_LIMITS.results).map(t=>({action:text(t?.action_name,40),title:text(t?.target?.title||t?.body,200),project:text(t?.project?.path_with_namespace,200),url:text(t?.target_url,300),date:text(t?.updated_at,40)}))};
  }
  if(op==='search'){
    const query=typeof args.query==='string'?args.query.trim():'';if(query.length<2||query.length>100)throw fail(400,'invalid_request','Suchbegriff fehlt.');
    const inProject=args.projectId!==undefined,scope=args.scope||(inProject?'blobs':'projects');
    if(!(inProject?SEARCH_SCOPES.project:SEARCH_SCOPES.global).includes(scope))throw fail(400,'invalid_request','Diese Suche ist hier nicht möglich.');
    const list=await get(`${inProject?`/api/v4/projects/${project(args.projectId)}`:'/api/v4'}/search?scope=${scope}&search=${encodeURIComponent(query)}&per_page=${GITLAB_LIMITS.results}`,ctx);
    if(!Array.isArray(list))throw fail(502,'invalid_response','GitLab hat keine gültige Antwort geliefert.');
    const map=scope==='projects'?row:['blobs','wiki_blobs'].includes(scope)?b=>({path:text(b?.path||b?.filename,300),line:Number.isSafeInteger(b?.startline)?b.startline:0,snippet:text(b?.data,GITLAB_LIMITS.snippet),projectId:b?.project_id}):scope==='commits'?c=>({title:text(c?.title,200),author:text(c?.author_name,80),date:text(c?.created_at,40),url:text(c?.web_url,300)}):issue;
    return {scope,results:list.slice(0,GITLAB_LIMITS.results).map(map)};
  }
  const id=project(args.projectId);
  if(op==='tree'){
    const path=safePath(args.path),list=await get(`/api/v4/projects/${id}/repository/tree?per_page=${GITLAB_LIMITS.entries}${path?'&path='+encodeURIComponent(path):''}`,ctx);
    if(!Array.isArray(list))throw fail(502,'invalid_response','GitLab hat keine gültige Antwort geliefert.');
    return {path,entries:list.slice(0,GITLAB_LIMITS.entries).map(e=>({name:text(e?.name,200),type:e?.type==='tree'?'folder':'file',path:text(e?.path,300)}))};
  }
  if(op==='file'){
    const path=safePath(args.path);if(!path)throw fail(400,'invalid_request','Dateipfad fehlt.');
    const body=await get(`/api/v4/projects/${id}/repository/files/${encodeURIComponent(path)}/raw?ref=HEAD`,{...ctx,raw:true});
    if(/\u0000/.test(body.slice(0,2000)))throw fail(415,'binary','Das ist keine Textdatei.');
    return {path,text:text(body,GITLAB_LIMITS.fileChars),truncated:body.length>GITLAB_LIMITS.fileChars};
  }
  if(op==='commits'){
    const list=await get(`/api/v4/projects/${id}/repository/commits?per_page=${GITLAB_LIMITS.commits}`,ctx);
    if(!Array.isArray(list))throw fail(502,'invalid_response','GitLab hat keine gültige Antwort geliefert.');
    return {commits:list.slice(0,GITLAB_LIMITS.commits).map(c=>({title:text(c?.title,200),author:text(c?.author_name,80),date:text(c?.created_at,40),url:text(c?.web_url,300)}))};
  }
  throw fail(400,'invalid_request','Unbekannter Vorgang.');
}
