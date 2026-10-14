// Conservative discovery only. The native source registry independently checks
// the current course and service scope before any linked resource is read.
export function offeredPlatformURL(value){
  if(typeof value!=='string'||value.length>2500||/[\x00-\x20\\\x7f]/.test(value))throw new Error('Ungültiger Plattformlink.');
  const url=new URL(value),hosts={'miro.com':'miro','www.miro.com':'miro','git.coco.study':'gitlab','th-koeln.sciebo.de':'sciebo','chat.coco.study':'mattermost'},service=Object.hasOwn(hosts,url.hostname)?hosts[url.hostname]:'';
  const decode=raw=>{let result=raw;for(let i=0;i<8;i++){const next=decodeURIComponent(result);if(next===result)break;result=next;}if(/[%\\\x00-\x1f\x7f]/.test(result)||result.includes('//')||/(?:^|\/)\.{1,2}(?:\/|$)/.test(result))throw new Error('Ungültiger Plattformpfad.');return result;};
  const path=decode(value.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1]||'/');
  if(!service||url.protocol!=='https:'||url.port||url.username||url.password||!path.startsWith('/'))throw new Error('Unbekannter Plattformlink.');
  url.pathname=path;url.hash='';
  if(service==='miro'){
    const match=/^\/app\/board\/([a-zA-Z0-9_=-]{4,100})\/?$/.exec(path);if(!match)throw new Error('Kein Miro-Board.');
    return {service,url:'https://miro.com/app/board/'+match[1]+'/'};
  }
  if(/(?:^|\/)(?:admin|settings|profile|account|logout|sign_out|sign_in|auth|oauth|login|password|register|new|edit|delete|destroy|remove|create|update|submit|upload|download|attachments?|raw|archive|export|error|forbidden|access-denied)(?:\/|$)/i.test(path)||/\.(?:zip|gz|tar|exe|dmg|pkg|apk|iso|pdf|docx?|xlsx?|pptx?|od[tpst]|csv|json|xml|png|jpe?g|gif|svg|webp|mp[34]|mov|wav)$/i.test(path))throw new Error('Kein lesender Plattformlink.');
  const params=keys=>{for(const key of url.searchParams.keys())if(!keys.includes(key)||url.searchParams.getAll(key).length!==1)throw new Error('Ungültige Plattformparameter.');};
  const secret=part=>/^\.env(?:[.-]|$)|^\.(?:ssh|aws|git)$|(?:^|[._-])(?:secrets?|tokens?|credentials?|passwd|passwords?|api[_-]?keys?)(?:[._-]|$)/i.test(part);
  if(service==='gitlab'){
    const parts=path.split('/').filter(Boolean),marker=parts.indexOf('-');
    if(path!=='/'&&!['/dashboard/projects','/explore/projects'].includes(path.replace(/\/$/,''))){
      if(marker<0){if(parts.length<2||parts.length>8||['users','groups','help','api','oauth','admin'].includes(parts[0]))throw new Error('Kein GitLab-Projekt.');}
      else if(marker<2||marker>8||!['issues','merge_requests','blob','tree','commits','commit','wikis','releases','milestones','boards'].includes(parts[marker+1])||parts.length>30||['issues','merge_requests'].includes(parts[marker+1])&&parts.slice(marker+2).some(part=>!/^\d{1,12}$/.test(part))||['blob','tree'].includes(parts[marker+1])&&parts.slice(marker+2).some(secret))throw new Error('Kein lesender GitLab-Inhalt.');
    }
    params(['page','per_page','ref','search','scope','sort','direction','state','label_name[]','assignee_id','author_id']);
    for(const [key,item]of url.searchParams)if(item.length>200||/[\x00-\x1f\x7f]/.test(item)||['page','per_page','assignee_id','author_id'].includes(key)&&!/^\d{1,9}$/.test(item))throw new Error('Ungültige GitLab-Parameter.');
  }else if(service==='sciebo'){
    if(path==='/'){url.pathname='/index.php/apps/files/';url.search='?dir=%2F';}
    else if(!/^\/(?:index\.php\/)?(?:apps\/files\/?|s\/[a-zA-Z0-9_-]{6,100}\/?)$/.test(path))throw new Error('Kein Sciebo-Ordner oder Share.');
    const shared=/^\/(?:index\.php\/)?s\/[a-zA-Z0-9_-]{6,100}\/?$/.test(path);params(shared?['path']:['dir','fileid']);
    for(const key of ['dir','path'])if(url.searchParams.has(key)){let folder=decode(url.searchParams.get(key));if(!folder.startsWith('/')||folder.length>1000||folder.split('/').some(secret))throw new Error('Ungültiger Sciebo-Ordner.');if(folder!=='/')folder=folder.replace(/\/$/,'');url.searchParams.set(key,folder);}
    if(url.searchParams.has('fileid')&&!/^[1-9]\d{0,17}$/.test(url.searchParams.get('fileid')))throw new Error('Ungültiger Sciebo-Dateibezug.');
  }else{
    if(path!=='/'&&!/^\/[a-zA-Z0-9_-]{1,100}\/(?:channels\/[a-zA-Z0-9_-]{1,100}|pl\/[a-zA-Z0-9]{20,40})\/?$/.test(path))throw new Error('Kein Mattermost-Kanal oder Beitrag.');params([]);
  }
  url.searchParams.sort();return {service,url:url.href};
}

