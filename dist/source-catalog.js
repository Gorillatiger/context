import {miroBoardURL,boardKnowledgeKey} from './board-index.js';
import {redactKnowledge} from './knowledge.js';
import {currentPlatformFindings} from './platform-links.js';

export const PLATFORM_SOURCE_LIMITS=Object.freeze({sources:100,documents:5000,characters:5000000,documentText:20000});
const services=Object.freeze({miro:'miro.com',gitlab:'git.coco.study',sciebo:'th-koeln.sciebo.de',mattermost:'chat.coco.study'});
const names=Object.freeze({miro:'Miro-Board',gitlab:'GitLab',sciebo:'Sciebo',mattermost:'Mattermost'});
const forbidden=/(?:^|\/)(?:admin|settings|profile|account|logout|sign_out|sign_in|auth|oauth|login|password|register|new|edit|delete|destroy|remove|create|update|submit|upload|download|attachments?|raw|archive|export)(?:\/|$)/i;
const invalid=()=>new Error('Ungültige freigegebene Plattformquelle.');
const text=(value,max=200)=>redactKnowledge(typeof value==='string'?value.trim().slice(0,max):'');
export const validPlatformProjectId=value=>typeof value==='string'&&/^[-a-zA-Z0-9_]{0,80}$/.test(value);
function decodedPath(value){
  let decoded=value;
  for(let n=0;n<8;n++){const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}
  if(/[%\\\x00-\x1f\x7f]/.test(decoded)||decoded.includes('//')||/(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded))throw invalid();
  return decoded;
}
function directory(value){const path=decodedPath(value);if(!path.startsWith('/')||path.length>1000)throw invalid();return path==='/'?path:path.replace(/\/$/,'');}
const secretPath=value=>value.split('/').some(part=>/^\.env(?:[.-]|$)|^\.(?:ssh|aws|git)$|(?:^|[._-])(?:secrets?|tokens?|credentials?|passwd|passwords?|api[_-]?keys?)(?:[._-]|$)/i.test(part));
function urlObject(service,value){
  if(!Object.hasOwn(services,service)||typeof value!=='string'||value.length>2500||/[\x00-\x20\\\x7f]/.test(value))throw invalid();
  const url=new URL(value),raw=value.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1]||'/',path=decodedPath(raw);
  if(url.protocol!=='https:'||url.hostname!==services[service]||url.port||url.username||url.password||!path.startsWith('/'))throw invalid();
  url.pathname=path;url.hash='';return url;
}
function canonical(service,value){
  if(service==='miro')return miroBoardURL(value);
  const url=urlObject(service,value),path=decodedPath(url.pathname);
  if(forbidden.test(path)||/\.(?:zip|gz|tar|exe|dmg|pkg|apk|iso|pdf|docx?|xlsx?|pptx?|od[tpst]|csv|json|xml|png|jpe?g|gif|svg|webp|mp[34]|mov|wav)$/i.test(path))throw invalid();
  const params=keys=>{for(const key of url.searchParams.keys())if(!keys.includes(key)||url.searchParams.getAll(key).length!==1)throw invalid();};
  if(service==='gitlab'){
    const parts=path.split('/').filter(Boolean),marker=parts.indexOf('-');
    if(path!=='/'&&!['/dashboard/projects','/explore/projects'].includes(path.replace(/\/$/,''))){
      if(marker===-1){if(parts.length<2||parts.length>8||['users','groups','help','api','oauth','admin'].includes(parts[0]))throw invalid();}
      else if(marker<2||marker>8||!['issues','merge_requests','blob','tree','commits','commit','wikis','releases','milestones','boards'].includes(parts[marker+1])||parts.length>30||['issues','merge_requests'].includes(parts[marker+1])&&parts.slice(marker+2).some(part=>!/^\d{1,12}$/.test(part))||['blob','tree'].includes(parts[marker+1])&&secretPath(parts.slice(marker+2).join('/')))throw invalid();
    }
    params(['page','per_page','ref','search','scope','sort','direction','state','label_name[]','assignee_id','author_id']);
    for(const [key,item]of url.searchParams)if(item.length>200||/[\x00-\x1f\x7f]/.test(item)||['page','per_page','assignee_id','author_id'].includes(key)&&!/^\d{1,9}$/.test(item))throw invalid();
  }else if(service==='sciebo'){
    if(path==='/'){url.pathname='/index.php/apps/files/';url.search='?dir=%2F';}
    else if(!/^\/(?:index\.php\/)?(?:apps\/files\/?|s\/[a-zA-Z0-9_-]{6,100}\/?)$/.test(path))throw invalid();
    const shared=/^\/(?:index\.php\/)?s\/[a-zA-Z0-9_-]{6,100}\/?$/.test(path);
    params(shared?['path']:['dir','fileid']);
    if(url.searchParams.has('dir'))url.searchParams.set('dir',directory(url.searchParams.get('dir')));
    if(url.searchParams.has('path'))url.searchParams.set('path',directory(url.searchParams.get('path')));
    if(url.searchParams.has('fileid')&&!/^[1-9]\d{0,17}$/.test(url.searchParams.get('fileid')))throw invalid();
  }else{
    if(path!=='/'&&!/^\/[a-zA-Z0-9_-]{1,100}\/(?:channels\/[a-zA-Z0-9_-]{1,100}|pl\/[a-zA-Z0-9]{20,40})\/?$/.test(path))throw invalid();
    params([]);
  }
  url.searchParams.sort();return url.href;
}

