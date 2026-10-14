import {createHash} from 'node:crypto';
import {providerPreferences} from './browser-session.mjs';

export const SERVICE_READER_LIMITS=Object.freeze({sources:100,requests:4,views:12,searchViews:4,text:60000,window:5000,links:500,items:50,nodes:50000,rowNodes:5000,fileBytes:2000000,documentBytes:8*1024*1024,documentTimeout:60000,timeout:25000});
const SERVICES=Object.freeze({gitlab:{host:'git.coco.study',title:'GitLab'},sciebo:{host:'th-koeln.sciebo.de',title:'Sciebo'},mattermost:{host:'chat.coco.study',title:'Mattermost'}});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sourceId=/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,159}$/;
const destructive=/(?:^|\/)(?:admin|settings|profile|account|logout|sign_out|sign_in|auth|oauth|login|password|register|new|edit|delete|destroy|remove|create|update|submit|upload|download|attachments?|raw|archive|export)(?:\/|$)/i;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error=(message,code)=>Object.assign(new Error(message),{code});
const aborted=()=>new DOMException('Abgebrochen','AbortError');
const bounded=(value,limit)=>typeof value==='string'?value.slice(0,limit):'';

function pathValue(value){
  let decoded=value;
  for(let i=0;i<8;i++){const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}
  if(/[%\\\x00-\x1f\x7f]/.test(decoded)||decoded.includes('//')||/(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded))throw error('Ungültiger lesender Dienstlink.','INVALID_URL');
  return decoded;
}
function secretPath(value){return value.split('/').some(part=>/^\.env(?:[.-]|$)|^\.(?:ssh|aws|git)$|(?:^|[._-])(?:secrets?|tokens?|credentials?|passwd|passwords?|api[_-]?keys?)(?:[._-]|$)/i.test(part));}
function directory(value){const dir=pathValue(value);if(!dir.startsWith('/')||dir.length>1000)throw error('Ungültiger Sciebo-Ordner.','INVALID_URL');return dir==='/'?dir:dir.replace(/\/$/,'');}
function shared(value){const u=typeof value==='string'?new URL(value):value,match=/^\/(?:index\.php\/)?s\/([a-zA-Z0-9_-]{6,100})\/?$/.exec(u.pathname);return match?{token:match[1],path:directory(u.searchParams.get('path')||'/')}:null;}
function canonical(service,value){
  if(!SERVICES[service]||typeof value!=='string'||value.length>2500||/[\x00-\x20\\\x7f]/.test(value))throw error('Ungültiger lesender Dienstlink.','INVALID_URL');
  const u=new URL(value),raw=value.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1]||'/',path=pathValue(raw);
  if(u.protocol!=='https:'||u.hostname!==SERVICES[service].host||u.port||u.username||u.password||!path.startsWith('/')||destructive.test(path)||/\.(?:zip|gz|tar|exe|dmg|pkg|apk|iso|pdf|docx?|xlsx?|pptx?|od[tpst]|csv|json|xml|png|jpe?g|gif|svg|webp|mp[34]|mov|wav)$/i.test(path))throw error('Dieser Dienstlink ist keine freigegebene lesende Ansicht.','INVALID_URL');
  u.pathname=path;u.hash='';
  const single=(keys)=>{for(const key of u.searchParams.keys())if(!keys.includes(key)||u.searchParams.getAll(key).length!==1)throw error('Unzulässige Dienstparameter.','INVALID_URL');};
  if(service==='gitlab'){
    const parts=path.split('/').filter(Boolean),marker=parts.indexOf('-');
    if(path!=='/'&&!['/dashboard/projects','/explore/projects'].includes(path.replace(/\/$/,''))){
      if(marker===-1){if(parts.length<2||parts.length>8||['users','groups','help','api','oauth','admin'].includes(parts[0]))throw error('Keine lesende Repository-Ansicht.','INVALID_URL');}
      else{
        if(marker<2||marker>8||!['issues','merge_requests','blob','tree','commits','commit','wikis','releases','milestones','boards'].includes(parts[marker+1])||parts.length>30)throw error('Keine lesende Repository-Ansicht.','INVALID_URL');
        if(['issues','merge_requests'].includes(parts[marker+1])&&parts.slice(marker+2).some(part=>!/^\d{1,12}$/.test(part)))throw error('Keine lesende Aufgabenansicht.','INVALID_URL');
        if(['blob','tree'].includes(parts[marker+1])&&secretPath(parts.slice(marker+2).join('/')))throw error('Geheimnisdateien sind keine Agentenquellen.','UNSUPPORTED_FILE');
      }
    }
    single(['page','per_page','ref','search','scope','sort','direction','state','label_name[]','assignee_id','author_id']);
    for(const [key,item]of u.searchParams){if(item.length>200||/[\x00-\x1f\x7f]/.test(item)||['page','per_page','assignee_id','author_id'].includes(key)&&!/^\d{1,9}$/.test(item))throw error('Ungültige Dienstparameter.','INVALID_URL');}
  }else if(service==='sciebo'){
    const share=shared(u);
    if(share){single(['path']);if(u.searchParams.has('path'))u.searchParams.set('path',share.path);}
    else if(path==='/'){u.pathname='/index.php/apps/files/';u.search='?dir=%2F';}
    else if(!/^\/(?:index\.php\/)?apps\/files\/?$/.test(path))throw error('Sciebo kann nur freigegebene Datei-Ansichten lesen.','INVALID_URL');
    if(!share){single(['dir','fileid']);if(u.searchParams.has('dir'))u.searchParams.set('dir',directory(u.searchParams.get('dir')));if(u.searchParams.has('fileid')&&!/^[1-9]\d{0,17}$/.test(u.searchParams.get('fileid')))throw error('Ungültige Sciebo-Datei.','INVALID_URL');}
  }else{
    if(path!=='/'&&!/^\/[a-zA-Z0-9_-]{1,100}\/(?:channels\/[a-zA-Z0-9_-]{1,100}|pl\/[a-zA-Z0-9]{20,40})\/?$/.test(path))throw error('Mattermost kann nur freigegebene Kanalansichten lesen.','INVALID_URL');
    single([]);
  }
  u.searchParams.sort();return u.href;
}

