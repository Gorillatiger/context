import {createHash} from 'node:crypto';
// Shared sync lifecycle. Credentials stay inside adapters; only normalized data
// and opaque account generations leave this module.
export function createPlatformFeed({adapters,now=Date.now,cacheMs=60000,retryMs=300000}){
  const records=new Map(),epochs=new Map();let disposed=false;
  function invalidate(source){for(const adapter of adapters)if(!source||adapter.source===source)epochs.set(adapter.source,(epochs.get(adapter.source)||0)+1);for(const [key,row] of records)if(!source||row.source===source){row.controller?.abort();records.delete(key);}}
  async function sync(adapter,scope,manual){
    const generation=epochs.get(adapter.source)||0,account=await adapter.account();
    if(disposed||generation!==(epochs.get(adapter.source)||0))throw Object.assign(new Error('Die Anmeldung wurde geändert.'),{code:'ACCOUNT_CHANGED'});
    const key=adapter.source+':'+JSON.stringify(scope),signature=JSON.stringify([account,scope]);
    for(const [oldKey,oldRow] of records)if(oldRow.source===adapter.source&&oldKey!==key){oldRow.controller?.abort();records.delete(oldKey);}
    let row=records.get(key);
    if(row?.signature!==signature){row?.controller?.abort();row={source:adapter.source,signature,account,items:[],due:0,failures:0};records.set(key,row);}
    if(row.pending)return row.pending;
    if(row.result&&now()<row.due&&(!manual||now()-row.settled<10000))return row.result;
    const controller=new AbortController();row.controller=controller;
    const current=()=>!disposed&&generation===(epochs.get(adapter.source)||0)&&records.get(key)===row&&!controller.signal.aborted;
    row.pending=(async()=>{
      let value;
      try{
        value=await adapter.read({scope,signal:controller.signal,previous:row.items});
        if(!value||!Array.isArray(value.items))throw new Error('Ungültiger Quellenstand.');
        let verifiedAccount;
        try{verifiedAccount=await adapter.account();}catch{throw Object.assign(new Error('Kontozustand nicht bestätigt.'),{code:'ACCOUNT_UNVERIFIED'});}
        if(verifiedAccount!==account||!current())throw Object.assign(new Error('Die Anmeldung wurde geändert.'),{code:'ACCOUNT_CHANGED'});
        row.items=value.items;row.failures=0;
        value={status:'connected',...value};
      }catch(error){
        if(!current()||error.code==='ACCOUNT_CHANGED')throw Object.assign(new Error('Die Anmeldung wurde geändert.'),{code:'ACCOUNT_CHANGED'});
        row.failures++;
        const login=error.status===401||error.status===403||error.code==='LOGIN_REQUIRED';
        if(login||error.code==='ACCOUNT_UNVERIFIED')row.items=[];
        value={items:row.items,status:login?'login_required':'error',complete:false,message:login?'Im Context-Browser anmelden und erneut aktualisieren.':error.code==='ACCOUNT_UNVERIFIED'?'Der Kontozustand konnte nicht bestätigt werden. Hinweise werden bis zur erneuten Prüfung ausgeblendet.':error.status===429?'Anbieter-Limit erreicht. Der letzte Stand bleibt erhalten.':'Abruf fehlgeschlagen. Der letzte Stand bleibt erhalten.'};
      }
      if(!current())throw Object.assign(new Error('Die Anmeldung wurde geändert.'),{code:'ACCOUNT_CHANGED'});
      if(value.status==='error'&&!row.failures)row.failures=1;
      row.settled=now();row.due=row.settled+(row.failures?Math.min(retryMs,cacheMs*2**Math.min(row.failures,3)):cacheMs);
      row.result={...value,source:adapter.source,itemsAuthoritative:true,accountGeneration:createHash('sha256').update(signature).digest('hex'),checkedAt:new Date(row.settled).toISOString()};return row.result;
    })().finally(()=>{row.pending=null;row.controller=null;});
    return row.pending;
  }
  return {async read({scope=[],manual=false}={}){
    if(disposed)throw new Error('Synchronisierung beendet.');
    const values=await Promise.all(adapters.map(async adapter=>{
      try{return await sync(adapter,typeof adapter.scope==='function'?adapter.scope(scope):scope,manual);}catch(error){
        if(disposed)throw error;
        if(error.code!=='ACCOUNT_CHANGED'){
          invalidate(adapter.source);
          return {source:adapter.source,status:'error',items:[],itemsAuthoritative:true,complete:false,checkedAt:new Date(now()).toISOString(),message:'Der Kontozustand dieser Plattform konnte nicht bestätigt werden. Erneut aktualisieren.'};
        }
        return {source:adapter.source,status:'login_required',items:[],itemsAuthoritative:true,complete:false,message:'Die Anmeldung wurde geändert. Erneut aktualisieren.'};
      }
    }));
    return {items:values.flatMap(value=>value.items),sources:values.map(({items,...source})=>source),checkedAt:new Date(now()).toISOString()};
  },invalidate,dispose(){disposed=true;invalidate();}};
}