// No Array.from/spread of arbitrary DOM lists: every inspected anchor counts,
// including hidden/duplicate/irrelevant anchors. Unknown remainder is partial.
function collectPlatformLinks(root,{pageURL,pageTitle,readLabel,readPost,readVisible},normalizeURL){
  const sidebar=document.querySelector('#defaultspace-sticky-sidebar'),lists=[root.querySelectorAll('a[href]'),sidebar?.querySelectorAll('a[href]')||[]],seen=new Set(),targets=new Set(),platformLinks=[],revisionLinks=[];
  let inspected=0,evidenceSize=0,platformLinksMore=false;
  outer:for(const list of lists)for(const anchor of list){
    if(++inspected>5000){platformLinksMore=true;break outer;}
    if(seen.has(anchor))continue;seen.add(anchor);
    if(!readVisible(anchor)||anchor.closest('form,[contenteditable=true],nav,header,footer,[hidden],[aria-hidden=true]'))continue;
    let target;try{target=normalizeURL(anchor.href);}catch{continue;}
    evidenceSize+=target.url.length+target.service.length+10;if(evidenceSize>500000){platformLinksMore=true;break outer;}
    revisionLinks.push([target.service,target.url]);
    const key=target.service+':'+target.url;if(targets.has(key))continue;targets.add(key);
    if(platformLinks.length===100){platformLinksMore=true;continue;}
    const post=anchor.closest('.comment,.comment-body,[id^=comment-],#defaultspace-sticky-sidebar')?null:anchor.closest('article,.post');
    const data=post&&(!post.getClientRects||readVisible(post))&&!post.closest?.('form,[contenteditable=true],[hidden],[aria-hidden=true]')?readPost(post):null;
    platformLinks.push({...target,title:(readLabel(anchor)||anchor.getAttribute('aria-label')||'').trim().slice(0,200),sourceURL:pageURL,sourceTitle:data?.title||pageTitle,postedBy:data?.sourceURL?data.postedBy:'',postedAt:data?.sourceURL?data.postedAt:''});
  }
  return {platformLinks,platformLinksMore,revisionLinks};
}

// SHA-256 in a bounded synchronous reader keeps the existing legacy API intact.
// UTF-8 encoding also handles unpaired surrogates like TextEncoder does.
export function readerSHA256(value){
  const bytes=[];for(const char of value){let cp=char.codePointAt(0);if(cp>=0xd800&&cp<=0xdfff)cp=0xfffd;if(cp<0x80)bytes.push(cp);else if(cp<0x800)bytes.push(0xc0|(cp>>>6),0x80|(cp&63));else if(cp<0x10000)bytes.push(0xe0|(cp>>>12),0x80|((cp>>>6)&63),0x80|(cp&63));else bytes.push(0xf0|(cp>>>18),0x80|((cp>>>12)&63),0x80|((cp>>>6)&63),0x80|(cp&63));}
  const bitLength=bytes.length*8;bytes.push(128);while(bytes.length%64!==56)bytes.push(0);for(let i=7;i>=0;i--)bytes.push(i<4?(bitLength>>>i*8)&255:0);
  const constants=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2],hash=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],words=new Array(64),rotate=(n,k)=>(n>>>k)|(n<<(32-k));
  for(let offset=0;offset<bytes.length;offset+=64){
    for(let i=0;i<16;i++)words[i]=(bytes[offset+i*4]<<24)|(bytes[offset+i*4+1]<<16)|(bytes[offset+i*4+2]<<8)|bytes[offset+i*4+3];
    for(let i=16;i<64;i++){const a=words[i-15],b=words[i-2];words[i]=(words[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+words[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))|0;}
    let [a,b,c,d,e,f,g,h]=hash;for(let i=0;i<64;i++){const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+constants[i]+words[i])|0,t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))|0;h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;}
    for(const [i,n]of [a,b,c,d,e,f,g,h].entries())hash[i]=(hash[i]+n)|0;
  }
  return hash.map(n=>(n>>>0).toString(16).padStart(8,'0')).join('');
}

