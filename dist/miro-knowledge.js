import {miroBoardURL} from './board-index.js';
import {platformCatalog} from './source-catalog.js';

export const miroAvailable=()=>typeof globalThis.window?.contextDesktop?.miro==='function';
export function requestMiro(action,body,{signal}={}) {
  if(!miroAvailable())return Promise.reject(new Error('Miro-Inhalte benötigen die aktuelle Context-Desktop-App.'));
  if(!['status','board'].includes(action))return Promise.reject(new Error('Ungültige Miro-Aktion.'));
  const id=globalThis.crypto.randomUUID(),bridge=window.contextDesktop.miro;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
    const finish=(error,value)=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve(value);};
    const cancelNative=()=>{void Promise.resolve().then(()=>bridge({action:'cancel',id})).catch(()=>{});};
    const cancel=()=>{cancelNative();finish(new DOMException('Abgebrochen','AbortError'));};
    const timer=setTimeout(()=>{cancelNative();finish(new Error('Miro benötigt zu lange. Bitte erneut versuchen.'));},180000);
    if(signal?.aborted){cancel();return;}
    signal?.addEventListener('abort',cancel,{once:true});
    Promise.resolve().then(()=>settled?undefined:bridge({action,id,...(body===undefined?{}:{body})})).then(result=>{
      if(result?.ok!==true){const message=typeof result?.error==='string'?result.error:result?.error?.message;const error=new Error(message||'Das Miro-Board konnte nicht gelesen werden.');error.code=result?.code||result?.error?.code;finish(error);}
      else finish(null,result.value);
    },()=>finish(new Error('Die lokale Miro-Anbindung ist nicht erreichbar.')));
  });
}
function knownBoard(workspace,projectId,url) {
  return platformCatalog(workspace).some(source=>source.service==='miro'&&source.projectId===projectId&&source.url===url);
}
// Only authenticated content for a currently linked course board enters local
// search/AI knowledge. Board metadata never proves the content was read.
export function miroBoardSources(snapshot,{workspace,projectId}={}) {
  let url;try{url=miroBoardURL(snapshot?.board?.url);}catch{throw new Error('Ungültiger Miro-Inhalt.');}
  if(snapshot.projectId!==projectId||!knownBoard(workspace,projectId,url)||!Array.isArray(snapshot.documents)||snapshot.documents.length>2001||typeof snapshot.generation!=='string'||!/^[a-f0-9]{64}$/.test(snapshot.generation)||typeof snapshot.fetchedAt!=='string'||!Number.isFinite(Date.parse(snapshot.fetchedAt)))throw new Error('Die Miro-Kurszuordnung ist nicht mehr gültig.');
  const boardId=new URL(url).pathname.split('/')[3],sources=[],seen=new Set();let total=0;
  for(const doc of snapshot.documents){
    if(!doc||Object.keys(doc).some(key=>!['id','kind','title','text','url','source','status','updatedAt','boardId','itemId'].includes(key))||doc.kind!=='miro'||doc.source!=='Miro'||!/^miro:[a-f0-9]{64}$/.test(doc.id)||seen.has(doc.id)||doc.boardId!==boardId||typeof doc.itemId!=='string'||doc.itemId&&!/^[a-zA-Z0-9_=-]{1,128}$/.test(doc.itemId)||typeof doc.title!=='string'||doc.title.length>240||typeof doc.text!=='string'||doc.text.length>12500||!['full','excerpt'].includes(doc.status))throw new Error('Ungültige Miro-Quelle.');
    const expected=new URL(url);if(doc.itemId)expected.searchParams.set('moveToWidget',doc.itemId);
    if(doc.url!==expected.href)throw new Error('Ungültiger Miro-Quellenlink.');
    seen.add(doc.id);total+=doc.text.length;if(total>3000000)throw new Error('Das Miro-Board überschreitet die lokale Textgrenze.');
    for(let start=0,part=0;start<doc.text.length;start+=12000,part++)sources.push({...doc,id:doc.id+':part'+part,text:doc.text.slice(start,start+12000),projectId,source:'Miro',targetId:projectId,boardURL:url,accountGeneration:snapshot.generation,fetchedAt:snapshot.fetchedAt});
  }
  return sources;
}
