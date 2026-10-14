import {createHash} from 'node:crypto';
import {MiroError,miroPlainText,safeMiroBoard} from './miro.mjs';

// Visitor access: a public board link without Miro account, OAuth or REST API.
// Miro's accessible board overview (#a11y-dom-*) is a read-only DOM layer for
// screen readers. It is not an official API and may change; every value read
// from it is untrusted board text, never markup or instructions.
// https://help.miro.com/hc/en-us/articles/4403828752274
// https://developers.miro.com/docs/oembed-live-embed
export const MIRO_VISITOR_LIMITS=Object.freeze({nodes:4000,label:400,text:2000,depth:10,characters:1200000,items:2000,itemText:12000,documentText:12500,oembedBytes:65536,oembedTimeout:8000});
export const MIRO_VISITOR_GENERATION=createHash('sha256').update('context-miro-visitor-overview:v1').digest('hex');
const L=MIRO_VISITOR_LIMITS;
const hash=value=>createHash('sha256').update(value).digest('hex');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,status)=>new MiroError(code,status);
// Inert plain text: textContent is already text. Only controls and runs of
// whitespace are normalized; angle brackets stay visible characters.
const clean=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,'').replace(/[ \t\u00a0]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{2,}/g,'\n').trim().slice(0,max):'';
const LABEL=/^([\s\S]*), ([^,\n]{1,80}), (\d{1,6}) (?:von|of) (\d{1,6})$/;
const FRAME=/^(?:rahmen|frame)$/i,GROUP=/^(?:auswahlgruppe|selection group)$/i,IMAGE=/^(?:bild|image)$/i;
const LINE=/(?:line|linie|connector|verbinder|pfeil|arrow)/i,LINE_NAME=/^(?:verbindungslinie|verbinder|linie|connector(?: line)?|connection line|line|arrow|pfeil)$/i;
const EMPTY=/^(?:\(?(?:leer|empty)\)?|\d{1,6} (?:elemente?|items?) (?:ausgewählt|selected))$/i;

/** Runs in an isolated world on a miro.com board page. Opens the overview once and returns bounded rows. */
export function miroOverviewScript(){
  return `(()=>{
  const host=location.hostname;if(location.protocol!=='https:'||host!=='miro.com'&&host!=='www.miro.com')return {state:'login'};
  if(!/^\\/app\\/board\\/[^/]+\\/?$/.test(location.pathname))return {state:/\\/(?:login|signup|sso|auth)\\b/.test(location.pathname)?'login':'no_access'};
  const explore=document.getElementById('a11y-dom-explore');
  if(!explore){const ask=[...document.querySelectorAll('button,[role=button]')].slice(0,400).some(el=>/^(?:Zugriff anfragen|Zugriff anfordern|Request access)$/i.test((el.textContent||'').trim()));return {state:ask?'no_access':'loading'};}
  if(explore.getAttribute('aria-expanded')!=='true'){explore.click();return {state:'loading'};}
  const contents=document.getElementById('a11y-dom-contents');if(!contents)return {state:'loading'};
  const nodes=[];let truncated=false,characters=0,visited=0;
  const textOf=element=>{const parts=[];let size=0;const visit=node=>{for(const child of node.childNodes){if(size>${L.text})return;if(child.nodeType===3){parts.push(child.nodeValue);size+=child.nodeValue.length;}else if(child.nodeType===1){if(child.tagName==='BR'){parts.push('\\n');continue;}const block=/^(?:P|DIV|LI|H[1-6]|TR|UL|OL|BLOCKQUOTE)$/.test(child.tagName);if(block)parts.push('\\n');visit(child);if(block)parts.push('\\n');}}};visit(element);return parts.join('');};
  const walk=(element,parent,depth)=>{for(const child of element.children){
    if(++visited>${L.nodes*20}||nodes.length>=${L.nodes}||characters>${L.characters}){truncated=true;return;}
    const id=/^a11y-dom-(\\d{1,40})$/.exec(child.id||'')?.[1],role=child.getAttribute('role');
    if(id&&(role==='region'||role==='button')){
      const label=(child.getAttribute('aria-label')||'').slice(0,${L.label}),heading=role==='region'?document.getElementById(child.id+'-heading'):null,raw=role==='button'?textOf(child):heading?textOf(heading):'';
      if(raw.length>${L.text})truncated=true;const text=raw.slice(0,${L.text}),index=nodes.length;characters+=label.length+text.length;nodes.push({id,role,parent,label,text});
      if(role==='region'){if(depth<${L.depth})walk(child,index,depth+1);else truncated=true;}
    }else if(!id&&depth<${L.depth})walk(child,parent,depth+1);
  }};
  walk(contents,-1,0);
  return {state:'ready',title:document.title.slice(0,300),nodes,truncated};
})()`;
}