/** A scope comes from a trusted workspace link, never from the model's URL. */
export function serviceURL(service,value,scope=''){
  const target=canonical(service,value);if(!scope)return target;
  const root=new URL(canonical(service,scope)),u=new URL(target);
  if(service==='gitlab'){
    const rootPath=root.pathname.replace(/\/$/,''),marker=rootPath.indexOf('/-/'),project=marker>=0?rootPath.slice(0,marker):rootPath;
    if(project&&!['/dashboard/projects','/explore/projects'].includes(project)&&u.pathname.replace(/\/$/,'')!==project&&!u.pathname.startsWith(project+'/-/'))throw error('Der Link gehört nicht zum freigegebenen Repository.','OUTSIDE_SCOPE');
  }else if(service==='sciebo'){
    const rootShare=shared(root),targetShare=shared(u);
    if(rootShare||targetShare){if(!rootShare||!targetShare||rootShare.token!==targetShare.token||rootShare.path!=='/'&&targetShare.path!==rootShare.path&&!targetShare.path.startsWith(rootShare.path+'/'))throw error('Der Link gehört nicht zur freigegebenen Sciebo-Freigabe.','OUTSIDE_SCOPE');}
    else{
      const dir=directory(root.searchParams.get('dir')||'/'),targetDir=directory(u.searchParams.get('dir')||'/');
      if(dir!=='/'&&targetDir!==dir&&!targetDir.startsWith(dir+'/')||u.searchParams.has('fileid')&&u.searchParams.get('fileid')!==root.searchParams.get('fileid')||root.searchParams.has('fileid')&&u.searchParams.get('fileid')!==root.searchParams.get('fileid'))throw error('Der Link gehört nicht zum freigegebenen Sciebo-Ordner.','OUTSIDE_SCOPE');
    }
  }else if(root.pathname!=='/'&&u.pathname.replace(/\/$/,'')!==root.pathname.replace(/\/$/,'')){
    // A message permalink does not prove channel membership. Until an API can
    // verify it, the native reader follows only the selected channel itself.
    throw error('Der Link gehört nicht zum freigegebenen Kanal.','OUTSIDE_SCOPE');
  }
  return target;
}

/** File GETs have their own policy; these addresses are never browser navigation. */
export function serviceFileURL(service,value,scope){
  const root=new URL(serviceURL(service,scope));
  if(typeof value!=='string'||value.length>2500||/[\x00-\x20\\\x7f]/.test(value))throw error('Ungültiger Dateilink.','INVALID_FILE');
  const u=new URL(value),raw=value.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1]||'/',path=pathValue(raw);
  if(u.protocol!=='https:'||u.hostname!==SERVICES[service].host||u.port||u.username||u.password||u.hash)throw error('Datei außerhalb der freigegebenen Quelle.','INVALID_FILE');
  u.pathname=path;let filePath='',singleSharedFile=false;
  if(service==='gitlab'){
    const match=/^\/(.+)\/-\/raw\/(.+)$/.exec(path);if(!match||u.search)throw error('Keine lesbare Repository-Datei.','INVALID_FILE');
    // File GETs check their repository directly; binary formats are kept out
    // of browser navigation and still pass secret/traversal checks below.
    serviceURL(service,'https://'+u.hostname+'/'+match[1],root.href);filePath=match[2];if(destructive.test('/'+filePath))throw error('Diese Datei liegt außerhalb lesender Kursinhalte.','INVALID_FILE');
  }else if(service==='sciebo'){
    const rootShare=shared(root),download=/^\/(?:index\.php\/)?s\/([a-zA-Z0-9_-]{6,100})\/download\/?$/.exec(path),dav=/^\/remote\.php\/(?:dav\/files\/[^/]+|webdav)\/(.+)$/.exec(path);
    if(rootShare){
      if(!download||download[1]!==rootShare.token||[...u.searchParams.keys()].some(key=>!['path','files'].includes(key))||u.searchParams.getAll('path').length>1||u.searchParams.getAll('files').length>1)throw error('Keine lesbare Datei dieser Sciebo-Freigabe.','INVALID_FILE');
      const folder=directory(u.searchParams.get('path')||'/'),name=u.searchParams.get('files');
      if(rootShare.path!=='/'&&folder!==rootShare.path&&!folder.startsWith(rootShare.path+'/'))throw error('Datei außerhalb der freigegebenen Sciebo-Freigabe.','OUTSIDE_SCOPE');
      if(name!==null){const clean=pathValue(name);if(!clean||clean.includes('/')||/[,\[\]{}\r\n]/.test(clean))throw error('Kein einzelner lesbarer Dateilink.','INVALID_FILE');filePath=(folder==='/'?'':folder)+'/'+clean;}
      else if(!u.search&&rootShare.path==='/')singleSharedFile=true;
      else throw error('Ordnerarchive werden nicht gelesen.','UNSUPPORTED_FILE');
    }else if(dav&&!u.search)filePath='/'+dav[1];
    else if(path==='/index.php/apps/files/ajax/download.php'){
      if([...u.searchParams.keys()].some(key=>!['dir','files'].includes(key))||u.searchParams.getAll('dir').length!==1||u.searchParams.getAll('files').length!==1)throw error('Kein einzelner lesbarer Dateilink.','INVALID_FILE');
      const dir=directory(u.searchParams.get('dir')),name=pathValue(u.searchParams.get('files'));if(!name||name.includes('/')||/[,\[\]{}\r\n]/.test(name))throw error('Kein einzelner lesbarer Dateilink.','INVALID_FILE');filePath=(dir==='/'?'':dir)+'/'+name;
    }else throw error('Diese Sciebo-Datei kann nicht sicher gelesen werden.','UNSUPPORTED_FILE');
    const dir=directory(root.searchParams.get('dir')||'/');if(!rootShare&&(root.searchParams.has('fileid')||dir!=='/'&&!filePath.startsWith(dir+'/')))throw error('Datei außerhalb des freigegebenen Sciebo-Ordners.','OUTSIDE_SCOPE');
  }else throw error('Dieser Dienst unterstützt keine Dateiabrufe.','UNSUPPORTED_FILE');
  const name=filePath.split('/').at(-1);if(!singleSharedFile&&(!/\.(?:md|markdown|txt|json|pdf|docx|pptx|xlsx)$/i.test(name)||/(?:secret|token|credential|passw(?:or)?d|\.env)/i.test(name)))throw error('Nur Text, PDF und Office-Dateien ohne Makros werden angeboten.','UNSUPPORTED_FILE');
  if(secretPath(filePath))throw error('Diese Datei ist keine Kursquelle.','UNSUPPORTED_FILE');
  u.searchParams.sort();return u.href;
}

