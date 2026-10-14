import {createMiroBoardClient,MiroError,safeMiroBoard} from '../connectors/miro.mjs';
import {fetchMiroOEmbed,MIRO_VISITOR_GENERATION} from '../connectors/miro-visitor.mjs';

const validID=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const validProject=value=>typeof value==='string'&&value.length>0&&value.length<=80&&!/[\x00-\x20\x7f]/.test(value);
const object=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const urls=(value,max)=>Array.isArray(value)&&value.length>0&&value.length<=max&&value.every(url=>typeof url==='string'&&url.length<=2048);
// REST failures that mean "this connection cannot see the board". Cancellation,
// scope and account changes are never masked by the visitor fallback.
const FALLBACK=new Set(['not_connected','permission_denied','provider_error','invalid_response']);
const META_TTL=6*3600000;

// Main-frame authorization is enforced by the caller's IPC handler. The native
// registry independently restricts reads to currently linked course boards.
export function createDesktopMiro({nango,visitor,shareLinks,fetchMeta=fetchMiroOEmbed,getAllowedBoards=()=>[],getGeneration=()=>'',now,clock=Date.now}={}) {
  const client=createMiroBoardClient({nango,...(now?{now}:{})}),requests=new Map(),metadata=new Map();let closed=false;
  async function scope(url,projectId) {
    const generation=await getGeneration(),allowed=await getAllowedBoards();
    if(!Array.isArray(allowed)||allowed.length>5000||!allowed.some(item=>{
      if(item?.projectId!==projectId)return false;try{return safeMiroBoard(item.url).url===url;}catch{return false;}
    }))throw new MiroError('board_not_allowed',403);
    return generation;
  }
  async function meta(url,signal) {
    const cached=metadata.get(url);if(cached&&clock()-cached.at<META_TTL)return cached.value;
    const value=await fetchMeta(url,{signal});metadata.delete(url);metadata.set(url,{at:clock(),value});while(metadata.size>500)metadata.delete(metadata.keys().next().value);return value;
  }
  // A Nango failure must not hide the visitor path; with no visitor it stays an error as before.
  async function restStatus(signal) {
    try{return await client.status(signal);}catch(error){if(signal.aborted||typeof visitor!=='function')throw error;return {configured:false,connected:false,boardRead:false,backend:'nango',generation:''};}
  }
  async function status(signal) {
    return {...await restStatus(signal),visitor:typeof visitor==='function',visitorGeneration:typeof visitor==='function'?MIRO_VISITOR_GENERATION:''};
  }
  async function board(target,signal) {
    const rest=await restStatus(signal);let notice='';
    if(rest.connected&&rest.boardRead){
      try{return {...await client.board({url:target.url},signal),access:'api'};}
      catch(error){if(typeof visitor!=='function'||!(error instanceof MiroError)||!FALLBACK.has(error.code))throw error;notice='Die verbundene Miro-API konnte dieses Board nicht lesen. Context hat stattdessen die öffentliche Board-Übersicht als Besucher gelesen.';}
    }else if(typeof visitor!=='function')throw new MiroError('not_connected',409);
    if(signal.aborted)throw new MiroError('cancelled',499);
    let info={};try{info=await meta(target.url,signal);}catch(error){if(signal.aborted)throw new MiroError('cancelled',499);}
    const value=await visitor({url:target.url,meta:{title:info?.title||'',author:info?.author||''}},signal);
    return {...value,generation:MIRO_VISITOR_GENERATION,access:'visitor',warnings:[...(notice?[notice]:[]),...value.warnings]};
  }
  const handle=async message=>{
    if(closed)throw new MiroError('closed',409);
    if(!object(message,['action','id','body'])||!validID(message.id))throw new MiroError('invalid_request');
    const {action,id,body}=message;
    if(action==='cancel'){if(body!==undefined)throw new MiroError('invalid_request');requests.get(id)?.abort();return;}
    if(action==='remember'){
      if(!object(body,['urls'])||!urls(body.urls,100))throw new MiroError('invalid_request');
      return shareLinks?shareLinks.remember(body.urls):{remembered:0};
    }
    if(!['status','board','meta'].includes(action)||requests.has(id)||action==='status'&&body!==undefined||action==='board'&&(!object(body,['url','projectId'])||!validProject(body.projectId))||action==='meta'&&(!object(body,['urls'])||!urls(body.urls,20)))throw new MiroError('invalid_request');
    if(requests.size>=2)throw new MiroError('busy',429);
    const controller=new AbortController();requests.set(id,controller);
    try {
      if(action==='status')return await status(controller.signal);
      if(action==='meta'){
        const boards=[];
        for(const value of body.urls){
          if(controller.signal.aborted)throw new MiroError('cancelled',499);
          let url;try{url=safeMiroBoard(value).url;}catch{boards.push({url:'',title:'',author:'',available:false});continue;}
          try{const info=await meta(url,controller.signal);boards.push({url,title:info.title,author:info.author,available:info.available===true});}
          catch(error){if(controller.signal.aborted)throw new MiroError('cancelled',499);boards.push({url,title:'',author:'',available:false});}
        }
        return {boards};
      }
      const target=safeMiroBoard(body.url),revision=await scope(target.url,body.projectId);
      if(controller.signal.aborted)throw new MiroError('cancelled',499);
      const value=await board(target,controller.signal);
      if(controller.signal.aborted)throw new MiroError('cancelled',499);
      if(await scope(target.url,body.projectId)!==revision)throw new MiroError('scope_changed',409);
      if(controller.signal.aborted||closed)throw new MiroError('cancelled',499);
      return {...value,projectId:body.projectId,scopeGeneration:revision};
    }finally{requests.delete(id);}
  };
  handle.dispose=()=>{closed=true;for(const controller of requests.values())controller.abort();requests.clear();visitor?.dispose?.();void shareLinks?.dispose?.();};
  return handle;
}
