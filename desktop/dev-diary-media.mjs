import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {inspectDiaryImage,diaryImageBytes,diaryMediaIds,validateDiaryAttachment,DIARY_MEDIA_PER_RUN} from '../dist/dev-diary-media.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const idRE=/^[a-f0-9]{64}$/;
const MAX_LOCAL=100*1024*1024;
export function createDiaryMedia({directory,fs}){
 const base=path.join(directory,'media'),journal=path.join(base,'index.json');let data={version:1,assets:{},uploads:{}},loaded=false;
 const scope=(courseURL,runId)=>hash(JSON.stringify([courseURL,runId]));
 const key=(courseURL,runId,id)=>scope(courseURL,runId)+'-'+id;
 const file=k=>path.join(base,k+'.image');
 function validate(value){
  if(!value||value.version!==1||!value.assets||typeof value.assets!=='object'||Array.isArray(value.assets)||!value.uploads||typeof value.uploads!=='object'||Array.isArray(value.uploads)||Object.keys(value).some(k=>!['version','assets','uploads'].includes(k))||Object.keys(value.assets).length>500||Object.keys(value.uploads).length>1000)throw new Error();
  let total=0;
  for(const [k,v]of Object.entries(value.assets)){if(!/^[a-f0-9]{64}-[a-f0-9]{64}$/.test(k)||!v||Object.keys(v).some(n=>!['id','name','mime','size','caption'].includes(n))||!k.endsWith('-'+v.id))throw new Error();validateDiaryAttachment(v);total+=v.size;}
  if(total>MAX_LOCAL)throw new Error();
  for(const [k,v]of Object.entries(value.uploads)){if(!idRE.test(k)||!v||!['pending','confirmed'].includes(v.state)||Object.keys(v).some(n=>!['state','id','url'].includes(n))||v.state==='pending'&&Object.keys(v).length!==1||v.state==='confirmed'&&(!Number.isSafeInteger(v.id)||v.id<=0||!mediaURL(v.url)))throw new Error();}
  return value;
 }
 async function ensureBase(){try{const stat=await fs.lstat(base);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error();}catch(e){if(e.code!=='ENOENT')throw fail('DIARY_MEDIA_STORAGE','Der lokale Bildordner ist nicht sicher verfügbar.');await fs.mkdir(base,{recursive:true,mode:0o700});}}
 async function load(){if(loaded)return;await ensureBase();try{const stat=await fs.lstat(journal);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1_000_000)throw new Error();data=validate(JSON.parse(await fs.readFile(journal,'utf8')));}catch(e){if(e.code!=='ENOENT')throw fail('DIARY_MEDIA_STORAGE','Der lokale Bildspeicher konnte nicht sicher gelesen werden.');}loaded=true;}
 async function save(next){validate(next);await ensureBase();const tmp=path.join(base,randomUUID()+'.tmp');try{await fs.writeFile(tmp,JSON.stringify(next),{flag:'wx',mode:0o600});await fs.rename(tmp,journal);data=next;}finally{await fs.unlink(tmp).catch(()=>{});}}
 async function read(courseURL,runId,id){
  await load();if(!idRE.test(id))throw fail('BAD_DIARY_MEDIA','Ungültiger Bildanhang.');const k=key(courseURL,runId,id),meta=data.assets[k];if(!meta)throw fail('DIARY_MEDIA_MISSING','Das Bild ist auf diesem Gerät nicht vorhanden. Füge es erneut hinzu.');
  const stat=await fs.lstat(file(k));if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==meta.size)throw fail('DIARY_MEDIA_STORAGE','Die gespeicherte Bilddatei ist ungültig.');
  const bytes=await fs.readFile(file(k));if(hash(bytes)!==id||inspectDiaryImage(bytes).mime!==meta.mime)throw fail('DIARY_MEDIA_STORAGE','Die gespeicherte Bilddatei ist beschädigt.');return {asset:meta,bytes:new Uint8Array(bytes)};
 }
 async function stage(courseURL,runId,name,value){
  await load();const bytes=diaryImageBytes(value),info=inspectDiaryImage(bytes),id=hash(bytes),k=key(courseURL,runId,id);
  name=typeof name==='string'?name.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g,'').slice(0,120).trim():'';
  const meta={id,name:name||'Diary-Bild',mime:info.mime,size:info.size,caption:''};
  if(data.assets[k]){try{return (await read(courseURL,runId,id)).asset;}catch{const tmp=path.join(base,randomUUID()+'.tmp');try{await fs.writeFile(tmp,bytes,{flag:'wx',mode:0o600});await fs.rename(tmp,file(k));return data.assets[k];}finally{await fs.unlink(tmp).catch(()=>{});}}}
  if(Object.keys(data.assets).length>=500||Object.values(data.assets).reduce((n,a)=>n+a.size,0)+info.size>MAX_LOCAL)throw fail('DIARY_MEDIA_FULL','Der lokale Bildspeicher ist voll (100 MiB).');
  await ensureBase();const tmp=path.join(base,randomUUID()+'.tmp');try{await fs.writeFile(tmp,bytes,{flag:'wx',mode:0o600});await fs.rename(tmp,file(k));try{await save({...data,assets:{...data.assets,[k]:meta}});}catch(e){await fs.unlink(file(k)).catch(()=>{});throw e;}}finally{await fs.unlink(tmp).catch(()=>{});}return meta;
 }
 function mediaURL(value){try{const u=new URL(value);return u.origin==='https://spaces.th-koeln.de'&&!u.username&&!u.password&&!u.search&&!u.hash&&/\/uploads\//.test(u.pathname)?u.href:'';}catch{return '';}}
 function checked(raw,ctx,slug,mime){
  if(!raw||!Number.isSafeInteger(raw.id)||raw.id<=0||raw.type!=='attachment'||raw.author!==ctx.authorId||raw.slug!==slug||raw.mime_type!==mime||!mediaURL(raw.source_url))throw fail('DIARY_MEDIA_IDENTITY','Spaces hat das eigene Bild nicht eindeutig bestätigt.');return {state:'confirmed',id:raw.id,url:mediaURL(raw.source_url)};
 }
 async function resolve(message,ctx,api,{allowUpload=false}={}){
  const ids=diaryMediaIds(message.content),output=new Map();if(!ids.length)return output;await load();
  if(ids.length>DIARY_MEDIA_PER_RUN)throw fail('BAD_DIARY_MEDIA','Zu viele Bilder im Beitrag.');
  if(!ctx.routes.media||ctx.canUpload!==true)throw fail('DIARY_MEDIA_PERMISSION','Dieser Kurs erlaubt deinem Konto keine Bild-Uploads über die Schnittstelle. Der Entwurf bleibt lokal.');
  for(const id of ids){
   const uploadKey=hash(JSON.stringify([message.courseURL,message.runId,ctx.authorId,id])),slug='context-diary-image-'+uploadKey.slice(0,40),record=data.uploads[uploadKey];
   const local=data.assets[key(message.courseURL,message.runId,id)];if(!local)throw fail('DIARY_MEDIA_MISSING','Ein Bild fehlt auf diesem Gerät. Füge es erneut hinzu.');
   const params={slug,author:ctx.authorId,context:'edit',per_page:100,_fields:'id,type,author,slug,mime_type,source_url'};
   const response=await api(ctx,ctx.routes.media,params);if(!Array.isArray(response.value)||Number(response.headers?.get('x-wp-totalpages')||1)>1||response.value.length>1)throw fail('DIARY_MEDIA_IDENTITY','Die vorhandenen Bilder konnten nicht eindeutig abgeglichen werden.');
   let confirmed=response.value.length?checked(response.value[0],ctx,slug,local.mime):null;
   if(confirmed&&record?.state==='confirmed'&&(confirmed.id!==record.id||confirmed.url!==record.url))throw fail('DIARY_MEDIA_IDENTITY','Das verknüpfte Bild hat sich auf Spaces geändert.');
   if(!confirmed){
    if(record)throw fail('DIARY_MEDIA_OUTCOME_UNKNOWN','Ein früherer Bild-Upload ist noch unklar oder wurde entfernt. Es wird keine zweite Kopie hochgeladen. Prüfe Spaces.');
    if(!allowUpload)throw fail('DIARY_MEDIA_NOT_UPLOADED','Bilder werden mit „Auf Spaces speichern“ übertragen.');
    const selected=await read(message.courseURL,message.runId,id);await save({...data,uploads:{...data.uploads,[uploadKey]:{state:'pending'}}});
    const extension={'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp'}[local.mime];
    try{const uploaded=await api(ctx,ctx.routes.media,{slug,title:slug,alt_text:local.name},{method:'POST',rawBody:selected.bytes,contentType:local.mime,filename:slug+'.'+extension});confirmed=checked(uploaded.value,ctx,slug,local.mime);}catch{throw fail('DIARY_MEDIA_OUTCOME_UNKNOWN','Spaces hat den Bild-Upload nicht eindeutig bestätigt. Beim nächsten Speichern wird er zuerst abgeglichen, statt doppelt hochgeladen.');}
   }
   await save({...data,uploads:{...data.uploads,[uploadKey]:confirmed}});output.set(id,confirmed.url);
  }
  return output;
 }
 return {stage,read,resolve};
}