function legacyDocumentRead(start,validateURL,normalizePlatform,collectPlatforms,digest){
  const loginRequired=location.hostname!=='spaces.th-koeln.de'||/login|auth|password/i.test(location.pathname)||!!document.querySelector('input[type=password]');
  if(loginRequired)return {loginRequired:true,title:'Spaces-Anmeldung erforderlich',url:'https://spaces.th-koeln.de/',text:'',links:[],platformLinks:[],platformLinksMore:false};
  if(/(?:^|\/)(?:error|forbidden|access-denied|wp-admin|wp-json)(?:\/|$)/i.test(location.pathname))return {permissionRequired:true,title:'Kurszugriff verweigert',url:'https://spaces.th-koeln.de/',text:'',links:[],platformLinks:[],platformLinksMore:false};
  let url;try{url=validateURL(location.href);}catch{return {permissionRequired:true,title:'Keine lesende Kursseite',url:'https://spaces.th-koeln.de/',text:'',links:[],platformLinks:[],platformLinksMore:false};}
  const root=document.querySelector('#swap-container')||document.querySelector('main, [role=main], #content, .layout-content-container')||document.body;
  const visible=el=>{if(!el?.getClientRects().length||el.closest('[hidden],[aria-hidden=true]')||typeof el.checkVisibility==='function'&&!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;if(typeof getComputedStyle!=='function')return true;const style=getComputedStyle(el);return style.display!=='none'&&!['hidden','collapse'].includes(style.visibility)&&style.opacity!=='0';};
  const label=el=>{
    if(!el)return '';if(el.nodeType!==1)return String(el.innerText||'').slice(0,400);
    const walk=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),values=[];let node,count=0,size=0;
    while((node=walk.nextNode())&&++count<=5000&&size<400){const parent=node.parentElement;if(!parent||!visible(parent)||parent.closest('script,style,noscript,form,input,textarea,select,button,[contenteditable=true],[hidden],[aria-hidden=true]'))continue;const value=node.textContent.trim().slice(0,400-size);if(value){values.push(value);size+=value.length+1;}}
    return values.join(' ');
  };
  const timestamp=value=>{if(typeof value!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,3})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/.test(value)||!Number.isFinite(Date.parse(value)))return '';const day=new Date(value.slice(0,10)+'T12:00:00Z');return day.toISOString().slice(0,10)===value.slice(0,10)?new Date(value).toISOString():'';};
  const cache=new WeakMap(),postData=post=>{
    if(cache.has(post))return cache.get(post);
    const query=selector=>post.querySelector?.(selector),heading=query('.entry-title,.post-title,.post-card-anchor'),author=query('[rel=author],.author .fn,.post-author,.author-profile-link'),time=query('time[datetime]'),permalink=query('a[rel=bookmark],.entry-title a,.post-title a,a.post-card-anchor');
    const rawTime=time?.getAttribute('datetime')||'',epoch=query('.time_ago[data-timestamp]')?.getAttribute('data-timestamp')||'';let postedAt=timestamp(rawTime);
    if(!postedAt&&/^(?:[0-9]{10}|[0-9]{13})$/.test(epoch)){const date=new Date(Number(epoch)*(epoch.length===10?1000:1));if(Number.isFinite(date.getTime()))postedAt=date.toISOString();}
    let sourceURL='';try{if(permalink?.href)sourceURL=validateURL(permalink.href,url);}catch{}
    const data={title:label(heading).trim().slice(0,200),postedBy:label(author).trim().slice(0,200),postedAt,legacyPostedAt:timestamp(rawTime)?rawTime:postedAt,sourceURL};cache.set(post,data);return data;
  };
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node,parts=[],size=0,visited=0,textTruncated=false;
  while((node=walker.nextNode())){
    if(++visited>50000){textTruncated=true;break;}
    const parent=node.parentElement;if(!parent||parent.closest('script,style,noscript,form,input,textarea,select,button,nav,header,footer,#defaultspace-sticky-sidebar,[hidden],[aria-hidden=true],[contenteditable=true]')||!visible(parent))continue;
    const value=node.textContent.trim();if(!value)continue;const room=70001-size;if(room<=0){textTruncated=true;break;}
    parts.push(value.slice(0,room));size+=Math.min(value.length,room)+1;if(value.length>room){textTruncated=true;break;}
  }
  const text=parts.join('\n'),links=[],seen=new Set(),linkRows=new Set();let inspected=0,linksTruncated=false;
  outer:for(const list of [root.querySelectorAll('a[href]'),document.querySelectorAll('#defaultspace-main-menu a[href]')])for(const anchor of list){
    if(++inspected>5000){linksTruncated=true;break outer;}if(seen.has(anchor))continue;seen.add(anchor);
    if(!visible(anchor)||anchor.closest('form,header,footer,[contenteditable=true]'))continue;
    let destination;try{destination=validateURL(anchor.href);}catch{continue;}
    if(linkRows.has(destination))continue;linkRows.add(destination);if(links.length===45){linksTruncated=true;continue;}
    const title=(label(anchor)||anchor.getAttribute('aria-label')||'Link').trim().slice(0,160);if(title)links.push({title,url:destination});
  }
  const sidebar=document.querySelector('#defaultspace-sticky-sidebar'),boardLinks=[],boardInvites=[],boardSeen=new Set();let boardInspected=0,boardLinksMore=false;
  boards:for(const list of [root.querySelectorAll('a[href]'),sidebar?.querySelectorAll('a[href]')||[]])for(const anchor of list){
    if(++boardInspected>5000){boardLinksMore=true;break boards;}if(boardSeen.has(anchor))continue;boardSeen.add(anchor);
    if(!visible(anchor)||anchor.closest('form,[contenteditable=true],nav,header,footer'))continue;
    let target;try{target=normalizePlatform(anchor.href);if(target.service!=='miro')continue;}catch{continue;}
    const share=(()=>{try{return new URL(anchor.href.replace(/&amp;/g,'&')).searchParams.get('share_link_id')||'';}catch{return '';}})();if(/^[A-Za-z0-9_-]{4,80}$/.test(share)&&boardInvites.length<100&&!boardInvites.some(row=>row.url===target.url))boardInvites.push({url:target.url,share});
    if(boardLinks.length===100){boardLinksMore=true;continue;}
    const post=anchor.closest('.comment,.comment-body,[id^=comment-],#defaultspace-sticky-sidebar')?null:anchor.closest('article,.post'),data=post&&(!post.getClientRects||visible(post))?postData(post):null;
    boardLinks.push({url:target.url,title:(label(anchor)||anchor.getAttribute('aria-label')||'').trim().slice(0,200),postedBy:data?.sourceURL?data.postedBy:'',postedAt:data?.sourceURL?data.legacyPostedAt:'',sourceTitle:data?.title||document.title.slice(0,200),sourceURL:data?.sourceURL||url});
  }
  const controls=[];let controlInspected=0;for(const el of document.querySelectorAll('#primary-swap-menu-label,#secondary-swap-menu-label,h1 button[id^=accordion-item-],h2 button[id^=accordion-item-],h3 button[id^=accordion-item-],h4 button[id^=accordion-item-]')){
    if(++controlInspected>5000||controls.length===30)break;
    if(visible(el)&&!el.closest('form,[contenteditable=true]')&&!el.form&&!el.getAttribute('form')&&!/^(submit|reset)$/i.test(el.getAttribute('type')||''))controls.push({id:el.id,title:(el.innerText||'').trim().slice(0,160)});
  }
  const title=document.title.slice(0,200),{platformLinks,platformLinksMore,revisionLinks}=collectPlatforms(root,{pageURL:url,pageTitle:title,readLabel:label,readPost:postData,readVisible:visible},normalizePlatform);
  const contentRevision=digest(JSON.stringify([url,title,text,textTruncated,links,linksTruncated,controls,boardLinks,boardLinksMore,platformLinks,platformLinksMore,revisionLinks]));
  return {boardLinks,boardInvites,boardLinksMore,platformLinks,platformLinksMore,contentRevision,controls,url,title,text:text.slice(start,start+5000),offset:start,hasMore:text.length>start+5000,textTruncated,links,linksTruncated,loginRequired:false};
}

