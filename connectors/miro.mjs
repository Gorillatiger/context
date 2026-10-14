import {createHash} from 'node:crypto';
import {miroBoardURL} from '../dist/board-index.js';

// OAuth and token renewal remain entirely inside Nango/native main process.
// Board text is untrusted evidence, never executable code or agent instructions.
// https://developers.miro.com/reference/get-specific-board-1
// https://developers.miro.com/reference/get-items-1 (limit 10..50, cursor)
const LIMITS = Object.freeze({items:2000,pages:40,page:50,text:1000000,itemText:12000,response:4000000});
const messages = {
  invalid_request:'Ungültige Miro-Anfrage.',not_connected:'Verbinde Miro, um Board-Inhalte lesen zu können.',
  permission_denied:'Diese Miro-Verbindung darf Boards nicht lesen.',invalid_response:'Miro hat keine gültigen Board-Daten geliefert.',
  connection_changed:'Die Miro-Verbindung wurde während des Lesens geändert. Bitte erneut versuchen.',
  cancelled:'Das Lesen des Miro-Boards wurde abgebrochen.',provider_error:'Das Miro-Board konnte nicht gelesen werden.',
  scope_changed:'Die Kurszuordnung wurde während des Lesens geändert. Bitte erneut versuchen.',
  board_not_allowed:'Dieses Board ist keinem freigegebenen Kurs zugeordnet.',closed:'Der Miro-Dienst wurde geschlossen.',
  busy:'Es wird bereits ein Miro-Board gelesen.',
};
export class MiroError extends Error {
  constructor(code,status=400) { super(messages[code] || messages.provider_error);this.name='MiroError';this.code=Object.hasOwn(messages,code)?code:'provider_error';this.status=status; }
}
const fail=(code,status)=>new MiroError(code,status);
const hash=value=>createHash('sha256').update(value).digest('hex');
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_=-]{1,128}$/.test(value)?value:'';
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const check=signal=>{if(signal?.aborted)throw fail('cancelled',499);};
const date=value=>{if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))return '';const day=new Date(value.slice(0,10)+'T12:00:00Z');return Number.isFinite(day.getTime())&&day.toISOString().slice(0,10)===value.slice(0,10)?new Date(value).toISOString():'';};
const entity={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…',auml:'ä',ouml:'ö',uuml:'ü',Auml:'Ä',Ouml:'Ö',Uuml:'Ü',szlig:'ß'};
function decode(value) {
  return value.replace(/&(?:#(?:x([a-f0-9]+)|(\d+))|([a-z]+));/gi,(all,hex,number,name)=>{
    if (name) return entity[name] ?? all;
    const code=Number.parseInt(hex || number,hex?16:10);
    return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'';
  });
}
export function miroPlainText(value,max=LIMITS.itemText) {
  if(typeof value!=='string')return '';
  // A linear, bounded tokenizer. An unterminated hidden tag cannot make its
  // script body visible, and repeated unmatched tags cannot cause regex O(n²).
  const input=value.slice(0,100000),parts=[],hidden=new Set(['script','style','head','iframe','object','svg','template','noscript']),blocks=new Set(['p','div','br','li','tr','h1','h2','h3','h4','h5','h6','blockquote','hr','table']),blocked=new Map();let cursor=0,count=0;
  while(cursor<input.length){
    const start=input.indexOf('<',cursor);
    if(start<0){if(!count)parts.push(input.slice(cursor));break;}
    if(!count)parts.push(input.slice(cursor,start));
    if(!/[a-zA-Z!/?]/.test(input[start+1]||'')){if(!count)parts.push('<');cursor=start+1;continue;}
    if(input.startsWith('<!--',start)){const end=input.indexOf('-->',start+4);cursor=end<0?input.length:end+3;continue;}
    let end=start+1,quote='';for(;end<input.length&&end-start<=4096;end++){const char=input[end];if(quote){if(char===quote)quote='';}else if(char==='"'||char==="'")quote=char;else if(char==='>')break;}
    if(input[end]!=='>')break;
    const raw=input.slice(start+1,end),tag=/^\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i.exec(raw);cursor=end+1;if(!tag)continue;
    const name=tag[2].toLowerCase();if(hidden.has(name)){const previous=blocked.get(name)||0;if(tag[1]){if(previous){blocked.set(name,previous-1);count--;}}else if(!/\/\s*$/.test(raw)){blocked.set(name,previous+1);count++;}}
    if(!count&&blocks.has(name))parts.push('\n');
  }
  return decode(parts.join(''))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim().slice(0,max);
}
function structuredText(value) {
  const result=[];let nodes=0,characters=0,truncated=false;
  const visit=(node,depth)=>{
    if(++nodes>2000||depth>8||characters>LIMITS.itemText){truncated=true;return;}
    if(typeof node==='string'){const text=miroPlainText(node,100000);if(text){result.push(text);characters+=text.length;}if(node.length>100000)truncated=true;return;}
    if(Array.isArray(node)){if(node.length>500)truncated=true;for(const child of node.slice(0,500))visit(child,depth+1);return;}
    if(object(node))for(const key of ['title','text','content','description','children','blocks','paragraphs','sections','body'])if(Object.hasOwn(node,key))visit(node[key],depth+1);
  };
  visit(value,0);const combined=result.join('\n');return {text:combined.slice(0,LIMITS.itemText),truncated:truncated||combined.length>LIMITS.itemText};
}
function author(value) {return {id:id(value?.id),name:miroPlainText(value?.name,200)};}
function identity(status) {return {integrationId:status.integrationId,connectionId:status.connectionId,revision:status.revision,capabilities:{boardRead:status.capabilities?.boardRead===true}};}
const signature=status=>hash(JSON.stringify(identity(status)));
function connected(status) {
  if(status?.connected!==true||typeof status.integrationId!=='string'||!status.integrationId||typeof status.connectionId!=='string'||!status.connectionId||typeof status.revision!=='string'||!/^(?:0|[1-9]\d{0,15}):(?:0|[1-9]\d{0,15})$/.test(status.revision))throw fail('not_connected',409);
  if(status.capabilities?.boardRead!==true)throw fail('permission_denied',403);
  return status;
}
export function safeMiroBoard(value) {
  if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f\\]/.test(value)||!/^https:\/\/(?:www\.)?miro\.com\/app\/board\/[^/?#]+\/?(?:[?#].*)?$/.test(value))throw fail('invalid_request');
  let url;try{url=miroBoardURL(value);}catch{throw fail('invalid_request');}
  return {url,id:new URL(url).pathname.split('/')[3]};
}
function normalizeItem(raw,board) {
  if(!object(raw)||!id(raw.id)||typeof raw.type!=='string'||!/^[a-z_]{1,60}$/.test(raw.type))throw fail('invalid_response',502);
  const data=object(raw.data)?raw.data:{},title=miroPlainText(data.title,240);
  const readable=new Set(['sticky_note','text','shape','card','app_card','frame','doc_format','data_table_format']);
  const sourceText=readable.has(raw.type)?structuredText({title:data.title,content:data.content,description:data.description,body:data.body,children:data.children,blocks:data.blocks,sections:data.sections}):{text:title,truncated:false};
  const structuredDocument=['doc_format','data_table_format'].includes(raw.type),semanticText=structuredDocument?structuredText({content:data.content,body:data.body,children:data.children,blocks:data.blocks,sections:data.sections}):null;
  // A truthy structured payload is not proof that its actual text was exposed
  // or understood. Unknown doc/table shapes remain metadata-only coverage.
  const contentReadable=readable.has(raw.type)&&(!structuredDocument||!!semanticText?.text);
  const url=new URL(board.url);url.searchParams.set('moveToWidget',raw.id);
  return {id:raw.id,type:raw.type,title,text:sourceText.text,url:url.href,createdBy:author(raw.createdBy),createdAt:date(raw.createdAt),modifiedBy:author(raw.modifiedBy),modifiedAt:date(raw.modifiedAt),parentId:id(raw.parent?.id),contentReadable,truncated:sourceText.truncated};
}
function boundedResponse(result) {
  if(!object(result)||result.status!==200||!object(result.data))throw fail('invalid_response',502);
  let size;try{size=Buffer.byteLength(JSON.stringify(result.data));}catch{throw fail('invalid_response',502);}
  if(size>LIMITS.response)throw fail('invalid_response',502);
  return result.data;
}

export function createMiroBoardClient({nango,now=()=>new Date().toISOString()}={}) {
  if(typeof nango?.status!=='function'||typeof nango?.proxy!=='function')throw fail('invalid_request');
  async function status(signal) {
    check(signal);let result;try{result=await nango.status('miro');}catch(error){check(signal);throw fail(error?.code==='permission_denied'?'permission_denied':'not_connected',409);}check(signal);
    return {configured:!!result?.integrationId,connected:result?.connected===true,boardRead:result?.capabilities?.boardRead===true,backend:'nango',generation:result?.integrationId?signature(result):'',...(result?.error?{error:{code:'not_connected',message:messages.not_connected}}:{})};
  }
  async function board(input,signal) {
    if(!object(input)||Object.keys(input).some(key=>key!=='url'))throw fail('invalid_request');
    const target=safeMiroBoard(input.url);check(signal);let initial;
    try{initial=connected(await nango.status('miro'));}catch(error){check(signal);throw error instanceof MiroError?error:fail('not_connected',409);}check(signal);
    const providerIdentity=identity(initial),generation=signature(initial);
    const request=async(path,params={})=>{
      check(signal);let result;
      try{result=await nango.proxy('miro',{method:'GET',path,params,identity:providerIdentity},signal);}catch(error){check(signal);throw fail(['connection_mismatch','cancelled'].includes(error?.code)?'connection_changed':error?.code==='permission_denied'?'permission_denied':'provider_error',error?.status||502);}
      check(signal);return boundedResponse(result);
    };
    const base='/v2/boards/'+encodeURIComponent(target.id),raw=await request(base);
    if(raw.id!==target.id||typeof raw.name!=='string'||raw.name.length>100000)throw fail('invalid_response',502);
    const board={...target,title:miroPlainText(raw.name,240)||'Miro-Board',description:miroPlainText(raw.description,12000),createdBy:author(raw.createdBy),createdAt:date(raw.createdAt),modifiedBy:author(raw.modifiedBy),modifiedAt:date(raw.modifiedAt)};
    const items=[],seen=new Set(),cursors=new Set(),warnings=[];let cursor,pages=0,characters=board.description.length,truncated=false,collectionLimited=false;
    do {
      const page=await request(base+'/items',{limit:LIMITS.page,...(cursor?{cursor}: {})});pages++;
      if(!Array.isArray(page.data)||page.data.length>LIMITS.page||page.cursor!==undefined&&page.cursor!==null&&page.cursor!==''&&(typeof page.cursor!=='string'||page.cursor.length>2048||/[\x00-\x20\x7f]/.test(page.cursor)))throw fail('invalid_response',502);
      for(const row of page.data){const item=normalizeItem(row,board);if(seen.has(item.id))throw fail('invalid_response',502);seen.add(item.id);
        if(items.length===LIMITS.items||characters+item.text.length>LIMITS.text){truncated=true;collectionLimited=true;break;}characters+=item.text.length;items.push(item);if(item.truncated)truncated=true;
      }
      cursor=page.cursor||'';
      if(cursor){if(cursors.has(cursor)||!page.data.length)throw fail('invalid_response',502);cursors.add(cursor);}
      if(collectionLimited||cursor&&pages===LIMITS.pages){truncated=true;break;}
    }while(cursor);
    check(signal);let final;try{final=connected(await nango.status('miro'));}catch{throw fail('connection_changed',409);}check(signal);
    if(signature(final)!==generation)throw fail('connection_changed',409);
    const byId=new Map(items.map(item=>[item.id,item])),unsupported=items.filter(item=>!item.contentReadable).length;
    if(unsupported)warnings.push(`${unsupported} Elemente enthalten Inhalte, die diese Textanbindung nicht ausliest (z. B. Bilder, PDFs oder Einbettungen).`);
    if(truncated)warnings.push('Das Board erreicht eine lokale Lesegrenze. Die gespeicherten Inhalte sind unvollständig.');
    const documents=items.filter(item=>item.text).map(item=>{
      const parent=byId.get(item.parentId),body=[`Board: ${board.title}`,parent?.title?`Bereich: ${parent.title}`:'',item.createdBy.name?`Erstellt von: ${item.createdBy.name}`:'',item.createdAt?`Erstellt: ${item.createdAt}`:'',!item.contentReadable?'Nur Metadaten: Der eigentliche Inhalt dieses Elements wurde nicht ausgelesen.':'',item.text].filter(Boolean).join('\n');
      return {id:'miro:'+hash(board.id+'\0'+item.id),kind:'miro',title:(item.title||miroPlainText(item.text.split('\n')[0],140)||'Miro-Element'),text:body.slice(0,12500),url:item.url,source:'Miro',status:item.truncated||!item.contentReadable||body.length>12500?'excerpt':'full',updatedAt:item.modifiedAt||item.createdAt,boardId:board.id,itemId:item.id};
    });
    if(board.description)documents.unshift({id:'miro:'+hash(board.id+'\0description'),kind:'miro',title:board.title,text:board.description,url:board.url,source:'Miro',status:'full',updatedAt:board.modifiedAt||board.createdAt,boardId:board.id,itemId:''});
    return {board,items,documents,coverage:{complete:!truncated&&!unsupported,pages,items:items.length,readableItems:items.filter(item=>item.contentReadable&&item.text).length,unsupportedItems:unsupported,truncated,basis:'rest-api-text'},warnings,fetchedAt:now(),generation};
  }
  return {status,board};
}
