import {createHash} from 'node:crypto';
import {createPlatformFeed} from '../connectors/platform-feed.mjs';
import {authenticationContext} from '../connectors/wordpress.mjs';
import {diaryCourseURL,readableDiaryContent} from './dev-diary.mjs';
import {gitlabNotifications,mattermostNotifications} from '../connectors/notifications.mjs';
import {scieboNotifications} from '../connectors/sciebo-notifications.mjs';
import {miroNotifications} from '../connectors/miro-notifications.mjs';
import {createWhatsAppNotifications} from './whatsapp-notifications.mjs';
import {boundNotificationFeed} from '../dist/feed-state.js';

const hosts={spaces:'spaces.th-koeln.de',mattermost:'chat.coco.study',gitlab:'git.coco.study',sciebo:'th-koeln.sciebo.de',miro:'miro.com'};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive=value=>Number.isSafeInteger(value)&&value>0;
const failure=(code)=>Object.assign(new Error('Die Plattform konnte nicht gelesen werden.'),{code});
const date=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(value)&&Number.isFinite(Date.parse(value+'Z'))?new Date(value+'Z').toISOString():'';
const clean=value=>readableDiaryContent(typeof value==='string'?value:'').contentText;
const getMethods=route=>[route?.methods,...(route?.endpoints||[]).map(value=>value.methods)].flatMap(value=>Array.isArray(value)?value:typeof value==='string'?value.split(','):[]);
export const notificationAuthCookie=cookie=>typeof cookie?.name==='string'&&(/sess(?:ion|id)|token|auth|logged_in|userid/i.test(cookie.name)||/^wordpress_(?:sec_|[a-f0-9]{32}$)/i.test(cookie.name)||/^oc[a-z0-9]{8,30}$/i.test(cookie.name));

export function notificationScopes(values){
  if(!Array.isArray(values)||values.length>20)throw failure('INVALID_REQUEST');
  const scopes=values.map(value=>{
    if(!value||Object.keys(value).some(key=>!['id','name','url'].includes(key))||typeof value.id!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(value.id)||typeof value.name!=='string'||!value.name.trim()||value.name.length>200)throw failure('INVALID_REQUEST');
    return {id:value.id,name:value.name,url:diaryCourseURL(value.url)};
  });
  if(new Set(scopes.map(value=>value.url)).size!==scopes.length)throw failure('INVALID_REQUEST');
  return scopes.sort((a,b)=>a.url.localeCompare(b.url));
}