/** URL-derived display hints only. Response MIME and magic are checked later. */
export function serviceFileMetadata(service,value,scope){
  const url=new URL(serviceFileURL(service,value,scope)),candidate=url.searchParams.get('files')||url.pathname.split('/').at(-1)||'',name=pathValue(candidate),extension=/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()||'';
  const type=['pdf','docx','pptx','xlsx'].includes(extension)?extension:['md','markdown','txt','json'].includes(extension)?'text':'unknown';
  return {fileName:type!=='unknown'?name.slice(0,200):'',type};
}

export function validateServiceSources(values){
  if(!Array.isArray(values)||values.length>SERVICE_READER_LIMITS.sources)throw error('Zu viele Dienstquellen.','INVALID_SOURCES');
  const ids=new Set();return values.map(value=>{
    if(!value||Array.isArray(value)||Object.keys(value).some(key=>!['id','service','url','title','projectId','revision'].includes(key))||typeof value.id!=='string'||!sourceId.test(value.id)||ids.has(value.id))throw error('Ungültige Dienstquelle.','INVALID_SOURCES');
    ids.add(value.id);const service=value.service||Object.keys(SERVICES).find(key=>{try{return new URL(value.url).hostname===SERVICES[key].host;}catch{return false;}});
    for(const key of ['title','projectId','revision'])if(value[key]!==undefined&&(typeof value[key]!=='string'||value[key].length>(key==='title'?200:key==='revision'?128:160)||/[\x00-\x1f\x7f]/.test(value[key])))throw error('Ungültige Dienstquelle.','INVALID_SOURCES');
    return Object.freeze({id:value.id,service,url:serviceURL(service,value.url),title:value.title||SERVICES[service].title,projectId:value.projectId||'',revision:value.revision||''});
  });
}

