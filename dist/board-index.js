// A deterministic local directory. Never fetches Miro or opens invitation URLs.
const str=(v,max=200)=>typeof v==='string'?v.trim().slice(0,max):'';
const plain=v=>str(v,500).replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&#(?:x([a-f0-9]+)|(\d+));/gi,(_a,h,d)=>{const n=parseInt(h||d,h?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}).trim();
const labelWords = new Set(['link','links','url','miro','board','boards','boardlink','whiteboard','hier','here','klick','klicken','anklicken','click','open','öffnen','öffne','ansehen','zum','zur','zu','auf','für','in','to','go','geht','es','s','um','gelangen','und','and','der','die','das','den','dem','ein','eine','dein','deine','unser','unsere','the','this','is','ist','jetzt','bitte','please','diesen','dieses']);
const normalizedLabel = value => plain(value).toLocaleLowerCase('de').replace(/[\p{P}\p{S}]+/gu,' ').replace(/\s+/g,' ').trim();
const genericSources = new Set(['gespeicherte quelle','home','startseite','übersicht','overview','resources','ressourcen','posts','beiträge','spaces','th spaces','th köln spaces']);
function usefulLabel(value,boardURL='') {
 const title=plain(value);
 if(!title||/^(?:https?:\/\/|(?:www\.)?miro\.com(?:\b|\/))/i.test(title))return false;
 if(boardURL&&title===new URL(boardURL).pathname.split('/')[3])return false;
 const words=normalizedLabel(title).split(' ').filter(Boolean);
 return words.some(word=>!labelWords.has(word)&&!/^\d+$/.test(word));
}
const usefulReference = value => usefulLabel(value)&&!genericSources.has(normalizedLabel(value));
function findingTitle(link,source,sourceTitle,url) {
 const title=plain(link.title),origin=link.titleOrigin;
 // A directory label is provenance, never an asserted Miro original title.
 if(origin==='reference'&&usefulReference(title.replace(/^Board\s*·\s*/i,'')))return {title,titleOrigin:'reference'};
 if((origin===undefined||origin==='link')&&usefulLabel(title,url))return {title,titleOrigin:'link'};
 const context=[sourceTitle,plain(source.projectTitle)].find(usefulReference);
 return context?{title:plain('Board · '+context),titleOrigin:'reference'}:{title:'Miro-Board',titleOrigin:'unknown'};
}
const titleRank = origin => ({unknown:0,reference:1,link:2,custom:3})[origin]??0;
function titleStrength(value) {
 const words=normalizedLabel(value).split(' ').filter(word=>word&&!labelWords.has(word)&&!/^\d+$/.test(word));
 return new Set(words).size*1000+Math.min(plain(value).length,500);
}
function preferredTitle(previous,fresh) {
 if(!previous)return {title:fresh.title,titleOrigin:fresh.titleOrigin};
 const oldRank=titleRank(previous.titleOrigin),newRank=titleRank(fresh.titleOrigin);
 if(newRank>oldRank||newRank===oldRank&&fresh.titleOrigin==='reference'&&titleStrength(fresh.title)>titleStrength(previous.title))return {title:fresh.title,titleOrigin:fresh.titleOrigin};
 return {title:previous.title,titleOrigin:previous.titleOrigin};
}
export function miroBoardURL(value){
 const u=new URL(String(value).replace(/&amp;/g,'&'));
 if(u.protocol!=='https:'||!['miro.com','www.miro.com'].includes(u.hostname)||u.username||u.password||u.port)throw new Error('Kein sicherer Miro-Boardlink.');
 const match=/^\/app\/board\/([a-zA-Z0-9_=-]{4,100})\/?$/.exec(decodeURIComponent(u.pathname));
 if(!match)throw new Error('Kein Miro-Boardlink.');
 return 'https://miro.com/app/board/'+match[1]+'/';
}
export function boardSourceURL(value){
 if(!value)return '';
 const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)throw new Error('Unsichere Fundstelle.');
 for(const k of [...u.searchParams.keys()])if(/token|key|secret|password|code|signature|auth|share_link/i.test(k))u.searchParams.delete(k);
 u.hash='';return u.href.slice(0,2000);
}
const stamp=v=>{
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(v))return '';
 const day=v.slice(0,10),d=new Date(day+'T12:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==day||!Number.isFinite(Date.parse(v)))return '';
 return v.length===10?v:new Date(v).toISOString();
};
const sourceKey=v=>{if(typeof v!=='string'||!v.trim())throw new Error('Fundstellen-Kennung fehlt.');v=v.trim();v=/^https:\/\//i.test(v)?boardSourceURL(v):v;if(v.length>200)throw new Error('Fundstellen-Kennung ist zu lang.');return v;};
export function boardFinding(link,source,now=new Date().toISOString()){
 const url=miroBoardURL(link.url),sourceId=sourceKey(source.id),projectId=str(source.projectId,80),originProjectId=str(link.originProjectId??source.projectId,80),sourceURL=boardSourceURL(link.sourceURL||source.url||''),sourceTitle=plain(link.sourceTitle||source.title)||'Gespeicherte Quelle';
 return {id:url+'|'+sourceId+'|'+originProjectId,url,...findingTitle(link,source,sourceTitle,url),sourceId,sourceTitle,sourceURL,sourceKind:str(source.kind,40)||'local',projectId,originProjectId,postedBy:plain(link.postedBy||source.postedBy),postedAt:stamp(link.postedAt||source.postedAt),foundAt:stamp(now),customTitle:'',assignedProjectId:null};
}
export function extractBoardLinks(value){
 const input=typeof value==='string'?value.slice(0,200000):'',found=new Map();
 const add=(url,title='')=>{try{url=miroBoardURL(url);title=plain(title);const old=found.get(url);if(!old||!old.title||!usefulLabel(old.title,url)&&usefulLabel(title,url))found.set(url,{url,title});}catch{}};
 for(const m of input.matchAll(/\[([^\]\n]{1,200})\]\((https:\/\/[^\s)]+)\)/g))add(m[2],m[1]);
 for(const m of input.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi))add(m[1],m[2]);
 for(const m of input.matchAll(/https:\/\/[^\s<>"'\])]+/g))add(m[0].replace(/[.,;!]$/,''));
 return [...found.values()].slice(0,100);
}
export function validateBoardFindings(value=[],projectIds){
 if(!Array.isArray(value)||value.length>5000)throw new Error('Zu viele Board-Fundstellen.');
 return value.map(f=>{
  if(!f||typeof f!=='object')throw new Error('Ungültige Board-Fundstelle.');
  const result=boardFinding(f,{id:f.sourceId,projectId:f.projectId,url:f.sourceURL,title:f.sourceTitle,kind:f.sourceKind},f.foundAt||'');
  if(projectIds&&result.projectId&&!projectIds.includes(result.projectId))throw new Error('Der Kurs der Board-Fundstelle fehlt.');
  if(f.assignedProjectId!==undefined&&f.assignedProjectId!==null){if(typeof f.assignedProjectId!=='string'||f.assignedProjectId.length>80||projectIds&&f.assignedProjectId&&!projectIds.includes(f.assignedProjectId))throw new Error('Ungültige eigene Kurszuordnung.');result.assignedProjectId=f.assignedProjectId;result.projectId=f.assignedProjectId;}
  result.customTitle=plain(f.customTitle);return result;
 });
}
export function mergeBoardFindings(previous,fresh){
 const rows=new Map(validateBoardFindings(previous).map(f=>[f.id,f]));
 for(const f of validateBoardFindings(fresh)){const old=rows.get(f.id);rows.set(f.id,{...f,...preferredTitle(old,f),foundAt:old?.foundAt||f.foundAt,customTitle:old?.customTitle||f.customTitle,...(old?.assignedProjectId!==null&&old?.assignedProjectId!==undefined?{assignedProjectId:old.assignedProjectId,projectId:old.assignedProjectId}:{}),postedBy:f.postedBy||old?.postedBy||'',postedAt:f.postedAt||old?.postedAt||''});}
 if(rows.size>5000)throw new Error('Das Board-Verzeichnis ist voll. Exportiere und bereinige es vor der nächsten Suche.');
 return [...rows.values()];
}
export function collectLocalBoards({workspace,updates=[],browserSources=[],courseOf=()=>''},now=new Date().toISOString()){
 const found=[],courseTitles=new Map((workspace.projects||[]).map(p=>[p.id,p.name]));let count=0;
 function add(source,body,links=[]){count++;source={...source,projectTitle:courseTitles.get(source.projectId)||''};for(const l of [...extractBoardLinks(body),...links].slice(0,100))try{found.push(boardFinding(l,source,now));}catch{}}
 for(const p of workspace.projects||[]){if(p.archived)continue;add({id:'project:'+p.id,projectId:p.id,title:p.name,kind:'project'},p.note,(p.links||[]).map(l=>({url:l.url,title:l.title})));}
 for(const b of workspace.bookmarks||[])add({id:'bookmark:'+b.id,projectId:b.projectId,title:b.title,kind:'bookmark'},b.note,[{url:b.url,title:b.title}]);
 for(const n of workspace.notes||[])add({id:'note:'+n.id,projectId:n.projectId,title:n.title,kind:'note'},n.content);
 for(const t of workspace.tasks||[])add({id:'task:'+t.id,projectId:t.projectId,title:t.title,kind:'task'},t.title,t.url?[{url:t.url}]:[]);
 for(const u of updates){if(!['spaces','mattermost','gitlab'].includes(u.source))continue;let projectId='';try{projectId=courseOf(u);}catch{}add({id:u.id,projectId,title:u.title,kind:u.source,url:u.url,postedBy:typeof u.author==='string'?u.author:u.author?.name||'',postedAt:u.kind==='summary'?'':u.createdAt},(u.summary||'')+'\n'+(u.content||''));}
 for(const s of browserSources)add({id:s.id,projectId:s.projectId,title:s.title,kind:'spaces',url:s.url},s.text,s.boardLinks||[]);
 return {findings:mergeBoardFindings([],found),sources:count};
}
export function groupBoards(findings,{projectId='',query='',sort='recent'}={}){
 const groups=new Map(),q=query.toLocaleLowerCase('de').trim();
 for(const f of findings){if(projectId&&f.projectId!==projectId)continue;const id=f.url+'|'+f.projectId;const g=groups.get(id)||{id,url:f.url,projectId:f.projectId,title:'Miro-Board',titleOrigin:'unknown',occurrences:[]};g.occurrences.push(f);Object.assign(g,preferredTitle(g,f.customTitle?{title:f.customTitle,titleOrigin:'custom'}:f));groups.set(id,g);}
 return [...groups.values()].filter(g=>!q||[g.title,g.url,...g.occurrences.flatMap(f=>[f.sourceTitle,f.postedBy])].join(' ').toLocaleLowerCase('de').includes(q)).sort((a,b)=>sort==='title'?a.title.localeCompare(b.title,'de'):(Math.max(...b.occurrences.map(f=>Date.parse(f.postedAt||f.foundAt)||0))-Math.max(...a.occurrences.map(f=>Date.parse(f.postedAt||f.foundAt)||0))));
}

export function boardKnowledgeKey(id){let h=14695981039346656037n;for(const c of id){h=BigInt.asUintN(64,(h^BigInt(c.codePointAt(0)))*1099511628211n);}return 'board-'+h.toString(16).padStart(16,'0');}