export function readScript(offset=0,options={}){
  if(options.crawler===true)return crawlerReadScript(offset,options);
  const start=Number.isSafeInteger(offset)?Math.max(0,Math.min(50000,offset)):0;
  const normalURL=`((value,scope)=>(${normalReaderURL.toString()})(value,scope,${crawlerURL.toString()}))`;
  return `(${legacyDocumentRead.toString()})(${start},${normalURL},${offeredPlatformURL.toString()},${collectPlatformLinks.toString()},${readerSHA256.toString()})`;
}

// Only the normal browser reader preserves a user-entered search query. Its
// original raw path still reaches the strict validator before URL normalization
// can erase traversal. Crawler navigation never inherits this exception.
export function normalReaderURL(value,scope='',strictURL=crawlerURL){
  const withoutSearch=input=>{
    if(typeof input!=='string'||input.length>2500||/[\x00-\x20\\\x7f]/.test(input))throw new Error('Ungültige Spaces-Suchansicht.');
    const parsed=new URL(input),values=parsed.searchParams.getAll('s');
    if(values.length>1||values.length===1&&(values[0].length>200||/[\x00-\x1f\x7f]/.test(values[0])))throw new Error('Ungültige Spaces-Suche.');
    if(!values.length)return {url:input,search:null};
    parsed.searchParams.delete('s');const query=parsed.searchParams.toString(),at=input.indexOf('?');
    return {url:input.slice(0,at)+(query?'?'+query:''),search:values[0]};
  };
  const target=withoutSearch(value),root=scope?withoutSearch(scope):null,url=new URL(strictURL(target.url,root?.url||''));
  if(target.search!==null)url.searchParams.set('s',target.search);return url.href;
}

