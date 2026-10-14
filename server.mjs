import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { collectNotifications } from './connectors/notifications.mjs';
import {withSnapshot} from './connectors/snapshot.mjs';
import {createKIClient,KIError} from './connectors/ki.mjs';
import {createMailClient,MailError} from './connectors/mail.mjs';
import {ServiceTokenError} from './connectors/service-tokens.mjs';

const root = resolve(import.meta.dirname, 'dist');
const snapshotPath=process.env.CONTEXT_SNAPSHOT_PATH||resolve(import.meta.dirname,'../../work/private/notifications.json');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const defaultKI=createKIClient();
const defaultOpenRouter=createKIClient({provider:'openrouter'});
const defaultMail=createMailClient();
const apiHeaders={'Content-Type':'application/json','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
const json=(res,status,value)=>{res.writeHead(status,apiHeaders);res.end(JSON.stringify(value));};
function aiErrorBody(error){
  const known=error instanceof KIError&&typeof error.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code);
  const code=known?error.code:'unavailable',limited=known&&error.status===429&&['local_limit','provider_limit'].includes(code);
  return {error:code,code,message:limited?'Das KI-Anfragelimit ist erreicht. Bitte kurz warten.':known?error.message:'Die KI-Verbindung ist gerade nicht verfügbar.',
    ...(limited&&typeof error.retryAfterMs==='number'&&Number.isFinite(error.retryAfterMs)&&error.retryAfterMs>=0?
      {retryAfterMs:Math.ceil(Math.max(1000,Math.min(60000,error.retryAfterMs)))}:{})};
}
async function chatBody(req,limit=512000){
  const declared=Number(req.headers['content-length']||0);
  if(!Number.isSafeInteger(declared)||declared<0||declared>limit)throw new KIError(413,'body_limit','Die Anfrage ist zu groß.');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw new KIError(413,'body_limit','Die Anfrage ist zu groß.');chunks.push(Buffer.from(chunk));}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new KIError(400,'invalid_json','Die Anfrage enthält kein gültiges JSON.');}
}
const cookieValid=(header,name,sessionToken)=>{
  const prefix=name+'=';
  const match=String(header||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(prefix));
  const value=match?.slice(prefix.length)||'';
  return /^[0-9a-f]{64}$/.test(value)&&timingSafeEqual(Buffer.from(value),Buffer.from(sessionToken));
};
export function validHost(host,port) { return host===`127.0.0.1:${port}`||host===`localhost:${port}`; }
export function createRequestHandler(portProvider, collect=undefined,ki=defaultKI,mail=defaultMail,openrouter=defaultOpenRouter,{now=Date.now,spaces=null,services=null}={}) {
const sessionToken=randomBytes(32).toString('hex');
// GitLab/Mattermost tokens saved in the app (services) take effect for the next collection.
const collectFeed=collect||(async()=>withSnapshot(await collectNotifications({...process.env,...(services?await services.overrides():{})},{mailClient:defaultMail}),snapshotPath));
let cachedFeed,cachedAt=0,pendingFeed,feedRevision=0;
async function collectCurrentFeed(){
  // Reconfiguration can finish while a previous account read is pending.
  // Discard that result entirely and collect only the current account state.
  for(let attempt=0;attempt<3;attempt++){
    const revision=feedRevision,feed=await collectFeed();
    if(revision!==feedRevision)continue;
    cachedFeed=feed;cachedAt=now();return feed;
  }
  throw new Error('Feed configuration changed repeatedly');
}
const downloads=new Map();
const download=(res,file,head=false)=>{res.writeHead(200,{...apiHeaders,'Content-Type':'application/octet-stream','Content-Length':file.bytes.length,'Content-Disposition':"attachment; filename=attachment; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())});res.end(head?undefined:file.bytes);};
return async (req, res) => {
  try {
    const port=portProvider();
    const cookieName='context_session_'+port;
    if(!validHost(req.headers.host,port)){res.writeHead(403);return res.end('Host rejected');}
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const mailActions=['connection','folders','list','message','attachment','attachment-link','flag','send'];
    if(!['GET','HEAD'].includes(req.method)&&!(req.method==='POST'&&(['/api/ai/chat','/api/ai/connection','/api/ai/forget','/api/spaces/search','/api/spaces/read','/api/services/configure','/api/services/forget'].includes(pathname)||mailActions.some(action=>pathname==='/api/mail/'+action)))){res.writeHead(405,{Allow:'GET, HEAD'});return res.end();}
    if(pathname.startsWith('/api/')){
      if(!cookieValid(req.headers.cookie,cookieName,sessionToken)||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(req.headers.origin))return json(res,403,{error:'session_expired',message:'Die lokale Sitzung ist nicht mehr gültig. Sichere offene Entwürfe und lade den Arbeitsbereich neu.'});
      if(pathname.startsWith('/api/spaces/')){
        if(pathname==='/api/spaces/status'&&req.method==='GET')return json(res,200,{configured:!!spaces,scope:'published'});
        if(req.method!=='POST'||!['/api/spaces/search','/api/spaces/read'].includes(pathname))return json(res,405,{error:'invalid_method',message:'Nur lesende Spaces-Suchaufträge sind verfügbar.'});
        if(req.headers['x-context-request']!=='spaces-search'||!req.headers['content-type']?.toLowerCase().startsWith('application/json')||new URL(req.url,'http://localhost').search)return json(res,400,{error:'invalid_request',message:'Ungültiger Spaces-Suchauftrag.'});
        if(!spaces)return json(res,503,{error:'spaces_not_connected',message:'Spaces-Direktsuche benötigt die aktuelle Context-App oder eine autorisierte WordPress-Verbindung im Web-Backend. Browser-Cookies werden nicht übernommen.'});
        const controller=new AbortController(),cancel=()=>controller.abort();req.on('aborted',cancel);res.on('close',()=>{if(!res.writableEnded)cancel();});
        try{const body=await chatBody(req,4096);if(body.op!==pathname.slice('/api/spaces/'.length))return json(res,400,{error:'invalid_request',message:'Ungültiger Spaces-Suchauftrag.'});const result=await spaces.handle(body,{signal:controller.signal});if(!controller.signal.aborted)return json(res,200,result);}
        catch(error){if(controller.signal.aborted)return;return json(res,400,{error:'spaces_search_failed',message:'Die Spaces-Anfrage konnte nicht abgeschlossen werden. Prüfe Anmeldung und Kurszugriff.'});}
        finally{req.off('aborted',cancel);}return;
      }
      if(pathname.startsWith('/api/mail/')){
        try{
          if(pathname.startsWith('/api/mail/download/')){
            const token=pathname.slice('/api/mail/download/'.length),file=downloads.get(token);
            if(!/^[0-9a-f]{64}$/.test(token)||!file||file.expires<=Date.now()){downloads.delete(token);return json(res,404,{error:'expired_download',message:'Der Anhang-Link ist abgelaufen. Bereite den Anhang erneut vor.'});}
            if(req.method==='GET')downloads.delete(token);
            return download(res,file,req.method==='HEAD');
          }
          if(pathname==='/api/mail/status'&&req.method!=='POST')return json(res,200,mail.status());
          const action=pathname.slice('/api/mail/'.length);
          if(!mailActions.includes(action)){res.writeHead(404);return res.end();}
          if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});return res.end();}
          if(req.headers.origin!=='http://'+req.headers.host||req.headers['x-context-request']!=='mail-request'){res.writeHead(403);return res.end('Unauthorized');}
          if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')return json(res,415,{error:'invalid_content_type',message:'Die Mail-Anfrage benötigt application/json.'});
          const body=await chatBody(req,action==='send'?12*1024*1024:10000);
          const method=action==='connection'?'configure':action==='attachment-link'?'attachment':action;
          const result=await mail[method](body);
          if(['connection','flag','send'].includes(action)){cachedFeed=null;cachedAt=0;feedRevision++;}
          if(action==='connection')downloads.clear();
          if(action==='attachment'||action==='attachment-link'){
            if(typeof result.data!=='string'||result.data.length>11200000||typeof result.name!=='string')throw new MailError('connection_failed');
            const data=Buffer.from(result.data,'base64');
            if(data.length>8*1024*1024)throw new MailError('attachment_too_large');
            if(action==='attachment-link'){
              for(const [token,file] of downloads)if(file.expires<=Date.now())downloads.delete(token);
              if(downloads.size>=4)downloads.delete(downloads.keys().next().value);
              const token=randomBytes(32).toString('hex'),file={name:result.name,bytes:data,expires:Date.now()+60000};downloads.set(token,file);
              setTimeout(()=>downloads.delete(token),60000).unref();
              return json(res,200,{name:result.name,url:'/api/mail/download/'+token,expiresIn:60});
            }
            return download(res,{name:result.name,bytes:data});
          }
          return json(res,200,result);
        }catch(error){if(!res.destroyed)return json(res,error instanceof MailError||error instanceof KIError?error.status:502,{error:error instanceof MailError||error instanceof KIError?error.code:'connection_failed',message:error instanceof MailError||error instanceof KIError?error.message:'Die Mail-Verbindung ist gerade nicht verfügbar.'});return;}
      }
      if(pathname.startsWith('/api/services/')){
        // Access tokens for the read-only connectors; the token is only ever received, never returned.
        try{
          if(pathname==='/api/services/status'&&req.method==='GET')return json(res,200,services?{available:true,services:await services.status()}:{available:false,services:{}});
          if(!['/api/services/configure','/api/services/forget'].includes(pathname)||req.method!=='POST'){res.writeHead(405,{Allow:'GET, POST'});return res.end();}
          if(req.headers.origin!=='http://'+req.headers.host||req.headers['x-context-request']!=='service-token'){res.writeHead(403);return res.end('Unauthorized');}
          if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')return json(res,415,{error:'invalid_content_type',message:'Die Anfrage benötigt application/json.'});
          if(!services)return json(res,503,{error:'not_available',message:'Das Speichern von Zugangsdaten braucht die Context-Desktop-App.'});
          let body;try{body=await chatBody(req,4096);}catch{throw new ServiceTokenError(400,'invalid_request','Ungültige Anfrage.');}
          if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['service','token'].includes(key))||typeof body.service!=='string')throw new ServiceTokenError(400,'invalid_request','Ungültige Anfrage.');
          let result;
          if(pathname==='/api/services/configure')result=await services.configure(body.service,body.token);
          else{if(body.token!==undefined)throw new ServiceTokenError(400,'invalid_request','Ungültige Anfrage.');result=await services.forget(body.service);}
          cachedFeed=null;cachedAt=0;feedRevision++;
          return json(res,200,{service:body.service,...result});
        }catch(error){if(!res.destroyed)return error instanceof ServiceTokenError?json(res,error.status,{error:error.code,message:error.message}):json(res,500,{error:'service_failed',message:'Die Verbindung konnte nicht gespeichert werden.'});}
        return;
      }
      if(pathname.startsWith('/api/ai/')){
        try{
          const selectProvider=id=>{if(id===undefined||id==='kiconnect')return ki;if(id==='openrouter')return openrouter;throw new KIError(400,'invalid_provider','Unbekannter KI-Anbieter.');};
          const queryProvider=new URL(req.url,'http://localhost').searchParams.get('provider')||undefined;
          if(pathname==='/api/ai/status'&&req.method!=='POST')return json(res,200,await selectProvider(queryProvider).status());
          if(pathname==='/api/ai/models'&&req.method!=='POST')return json(res,200,await selectProvider(queryProvider).models());
          if(pathname==='/api/ai/usage'){
            if(req.method!=='GET'){res.writeHead(405,{Allow:'GET'});return res.end();}
            const params=new URL(req.url,'http://localhost').searchParams;
            if([...params.keys()].some(key=>key!=='provider')||params.getAll('provider').length>1||req.headers['transfer-encoding']||req.headers['content-length']&&req.headers['content-length']!=='0')throw new KIError(400,'invalid_request','Ungültige Limitabfrage.');
            const controller=new AbortController(),closed=()=>{if(!res.writableEnded)controller.abort();};res.once?.('close',closed);
            try{const value=await selectProvider(queryProvider).usage(controller.signal);if(!res.destroyed)return json(res,200,value);}
            finally{res.off?.('close',closed);}
            return;
          }
          if(['/api/ai/chat','/api/ai/connection','/api/ai/forget'].includes(pathname)){
            if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});return res.end();}
            if(req.headers.origin!=='http://'+req.headers.host||req.headers['x-context-request']!=='ki-request'){res.writeHead(403);return res.end('Unauthorized');}
            if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')return json(res,415,{error:'invalid_content_type',message:'Die KI-Anfrage benötigt application/json.'});
            const body=await chatBody(req);
            const client=selectProvider(body?.provider),input=body&&typeof body==='object'&&!Array.isArray(body)?Object.fromEntries(Object.entries(body).filter(([key])=>key!=='provider')):body;
            if(pathname==='/api/ai/connection')return json(res,200,await client.configure(input));
            if(pathname==='/api/ai/forget'){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new KIError(400,'invalid_request','Ungültige KI-Anfrage.');return json(res,200,await client.forget());}
            const controller=new AbortController();
            const closed=()=>{if(!res.writableEnded)controller.abort();};
            res.once?.('close',closed);
            try{const answer=await client.complete(input,controller.signal);if(!res.destroyed)return json(res,200,answer);}
            finally{res.off?.('close',closed);}
            return;
          }
          res.writeHead(404);return res.end();
        }catch(error){if(!res.destroyed)return json(res,error instanceof KIError?error.status:502,aiErrorBody(error));return;}
      }
      if(pathname!=='/api/notifications'){res.writeHead(404);return res.end();}
      const manualRefresh=new URL(req.url,'http://localhost').searchParams.get('refresh')==='1';
      if(!cachedFeed||now()-cachedAt>=(manualRefresh?10000:60000)){
        if(!pendingFeed)pendingFeed=collectCurrentFeed().finally(()=>pendingFeed=null);
        await pendingFeed;
      }
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});
      return res.end(JSON.stringify(cachedFeed));
    }
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(pathname==='/'||pathname==='/index.html'?{'Set-Cookie':`${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"}:{}) });
    res.end(body);
  } catch { res.writeHead(404); res.end('Nicht gefunden'); }
};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
const server=createServer(createRequestHandler(()=>server.address().port));
server.listen(Number(process.env.PORT || 4318), '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + server.address().port));

}
