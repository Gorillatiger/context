import {randomUUID} from 'node:crypto';
import * as files from 'node:fs/promises';
import path from 'node:path';

const preferences=new Set(['system','light','dark']);
const backgrounds={light:'#fff7f8',dark:'#191417'};
const MAX_STORE_BYTES=512;
function failure(code,message){return Object.assign(new Error(message),{code});}
export function themePreference(value){
 if(typeof value!=='string'||!preferences.has(value))throw failure('BAD_THEME_PREFERENCE','Wähle System, Hell oder Dunkel.');
 return value;
}
export function parseThemeSnapshot(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>MAX_STORE_BYTES)throw failure('BAD_THEME_STORE','Ungültiger Darstellungsspeicher.');
 const data=JSON.parse(text);
 if(!data||Array.isArray(data)||data.version!==1||Object.keys(data).some(key=>!['version','preference'].includes(key)))throw failure('BAD_THEME_STORE','Ungültiger Darstellungsspeicher.');
 return themePreference(data.preference);
}
function themeRequest(message){
 if(!message||typeof message!=='object'||Array.isArray(message)||!['get','set'].includes(message.op)||Object.keys(message).some(key=>!(message.op==='set'?['op','preference']:['op']).includes(key)))throw failure('BAD_THEME_REQUEST','Unbekannter Darstellungsauftrag.');
 return message.op==='set'?themePreference(message.preference):null;
}

// Theme storage is separate from cookies, credentials and workspace content.
// Only the trusted workspace's IPC handler calls this controller.
export function createDesktopTheme({nativeTheme,directory,fs=files,emit=()=>{},apply=()=>{}}){
 const target=path.join(directory,'theme.json');
 let preference='system',configured=false,initialization,queue=Promise.resolve(),last='',disposed=false;
 const snapshot=()=>({preference,resolved:nativeTheme.shouldUseDarkColors?'dark':'light',configured});
 const backgroundColor=()=>backgrounds[snapshot().resolved];
 function publish(){
  if(disposed)return;
  const value=snapshot(),key=JSON.stringify(value);
  if(key===last)return;
  last=key;apply(value);emit(value);
 }
 function initialize(){
  if(initialization)return initialization;
  initialization=(async()=>{
   try{
    const stat=await fs.stat(target);
    if(!stat.isFile()||stat.size>MAX_STORE_BYTES)throw failure('BAD_THEME_STORE','Ungültiger Darstellungsspeicher.');
    preference=parseThemeSnapshot(await fs.readFile(target,'utf8'));configured=true;
   }catch{preference='system';configured=false;}
   nativeTheme.themeSource=preference;
   nativeTheme.on('updated',publish);publish();return snapshot();
  })();
  return initialization;
 }
 async function persist(value){
  const temporary=path.join(directory,'theme.'+randomUUID()+'.tmp');
  try{
   await fs.mkdir(directory,{recursive:true,mode:0o700});
   await fs.writeFile(temporary,JSON.stringify({version:1,preference:value})+'\n',{mode:0o600,flag:'wx'});
   await fs.rename(temporary,target);
  }catch{throw failure('THEME_SAVE_FAILED','Die Darstellung konnte nicht lokal gespeichert werden.');}
  finally{await fs.unlink(temporary).catch(()=>{});}
 }
 async function handle(message){
  const next=themeRequest(message);
  if(message.op==='get'){await initialize();return snapshot();}
  const pending=queue.then(async()=>{
   await initialize();
   if(!configured||next!==preference)await persist(next);
   preference=next;configured=true;nativeTheme.themeSource=next;publish();return snapshot();
  });
  queue=pending.catch(()=>{});return pending;
 }
 return Object.freeze({initialize,handle,snapshot,backgroundColor,flush:()=>queue,dispose:()=>{disposed=true;nativeTheme.removeListener('updated',publish);}});
}
