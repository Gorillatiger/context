import {readFile} from 'node:fs/promises';
const hosts={spaces:'spaces.th-koeln.de',mattermost:'chat.coco.study',gitlab:'git.coco.study',webmail:'webmail.th-koeln.de'};
const text=(value,max=500)=>{if(typeof value!=='string'||value.length>max)throw new Error('Invalid snapshot text');return value;};
const identifier=value=>{if(typeof value!=='string'||!/^[-a-zA-Z0-9_]{1,150}$/.test(value))throw new Error('Invalid snapshot ID');return value;};
const date=value=>{if(typeof value!=='string'||Number.isNaN(Date.parse(value)))throw new Error('Invalid snapshot date');return value;};
const link=(value,source)=>{const u=new URL(value);if(u.protocol!=='https:'||u.hostname!==hosts[source]||u.port||u.username||u.password||/…|%e2%80%a6/i.test(u.href))throw new Error('Invalid snapshot URL');return u.href;};
export function validateSnapshot(raw){
  if(!raw||raw.version!==1||!Array.isArray(raw.items)||raw.items.length>2000||!Array.isArray(raw.sources)||raw.sources.length>4)throw new Error('Invalid snapshot');
  const capturedAt=date(raw.capturedAt);
  const courses=(raw.courses||[]).map(c=>{
    if(!Array.isArray(c.links||[])||(c.links||[]).length>20)throw new Error('Invalid course links');
    const links=(c.links||[]).map(l=>{if(!['spaces','gitlab','mattermost'].includes(l.tool))throw new Error('Invalid course tool');return {id:identifier(l.id),title:text(l.title,200),tool:l.tool,url:link(l.url,l.tool)};});
    return {id:identifier(c.id),name:text(c.name,200),url:link(c.url,'spaces'),links};
  });
  if(courses.length>300||new Set(courses.map(c=>c.id)).size!==courses.length)throw new Error('Invalid courses');
  const sources=raw.sources.map(s=>{if(!hosts[s.source]||!['snapshot','login_required','not_configured'].includes(s.status))throw new Error('Invalid source');return {source:s.source,status:s.status,capturedAt:date(s.capturedAt||capturedAt),message:text(s.message||'',300),complete:s.complete===true};});
  if(new Set(sources.map(s=>s.source)).size!==sources.length)throw new Error('Duplicate source');
  const items=raw.items.map(n=>{if(!hosts[n.source]||!sources.some(s=>s.source===n.source&&s.status==='snapshot'))throw new Error('Invalid notification source');return {id:identifier(n.id),source:n.source,title:text(n.title,200),summary:text(n.summary||''),content:text(n.content||'',20000),contentStatus:['full','excerpt','headers','summary','unavailable'].includes(n.contentStatus)?n.contentStatus:'unavailable',groupId:n.groupId?identifier(n.groupId):'',groupName:text(n.groupName||'',200),url:link(n.url,n.source),createdAt:date(n.createdAt),revision:text(n.revision||'1',100),courseId:n.courseId?identifier(n.courseId):'',displayedTime:text(n.displayedTime||'',100),capturedAt:date(n.capturedAt||sources.find(s=>s.source===n.source).capturedAt),mode:'snapshot'};});
  if(new Set(items.map(n=>n.id)).size!==items.length)throw new Error('Duplicate notification');
  return {items,sources,courses,capturedAt};
}
export async function readSnapshot(path){
  const bytes=await readFile(path);if(bytes.length>1500000)throw new Error('Snapshot too large');
  return validateSnapshot(JSON.parse(bytes.toString('utf8')));
}
export async function withSnapshot(feed,path){
  if(!path)return {...feed,courses:[]};
  try{
    const snapshot=await readSnapshot(path);
    const live=new Set(feed.sources.filter(s=>s.status==='connected').map(s=>s.source));
    return {...feed,courses:snapshot.courses,items:[...feed.items,...snapshot.items.filter(n=>!live.has(n.source))],sources:[...feed.sources.filter(s=>!snapshot.sources.some(p=>p.source===s.source)||live.has(s.source)),...snapshot.sources.filter(s=>!live.has(s.source))]};
  }catch(error){return {...feed,courses:[],sources:[...feed.sources,{source:'spaces',status:error.code==='ENOENT'?'not_configured':'error',message:error.code==='ENOENT'?'Kein lokaler Browser-Stand vorhanden.':'Lokaler Browser-Stand konnte nicht gelesen werden.'}]};}
}