// Uses Electron's existing provider session. No cookies/tokens/nonces are
// returned through IPC, copied to the workspace or sent to another origin.
export function createDesktopNotifications({providerSession,nango,getMiroBoards=()=>[],getMiroSnapshots=()=>[],getWhatsAppContext=()=>null,getWhatsAppSelection=()=>[],now=Date.now,emit=()=>{}}){
  let disposed=false;const identities=new Map();
  async function cookieAccount(source){
    const cookies=(await providerSession.cookies.get({})).filter(cookie=>{const domain=String(cookie.domain||'').replace(/^\./,'');return domain===hosts[source]||hosts[source].endsWith('.'+domain);});
    return hash([source,cookies.filter(cookie=>source==='miro'?(cookie.httpOnly||/session|token|auth|userid/i.test(cookie.name)):notificationAuthCookie(cookie)).map(cookie=>[cookie.domain,cookie.path,cookie.name,cookie.value]).sort((a,b)=>String(a.slice(0,3)).localeCompare(String(b.slice(0,3))))]);
  }
  async function account(source){
    let value=await cookieAccount(source);
    if(source==='miro'){
      const status=typeof nango?.localStatus==='function'?nango.localStatus('miro'):await nango?.status?.('miro');
      value=hash([value,{integrationId:status?.integrationId,connectionId:status?.connectionId,revision:status?.revision,boardRead:status?.capabilities?.boardRead===true}]);
    }
    if(disposed)throw failure('DISPOSED');
    const previous=identities.get(source);identities.set(source,value);
    if(previous&&previous!==value){feed.invalidate(source);emit({source});}
    return value;
  }
  async function request(url,{headers={},signal}={}){
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||!Object.values(hosts).includes(parsed.hostname)||parsed.port||parsed.username||parsed.password||parsed.hash)throw failure('INVALID_REQUEST');
    const response=await providerSession.fetch(url,{method:'GET',credentials:'include',redirect:'manual',cache:'no-store',signal:AbortSignal.any([AbortSignal.timeout(12000),...(signal?[signal]:[])]),headers:{Accept:'application/json, text/html',...headers}});
    if(response.status>=300&&response.status<400)throw failure('LOGIN_REQUIRED');
    if(!response.ok){void response.body?.cancel().catch(()=>{});throw Object.assign(failure('HTTP_ERROR'),{status:response.status});}
    if(response.status===204)return {text:'',headers:response.headers,status:204};
    const reader=response.body.getReader(),chunks=[];let length=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>2_000_000)throw failure('RESPONSE_LIMIT');chunks.push(Buffer.from(value));}}
    catch(error){void reader.cancel().catch(()=>{});throw error;}
    return {text:Buffer.concat(chunks).toString('utf8'),headers:response.headers,status:response.status};
  }
  async function json(url,options){const result=await request(url,options);if(!result.headers.get('content-type')?.includes('json'))throw failure('LOGIN_REQUIRED');return {...result,value:JSON.parse(result.text)};}
  async function spaces({scope,signal,previous}){
    if(!scope.length)return {items:[],status:'not_configured',message:'Verknüpfe einen Spaces-Kurs, um Beiträge und Kommentare zu synchronisieren.'};
    const items=[],warnings=[],scopes=[];let cursor=0;
    await Promise.all(Array.from({length:Math.min(3,scope.length)},async()=>{while(cursor<scope.length){
      const course=scope[cursor++];
      try{
        const html=(await request(course.url,{signal})).text;let ctx;
        try{ctx=authenticationContext(html,course.url);}catch(error){
          if(error.code!=='UNVERIFIED_SPACES_API')throw error;
          const backend=(await request(course.url+'wp-admin/edit.php',{signal})).text;
          ctx=authenticationContext(backend,course.url,{admin:true});
        }
        const index=(await json(ctx.apiRoot,{headers:{'X-WP-Nonce':ctx.nonce},signal})).value;
        if(!['/wp/v2/posts','/wp/v2/users/me'].every(route=>getMethods(index.routes?.[route]).includes('GET')))throw failure('UNVERIFIED_SPACES_API');
        const api=async(route,params={})=>{
          const url=new URL(ctx.apiRoot+route);for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
          return json(url.href,{headers:{'X-WP-Nonce':ctx.nonce},signal});
        };
        const me=(await api('wp/v2/users/me',{context:'view',_fields:'id'})).value;if(!positive(me?.id))throw failure('LOGIN_REQUIRED');
        const accountID=hash([course.url,me.id]).slice(0,20),result=await api('wp/v2/posts',{context:'view',status:'publish',per_page:50,orderby:'modified',order:'desc',_fields:'id,link,title,content,excerpt,date_gmt,modified_gmt,status'});
        if(!Array.isArray(result.value)||result.value.length>50)throw failure('INVALID_RESPONSE');
        const courseItems=[],posts=new Map();
        function original(value){const url=new URL(value);if(url.origin!==new URL(course.url).origin||!url.pathname.startsWith(new URL(course.url).pathname)||url.username||url.password||url.search||url.hash&&!/^#comment-[1-9]\d*$/.test(url.hash)||/%(?:2f|5c|00|2e)/i.test(url.pathname)||/\\|[\x00-\x20]/.test(decodeURIComponent(url.pathname))||/\/(?:wp-admin|wp-json|wp-login\.php)(?:\/|$)/.test(url.pathname))throw failure('INVALID_RESPONSE');return url.href;}
        for(const post of result.value){
          if(!positive(post.id)||post.status!=='publish')throw failure('INVALID_RESPONSE');
          if(post.content?.protected)continue;
          const title=clean(post.title?.rendered).slice(0,200)||'Spaces-Beitrag',content=clean(post.content?.rendered),url=original(post.link);
          posts.set(post.id,{title,url});
          courseItems.push({id:'spaces_'+accountID+'_post_'+post.id,revision:hash([post.modified_gmt,post.title?.rendered,post.content?.rendered]),source:'spaces',title,summary:course.name,content,contentStatus:typeof post.content?.rendered==='string'&&post.content.rendered.length<=20000?'full':'excerpt',url,groupUrl:course.url,createdAt:date(post.date_gmt),updatedAt:date(post.modified_gmt),courseId:course.id,groupId:course.id,groupName:course.name,scopeUrl:course.url,kind:'post',mode:'api'});
        }
        let partial=Number(result.headers.get('x-wp-totalpages')||1)>1,commentError=false;
        if(posts.size&&getMethods(index.routes?.['/wp/v2/comments']).includes('GET')){
          try{
            const comments=await api('wp/v2/comments',{context:'view',post:[...posts.keys()].join(','),per_page:50,orderby:'date',order:'desc',_fields:'id,post,link,content,date_gmt,author_name,status'});
            if(!Array.isArray(comments.value)||comments.value.length>50)throw failure('INVALID_RESPONSE');
            partial ||= Number(comments.headers.get('x-wp-totalpages')||1)>1;
            for(const comment of comments.value){
              if(!positive(comment.id)||!posts.has(comment.post)||comment.status&&comment.status!=='approved')continue;
              const post=posts.get(comment.post),content=clean(comment.content?.rendered);
              courseItems.push({id:'spaces_'+accountID+'_comment_'+comment.id,revision:hash([comment.content?.rendered]),source:'spaces',title:'Kommentar · '+post.title.slice(0,180),summary:(clean(comment.author_name).slice(0,160)||'Kommentar')+' · '+course.name,content,contentStatus:'excerpt',url:original(comment.link||post.url+'#comment-'+comment.id),groupUrl:course.url,createdAt:date(comment.date_gmt),courseId:course.id,groupId:course.id,groupName:course.name,scopeUrl:course.url,kind:'comment',mode:'api'});
            }
          }catch(error){if(error.status===401||error.status===403||error.code==='LOGIN_REQUIRED')throw error;commentError=true;warnings.push(course.name+': Kommentare konnten nicht aktualisiert werden.');courseItems.push(...previous.filter(item=>item.scopeUrl===course.url&&item.kind==='comment').map(item=>({...item,stale:true})));}
        }
        items.push(...courseItems);scopes.push({url:course.url,status:'connected',complete:!partial&&!commentError});
        if(partial)warnings.push(course.name+': Die neuesten 50 Beiträge und 50 Kommentare sind enthalten.');
      }catch(error){
        const login=error.status===401||error.status===403||error.code==='LOGIN_REQUIRED';
        scopes.push({url:course.url,status:login?'login_required':'error',complete:false});
        warnings.push(course.name+(login?': Anmeldung oder Kurszugriff erforderlich.':error.code==='UNVERIFIED_SPACES_API'?': WordPress-Schnittstelle nicht erkannt.':': Abruf fehlgeschlagen.'));
        if(!login)items.push(...previous.filter(item=>item.scopeUrl===course.url).map(item=>({...item,stale:true})));
      }
    }}));
    const connected=scopes.some(scope=>scope.status==='connected'),login=scopes.every(scope=>scope.status==='login_required');
    return {items,status:connected?'connected':login?'login_required':'error',complete:scopes.every(scope=>scope.complete),warnings,scopes,message:connected?'Beiträge und Kommentare aus '+scopes.filter(scope=>scope.status==='connected').length+' Kursen synchronisiert.':'Kursquellen konnten nicht aktualisiert werden.'};
  }
  const sessionFetcher=(url,options={})=>providerSession.fetch(url,{...options,headers:Object.fromEntries(Object.entries(options.headers||{}).filter(([key])=>!['authorization','private-token'].includes(key.toLowerCase()))),credentials:'include',redirect:'error'});
  const whatsapp=createWhatsAppNotifications({getContext:getWhatsAppContext,getSelection:getWhatsAppSelection,now,onAccountChange:source=>{feed.invalidate(source);emit({source});}});
  const adapters=[{source:'spaces',read:spaces},{source:'gitlab',scope:()=>[],read:async({signal})=>({items:await gitlabNotifications('',(url,options)=>sessionFetcher(url,{...options,signal:AbortSignal.any([options.signal,signal].filter(Boolean))})),complete:false,message:'Offene GitLab-To-dos über deine Browser-Anmeldung.'})},{source:'mattermost',scope:()=>[],read:({signal})=>mattermostNotifications('',sessionFetcher,{now,signal})},{source:'sciebo',scope:()=>[],read:({signal})=>scieboNotifications({read:request,signal})},{source:'miro',scope:()=>getMiroBoards(),read:async({scope,signal,previous})=>miroNotifications({nango,scope,signal,previous,snapshots:getMiroSnapshots(await cookieAccount('miro'))})},{source:'whatsapp',...whatsapp},{source:'signal',scope:()=>[],account:async()=>hash('signal-external-app'),read:async()=>({items:[],status:'unsupported',complete:false,message:'Signal ist als externe App erreichbar. Eine Benachrichtigungs-Schnittstelle ist in Context noch nicht verbunden.'})}].map(adapter=>({...adapter,account:adapter.account||(()=>account(adapter.source))}));
  const feed=createPlatformFeed({adapters:adapters.map(adapter=>({...adapter,read:options=>adapter.read({...options,signal:AbortSignal.any([options.signal,AbortSignal.timeout(20000)])})})),now});
  return {async handle(message){
    if(disposed||!message||message.action!=='sync'||Object.keys(message).some(key=>!['action','courses','manual'].includes(key))||typeof message.manual!=='boolean')throw failure('INVALID_REQUEST');
    const value=await feed.read({scope:notificationScopes(message.courses),manual:message.manual});return {...value,...boundNotificationFeed(value.items,value.sources)};
  },cancel(){feed.invalidate();},changed(source){if(!disposed&&(hosts[source]||source==='whatsapp'))feed.invalidate(source);},invalidate(source){if(disposed||!hosts[source])return;void account(source).catch(()=>{});},dispose(){disposed=true;feed.dispose();whatsapp.dispose();identities.clear();}};
}
