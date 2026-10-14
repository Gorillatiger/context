import {notificationCourse,requireText,cleanText,safeURL} from './core.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function notificationGroup(item,state){
  if(item.groupId&&item.groupName)return {id:item.source+'_'+item.groupId,name:item.groupName};
  if(item.source==='webmail')return {id:'webmail_inbox',name:'Posteingang'};
  const course=item.source==='spaces'?(item.courseId||notificationCourse(item,state)):notificationCourse(item,state);
  const name=state.projects.find(p=>p.id===course)?.name;
  if(course&&name)return {id:item.source+'_'+course,name};
  if(item.source==='context')return {id:'context_personal',name:'Persönliche Aufgaben'};
  return {id:item.source+'_other',name:'Weitere Hinweise'};
}

export function notificationGroups(items,state){
  const groups=new Map();
  for(const item of items){const group=notificationGroup(item,state);const existing=groups.get(group.id);if(existing)existing.count++;else groups.set(group.id,{...group,source:item.source,count:1});}
  return [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name,'de'));
}

export function resolveNotificationGroup(selected,groups){
  return selected==='all'||groups.some(group=>group.id===selected)?selected:'all';
}

const knownDate=value=>typeof value==='string'&&value&&!Number.isNaN(Date.parse(value));
export function parseNotificationItems(items){
  if(!Array.isArray(items)||items.length>2200)throw new Error('invalid_feed');
  return items.map(item=>{
    if(!item||!['spaces','mattermost','gitlab','webmail'].includes(item.source)||typeof item.id!=='string'||!/^[-a-zA-Z0-9_]{1,150}$/.test(item.id)||typeof item.createdAt!=='string'||item.createdAt&&!knownDate(item.createdAt))throw new Error('invalid_feed');
    const url=safeURL(item.url),groupUrl=item.groupUrl?safeURL(item.groupUrl):'';
    return {...item,title:requireText(item.title),summary:cleanText(item.summary||'',500),content:cleanText(item.content||'',20000),groupName:cleanText(item.groupName||'',200),url,groupUrl:groupUrl&&new URL(groupUrl).origin===new URL(url).origin?groupUrl:'',revision:cleanText(item.revision||'1',100),displayedTime:cleanText(item.displayedTime||'',100),observedAt:knownDate(item.observedAt)?item.observedAt:'',checkedAt:knownDate(item.checkedAt)?item.checkedAt:'',capturedAt:knownDate(item.capturedAt)?item.capturedAt:''};
  });
}

const timeOf=item=>item.kind==='summary'?(item.observedAt||item.checkedAt||item.capturedAt||item.createdAt):item.createdAt;
export function compareNotificationTime(a,b){
  const left=knownDate(timeOf(a))?Date.parse(timeOf(a)):null,right=knownDate(timeOf(b))?Date.parse(timeOf(b)):null;
  return left===null?(right===null?0:1):right===null?-1:right-left;
}

export function notificationTime(item,now=Date.now()){
  if(typeof item.displayedTime==='string'&&item.displayedTime)return item.displayedTime;
  const value=timeOf(item),summary=item.kind==='summary';
  if(!knownDate(value))return summary?'Stand unbekannt':'Zeitpunkt unbekannt';
  const age=Math.floor((now-Date.parse(value))/60000);
  const label=age<0?'am '+formatSnapshotTime(value):age<1?'gerade eben':age<60?`vor ${age} Min.`:age<1440?`vor ${Math.floor(age/60)} Std.`:formatSnapshotTime(value);
  return summary?'Stand: '+label:label;
}

export function previewContent(item){
  const content=typeof item.content==='string'&&item.content.length<=20000?item.content:'';
  const full=content&&item.contentStatus==='full';
  const label=full?'Vollständiger Text':content?'Textauszug':item.source==='webmail'?'Nur Kopfzeilen':item.kind==='summary'?'Zusammenfassung':'Nachrichtentext noch nicht eingelesen';
  return {text:content,label,full:!!full,html:content?`<div class="message-text">${escape(content)}</div>`:''};
}

export function formatSnapshotTime(value){
  const date=new Date(value);
  if(!value||Number.isNaN(date.getTime()))return 'Zeitpunkt unbekannt';
  return new Intl.DateTimeFormat('de-DE',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Berlin'}).format(date);
}