function documentRead(options,validate,validateFile,describeFile){
  return (async()=>{
    const path=location.pathname,loginRequired=!!document.querySelector('input[type=password]')||/(?:^|\/)(?:login|signin|sign_in|auth|oauth)(?:\/|$)/i.test(path),denied=/(?:^|\/)(?:error|forbidden|access_denied)(?:\/|$)/i.test(path);
    if(loginRequired||denied)return {loginRequired,permissionRequired:denied,text:'',links:[],items:[],boardLinks:[],fileLinks:[]};
    const url=validate(options.service,location.href,options.scope),root=document.querySelector('main,[role=main],#content,#app-content,.content-wrapper')||document.body;
    const excluded='script,style,noscript,form,input,textarea,select,button,nav,header,footer,[hidden],[aria-hidden=true],[contenteditable=true]';
    const visible=el=>!!el?.getClientRects().length&&!el.closest('[hidden],[aria-hidden=true]')&&(typeof getComputedStyle!=='function'||!['hidden','collapse'].includes(getComputedStyle(el).visibility));
    const time=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||Number.isNaN(Date.parse(value))||new Date(value.slice(0,10)+'T12:00:00Z').toISOString().slice(0,10)!==value.slice(0,10))return '';return new Date(value).toISOString();};
    const clock=el=>time(el?.getAttribute('datetime')||'');
    let itemsTruncated=false;
    const visibleText=element=>{
      if(!element||!visible(element))return '';const walk=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),values=[];let child,inspected=0,size=0;
      while((child=walk.nextNode())){if(++inspected>5000){itemsTruncated=true;break;}const parent=child.parentElement;if(!parent||parent.closest(excluded)||!visible(parent))continue;const text=child.textContent.trim();if(text){values.push(text.slice(0,1200-size));size+=text.length+1;}if(size>=1200)break;}
      return values.join(' ').slice(0,1200);
    };
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),seen=new Set();let node,size=0,inspectedNodes=0,parts=[],overflow=false;
    while((node=walker.nextNode())){
      if(++inspectedNodes>50000){overflow=true;break;}
      const parent=node.parentElement;if(!parent||parent.closest(excluded)||!visible(parent))continue;
      const timestamp=parent.closest('time[datetime]'),iso=clock(timestamp);if(iso&&seen.has(timestamp))continue;if(iso)seen.add(timestamp);
      const text=iso||node.textContent.trim();if(!text)continue;const room=60001-size;
      if(room<=0){overflow=true;break;}parts.push(text.slice(0,room));size+=Math.min(text.length,room)+1;if(text.length>room){overflow=true;break;}
    }
    const fullText=parts.join('\n');let limit=Math.min(60000,fullText.length);
    const high=index=>index>=0&&/[\uD800-\uDBFF]/.test(fullText[index]),low=index=>index<fullText.length&&/[\uDC00-\uDFFF]/.test(fullText[index]);
    if(high(limit-1)&&low(limit))limit--;const start=Math.min(options.offset,limit);if(low(start)&&high(start-1))throw new Error('Ungültige Textgrenze. Bitte nextOffset verwenden.');let end=Math.min(start+5000,limit);if(high(end-1)&&low(end))end--;
    const links=[],boards=[],items=[],files=[],unique=new Set(),uniqueFiles=new Set();let inspected=0,linksTruncated=false;
    for(const anchor of root.querySelectorAll('a[href]')){
      if(++inspected>5000){linksTruncated=true;break;}if(!visible(anchor)||anchor.closest('form,[contenteditable=true],header,footer')||anchor.closest('nav')&&!anchor.closest('.pagination,.nav-links,[aria-label=pagination]'))continue;
      const title=(anchor.innerText||anchor.getAttribute('aria-label')||'Link').trim().slice(0,200);let target='';try{target=validate(options.service,anchor.href,options.scope);}catch{}
      const row=anchor.closest('article,.issuable-item,.commit-row,.file-row,tr[data-id],tr[data-file],li.issue'),author=row?.querySelector('[rel=author],.author,.username,.user-name'),timeEl=row?.querySelector('time[datetime]'),updated=row?.querySelector('time.updated[datetime]');
      const metadata={postedBy:visible(author)?author.innerText.trim().slice(0,200):'',postedAt:clock(timeEl),updatedAt:clock(updated)};
      try{const fileURL=validateFile(options.service,anchor.href,options.scope);if(!uniqueFiles.has(fileURL)&&files.length<50){uniqueFiles.add(fileURL);files.push({url:fileURL,title,...metadata,...describeFile(options.service,fileURL,options.scope)});}}catch{}
      if(target&&!unique.has(target)){unique.add(target);if(links.length<500)links.push({url:target,title,...metadata});else linksTruncated=true;if(row&&items.length<50)items.push({url:target,title,...metadata,excerpt:visibleText(row)});}
      try{const u=new URL(anchor.href),match=/^\/app\/board\/([a-zA-Z0-9_=-]{4,100})\/?$/.exec(decodeURIComponent(u.pathname));if(u.protocol==='https:'&&['miro.com','www.miro.com'].includes(u.hostname)&&!u.username&&!u.password&&!u.port&&match&&boards.length<50)boards.push({url:'https://miro.com/app/board/'+match[1]+'/',title,...metadata,sourceURL:target||url});}catch{}
    }
    const title=document.title.slice(0,200),data=new TextEncoder().encode(JSON.stringify([url,title,fullText,overflow,links,items,itemsTruncated,boards,files])),digest=await crypto.subtle.digest('SHA-256',data),contentRevision=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
    return {url,title,text:fullText.slice(start,end),offset:start,nextOffset:end,hasMore:end<limit,totalLength:limit,textTruncated:overflow||fullText.length>limit,contentRevision,links:links.slice(options.linkOffset,options.linkOffset+45),totalLinks:links.length,linkOffset:options.linkOffset,linksHasMore:options.linkOffset+45<links.length,linksTruncated,items,itemsTruncated,boardLinks:boards,fileLinks:files,loginRequired:false,permissionRequired:false};
  })();
}

/** The isolated world reads rendered text only: no cookie/storage/API/form access. */
export function serviceReadScript(service,scope,{offset=0,linkOffset=0}={}){
  const config={service,scope:serviceURL(service,scope),offset,linkOffset};
  if(!Number.isSafeInteger(offset)||offset<0||offset>60000||!Number.isSafeInteger(linkOffset)||linkOffset<0||linkOffset>500)throw error('Ungültiges Lesefenster.','INVALID_REQUEST');
  // The validator is embedded as self-contained code. Its only inputs are the
  // selected grant and hrefs actually present in the DOM.
  const validator=`(()=>{const SERVICES=${JSON.stringify(SERVICES)},destructive=${destructive.toString()},error=(message,code)=>Object.assign(new Error(message),{code});${pathValue.toString()};${secretPath.toString()};${directory.toString()};${shared.toString()};${canonical.toString()};${serviceURL.toString()};${serviceFileURL.toString()};${serviceFileMetadata.toString()};return {view:serviceURL,file:serviceFileURL,metadata:serviceFileMetadata};})()`;
  return `(()=>{const validators=${validator};return (${documentRead.toString()})(${JSON.stringify(config)},validators.view,validators.file,validators.metadata);})()`;
}