function validSnapshot(value){
  if(!object(value)||Object.keys(value).some(key=>!['state','title','nodes','truncated'].includes(key))||value.state!=='ready'||typeof value.title!=='string'||value.title.length>300||typeof value.truncated!=='boolean'||!Array.isArray(value.nodes)||value.nodes.length>L.nodes)throw fail('invalid_response',502);
  const ids=new Set();
  value.nodes.forEach((node,index)=>{
    if(!object(node)||Object.keys(node).some(key=>!['id','role','parent','label','text'].includes(key))||typeof node.id!=='string'||!/^\d{1,40}$/.test(node.id)||ids.has(node.id)||!['region','button'].includes(node.role)||!Number.isSafeInteger(node.parent)||node.parent<-1||node.parent>=index||node.parent>=0&&value.nodes[node.parent].role!=='region'||typeof node.label!=='string'||node.label.length>L.label||typeof node.text!=='string'||node.text.length>L.text)throw fail('invalid_response',502);
    ids.add(node.id);
  });
  return value;
}
const parseLabel=label=>{const match=LABEL.exec(label);return match?{name:match[1],type:match[2].trim()}:{name:label,type:''};};
export const miroOverviewRevision=snapshot=>hash(JSON.stringify(validSnapshot(snapshot).nodes));

/** Converts a validated overview snapshot into the client.board() result shape. */
export function parseMiroOverview(snapshot,{url,meta={},now=()=>new Date().toISOString(),generation=MIRO_VISITOR_GENERATION}={}){
  const target=safeMiroBoard(url),value=validSnapshot(snapshot);
  const rows=value.nodes.map(node=>{const {name,type}=parseLabel(node.label),kind=node.role==='region'?(FRAME.test(type)?'frame':'group'):IMAGE.test(type)?'image':LINE.test(type)?'line':'element';return {...node,kind,text:clean(node.text||name,L.itemText)};});
  const frameOf=index=>{for(let at=rows[index].parent;at>=0;at=rows[at].parent)if(rows[at].kind==='frame')return at;return -1;};
  const topOf=index=>{let at=index;while(rows[at].parent>=0)at=rows[at].parent;return at;};
  const containers=new Map(),container=index=>{if(!containers.has(index))containers.set(index,{index,lines:[],images:0,characters:0,truncated:false});return containers.get(index);};
  let truncated=value.truncated,images=0,characters=0;
  rows.forEach((row,index)=>{
    if(row.kind==='frame'){container(index);return;}
    if(row.kind==='group'||!row.text||EMPTY.test(row.text)||row.kind==='line'&&LINE_NAME.test(row.text))return;
    const frame=frameOf(index),box=container(frame>=0?frame:topOf(index)),line=row.kind==='image'?'[Bild: '+row.text.slice(0,240)+']':row.text;
    if(row.kind==='image'){box.images++;images++;}
    if(characters+line.length>1000000||box.characters+line.length>L.itemText){truncated=true;box.truncated=true;return;}
    characters+=line.length;box.characters+=line.length+1;box.lines.push(line);
  });
  const boardTitle=miroPlainText(meta.title,240)||clean(value.title.replace(/\s+-\s+Miro$/,''),240)||'Miro-Board';
  const board={...target,title:boardTitle,description:'',createdBy:{id:'',name:miroPlainText(meta.author,200)},createdAt:'',modifiedBy:{id:'',name:''},modifiedAt:''};
  const items=[],byIndex=new Map();
  // Frames (usually the slides) first in board order, then loose groups/elements.
  const rank=box=>rows[box.index].kind==='frame'?0:1;
  for(const box of [...containers.values()].sort((a,b)=>rank(a)-rank(b)||a.index-b.index)){
    const row=rows[box.index],frame=row.kind==='frame',title=frame?row.text.slice(0,240):'';
    if(!box.lines.length&&!title)continue;
    if(items.length===L.items){truncated=true;break;}
    const parent=frame?frameOf(box.index):-1,item={id:row.id,type:frame?'frame':'visitor_group',title,text:(frame?[title,...box.lines]:box.lines).filter(Boolean).join('\n').slice(0,L.itemText),url:'',createdBy:{id:'',name:''},createdAt:'',modifiedBy:{id:'',name:''},modifiedAt:'',parentId:parent>=0?rows[parent].id:'',contentReadable:box.images===0||box.lines.length>box.images,truncated:box.truncated};
    const link=new URL(target.url);link.searchParams.set('moveToWidget',row.id);item.url=link.href;
    items.push(item);byIndex.set(row.id,{item,images:box.images});
  }
  const documents=items.map(item=>{
    const parent=item.parentId?byIndex.get(item.parentId)?.item:null,images=byIndex.get(item.id).images;
    const body=[`Board: ${board.title}`,parent?.title?`Bereich: ${parent.title}`:'',item.text].filter(Boolean).join('\n');
    return {id:'miro:'+hash(target.id+'\0'+item.id),kind:'miro',title:item.title||clean(item.text.split('\n')[0],140)||'Miro-Bereich',text:body.slice(0,L.documentText),url:item.url,source:'Miro',status:item.truncated||images||body.length>L.documentText?'excerpt':'full',updatedAt:'',boardId:target.id,itemId:item.id};
  });
  const warnings=['Gelesen über Miros öffentliche Board-Übersicht für Screenreader (Besucherzugriff, keine offizielle Schnittstelle). Reihenfolge und Umfang können von der Board-Ansicht abweichen.'];
  if(images)warnings.push(`${images} Bilder wurden nicht ausgelesen; bekannt sind nur ihre Dateinamen.`);
  if(truncated)warnings.push('Das Board erreicht eine lokale Lesegrenze. Die gespeicherten Inhalte sind unvollständig.');
  return {board,items,documents,coverage:{complete:!truncated&&!images,pages:1,items:items.length,readableItems:items.filter(item=>item.contentReadable&&item.text).length,unsupportedItems:images,truncated,basis:'visitor-overview'},warnings,fetchedAt:now(),generation,overviewRevision:hash(JSON.stringify(value.nodes))};
}

