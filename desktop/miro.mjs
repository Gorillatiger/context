import {createMiroBoardClient,MiroError,safeMiroBoard} from '../connectors/miro.mjs';

const validID=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const validProject=value=>typeof value==='string'&&value.length>0&&value.length<=80&&!/[\x00-\x20\x7f]/.test(value);
const object=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));

// Main-frame authorization is enforced by the caller's IPC handler. The native
// registry independently restricts reads to currently linked course boards.
export function createDesktopMiro({nango,getAllowedBoards=()=>[],getGeneration=()=>'',now}={}) {
  const client=createMiroBoardClient({nango,...(now?{now}:{})}),requests=new Map();let closed=false;
  async function scope(url,projectId) {
    const generation=await getGeneration(),allowed=await getAllowedBoards();
    if(!Array.isArray(allowed)||allowed.length>5000||!allowed.some(item=>{
      if(item?.projectId!==projectId)return false;try{return safeMiroBoard(item.url).url===url;}catch{return false;}
    }))throw new MiroError('board_not_allowed',403);
    return generation;
  }
  const handle=async message=>{
    if(closed)throw new MiroError('closed',409);
    if(!object(message,['action','id','body'])||!validID(message.id))throw new MiroError('invalid_request');
    const {action,id,body}=message;
    if(action==='cancel'){if(body!==undefined)throw new MiroError('invalid_request');requests.get(id)?.abort();return;}
    if(!['status','board'].includes(action)||requests.has(id)||action==='status'&&body!==undefined||action==='board'&&(!object(body,['url','projectId'])||!validProject(body.projectId)))throw new MiroError('invalid_request');
    if(requests.size>=2)throw new MiroError('busy',429);
    const controller=new AbortController();requests.set(id,controller);
    try {
      if(action==='status')return await client.status(controller.signal);
      const target=safeMiroBoard(body.url),revision=await scope(target.url,body.projectId);
      if(controller.signal.aborted)throw new MiroError('cancelled',499);
      const value=await client.board({url:target.url},controller.signal);
      if(controller.signal.aborted)throw new MiroError('cancelled',499);
      if(await scope(target.url,body.projectId)!==revision)throw new MiroError('scope_changed',409);
      if(controller.signal.aborted||closed)throw new MiroError('cancelled',499);
      return {...value,projectId:body.projectId,scopeGeneration:revision};
    }finally{requests.delete(id);}
  };
  handle.dispose=()=>{closed=true;for(const controller of requests.values())controller.abort();requests.clear();};
  return handle;
}