function wait(work,record){return new Promise((resolve,reject)=>{const signal=record.controller.signal,abort=()=>{signal.removeEventListener('abort',abort);reject(aborted());};if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});Promise.resolve(work).then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(aborted());else resolve(value);},reason=>{signal.removeEventListener('abort',abort);reject(reason);});});}
function pause(record,milliseconds){return new Promise((resolve,reject)=>{const signal=record.controller.signal,cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);},abort=()=>{cleanup();reject(aborted());},timer=setTimeout(()=>{cleanup();resolve();},milliseconds);if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});});}
function validMessage(message){
  if(!message||Array.isArray(message)||!uuid.test(message.id||'')||!['read','read-file','open','search','open-login','cancel','release'].includes(message.action))throw error('Ungültiger Dienstauftrag.','INVALID_REQUEST');
  const allowed=['action','id','sourceId',...(message.action==='open'?['url','expectedRevision']:message.action==='read-file'?['url','offset','expectedRevision']:message.action==='read'?['offset','linkOffset','expectedRevision']:message.action==='search'?['query','maxViews']:[])];
  if(Object.keys(message).some(key=>!allowed.includes(key))||!['cancel','release'].includes(message.action)&&!sourceId.test(message.sourceId||''))throw error('Ungültiger Dienstauftrag.','INVALID_REQUEST');
  if(message.expectedRevision!==undefined&&!/^[a-f0-9]{64}$/.test(message.expectedRevision))throw error('Ungültiger Quellenstand.','INVALID_REQUEST');
  for(const [key,limit]of [['offset',60000],['linkOffset',500],['maxViews',4]])if(message[key]!==undefined&&(!Number.isSafeInteger(message[key])||message[key]<0||message[key]>limit||key==='maxViews'&&message[key]<1))throw error('Ungültiges Leselimit.','INVALID_REQUEST');
  if(message.action==='search'&&(typeof message.query!=='string'||!message.query.trim()||message.query.length>200||/[\x00-\x1f\x7f]/.test(message.query)))throw error('Ungültiger Suchtext.','INVALID_REQUEST');
}

/**
 * Root supplies trusted workspace grants and the persistent provider session.
 * There is one recyclable, hidden view and no password/SSO automation method.
 * getAuthRevision observes session changes without exporting cookie values.
 */