async function boundedText(response,max){
  const declared=Number(response.headers?.get?.('content-length')||0);if(declared>max)throw fail('invalid_response',502);
  if(!response.body?.getReader){const text=await response.text();if(Buffer.byteLength(text)>max)throw fail('invalid_response',502);return text;}
  const reader=response.body.getReader(),chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel().catch(()=>{});throw fail('invalid_response',502);}chunks.push(Buffer.from(value));}
  return Buffer.concat(chunks).toString('utf8');
}
/** Public board metadata (title, owner) from Miro's documented oEmbed endpoint. No cookies, no redirects. */
export async function fetchMiroOEmbed(value,{fetch=globalThis.fetch,signal,timeoutMs=L.oembedTimeout}={}){
  const {url}=safeMiroBoard(value);if(typeof fetch!=='function')throw fail('provider_error',502);
  const controller=new AbortController(),relay=()=>controller.abort(),timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();
  if(signal?.aborted)controller.abort();signal?.addEventListener('abort',relay,{once:true});
  try{
    const response=await fetch('https://miro.com/api/v1/oembed?format=json&url='+encodeURIComponent(url),{method:'GET',redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',headers:{accept:'application/json'},signal:controller.signal});
    if([401,403,404].includes(response.status))return {url,title:'',author:'',available:false};
    if(!response.ok||!/^application\/json\b/i.test(response.headers?.get?.('content-type')||''))throw fail('provider_error',502);
    let data;try{data=JSON.parse(await boundedText(response,L.oembedBytes));}catch(error){throw error instanceof MiroError?error:fail('invalid_response',502);}
    if(!object(data)||data.type!==undefined&&data.type!=='rich'||data.provider_name!==undefined&&data.provider_name!=='Miro')throw fail('invalid_response',502);
    const author=typeof data.author==='string'?data.author:data.author_name;
    return {url,title:miroPlainText(data.title,240),author:miroPlainText(author,200),available:true};
  }catch(error){if(signal?.aborted)throw fail('cancelled',499);throw error instanceof MiroError?error:fail('provider_error',502);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',relay);}
}

/** Extracts a board invitation from a raw link. Returns null for ordinary board links. */
export function miroShareLink(value){
  if(typeof value!=='string'||value.length>2048)return null;
  try{const raw=value.replace(/&amp;/g,'&'),share=new URL(raw).searchParams.get('share_link_id')||'';if(!/^[A-Za-z0-9_-]{4,80}$/.test(share))return null;const {id,url}=safeMiroBoard(raw);return {id,url,share};}catch{return null;}
}
export function miroOpenURL(value,share=''){
  const {url}=safeMiroBoard(value);if(!share)return url;
  if(typeof share!=='string'||!/^[A-Za-z0-9_-]{4,80}$/.test(share))throw fail('invalid_request');
  const link=new URL(url);link.searchParams.set('share_link_id',share);return link.href;
}