// A separate stricter policy is used only by the bounded course crawler.
// Decode the original path before URL normalization can erase traversal.
export function crawlerURL(value,scope=''){
  const canonical=input=>{
    if(typeof input!=='string'||input.length>2000||/[\x00-\x20\\]/.test(input))throw new Error('Ungültiger lesender Kurslink.');
    const u=new URL(input);let raw=input.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1]||'/';
    for(let i=0;i<8;i++){const next=decodeURIComponent(raw);if(next===raw)break;raw=next;}
    if(u.protocol!=='https:'||u.hostname!=='spaces.th-koeln.de'||u.port||u.username||u.password||/[%\\\x00-\x20]/.test(raw)||/(?:^|\/)\.{1,2}(?:\/|$)/.test(raw)||raw.includes('//'))throw new Error('Ungültiger lesender Kurslink.');
    if(/(?:^|\/)(?:members?|users?|profiles?|people|persons?|participants?|students?|staff|directory|contacts?|community|groups?|wp-admin|wp-json|wp-content|wp-includes|feed|comments?|trackback|attachment|embed)(?:\/|$)|(?:^|\/)xmlrpc\.php$/i.test(raw)||/(?:^|\/)[^/]*(?:logout|delete|remove|edit|create|submit|update|auth|login|register|account|password)[^/]*(?:\/|$)/i.test(raw)||/\.(?:pdf|zip|gz|tar|docx?|xlsx?|pptx?|od[tpst]|csv|txt|json|xml|js|css|exe|dmg|pkg|apk|jpe?g|png|gif|webp|avif|svg|ico|heic|mp[34]|m4a|mov|webm|wav|ogg|woff2?|ttf)(?:\/|$)/i.test(raw)||[...u.searchParams.keys()].some(key=>!['paged','page_id'].includes(key)))throw new Error('Dieser Link liegt außerhalb lesender Kursinhalte.');
    for(const [key,item]of u.searchParams)if(!/^[1-9]\d{0,8}$/.test(item)||u.searchParams.getAll(key).length!==1)throw new Error('Ungültige Kurs-Paginierung.');
    u.hash='';return {url:u.href,path:raw};
  };
  const target=canonical(value);if(!scope)return target.url;
  const root=canonical(scope),path=root.path.replace(/\/$/,'');
  if(!path||path==='/'||root.path!==path&&root.path!==path+'/')throw new Error('Verknüpfe eine konkrete Spaces-Kursseite.');
  const within=target.path===path||target.path.startsWith(path+'/');
  const blog=/^\/(?:wp\/)?blog\/[a-zA-Z0-9_\p{L}\p{N}-]+(?:\/[a-zA-Z0-9_\p{L}\p{N}-]+)*\/?$/u.test(target.path);
  const permalink=/^\/(?:wp\/|blog\/|wp\/blog\/)?20\d{2}\/\d{1,2}\/\d{1,2}\/[a-zA-Z0-9_\p{L}\p{N}-]+\/?$/u.test(target.path);
  if(!within&&!blog&&!permalink)throw new Error('Der Link gehört nicht zum gewählten Kurs.');
  return target.url;
}

