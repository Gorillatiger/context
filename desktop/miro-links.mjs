import {randomUUID} from 'node:crypto';
import * as files from 'node:fs/promises';
import path from 'node:path';
import {miroShareLink} from '../connectors/miro-visitor.mjs';

// Miro invitation tokens (share_link_id) stay in the native process. They are
// persisted only through OS-backed encryption and are appended solely when the
// hidden visitor reader opens that board. Renderer, search index, exports, AI
// requests and logs only ever see the normalized board URL.
const MAX_LINKS=2000,MAX_BYTES=256000,TOKEN=/^[A-Za-z0-9_-]{4,80}$/,BOARD=/^[a-zA-Z0-9_=-]{4,100}$/;
export function createMiroShareLinks({directory,crypto,platform=process.platform}={}){
  const target=directory?path.join(directory,'miro-links.enc'):'';
  let links=new Map(),storage='session',queue=Promise.resolve(),restored=false,disposed=false;
  const available=async()=>!!target&&platform!=='linux'&&typeof crypto?.isAsyncEncryptionAvailable==='function'&&typeof crypto?.encryptStringAsync==='function'&&typeof crypto?.decryptStringAsync==='function'&&!!await crypto.isAsyncEncryptionAvailable();
  async function persist(){
    const temporary=path.join(directory||'.','miro-links.'+randomUUID()+'.tmp');let file;
    try{
      if(!await available())throw new Error('unavailable');
      const text=JSON.stringify({version:1,links:Object.fromEntries(links)});if(Buffer.byteLength(text)>MAX_BYTES)throw new Error('limit');
      const encrypted=await crypto.encryptStringAsync(text);if(!Buffer.isBuffer(encrypted))throw new Error('invalid');
      await files.mkdir(directory,{recursive:true,mode:0o700});file=await files.open(temporary,'wx',0o600);await file.writeFile(encrypted);await file.sync();await file.close();file=null;
      await files.rename(temporary,target);storage='encrypted';
    }catch{storage='session';}
    finally{await file?.close().catch(()=>{});if(directory)await files.unlink(temporary).catch(()=>{});}
  }
  async function restore(){
    if(restored)return;restored=true;
    try{
      if(!await available())return;
      let encrypted;try{const stat=await files.lstat(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES+4096)throw new Error('invalid');encrypted=await files.readFile(target);}catch(error){if(error.code==='ENOENT'){storage='encrypted';return;}throw error;}
      const decoded=await crypto.decryptStringAsync(encrypted),value=JSON.parse(decoded.result);
      if(!value||value.version!==1||!value.links||typeof value.links!=='object'||Array.isArray(value.links))throw new Error('invalid');
      const entries=Object.entries(value.links).filter(([board,share])=>BOARD.test(board)&&typeof share==='string'&&TOKEN.test(share)).slice(-MAX_LINKS);
      links=new Map([...entries,...links]);storage='encrypted';if(decoded.shouldReEncrypt)await persist();
    }catch{links=new Map(links);storage='session';}
  }
  const enqueue=operation=>{const pending=queue.then(operation);queue=pending.catch(()=>{});return pending;};
  /** Accepts raw links and remembers only valid invitations. Returns a count, never a token. */
  function remember(values){
    if(!Array.isArray(values)||values.length>100)throw Object.assign(new Error('Ungültige Miro-Links.'),{code:'invalid_request'});
    let changed=0;
    for(const value of values){const row=typeof value==='string'?miroShareLink(value):value&&typeof value==='object'&&TOKEN.test(value.share||'')?miroShareLink(String(value.url||'').replace(/[?#].*$/,'')+'?share_link_id='+value.share):null;if(!row||disposed)continue;if(links.get(row.id)===row.share)continue;links.delete(row.id);links.set(row.id,row.share);changed++;}
    while(links.size>MAX_LINKS)links.delete(links.keys().next().value);
    if(changed)void enqueue(async()=>{await restore();await persist();});
    return {remembered:changed};
  }
  /** Removes boardInvites from a reader page before it reaches the renderer. */
  function take(page){
    if(!page||typeof page!=='object')return page;
    const invites=page.boardInvites;delete page.boardInvites;
    if(Array.isArray(invites)&&invites.length)try{remember(invites.slice(0,100));}catch{}
    return page;
  }
  return {
    initialize:()=>enqueue(restore),remember,take,
    get:async board=>{await queue;return typeof board==='string'&&BOARD.test(board)?links.get(board)||'':'';},
    status:()=>({storage,count:links.size}),
    flush:()=>queue,
    dispose:()=>{disposed=true;return queue;},
  };
}
