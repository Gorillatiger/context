import {SERVICE_ORIGINS} from './notifications.mjs';

// Read-only Mattermost (chat.coco.study) for the assistant: the person's teams and channels,
// message search and the latest posts of one channel. Search is a POST by Mattermost's API
// design; nothing is written, no read state changes. Fixed host, bounded sizes, untrusted text.
export const MATTERMOST_LIMITS=Object.freeze({teams:5,channels:40,results:15,posts:25,message:700,users:10,bytes:900000,timeoutMs:15000});
const ORIGIN=SERVICE_ORIGINS.mattermost,L=MATTERMOST_LIMITS;
export class MattermostReadError extends Error{constructor(status,code,message){super(message);this.name='MattermostReadError';this.status=status;this.code=code;}}
const fail=(status,code,message)=>new MattermostReadError(status,code,message);
const text=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max):'';
const ID=/^[a-z0-9]{26}$/;
const date=ms=>Number.isSafeInteger(ms)&&ms>0?new Date(ms).toISOString():'';

async function call(path,{fetcher,token,signal,body}){
  const headers={Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'}:{})};
  let response;
  try{response=await fetcher(ORIGIN+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),credentials:'omit',redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(L.timeoutMs),...(signal?[signal]:[])])});}
  catch{throw fail(502,'unreachable','Mattermost ist gerade nicht erreichbar.');}
  if(response.status===401||response.status===403)throw fail(401,'login_required','Mattermost hat die Anmeldung abgelehnt. Melde dich im Context-Browser bei chat.coco.study neu an oder verbinde Mattermost unter Mitteilungen → Quellen & Status.');
  if(response.status===404)throw fail(404,'not_found','Nicht gefunden oder kein Zugriff.');
  if(!response.ok)throw fail(502,'provider_error','Mattermost konnte nicht gelesen werden.');
  const reader=response.body?.getReader(),chunks=[];let size=0;
  if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>L.bytes){await reader.cancel().catch(()=>{});throw fail(502,'too_large','Die Mattermost-Antwort ist zu groß.');}chunks.push(Buffer.from(value));}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(502,'invalid_response','Mattermost hat keine gültige Antwort geliefert.');}
}
const teamsOf=async ctx=>{const list=await call('/api/v4/users/me/teams',ctx);if(!Array.isArray(list))throw fail(502,'invalid_response','Mattermost hat keine gültige Antwort geliefert.');return list.filter(t=>ID.test(t?.id||'')).slice(0,L.teams);};
// Post lists come as {order,posts}; channel and author names are looked up once per id.
async function describe(result,ctx,teamName,limit=L.results){
  if(!result||!Array.isArray(result.order)||!result.posts||typeof result.posts!=='object')throw fail(502,'invalid_response','Mattermost hat keine gültige Antwort geliefert.');
  const posts=result.order.map(id=>result.posts[id]).filter(p=>p&&ID.test(p.id||'')&&typeof p.message==='string'&&!String(p.type||'').startsWith('system_')).slice(0,limit);
  const channels=new Map(),users=new Map();
  for(const id of [...new Set(posts.map(p=>p.channel_id))].filter(id=>ID.test(id||'')).slice(0,8)){try{const c=await call('/api/v4/channels/'+id,ctx);channels.set(id,text(c?.display_name||c?.name,120));}catch{}}
  const ids=[...new Set(posts.map(p=>p.user_id))].filter(id=>ID.test(id||'')).slice(0,L.users);
  if(ids.length){try{const list=await call('/api/v4/users/ids',{...ctx,body:ids});if(Array.isArray(list))for(const u of list)if(ID.test(u?.id||''))users.set(u.id,text([u.first_name,u.last_name].filter(Boolean).join(' ')||u.username,80));}catch{}}
  return posts.map(p=>({id:p.id,channel:channels.get(p.channel_id)||'',channelId:p.channel_id,author:users.get(p.user_id)||'',date:date(p.create_at),message:text(p.message,L.message),truncated:p.message.length>L.message,url:teamName?`${ORIGIN}/${encodeURIComponent(teamName)}/pl/${p.id}`:ORIGIN}));
}

/** One read operation: teams, search, channel. */
export async function mattermostRead(op,args={},{fetcher=fetch,token='',signal}={}){
  const ctx={fetcher,token,signal};
  if(op==='teams'){
    const teams=await teamsOf(ctx),out=[];
    for(const team of teams){
      const channels=await call(`/api/v4/users/me/teams/${team.id}/channels`,ctx);
      out.push({id:team.id,name:text(team.display_name||team.name,120),channels:(Array.isArray(channels)?channels:[]).filter(c=>ID.test(c?.id||'')&&['O','P'].includes(c.type)).slice(0,L.channels).map(c=>({id:c.id,name:text(c.display_name||c.name,120),purpose:text(c.purpose,160),lastPost:date(c.last_post_at)}))});
    }
    return {teams:out};
  }
  if(op==='search'){
    const query=typeof args.query==='string'?args.query.trim():'';if(query.length<2||query.length>120)throw fail(400,'invalid_request','Suchbegriff fehlt.');
    if(args.teamId!==undefined&&!ID.test(String(args.teamId)))throw fail(400,'invalid_request','Ungültiges Team.');
    const teams=(await teamsOf(ctx)).filter(t=>args.teamId===undefined||t.id===args.teamId),results=[];
    for(const team of teams){
      const found=await call(`/api/v4/teams/${team.id}/posts/search`,{...ctx,body:{terms:query,is_or_search:false,include_deleted_channels:false,page:0,per_page:L.results}});
      results.push(...(await describe(found,ctx,team.name)).map(p=>({...p,team:text(team.display_name||team.name,120)})));
      if(results.length>=L.results)break;
    }
    results.sort((a,b)=>b.date.localeCompare(a.date));
    return {query,results:results.slice(0,L.results)};
  }
  if(op==='channel'){
    const id=String(args.channelId||'');if(!ID.test(id))throw fail(400,'invalid_request','Ungültiger Kanal.');
    const channel=await call('/api/v4/channels/'+id,ctx),team=ID.test(channel?.team_id||'')?await call('/api/v4/teams/'+channel.team_id,ctx).catch(()=>null):null;
    const posts=await describe(await call(`/api/v4/channels/${id}/posts?per_page=${L.posts}`,ctx),ctx,team?.name,L.posts);
    return {channel:text(channel?.display_name||channel?.name,120),posts};
  }
  throw fail(400,'invalid_request','Unbekannter Vorgang.');
}
