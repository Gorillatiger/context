import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {fileURLToPath} from 'node:url';
import { safeURL } from '../dist/core.js';

const execFileAsync=promisify(execFile);
const GITLAB='https://git.coco.study';
const MATTERMOST='https://chat.coco.study';
export const SERVICE_ORIGINS=Object.freeze({gitlab:GITLAB,mattermost:MATTERMOST});
const stableAccount=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,12);
const text=(value,max=200)=>typeof value==='string'?value.slice(0,max):'';
const id=value=>(typeof value==='string'||typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)&&/^[a-zA-Z0-9_-]{1,80}$/.test(String(value))?String(value):null;
const timestamp=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,7})?)?(?:Z|[+-]\d\d:\d\d))?$/.test(value)||!Number.isFinite(Date.parse(value)))return '';
  const day=new Date(value.slice(0,10)+'T00:00:00Z');if(!Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==value.slice(0,10))return '';
  return new Date(value).toISOString();
};
const milliseconds=value=>Number.isSafeInteger(value)&&value>0&&Number.isFinite(new Date(value).getTime())?new Date(value).toISOString():'';
const MATTERMOST_LIMITS=Object.freeze({teams:5,channels:20,previewChannels:10,postsPerChannel:10,posts:100,requests:40,concurrency:3,timeoutMs:20000});
export function providerURL(value,origin,fallback=origin) {
  try{const url=new URL(safeURL(value));return url.origin===origin?url.href:fallback;}catch{return fallback;}
}
export async function readJSON(url,headers,fetcher=fetch,{signal}={}) {
  if(signal?.aborted)throw new Error('Provider request cancelled');
  const active=AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])]);
  const response=await fetcher(url,{method:'GET',headers,credentials:'omit',redirect:'error',signal:active});
  if(!response.ok){void response.body?.cancel().catch(()=>{});const error=new Error('Provider request failed');error.status=response.status;throw error;}
  if(!response.headers.get('content-type')?.includes('json')){void response.body?.cancel().catch(()=>{});throw new Error('Provider did not return JSON');}
  const reader=response.body.getReader();let length=0;const chunks=[];
  const abort=()=>{void reader.cancel().catch(()=>{});};active.addEventListener('abort',abort,{once:true});
  try{while(true){if(active.aborted)throw new Error('Provider request cancelled');const {done,value}=await reader.read();if(active.aborted)throw new Error('Provider request cancelled');if(done)break;length+=value.byteLength;if(length>1500000)throw new Error('Provider response too large');chunks.push(Buffer.from(value));}}
  catch(error){void reader.cancel().catch(()=>{});throw error;}
  finally{active.removeEventListener('abort',abort);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function gitlabNotifications(token,fetcher=fetch) {
  const headers={'PRIVATE-TOKEN':token,Accept:'application/json'};
  const [user,todos]=await Promise.all([readJSON(GITLAB+'/api/v4/user',headers,fetcher),readJSON(GITLAB+'/api/v4/todos?state=pending&per_page=50',headers,fetcher)]);
  if(!Array.isArray(todos)||!id(user.id))throw new Error('Invalid GitLab response');
  return todos.slice(0,50).filter(t=>id(t.id)).map(t=>({id:'gitlab_'+stableAccount(user.id)+'_'+t.id,revision:text(t.updated_at,80)||'1',source:'gitlab',title:text(t.target?.title||t.body)||'GitLab To-do',summary:text(t.project?.path_with_namespace||'Erwähnung oder zugewiesene Aufgabe'),content:text(t.body,20000),contentStatus:'excerpt',groupId:id(t.project?.id)?'project_'+t.project.id:'',groupName:text(t.project?.path_with_namespace),url:providerURL(t.target_url,GITLAB),createdAt:timestamp(t.created_at)}));
}
export async function mattermostNotifications(token,fetcher=fetch,{now=Date.now,signal}={}) {
  // Official GET-only routes: mattermost/mattermost api/v4/source/{channels,posts}.yaml.
  // posts/unread supports limit_before=0, limit_after and skipFetchThreads.
  // No channel-view, read-state, search POST, user profiles, attachments or media.
  const checkedAt=new Date(now()).toISOString(),headers={Authorization:'Bearer '+token,Accept:'application/json'},limits=MATTERMOST_LIMITS;
  const active=AbortSignal.any([AbortSignal.timeout(limits.timeoutMs),...(signal?[signal]:[])]),warnings=new Set(),items=[],channels=[];
  let requests=0,truncated=false;
  const warn=message=>{truncated=true;warnings.add(message);};
  const read=async suffix=>{if(active.aborted||requests>=limits.requests)throw Object.assign(new Error('Mattermost read limit'),{code:'read_limit'});requests++;return readJSON(MATTERMOST+'/api/v4'+suffix,headers,fetcher,{signal:active});};
  const batch=async(values,fn)=>{
    const result=new Array(values.length);let cursor=0,stopped=false;
    await Promise.all(Array.from({length:Math.min(limits.concurrency,values.length)},async()=>{while(cursor<values.length&&!stopped){const index=cursor++;try{result[index]=await fn(values[index]);}catch(error){stopped=true;throw error;}}}));return result;
  };
  const user=await read('/users/me');if(!id(user?.id))throw new Error('Invalid Mattermost user');
  const account=stableAccount(user.id),userId=encodeURIComponent(user.id);
  const [teams,unreads]=await Promise.all([read('/users/me/teams'),read('/users/me/teams/unread')]);
  if(!Array.isArray(teams)||!Array.isArray(unreads)||teams.length>500||unreads.length>500)throw new Error('Invalid Mattermost teams');
  const unreadTeams=[...new Map(unreads.filter(row=>id(row?.team_id)&&Number.isSafeInteger(row.msg_count)&&row.msg_count>0&&teams.some(team=>team.id===row.team_id&&id(team.name))).map(row=>[row.team_id,row])).values()];
  const selectedTeams=unreadTeams.slice(0,limits.teams);
  if(unreadTeams.length>selectedTeams.length)warn('Weitere Teams mit ungelesenen Nachrichten wurden wegen des Abruflimits nicht geprüft.');
  const summary=(scope,count,reason)=>{
    const mentions=Number.isSafeInteger(count.mention_count)&&count.mention_count>=0?count.mention_count:0;
    return {id:'mattermost_'+account+'_summary_'+scope.groupId,revision:String(count.msg_count)+'_'+String(mentions),source:'mattermost',title:scope.title,
      summary:`${count.msg_count} ungelesene Nachrichten${mentions?` · ${mentions} Erwähnungen`:''} · ${reason}`,content:'',contentStatus:'summary',url:scope.url,
      createdAt:'',observedAt:checkedAt,timeKind:'observed',kind:'summary',groupId:scope.groupId,groupName:scope.title};
  };
  await batch(selectedTeams,async unread=>{
    const team=teams.find(team=>team.id===unread.team_id),teamName=id(team.name);
    try{
      const found=await read('/users/'+userId+'/teams/'+encodeURIComponent(team.id)+'/channels');
      if(!Array.isArray(found)||found.length>2000)throw new Error('Invalid Mattermost channels');
      for(const channel of found){
        if(!id(channel?.id)||!id(channel.name)||channel.team_id!==team.id||!['O','P'].includes(channel.type)||channel.delete_at>0)continue;
        channels.push({...channel,teamName,teamTitle:text(team.display_name)||teamName});
      }
    }catch(error){
      if(error.status===401)throw error;
      warn('Kanäle eines Teams konnten nicht vollständig gelesen werden.');
      items.push(summary({id:unread.team_id,title:text(team.display_name)||'Mattermost Team',url:MATTERMOST+'/'+teamName,groupId:'team_'+unread.team_id},unread,'Kanalabruf nicht verfügbar'));
    }
  });
  const unique=[...new Map(channels.map(channel=>[channel.id,channel])).values()].sort((a,b)=>(Number(b.last_post_at)||0)-(Number(a.last_post_at)||0));
  const inspected=unique.slice(0,limits.channels);if(unique.length>inspected.length)warn('Weitere Kanäle wurden wegen des Abruflimits nicht geprüft.');
  const unreadChannels=(await batch(inspected,async channel=>{
    try{
      const unread=await read('/users/'+userId+'/channels/'+encodeURIComponent(channel.id)+'/unread');
      if(unread?.channel_id!==channel.id||unread.team_id!==channel.team_id||!Number.isSafeInteger(unread.msg_count)||unread.msg_count<0||!Number.isSafeInteger(unread.mention_count)||unread.mention_count<0)throw new Error('Invalid Mattermost unread count');
      return unread.msg_count>0?{...channel,unread}:null;
    }catch(error){if(error.status===401)throw error;warn('Ungelesene Nachrichten einiger Kanäle konnten nicht geprüft werden.');return null;}
  })).filter(Boolean);
  const selectedPreviews=unreadChannels.slice(0,limits.previewChannels);
  for(const channel of unreadChannels.slice(limits.previewChannels)){
    warn('Weitere ungelesene Kanäle enthalten nur einen Zähler statt einer Nachrichtenvorschau.');
    items.push(summary({id:channel.id,title:text(channel.display_name)||channel.name,url:MATTERMOST+'/'+channel.teamName+'/channels/'+channel.name,groupId:'channel_'+channel.id},channel.unread,'Vorschau-Abruflimit'));
  }
  await batch(selectedPreviews,async channel=>{
    const url=MATTERMOST+'/'+channel.teamName+'/channels/'+channel.name,label=text(channel.display_name)||channel.name;
    try{
      const response=await read('/users/'+userId+'/channels/'+encodeURIComponent(channel.id)+'/posts/unread?limit_before=0&limit_after='+limits.postsPerChannel+'&skipFetchThreads=true');
      if(!Array.isArray(response?.order)||!response.posts||typeof response.posts!=='object'||Array.isArray(response.posts)||response.order.length>200||Object.keys(response.posts).length>500)throw new Error('Invalid Mattermost posts');
      if(response.order.length>limits.postsPerChannel||channel.unread.msg_count>limits.postsPerChannel||response.has_next===true||response.next_post_id)warn('Nicht alle ungelesenen Nachrichten eines Kanals sind in diesem Teilstand enthalten.');
      const seen=new Set();let displayed=0;
      for(const postId of response.order.slice(0,limits.postsPerChannel)){
        const post=response.posts[postId];if(!id(postId)||seen.has(postId)||!post||post.id!==postId||post.channel_id!==channel.id||post.delete_at>0||typeof post.type==='string'&&post.type.startsWith('system_')||typeof post.message!=='string'||!post.message.trim())continue;seen.add(postId);
        const content=text(post.message,20000),digest=createHash('sha256').update(post.message).digest('hex').slice(0,16);
        items.push({id:'mattermost_'+account+'_'+postId,revision:(milliseconds(post.update_at)||milliseconds(post.edit_at)||'unknown')+'_'+digest,source:'mattermost',
          title:text(content.replace(/[\r\n\t]+/g,' ').trim())||label,summary:channel.teamTitle+' · '+label,content,contentStatus:post.message.length>20000?'excerpt':'full',
          url:MATTERMOST+'/'+channel.teamName+'/pl/'+postId,groupUrl:url,createdAt:milliseconds(post.create_at),observedAt:checkedAt,groupId:'channel_'+channel.id,groupName:label,unreadCount:channel.unread.msg_count,mentionCount:channel.unread.mention_count});displayed++;
      }
      if(!displayed){warn('Für einen ungelesenen Kanal fehlt eine lesbare Nachrichtenvorschau.');items.push(summary({id:channel.id,title:label,url,groupId:'channel_'+channel.id},channel.unread,'Kein lesbarer Vorschautext'));}
    }catch(error){if(error.status===401)throw error;warn('Nachrichtenvorschauen einiger Kanäle konnten nicht geladen werden.');items.push(summary({id:channel.id,title:label,url,groupId:'channel_'+channel.id},channel.unread,'Vorschau nicht verfügbar'));}
  });
  return {items,checkedAt,complete:false,truncated,limits:{...limits},warnings:[...warnings],
    message:'Teilstand: bis zu 5 Teams und 20 geprüfte Kanäle; bis zu 10 Kanäle mit je 10 Textvorschauen (max. 100). Direktnachrichten, Anhänge und Medien werden nicht eingelesen.'+(warnings.size?' Einige Hinweise fehlen oder enthalten nur Zähler.':'')};
}
export async function mailNotifications(user,password,runner=execFileAsync) {
  const {stdout}=await runner('python3',[fileURLToPath(new URL('./mail-reader.py',import.meta.url)).replace(/app\.asar\//,'app.asar.unpacked/')],{
    env:{PATH:process.env.PATH,TH_MAIL_USER:user,TH_MAIL_PASSWORD:password},timeout:20000,maxBuffer:250000,windowsHide:true
  });
  const result=JSON.parse(stdout);
  if(result.error)throw new Error('Mail connection failed');
  if(!Array.isArray(result.items)||result.items.length>50)throw new Error('Invalid mail result');
  return result.items.filter(t=>id(t.uid)).map(t=>({id:'webmail_'+stableAccount(user)+'_'+text(String(result.uidValidity),30)+'_'+t.uid,revision:'1',source:'webmail',title:text(t.subject)||'(Kein Betreff)',summary:text(t.sender),url:'https://webmail.th-koeln.de/',createdAt:timestamp(t.date),relatedTool:text(t.subject).includes('[THspaces]')?'spaces':''}));
}
export async function collectNotifications(env=process.env,deps={}) {
  const configured=[
    {source:'gitlab',enabled:!!env.GITLAB_TOKEN,read:()=>gitlabNotifications(env.GITLAB_TOKEN,deps.fetcher)},
    {source:'mattermost',enabled:!!env.MATTERMOST_TOKEN,read:()=>mattermostNotifications(env.MATTERMOST_TOKEN,deps.fetcher)},
    {source:'webmail',enabled:deps.mailClient?deps.mailClient.status().configured:!!env.TH_MAIL_USER&&!!env.TH_MAIL_PASSWORD,read:()=>deps.mailClient?deps.mailClient.notifications():mailNotifications(env.TH_MAIL_USER,env.TH_MAIL_PASSWORD,deps.mailRunner)}
  ];
  const results=await Promise.all(configured.map(async p=>{
    if(!p.enabled)return {source:p.source,status:'not_configured',items:[],message:'Verbindung noch nicht eingerichtet.'};
    try{const result=await p.read();return {source:p.source,status:'connected',...(Array.isArray(result)?{items:result,checkedAt:new Date().toISOString()}:result)};}
    catch(error){return {source:p.source,status:'error',items:[],message:error.status===401||error.status===403?'Zugriff abgelehnt. Verbindung prüfen.':error.status===429?'Anbieter-Limit erreicht. Später erneut versuchen.':'Abruf fehlgeschlagen. Verbindung prüfen.'};}
  }));
  return {sources:results.map(({items,...rest})=>rest),items:results.flatMap(r=>r.items),checkedAt:new Date().toISOString()};
}