function crawlerDocumentRead(options,validateURL,normalizePlatform,collectPlatforms){
  return (async()=>{
    const loginRequired=location.hostname!=='spaces.th-koeln.de'||/login|auth|password/i.test(location.pathname)||!!document.querySelector('input[type=password]');
    if(loginRequired)return {loginRequired:true,title:'Spaces-Anmeldung erforderlich',url:'https://spaces.th-koeln.de/',text:'',links:[],controls:[],platformLinks:[],platformLinksMore:false};
    if(/(?:^|\/)(?:error|forbidden|access-denied|wp-admin|wp-json)(?:\/|$)/i.test(location.pathname))return {permissionRequired:true,title:'Kurszugriff verweigert',url:'https://spaces.th-koeln.de/',text:'',links:[],controls:[],platformLinks:[],platformLinksMore:false};
    const url=validateURL(location.href,options.courseURL);
    const root=document.querySelector('#swap-container')||document.querySelector('main, [role=main], #content, .layout-content-container')||document.body;
    const excluded='script,style,noscript,form,input,textarea,select,button,nav,header,footer,#defaultspace-sticky-sidebar,[hidden],[aria-hidden=true],[contenteditable=true]';
    const visible=el=>{if(!el?.getClientRects().length||el.closest('[hidden],[aria-hidden=true]')||typeof el.checkVisibility==='function'&&!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;if(typeof getComputedStyle!=='function')return true;const style=getComputedStyle(el);return style.display!=='none'&&!['hidden','collapse'].includes(style.visibility)&&style.opacity!=='0';};
    const timestamp=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(value)||Number.isNaN(Date.parse(value)))return '';const day=value.slice(0,10),date=new Date(day+'T12:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===day?new Date(value).toISOString():'';};
    const epochTimestamp=value=>{if(!/^(?:\d{10}|\d{13})$/.test(value||''))return '';const date=new Date(Number(value)*(value.length===10?1000:1));return Number.isFinite(date.getTime())?date.toISOString():'';};
    const clockSelector='.time_ago[data-timestamp],time[datetime]';
    const clockTime=el=>timestamp(el?.getAttribute?.('datetime')||'')||(el&&el.closest?.('.time_ago[data-timestamp]')===el?epochTimestamp(el.getAttribute('data-timestamp')):'');
    const nodeText=(textNode,seen)=>{const raw=textNode.textContent.trim();if(!raw)return '';const clock=textNode.parentElement?.closest(clockSelector),iso=clockTime(clock);if(!iso)return raw;if(seen.has(clock))return '';seen.add(clock);return iso;};
    const labelText=el=>{if(!el)return '';const own=clockTime(el.closest?.(clockSelector));if(own)return own;if(el.nodeType!==1&&!el.querySelector?.(clockSelector))return String(el.innerText||'').slice(0,400);const walk=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),seen=new Set(),values=[];let child,count=0,size=0;while((child=walk.nextNode())&&++count<=5000&&size<400){const parent=child.parentElement;if(!parent||!visible(parent)||parent.closest('script,style,noscript,form,input,textarea,select,[contenteditable=true],[hidden],[aria-hidden=true]'))continue;const value=nodeText(child,seen).slice(0,400-size);if(value){values.push(value);size+=value.length+1;}}return values.join(' ');};
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),seenTimes=new Set();let node,parts=[],size=0,visited=0,overflow=false;
    while((node=walker.nextNode())){
      if(++visited>50000){overflow=true;break;}
      const parent=node.parentElement;if(!parent||parent.closest(excluded)||!visible(parent))continue;
      const value=nodeText(node,seenTimes);if(!value)continue;
      const room=70001-size;if(room<=0){overflow=true;break;}
      parts.push(value.slice(0,room));size+=Math.min(value.length,room)+1;
      if(value.length>room){overflow=true;break;}
    }
    const fullText=parts.join('\n'),totalLength=fullText.length;
    let limit=Math.min(60000,totalLength);
    const high=index=>index>=0&&/[\uD800-\uDBFF]/.test(fullText[index]),low=index=>index<totalLength&&/[\uDC00-\uDFFF]/.test(fullText[index]);
    if(high(limit-1)&&low(limit))limit--;
    const start=Math.min(options.offset,limit);
    if(low(start)&&high(start-1))throw new Error('Ungültige Textgrenze. Bitte nextOffset verwenden.');
    let end=Math.min(start+5000,limit);if(high(end-1)&&low(end))end--;
    const navAllowed='[rel=next],[rel=prev],.nav-links,.navigation.pagination,.pagination,.paging-navigation,.posts-navigation,#defaultspace-main-menu,.course-menu,.swap-menu';
    const candidates=[root.querySelectorAll('a[href]'),document.querySelectorAll('#defaultspace-main-menu a[href],.course-menu a[href],.swap-menu a[href]')];
    const uniqueLinks=new Map(),seenAnchors=new Set();let inspected=0,linksTruncated=false;
    navigation:for(const list of candidates)for(const anchor of list){
      if(++inspected>5000){linksTruncated=true;break navigation;}if(seenAnchors.has(anchor))continue;seenAnchors.add(anchor);
      if(!visible(anchor)||anchor.closest('form,[contenteditable=true],header,#defaultspace-sticky-sidebar'))continue;
      if(anchor.closest('nav,footer')&&!anchor.closest(navAllowed))continue;
      let destination;try{destination=validateURL(anchor.href,options.courseURL);}catch{continue;}
      const title=(labelText(anchor)||anchor.getAttribute('aria-label')||'Kurslink').trim().slice(0,160);
      if(!title||uniqueLinks.has(destination))continue;
      uniqueLinks.set(destination,{title,url:destination});
    }
    const discovered=[...uniqueLinks.values()],allLinks=discovered.slice(0,500);
    linksTruncated ||= discovered.length>500;
    const controlMap=new Map();let controlsInspected=0,controlsTruncated=false;
    for(const el of document.querySelectorAll('#primary-swap-menu-label,#secondary-swap-menu-label,h1 button[id^=accordion-item-],h2 button[id^=accordion-item-],h3 button[id^=accordion-item-],h4 button[id^=accordion-item-]')){
      if(++controlsInspected>5000){controlsTruncated=true;break;}
      if(!visible(el)||el.closest('form,[contenteditable=true],header,footer,#defaultspace-sticky-sidebar')||el.closest('nav')&&!el.closest('#defaultspace-main-menu,.course-menu,.swap-menu')||el.form||el.getAttribute('form')||/^(submit|reset)$/i.test(el.getAttribute('type')||'')||!/^(?:primary-swap-menu-label|secondary-swap-menu-label|accordion-item-[a-zA-Z0-9_-]{1,80})$/.test(el.id)||controlMap.has(el.id))continue;
      if(controlMap.size===300){controlsTruncated=true;continue;}controlMap.set(el.id,{id:el.id,title:labelText(el).trim().slice(0,160)});
    }
    const controls=[...controlMap.values()];
    const postCache=new WeakMap();
    const postData=post=>{
      if(postCache.has(post))return postCache.get(post);
      const heading=post.querySelector('.entry-title,.post-title,.post-card-anchor'),author=post.querySelector('[rel=author],.author .fn,.post-author,.author-profile-link'),time=post.querySelector('time[datetime]'),updated=post.querySelector('time.updated[datetime],time.entry-date.updated[datetime]'),permalink=post.querySelector('a[rel=bookmark],.entry-title a,.post-title a,a.post-card-anchor');
      let postedAt=timestamp(time?.getAttribute('datetime')||'');const epoch=post.querySelector('.time_ago[data-timestamp]')?.getAttribute('data-timestamp')||'';
      if(!postedAt)postedAt=epochTimestamp(epoch);
      let sourceURL='';try{if(permalink?.href)sourceURL=validateURL(permalink.href,options.courseURL);}catch{}
      const data={title:labelText(heading).trim().slice(0,200),postedBy:labelText(author).trim().slice(0,200),postedAt,updatedAt:timestamp(updated?.getAttribute('datetime')||''),sourceURL};postCache.set(post,data);return data;
    };
    const posts=[];let postsInspected=0;for(const post of root.querySelectorAll('article,.post')){if(++postsInspected>5000||posts.length===50)break;if(visible(post)&&!post.closest('form,[contenteditable=true],[hidden],[aria-hidden=true]'))posts.push(postData(post));}
    const sidebar=document.querySelector('#defaultspace-sticky-sidebar'),boardCandidates=[root.querySelectorAll('a[href]'),sidebar?.querySelectorAll('a[href]')||[]];
    const boardLinks=[],boardInvites=[],seenBoards=new Set();let boardLinksMore=false,boardInspected=0;
    boards:for(const list of boardCandidates)for(const anchor of list){
      if(++boardInspected>5000){boardLinksMore=true;break boards;}if(seenBoards.has(anchor))continue;seenBoards.add(anchor);
      if(!visible(anchor)||anchor.closest('form,[contenteditable=true],nav,header,footer'))continue;
      let boardURL;try{const parsed=normalizePlatform(anchor.href);if(parsed.service!=='miro')continue;boardURL=parsed.url;}catch{continue;}
      const share=(()=>{try{return new URL(anchor.href.replace(/&amp;/g,'&')).searchParams.get('share_link_id')||'';}catch{return '';}})();if(/^[A-Za-z0-9_-]{4,80}$/.test(share)&&boardInvites.length<100&&!boardInvites.some(row=>row.url===boardURL))boardInvites.push({url:boardURL,share});
      if(boardLinks.length===100){boardLinksMore=true;continue;}
      const post=anchor.closest('.comment,.comment-body,[id^=comment-],#defaultspace-sticky-sidebar')?null:anchor.closest('article,.post');
      const data=post&&visible(post)?postData(post):null;
      boardLinks.push({url:boardURL,title:(labelText(anchor)||anchor.getAttribute('aria-label')||'').trim().slice(0,200),postedBy:data?.sourceURL?data.postedBy:'',postedAt:data?.sourceURL?data.postedAt:'',sourceTitle:data?.title||document.title.slice(0,200),sourceURL:data?.sourceURL||url});
    }
    const title=document.title.slice(0,200),metadata={sourceURL:url,postedBy:'',postedAt:'',updatedAt:'',posts};
    if(posts.length===1&&posts[0].sourceURL===url)Object.assign(metadata,{postedBy:posts[0].postedBy,postedAt:posts[0].postedAt,updatedAt:posts[0].updatedAt});
    const {platformLinks,platformLinksMore,revisionLinks}=collectPlatforms(root,{pageURL:url,pageTitle:title,readLabel:labelText,readPost:postData,readVisible:visible},normalizePlatform);
    const data=new TextEncoder().encode(JSON.stringify([url,title,fullText,overflow,discovered,linksTruncated,controls,controlsTruncated,metadata,boardLinks,boardLinksMore,platformLinks,platformLinksMore,revisionLinks]));
    const hash=await crypto.subtle.digest('SHA-256',data),contentRevision=[...new Uint8Array(hash)].map(value=>value.toString(16).padStart(2,'0')).join('');
    return {boardInvites,url,title,text:fullText.slice(start,end),offset:start,nextOffset:end,hasMore:end<limit,totalLength:limit,originalObservedLength:totalLength,totalLengthKnown:!overflow,textTruncated:overflow||totalLength>limit,contentRevision,links:allLinks.slice(options.linkOffset,options.linkOffset+45),linkOffset:options.linkOffset,totalLinks:allLinks.length,linksHasMore:options.linkOffset+45<allLinks.length,linksTruncated,controls:controls.slice(options.controlOffset,options.controlOffset+30),controlOffset:options.controlOffset,totalControls:controls.length,controlsMore:options.controlOffset+30<controls.length,controlsTruncated,metadata,boardLinks,boardLinksMore,platformLinks,platformLinksMore,loginRequired:false};
  })();
}

export function crawlerReadScript(offset=0,options={}){
  const config={offset:Number.isSafeInteger(offset)?Math.max(0,Math.min(60000,offset)):0,linkOffset:Number.isSafeInteger(options.linkOffset)?Math.max(0,Math.min(500,options.linkOffset)):0,controlOffset:Number.isSafeInteger(options.controlOffset)?Math.max(0,Math.min(300,options.controlOffset)):0,courseURL:crawlerURL(options.courseURL,options.courseURL)};
  return `(${crawlerDocumentRead.toString()})(${JSON.stringify(config)},${crawlerURL.toString()},${offeredPlatformURL.toString()},${collectPlatformLinks.toString()})`;
}
