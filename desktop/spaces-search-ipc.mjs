// The main frame owns these cancellable jobs; websites never receive the IPC.
export function createSpacesSearchIPC(service){
  const jobs=new Map();let disposed=false;
  const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  function invalidate(){for(const controller of jobs.values())controller.abort();jobs.clear();service.invalidate();}
  async function handle(message){
    if(disposed||!message||typeof message!=='object'||Array.isArray(message)||!uuid(message.requestId))throw new Error('Ungültiger Spaces-Suchauftrag.');
    if(message.op==='cancel'){
      if(Object.keys(message).some(k=>!['op','requestId'].includes(k)))throw new Error('Ungültiger Abbruch.');jobs.get(message.requestId)?.abort();return {cancelled:true};
    }
    if(!['search','read'].includes(message.op)||jobs.has(message.requestId)||jobs.size>=4)throw new Error('Eine Spaces-Suche läuft bereits. Bitte kurz warten.');
    const controller=new AbortController(),{requestId,...request}=message;jobs.set(requestId,controller);
    try{const result=await service.handle(request,{signal:controller.signal});if(controller.signal.aborted||disposed)throw new DOMException('Abgebrochen','AbortError');return result;}
    finally{if(jobs.get(requestId)===controller)jobs.delete(requestId);}
  }
  return {handle,invalidate,dispose(){disposed=true;invalidate();service.dispose();}};
}