/** This only admits a user-saved course link. It never fetches or logs in. */
export function normalizePlatformURL(service,value,scope=''){
  const target=canonical(service,value);if(!scope)return target;
  const root=new URL(canonical(service,scope)),url=new URL(target);
  if(service==='miro'){if(target!==root.href)throw invalid();}
  else if(service==='gitlab'){
    const path=root.pathname.replace(/\/$/,''),marker=path.indexOf('/-/'),repo=marker<0?path:path.slice(0,marker);
    if(repo&&!['/dashboard/projects','/explore/projects'].includes(repo)&&url.pathname.replace(/\/$/,'')!==repo&&!url.pathname.startsWith(repo+'/-/'))throw invalid();
  }else if(service==='sciebo'){
    const shared=/^\/(?:index\.php\/)?s\/([a-zA-Z0-9_-]{6,100})\/?$/.exec(root.pathname);
    if(shared){
      const other=/^\/(?:index\.php\/)?s\/([a-zA-Z0-9_-]{6,100})\/?$/.exec(url.pathname),dir=directory(root.searchParams.get('path')||'/'),next=directory(url.searchParams.get('path')||'/');
      if(!other||other[1]!==shared[1]||dir!=='/'&&next!==dir&&!next.startsWith(dir+'/'))throw invalid();
    }else{
      if(/^\/(?:index\.php\/)?s\//.test(url.pathname))throw invalid();
      const dir=directory(root.searchParams.get('dir')||'/'),next=directory(url.searchParams.get('dir')||'/');
      if(dir!=='/'&&next!==dir&&!next.startsWith(dir+'/')||url.searchParams.has('fileid')&&url.searchParams.get('fileid')!==root.searchParams.get('fileid')||root.searchParams.has('fileid')&&url.searchParams.get('fileid')!==root.searchParams.get('fileid')||/^\/(?:index\.php\/)?f\//.test(root.pathname)&&url.pathname!==root.pathname)throw invalid();
    }
  }else if(root.pathname!=='/'&&url.pathname.replace(/\/$/,'')!==root.pathname.replace(/\/$/,''))throw invalid();
  return target;
}

/** Cache URLs must remain in the selected board/repository/folder/channel. */
export function platformDocumentURL(service,value,scope){
  try{return normalizePlatformURL(service,value,scope);}catch{}
  if(!['gitlab','sciebo'].includes(service))throw invalid();
  if(new URL(value).hash)throw invalid();
  const root=new URL(normalizePlatformURL(service,scope)),url=urlObject(service,value),path=decodedPath(url.pathname);let filePath='',singleSharedFile=false;
  if(service==='gitlab'){
    const match=/^\/(.+)\/-\/raw\/(.+)$/.exec(path);if(!match||url.search)throw invalid();
    // Binary documents never become browser navigation. Check repository scope
    // separately, then apply the same decoded file-path/secret checks below.
    normalizePlatformURL(service,'https://'+url.hostname+'/'+match[1],root.href);filePath=match[2];if(forbidden.test('/'+filePath))throw invalid();
  }else{
    const share=/^\/(?:index\.php\/)?s\/([a-zA-Z0-9_-]{6,100})\/?$/.exec(root.pathname),download=/^\/(?:index\.php\/)?s\/([a-zA-Z0-9_-]{6,100})\/download\/?$/.exec(path),dav=/^\/remote\.php\/(?:dav\/files\/[^/]+|webdav)\/(.+)$/.exec(path);
    if(share){
      if(!download||download[1]!==share[1]||[...url.searchParams.keys()].some(key=>!['path','files'].includes(key))||url.searchParams.getAll('path').length>1||url.searchParams.getAll('files').length>1)throw invalid();
      const dir=directory(root.searchParams.get('path')||'/'),folder=directory(url.searchParams.get('path')||'/'),name=url.searchParams.get('files');
      if(dir!=='/'&&folder!==dir&&!folder.startsWith(dir+'/'))throw invalid();
      if(name!==null){const clean=decodedPath(name);if(!clean||clean.includes('/')||/[,\[\]{}\r\n]/.test(clean))throw invalid();filePath=(folder==='/'?'':folder)+'/'+clean;}
      else if(!url.search&&dir==='/')singleSharedFile=true;else throw invalid();
    }else if(dav&&!url.search)filePath='/'+dav[1];
    else if(path==='/index.php/apps/files/ajax/download.php'){
      if([...url.searchParams.keys()].some(key=>!['dir','files'].includes(key))||url.searchParams.getAll('dir').length!==1||url.searchParams.getAll('files').length!==1)throw invalid();
      const dir=directory(url.searchParams.get('dir')),name=decodedPath(url.searchParams.get('files'));
      if(!name||name.includes('/')||/[,\[\]{}\r\n]/.test(name))throw invalid();filePath=(dir==='/'?'':dir)+'/'+name;
    }else throw invalid();
    const dir=directory(root.searchParams.get('dir')||'/');if(!share&&(root.searchParams.has('fileid')||/^\/(?:index\.php\/)?f\//.test(root.pathname)||dir!=='/'&&!filePath.startsWith(dir+'/')))throw invalid();
  }
  if(!singleSharedFile&&(!/\.(?:md|markdown|txt|json|pdf|docx|pptx|xlsx)$/i.test(filePath.split('/').at(-1))||/(?:secret|token|credential|passw(?:or)?d|\.env)/i.test(filePath.split('/').at(-1)))||secretPath(filePath))throw invalid();
  url.searchParams.sort();return url.href;
}

// Deterministic opaque cache keys. Full URL/course/service equality, not this
// non-cryptographic identity, is the authority boundary at every read/commit.
const fingerprint=value=>{const json=JSON.stringify(value);return boardKnowledgeKey(json).slice(6)+boardKnowledgeKey('platform-v1:'+json).slice(6);};
export function platformSourceId({service,url,projectId}){
  if(!validPlatformProjectId(projectId)||service==='miro'&&!projectId)throw invalid();return 'platform:'+fingerprint([service,normalizePlatformURL(service,url),projectId]);
}
export function platformSourceRevision({service,url,projectId,title}){return fingerprint([service,normalizePlatformURL(service,url),projectId,text(title)]);}
export function platformCatalog(workspace={}){
  const projects=Array.isArray(workspace.projects)?workspace.projects:[],known=new Map(),sources=new Map();
  for(const project of projects.slice(0,300))if(project&&!project.archived&&project.id&&validPlatformProjectId(project.id))known.set(project.id,project);
  const add=(service,url,projectId,title)=>{
    if(sources.size>=PLATFORM_SOURCE_LIMITS.sources||!Object.hasOwn(services,service)||(projectId?!known.has(projectId):service==='miro'))return;
    try{url=normalizePlatformURL(service,url);title=text(title)||names[service];const row={service,url,projectId,title};row.id=platformSourceId(row);row.revision=platformSourceRevision(row);if(!sources.has(row.id))sources.set(row.id,Object.freeze({id:row.id,service,url,projectId,title,revision:row.revision}));}catch{}
  };
  for(const project of known.values())for(const link of (Array.isArray(project.links)?project.links:[]).slice(0,40))if(link&&Object.hasOwn(services,link.tool))add(link.tool,link.url,project.id,link.title);
  // A link poster is provenance only. No creator identity is inferred here.
  for(const finding of (Array.isArray(workspace.boardFindings)?workspace.boardFindings:[]).slice(0,5000)){
    if(sources.size>=PLATFORM_SOURCE_LIMITS.sources)break;if(!finding)continue;
    const projectId=finding.assignedProjectId===null||finding.assignedProjectId===undefined?finding.projectId:finding.assignedProjectId;
    add('miro',finding.url,projectId,finding.customTitle||finding.title);
  }
  for(const finding of currentPlatformFindings(workspace))add(finding.service,finding.url,finding.projectId,finding.title);
  // Existing configured tools are explicit global entry points. They do not
  // prove a course assignment or access to any unread resource. Course grants
  // above get priority over these three optional entry points at the cap.
  for(const tool of (Array.isArray(workspace.tools)?workspace.tools:[]).slice(0,100))if(tool&&['gitlab','sciebo','mattermost'].includes(tool.id))add(tool.id,tool.url,'',tool.title||names[tool.id]);
  return [...sources.values()];
}
