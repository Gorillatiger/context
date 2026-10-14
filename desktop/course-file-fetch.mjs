import {serviceFileURL} from './service-reader.mjs';

const textMimes=new Set(['text/plain','text/markdown','application/json']);
const types={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
const fail=(message,code='UNSUPPORTED_FILE')=>Object.assign(new Error(message),{code});
const abort=()=>new DOMException('Abgebrochen','AbortError');
const secretName=value=>/^\.env(?:[.-]|$)|^\.(?:ssh|aws|git)(?:[.-]|$)|(?:^|[._-])(?:secrets?|tokens?|credentials?|passwd|passwords?|api[_-]?keys?)(?:[._-]|$)/i.test(value);
function fileName(url,header,mime){
  const parsed=new URL(url),name=parsed.searchParams.get('files')||decodeURIComponent(parsed.pathname.split('/').at(-1)||'');
  let declared='';
  const encoded=/filename\*=UTF-8''([^;]+)/i.exec(header||''),quoted=/filename="([^"\r\n]+)"/i.exec(header||''),bare=/filename=([^;\r\n]+)/i.exec(header||'');
  try{declared=encoded?decodeURIComponent(encoded[1]):quoted?.[1]||bare?.[1]?.trim()||'';}catch{throw fail('Der angebotene Dateiname ist ungültig.');}
  if(declared&&(secretName(declared)||/[\/\\\x00-\x1f\x7f]/.test(declared)||! /\.(?:md|markdown|txt|json|pdf|docx|pptx|xlsx)$/i.test(declared)))throw fail('Der Dateiname ist nicht als Kursquelle freigegeben.');
  const known=/\.(?:md|markdown|txt|json|pdf|docx|pptx|xlsx)$/i.test(name),inferred=Object.entries(types).find(([,type])=>type===mime)?.[0];
  const value=known?name:declared||(inferred?'Kursdatei.'+inferred:textMimes.has(mime)?'Kursdatei.txt':'');
  if(!value||value.length>200||/[\/\\\x00-\x1f\x7f]/.test(value)||secretName(value)||!/\.(?:md|markdown|txt|json|pdf|docx|pptx|xlsx)$/i.test(value))throw fail('Der Dateityp oder Dateiname ist nicht als Kursquelle freigegeben.');
  return value;
}

/** Called only after a current offered-link lease. Bounded authenticated GET;
 * raw bytes stay in native memory and never pass through renderer IPC. */
export function createCourseFileFetch({session}={}){
  if(typeof session?.fetch!=='function')throw new Error('Dateiabruf benötigt die native Sitzung.');
  return async(url,{signal,maxBytes,service,scope}={})=>{
    if(signal?.aborted)throw abort();
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8*1024*1024)throw fail('Ungültige Dateigröße.','INVALID_REQUEST');
    const target=serviceFileURL(service,url,scope);
    // Electron documents Response.url as unreliable. Scope the requested URL
    // and prohibit redirects rather than trusting that response property.
    const response=await session.fetch(target,{method:'GET',redirect:'error',signal,credentials:'include'});
    const stop=async()=>{try{await response.body?.cancel();}catch{}};
    if(!response.ok||response.status>=300&&response.status<400){await stop();throw fail('Die Kursdatei ist nicht verfügbar.',response.status===401||response.status===403?'LOGIN_REQUIRED':'FILE_HTTP_ERROR');}
    const contentType=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    let name;try{name=fileName(target,response.headers.get('content-disposition'),contentType);}catch(reason){await stop();throw reason;}
    const format=/\.(pdf|docx|pptx|xlsx)$/i.exec(name)?.[1]?.toLowerCase()||'';
    const accepted=format?[types[format],'application/octet-stream',...(format==='pdf'?[]:['application/zip'])].includes(contentType):textMimes.has(contentType);
    const lengthHeader=response.headers.get('content-length');
    if(!accepted||lengthHeader!==null&&(!/^\d+$/.test(lengthHeader)||Number(lengthHeader)>maxBytes)){await stop();throw fail('Die Kursdatei hat kein unterstütztes Format oder ist zu groß.');}
    if(signal?.aborted){await stop();throw abort();}
    if(typeof response.body?.getReader!=='function'){await stop();throw fail('Die Datei kann nicht begrenzt eingelesen werden.');}
    const reader=response.body.getReader(),chunks=[];let size=0,rejectAbort;
    const cancelled=new Promise((_,reject)=>{rejectAbort=reject;});
    const onAbort=()=>{rejectAbort(abort());void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',onAbort,{once:true});
    try{
      if(signal?.aborted)throw abort();
      while(true){const item=await Promise.race([reader.read(),cancelled]);if(item.done)break;if(!(item.value instanceof Uint8Array))throw fail('Ungültige Kursdatei.');size+=item.value.byteLength;if(size>maxBytes)throw fail('Die Kursdatei ist zu groß.');chunks.push(item.value);}
      if(signal?.aborted)throw abort();
      if(lengthHeader!==null&&!response.headers.get('content-encoding')&&size!==Number(lengthHeader))throw fail('Die Kursdatei wurde nicht vollständig übertragen.','FILE_TRANSFER_INCOMPLETE');
      const bytes=Buffer.concat(chunks,size);if(!bytes.length)throw fail('Die Kursdatei ist leer.');
      return {url:target,fileName:name,contentType,...(format?{bytes}:{text:bytes.toString('utf8')})};
    }finally{signal?.removeEventListener('abort',onAbort);await reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
  };
}
