import {randomUUID} from 'node:crypto';
import * as files from 'node:fs/promises';
import path from 'node:path';

// API keys of the cloud AI providers and access tokens of the GitLab and Mattermost connectors. They are persisted only through the
// operating system's encryption (Electron safeStorage, macOS keychain) and never
// reach the renderer, the workspace, backups, exports or logs. Without available
// encryption nothing is written and the key lives in memory until quit.
const PROVIDERS=['kiconnect','openrouter','gitlab','mattermost'],MAX_BYTES=16384,MAX_KEY=4096;
const valid=value=>typeof value==='string'&&value.length>0&&value.length<=MAX_KEY&&!/[\r\n]/.test(value);
export function createDesktopKeyStore({directory,crypto,platform=process.platform}={}){
  const target=directory?path.join(directory,'ai-keys.enc'):'';
  let keys={},restored=false,queue=Promise.resolve();
  const available=async()=>!!target&&platform!=='linux'&&typeof crypto?.isAsyncEncryptionAvailable==='function'&&typeof crypto?.encryptStringAsync==='function'&&typeof crypto?.decryptStringAsync==='function'&&!!await crypto.isAsyncEncryptionAvailable();
  const enqueue=operation=>{const pending=queue.then(operation);queue=pending.catch(()=>{});return pending;};
  async function persist(){
    const temporary=path.join(directory,'ai-keys.'+randomUUID()+'.tmp');let file;
    try{
      if(!await available())return false;
      const text=JSON.stringify({version:1,keys});if(Buffer.byteLength(text)>MAX_BYTES)return false;
      const encrypted=await crypto.encryptStringAsync(text);if(!Buffer.isBuffer(encrypted)||encrypted.length>MAX_BYTES+4096)return false;
      await files.mkdir(directory,{recursive:true,mode:0o700});file=await files.open(temporary,'wx',0o600);await file.writeFile(encrypted);await file.sync();await file.close();file=null;
      await files.rename(temporary,target);return true;
    }catch{return false;}
    finally{await file?.close().catch(()=>{});if(directory)await files.unlink(temporary).catch(()=>{});}
  }
  async function restore(){
    if(restored)return;restored=true;
    try{
      if(!await available())return;
      let encrypted;try{const stat=await files.lstat(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES+4096)return;encrypted=await files.readFile(target);}catch(error){if(error.code==='ENOENT')return;throw error;}
      const decoded=await crypto.decryptStringAsync(encrypted),value=JSON.parse(decoded.result);
      if(!value||value.version!==1||!value.keys||typeof value.keys!=='object'||Array.isArray(value.keys))return;
      // Keys saved in this run win over older file content.
      keys={...Object.fromEntries(PROVIDERS.filter(id=>valid(value.keys[id])).map(id=>[id,value.keys[id]])),...keys};
      if(decoded.shouldReEncrypt)await persist();
    }catch{/* an unreadable store (reset keychain) is treated as empty; the next save replaces it */}
  }
  return {
    /** One provider's view; load() returns '' when nothing is stored. */
    forProvider(provider){
      if(!PROVIDERS.includes(provider))throw new TypeError('Unbekannter Anbieter.');
      return {
        load:()=>enqueue(async()=>{await restore();return keys[provider]||'';}),
        save:key=>enqueue(async()=>{if(!valid(key))return false;await restore();const previous=keys[provider];keys={...keys,[provider]:key};if(await persist())return true;if(previous===undefined){const {[provider]:_removed,...rest}=keys;keys=rest;}else keys={...keys,[provider]:previous};return false;}),
        clear:()=>enqueue(async()=>{await restore();if(keys[provider]===undefined)return;const {[provider]:_removed,...rest}=keys;keys=rest;if(Object.keys(keys).length)await persist();else{try{await files.unlink(target);}catch(error){if(error.code!=='ENOENT'&&await available())await persist();}}}),
      };
    },
    status:()=>({providers:Object.keys(keys)}),
    flush:()=>queue,
  };
}