export function createServiceReader({createView,destroyView, getSources,openVisible,fetchText,readDocument,getAuthRevision=()=>0,settleMs=250,now=()=>new Date().toISOString()}){
  if(typeof createView!=='function'||typeof getSources!=='function'||typeof openVisible!=='function')throw new TypeError('Dienstleser benötigt View, Quellen und Browserhandoff.');
  let active,disposed=false,queue=Promise.resolve();const requests=new Map();
  const sources=()=>validateServiceSources(getSources());
  const source=id=>{const value=sources().find(item=>item.id===id);if(!value)throw error('Diese Quelle wurde nicht freigegeben.','SOURCE_UNAVAILABLE');return value;};
  const signature=value=>hash([value.id,value.service,value.url,value.projectId,value.revision]);
  const auth=value=>String(getAuthRevision(value.service));
  const clearLease=()=>{if(active){active.links.clear();active.files.clear();active.file=undefined;active.readAt='';active.contentRevision='';}};
  function cancel(record){if(!record)return;record.controller.abort();if(record.view===active?.view){clearLease();try{record.view.webContents.stop();}catch{}}}
  function retire(){if(!active)return;const old=active;active=undefined;for(const [target,event,listener]of old.listeners)target.removeListener(event,listener);try{old.view.webContents.stop();}catch{}if(destroyView)destroyView(old.view);else if(!old.view.webContents.isDestroyed())old.view.webContents.close();}
  function assertCurrent(record){
    if(disposed||record.controller.signal.aborted||requests.get(record.id)!==record)throw aborted();
    if(signature(source(record.source.id))!==record.sourceSignature)throw error('Die freigegebene Quelle wurde geändert. Bitte erneut beginnen.','SOURCE_CHANGED');
    if(auth(record.source)!==record.authRevision)throw error('Die Anmeldung wurde geändert. Bitte erneut lesen.','ACCOUNT_CHANGED');
    if(record.view?.webContents.isDestroyed())throw error('Die Dienstansicht wurde geschlossen.','VIEW_CLOSED');
  }
  async function viewFor(record){
    if(!active||active.sourceSignature!==record.sourceSignature||active.authRevision!==record.authRevision||active.view.webContents.isDestroyed()){retire();assertCurrent(record);const created=Promise.resolve(createView({webPreferences:{...providerPreferences(),focusOnNavigation:false},source:record.source})).then(view=>{try{assertCurrent(record);return view;}catch(reason){if(destroyView)destroyView(view);else view.webContents.close();throw reason;}});const view=await wait(created,record);assertCurrent(record);
      const wc=view.webContents,entry={view,sourceSignature:record.sourceSignature,authRevision:record.authRevision,service:record.source.service,scope:record.source.url,epoch:0,links:new Set(),files:new Set(),file:undefined,readAt:'',contentRevision:'',visited:new Set(),listeners:[],blocked:'',httpStatus:0,httpURL:''};active=entry;view.setVisible?.(false);wc.setWindowOpenHandler(()=>({action:'deny'}));
      const listen=(target,event,listener)=>{target.on(event,listener);entry.listeners.push([target,event,listener]);};
      const guard=(event,url)=>{try{serviceURL(entry.service,url,entry.scope);}catch{event.preventDefault();entry.blocked=/(?:login|sign_in|auth|oauth|password)/i.test(url)?'login':'scope';}};
      listen(wc,'will-navigate',guard);listen(wc,'will-redirect',guard);listen(wc,'will-attach-webview',event=>event.preventDefault());
      listen(wc,'did-start-navigation',(_event,_url,_inPlace,main)=>{if(main){entry.epoch++;entry.links.clear();entry.files.clear();entry.file=undefined;entry.readAt='';entry.contentRevision='';entry.httpStatus=0;entry.httpURL='';}});
      listen(wc,'did-navigate-in-page',(_event,_url,main)=>{if(main!==false){entry.epoch++;entry.links.clear();entry.files.clear();entry.file=undefined;entry.readAt='';entry.contentRevision='';}});
      listen(wc,'did-navigate',(_event,url,status)=>{entry.httpURL=url;entry.httpStatus=Number.isInteger(status)?status:0;});
      for(const event of ['render-process-gone','destroyed'])listen(wc,event,()=>{clearLease();for(const request of requests.values())if(request.view===view)cancel(request);});
    }
    record.view=active.view;return active;
  }
  const status=(record,kind)=>({sourceId:record.source.id,projectId:record.source.projectId,service:record.source.service,url:record.source.url,title:record.source.title,loginRequired:kind==='login',permissionRequired:kind==='permission',navigationBlocked:kind==='scope',text:'',links:[],items:[],boardLinks:[],fileLinks:[],coverage:'none',trust:'untrusted-source'});
  async function navigate(record,entry,url){
    assertCurrent(record);if(entry.visited.size>=SERVICE_READER_LIMITS.views&&!entry.visited.has(url))throw error('Leselimit erreicht. Beginne eine neue Quellenprüfung.','VIEW_LIMIT');entry.blocked='';
    try{await wait(entry.view.webContents.loadURL(url),record);}catch(reason){assertCurrent(record);if(entry.blocked)return status(record,entry.blocked);throw error('Die Dienstseite konnte nicht geladen werden. Öffne sie im Browser und prüfe die Anmeldung.','LOAD_FAILED');}
    assertCurrent(record);if(entry.blocked)return status(record,entry.blocked);try{serviceURL(record.source.service,entry.view.webContents.getURL(),record.source.url);}catch{return status(record,'login');}entry.visited.add(url);
    if(entry.httpURL===entry.view.webContents.getURL()&&[401,403].includes(entry.httpStatus))return status(record,entry.httpStatus===401?'login':'permission');
    if(entry.httpURL===entry.view.webContents.getURL()&&entry.httpStatus>=400)throw error('Diese Dienstquelle ist nicht verfügbar.','HTTP_ERROR');return null;
  }
  async function snapshot(record,entry,options={}){
    assertCurrent(record);const wc=entry.view.webContents,url=serviceURL(record.source.service,wc.getURL(),record.source.url),epoch=entry.epoch;
    const check=()=>{assertCurrent(record);if(entry!==active||entry.epoch!==epoch||wc.getURL()!==url)throw error('Die Dienstansicht hat sich geändert. Bitte erneut lesen.','NAVIGATION_CHANGED');};
    const read=async()=>{check();const page=await wait(wc.executeJavaScriptInIsolatedWorld(1002,[{code:serviceReadScript(record.source.service,record.source.url,options)}]),record);check();if(page?.loginRequired||page?.permissionRequired)return status(record,page.loginRequired?'login':'permission');if(!page||page.url!==url||!/^[a-f0-9]{64}$/.test(page.contentRevision||'')||typeof page.text!=='string'||page.text.length>5000)throw error('Ungültiger Dienstinhalt.','INVALID_PAGE');return page;};
    let page=await read();if(page.coverage==='none'){clearLease();return page;}
    if(options.offset===undefined||options.offset===0){if(!options.linkOffset&&!options.expectedRevision){let stable=settleMs===0;for(let i=0;!stable&&i<4;i++){await pause(record,settleMs);check();const next=await read();if(next.coverage==='none'){clearLease();return next;}stable=next.contentRevision===page.contentRevision;page=next;}if(!stable)throw error('Die Dienstansicht lädt noch. Bitte erneut versuchen.','CONTENT_UNSTABLE');}}
    if(options.expectedRevision&&page.contentRevision!==options.expectedRevision)throw error('Der Quelleninhalt wurde geändert. Bitte erneut beginnen.','CONTENT_CHANGED');
    if(entry.contentRevision!==page.contentRevision||entry.readAt!==url){entry.links.clear();entry.files.clear();entry.file=undefined;}
    const links=[];for(const link of (Array.isArray(page.links)?page.links:[]).slice(0,45)){try{const clean={...cleanMetadata(link),url:serviceURL(record.source.service,link.url,record.source.url)};links.push(clean);entry.links.add(clean.url);}catch{}}
    entry.readAt=url;entry.contentRevision=page.contentRevision;
    const items=(Array.isArray(page.items)?page.items:[]).slice(0,50).flatMap(item=>{try{return [{...cleanMetadata(item),url:serviceURL(record.source.service,item.url,record.source.url),excerpt:bounded(item.excerpt,1200)}];}catch{return [];}});
    const boardLinks=(Array.isArray(page.boardLinks)?page.boardLinks:[]).slice(0,50).flatMap(item=>{try{const u=new URL(item.url);if(u.protocol!=='https:'||u.hostname!=='miro.com'||u.port||u.username||u.password||!/^\/app\/board\/[a-zA-Z0-9_=-]{4,100}\/$/.test(u.pathname))return [];return [{...cleanMetadata(item),url:u.origin+u.pathname,sourceURL:serviceURL(record.source.service,item.sourceURL||url,record.source.url)}];}catch{return [];}});
    const fileLinks=(Array.isArray(page.fileLinks)?page.fileLinks:[]).slice(0,50).flatMap(item=>{try{const file={...cleanMetadata(item),url:serviceFileURL(record.source.service,item.url,record.source.url),...serviceFileMetadata(record.source.service,item.url,record.source.url)};entry.files.add(file.url);return [file];}catch{return [];}});
    return {...page,title:bounded(page.title,200),sourceId:record.source.id,projectId:record.source.projectId,service:record.source.service,links,items,boardLinks,fileLinks,checkedAt:now(),coverage:page.textTruncated||page.linksTruncated||page.itemsTruncated?'partial':'rendered-view',trust:'untrusted-source'};
  }
  async function readFile(record,entry,message){
    if(typeof fetchText!=='function')throw error('Dieser Build unterstützt noch keine lokalen Dateiabrufe.','UNSUPPORTED_FILE');
    const url=serviceFileURL(record.source.service,message.url,record.source.url),offset=message.offset||0;let file=entry.file;
    if(offset){if(!file||file.url!==url||file.contentRevision!==message.expectedRevision||file.authRevision!==auth(record.source))throw error('Die Datei wurde geändert. Bitte erneut beginnen.','CONTENT_CHANGED');}
    else{
      if(!message.expectedRevision||entry.readAt!==entry.view.webContents.getURL()||entry.contentRevision!==message.expectedRevision||!entry.files.has(url))throw error('Nur zuvor angebotene Dateien dürfen gelesen werden.','LINK_NOT_OFFERED');
      const page=await snapshot(record,entry,{expectedRevision:message.expectedRevision});if(page.coverage==='none')return page;const epoch=entry.epoch;
      const metadata=serviceFileMetadata(record.source.service,url,record.source.url),maxBytes=metadata.type==='text'?SERVICE_READER_LIMITS.fileBytes:SERVICE_READER_LIMITS.documentBytes;
      const value=await wait(fetchText(url,{signal:record.controller.signal,maxBytes,sourceId:record.source.id,service:record.source.service,scope:record.source.url}),record);assertCurrent(record);
      if(active!==entry||entry.epoch!==epoch||!entry.files.has(url))throw error('Die Datei-Quelle wurde geändert.','NAVIGATION_CHANGED');
      const contentType=String(value?.contentType||'').split(';')[0].trim().toLowerCase();
      if(value.url&&value.url!==url)throw error('Die Dateiantwort gehört nicht zur Quelle.','UNSUPPORTED_FILE');
      let body=value.text,revision,byteLength,coverage='text-file',warnings=[],title=metadata.fileName||'Kursdatei';
      if(value.bytes!==undefined){
        if(typeof readDocument!=='function'||!(value.bytes instanceof Uint8Array)||!value.bytes.length||value.bytes.byteLength>SERVICE_READER_LIMITS.documentBytes)throw error('Der lokale Dateileser ist nicht verfügbar oder die Datei ist zu groß.','UNSUPPORTED_FILE');
        const name=value.fileName||metadata.fileName,format=typeof name==='string'?/\.(pdf|docx|pptx|xlsx)$/i.exec(name)?.[1]?.toLowerCase():'';
        const documentTypes={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
        if(!format||![documentTypes[format],'application/octet-stream',...(format==='pdf'?[]:['application/zip'])].includes(contentType))throw error('Dateiname und Dateiformat passen nicht zusammen.','UNSUPPORTED_FILE');
        const result=await wait(readDocument({bytes:value.bytes,mimeType:documentTypes[format],fileName:name,signal:record.controller.signal}),record);assertCurrent(record);
        if(active!==entry||entry.epoch!==epoch||!entry.files.has(url))throw error('Die Datei-Quelle wurde geändert.','NAVIGATION_CHANGED');
        if(!['ok','empty'].includes(result?.status)||typeof result.text!=='string'||result.text.length>SERVICE_READER_LIMITS.text)throw error('Diese Datei konnte lokal nicht zuverlässig gelesen werden.','UNSUPPORTED_FILE');
        body=result.text;const meta=result.metadata||{};
        coverage={complete:result.coverage==='complete',status:result.status,method:bounded(meta.engine,80),read:Number.isSafeInteger(meta.unitsRead)?meta.unitsRead:0,total:Number.isSafeInteger(meta.unitsTotal)?meta.unitsTotal:0,truncated:meta.truncated===true};
        warnings=(Array.isArray(result.warnings)?result.warnings:[]).slice(0,10).map(value=>bounded(value,300));title=value.fileName||title;
        byteLength=value.bytes.byteLength;revision=createHash('sha256').update(url).update(contentType).update(value.bytes).digest('hex');
      }else{
        if(!['text','unknown'].includes(metadata.type)||!['text/plain','text/markdown','application/json'].includes(contentType)||typeof body!=='string'||Buffer.byteLength(body,'utf8')>SERVICE_READER_LIMITS.fileBytes)throw error('Diese Datei hat kein unterstütztes Textformat oder ist zu groß.','UNSUPPORTED_FILE');
        byteLength=Buffer.byteLength(body,'utf8');revision=hash([url,contentType,body]);
      }
      const text=body.slice(0,SERVICE_READER_LIMITS.text),limit=/[\uD800-\uDBFF]$/.test(text)&&/[\uDC00-\uDFFF]/.test(body[text.length]||'')?text.length-1:text.length;
      file={url,title:bounded(title,200),text:text.slice(0,limit),contentType,contentRevision:revision,textTruncated:body.length>limit||coverage?.complete===false,coverage,warnings,byteLength,authRevision:record.authRevision,checkedAt:now()};entry.file=file;
    }
    assertCurrent(record);if(offset>file.text.length||/^[\uDC00-\uDFFF]/.test(file.text.slice(offset)))throw error('Ungültige Textgrenze. Bitte nextOffset verwenden.','INVALID_REQUEST');let end=Math.min(offset+5000,file.text.length);if(/[\uD800-\uDBFF]/.test(file.text[end-1]||'')&&/[\uDC00-\uDFFF]/.test(file.text[end]||''))end--;
    return {url,title:file.title,sourceId:record.source.id,projectId:record.source.projectId,service:record.source.service,text:file.text.slice(offset,end),offset,nextOffset:end,hasMore:end<file.text.length,totalLength:file.text.length,byteLength:file.byteLength,contentType:file.contentType,contentRevision:file.contentRevision,checkedAt:file.checkedAt,textTruncated:file.textTruncated,coverage:typeof file.coverage==='object'?file.coverage:file.textTruncated?'partial':'text-file',warnings:file.warnings,trust:'untrusted-source'};
  }
  async function run(record,message){
    assertCurrent(record);if(message.action==='open-login'){await wait(openVisible(record.source.url,{sourceId:record.source.id,service:record.source.service}),record);assertCurrent(record);return {...status(record,'login'),opened:true};}
    const entry=await viewFor(record);assertCurrent(record);let page;
    if(message.action==='read-file')return readFile(record,entry,message);
    if(message.action==='open'){
      const url=serviceURL(record.source.service,message.url,record.source.url);
      if(!message.expectedRevision||entry.readAt!==entry.view.webContents.getURL()||entry.contentRevision!==message.expectedRevision||!entry.links.has(url))throw error('Der Assistent darf nur zuvor gelesenen Links derselben Quelle folgen.','LINK_NOT_OFFERED');
      page=await snapshot(record,entry,{expectedRevision:message.expectedRevision});if(page.coverage==='none')return page;
      if(!entry.links.has(url))throw error('Der Quellenlink ist nicht mehr verfügbar.','LINK_NOT_OFFERED');page=await navigate(record,entry,url);if(page)return page;return snapshot(record,entry);
    }
    if((message.offset||message.linkOffset)&&(!message.expectedRevision||entry.contentRevision!==message.expectedRevision||entry.readAt!==entry.view.webContents.getURL()))throw error('Weiterlesen benötigt den aktuellen Quellenstand.','CONTENT_CHANGED');
    if(!entry.readAt){page=await navigate(record,entry,record.source.url);if(page)return page;}
    if(message.action==='read')return snapshot(record,entry,{offset:message.offset||0,linkOffset:message.linkOffset||0,expectedRevision:message.expectedRevision});
    const maxViews=message.maxViews||3,query=message.query.trim().normalize('NFKC').toLocaleLowerCase('de'),documents=[],results=[],pending=[entry.view.webContents.getURL()],seen=new Set();let remaining=[];
    while(pending.length&&documents.length<maxViews){
      const url=pending.shift();if(seen.has(url))continue;seen.add(url);if(entry.view.webContents.getURL()!==url){page=await navigate(record,entry,url);if(page)return {...page,documents:[],results:[]};}page=await snapshot(record,entry);if(page.coverage==='none')return {...page,documents:[],results:[]};
      let text=page.text,offset=page.nextOffset;while(page.hasMore&&text.length<12000){const next=await snapshot(record,entry,{offset,expectedRevision:page.contentRevision});if(next.coverage==='none')return {...next,documents:[],results:[]};text+=next.text;offset=next.nextOffset;if(!next.hasMore)break;}
      text=text.slice(0,12000);const doc={sourceId:page.sourceId,projectId:page.projectId,service:page.service,url:page.url,title:page.title,text,items:page.items,boardLinks:page.boardLinks,fileLinks:page.fileLinks,checkedAt:page.checkedAt,contentRevision:page.contentRevision,coverage:page.totalLength>text.length||page.coverage==='partial'?'partial':'rendered-view',trust:'untrusted-source'};documents.push(doc);
      const haystack=(doc.title+'\n'+text).normalize('NFKC').toLocaleLowerCase('de'),at=haystack.indexOf(query);if(at>=0)results.push({...doc,text:undefined,excerpt:(doc.title+'\n'+text).slice(Math.max(0,at-180),at+600)});
      for(const link of page.links)if(!seen.has(link.url)&&!pending.includes(link.url))pending.push(link.url);
    }
    remaining=pending.filter(url=>!seen.has(url));assertCurrent(record);return {sourceId:record.source.id,projectId:record.source.projectId,service:record.source.service,query:message.query.trim(),documents,results,viewsRead:documents.length,remainingViews:remaining.length,coverage:'partial',bounded:true,limitReached:remaining.length>0||documents.some(doc=>doc.coverage==='partial'),loginRequired:false,permissionRequired:false,trust:'untrusted-source'};
  }
  function handle(message){
    validMessage(message);if(disposed)return Promise.reject(error('Der Dienstleser ist beendet.','DISPOSED'));
    if(message.action==='cancel'){cancel(requests.get(message.id));return Promise.resolve({cancelled:true});}
    if(message.action==='release'){for(const request of requests.values())cancel(request);retire();return Promise.resolve({released:true});}
    if(requests.has(message.id)||requests.size>=SERVICE_READER_LIMITS.requests)throw error('Ein Dienstauftrag läuft bereits.','BUSY');
    const grant=source(message.sourceId),record={id:message.id,source:grant,sourceSignature:signature(grant),authRevision:auth(grant),controller:new AbortController()};requests.set(record.id,record);
    const timer=setTimeout(()=>cancel(record),message.action==='read-file'?SERVICE_READER_LIMITS.documentTimeout:SERVICE_READER_LIMITS.timeout);timer.unref?.();
    const promise=wait(queue,record).then(()=>run(record,message)).finally(()=>{clearTimeout(timer);if(requests.get(record.id)===record)requests.delete(record.id);});queue=promise.catch(()=>{});return promise;
  }
  return Object.freeze({handle,dispose:()=>{if(disposed)return;disposed=true;for(const request of requests.values())cancel(request);retire();},invalidate:()=>{for(const request of requests.values())cancel(request);clearLease();},limits:SERVICE_READER_LIMITS});
}

function cleanMetadata(value){
  const iso=item=>typeof item==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(item)&&Number.isFinite(Date.parse(item))&&new Date(item.slice(0,10)+'T12:00:00Z').toISOString().slice(0,10)===item.slice(0,10)?new Date(item).toISOString():'';
  return {title:bounded(value.title,200),postedBy:bounded(value.postedBy,200),postedAt:iso(value.postedAt),updatedAt:iso(value.updatedAt)};
}
