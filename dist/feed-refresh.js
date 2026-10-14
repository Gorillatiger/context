// Lifecycle and timing only. The caller owns all feed reads, validation and
// source updates; this scheduler never fetches an account or provider itself.
export const FEED_REFRESH_INTERVALS=Object.freeze({live:60000,snapshot:120000,maximumRetry:300000});
const errorText=value=>String(value?.message||value||'Die Quellen konnten nicht aktualisiert werden.').slice(0,500);

export function createFeedRefresh({refresh,onStatus=()=>{},getVisibility=()=>globalThis.document?.visibilityState||'visible',isConnected=()=>false,now=()=>Date.now(),timers=globalThis,eventTarget=globalThis.window,visibilityTarget=globalThis.document}={}){
  if(typeof refresh!=='function'||typeof onStatus!=='function'||typeof getVisibility!=='function'||typeof isConnected!=='function'||typeof now!=='function'||typeof timers?.setTimeout!=='function'||typeof timers?.clearTimeout!=='function')throw new TypeError('Ungültiger Auftrag für die Quellenaktualisierung.');
  let started=false,disposed=false,generation=0,timer=null,active=null,attached=false,nextDueAt=null,lastAttemptAt=null,lastSuccessAt=null,lastSettledAt=null,lastError='',failures=0,manual=false,reason='';
  const connected=()=>{try{return isConnected()===true;}catch{return false;}};
  const visible=()=>{try{const value=getVisibility();return value===true||value==='visible';}catch{return false;}};
  const interval=()=>connected()?FEED_REFRESH_INTERVALS.live:FEED_REFRESH_INTERVALS.snapshot;
  const retryDelay=()=>Math.min(FEED_REFRESH_INTERVALS.maximumRetry,interval()*2**Math.min(failures,3));
  function status(){
    const shown=visible();
    return {state:disposed?'disposed':!started?'stopped':active?'refreshing':!shown?'paused':lastError?'error':'waiting',busy:!!active,visible:shown,connected:connected(),intervalMs:interval(),nextDueAt,lastAttemptAt,lastSuccessAt,lastError,failures,manual,reason};
  }
  function emit(){if(!disposed)try{onStatus(status());}catch{/* A renderer failure cannot create duplicate source reads. */}}
  function clearTimer(){if(timer!==null){timers.clearTimeout(timer);timer=null;}}
  function arm(){
    clearTimer();if(disposed||!started||active||!visible()||nextDueAt===null)return;
    const delay=Math.max(0,Math.min(FEED_REFRESH_INTERVALS.maximumRetry,nextDueAt-now()));
    timer=timers.setTimeout(()=>{
      timer=null;if(disposed||!started)return;
      if(!visible()){emit();return;}
      if(now()<nextDueAt){arm();return;}
      void attempt(false,'automatic');
    },delay);
  }
  function attempt(userTriggered,why){
    if(disposed||!started)return Promise.resolve({accepted:false,reason:disposed?'disposed':'stopped'});
    if(active)return Promise.resolve({accepted:false,reason:'busy'});
    if(!userTriggered&&!visible()){clearTimer();emit();return Promise.resolve({accepted:false,reason:'hidden'});}
    clearTimer();if(userTriggered){failures=0;lastError='';}
    const run={generation,controller:new AbortController(),promise:null};active=run;manual=userTriggered;reason=why;lastAttemptAt=now();nextDueAt=null;emit();
    // The promise fence survives stop/start when a caller ignores AbortSignal.
    // A later run cannot overlap that still unsettled request.
    run.promise=Promise.resolve().then(()=>{
      if(run.controller.signal.aborted||disposed||run.generation!==generation)throw new DOMException('Aktualisierung angehalten.','AbortError');
      return refresh({signal:run.controller.signal,manual:userTriggered,reason:why});
    }).then(result=>{
      if(run.controller.signal.aborted||disposed||run.generation!==generation)return {accepted:true,ok:false,aborted:true};
      if(result===false||result?.ok===false)throw new Error(errorText(result?.error));
      lastSettledAt=now();lastSuccessAt=lastSettledAt;lastError='';failures=0;nextDueAt=lastSettledAt+interval();
      return {accepted:true,ok:true,result};
    }).catch(error=>{
      if(run.controller.signal.aborted||disposed||run.generation!==generation)return {accepted:true,ok:false,aborted:true};
      lastSettledAt=now();lastError=errorText(error);failures=Math.min(10,failures+1);nextDueAt=lastSettledAt+retryDelay();
      return {accepted:true,ok:false,error:lastError};
    }).finally(()=>{
      if(active===run)active=null;
      if(disposed)return;
      if(started&&nextDueAt!==null&&nextDueAt<=now()&&visible())void attempt(false,'resume');else {arm();emit();}
    });
    return run.promise;
  }
  function resume(why='focus'){
    if(disposed||!started)return Promise.resolve({accepted:false,reason:disposed?'disposed':'stopped'});
    if(!visible()){clearTimer();emit();return Promise.resolve({accepted:false,reason:'hidden'});}
    if(active){emit();return Promise.resolve({accepted:false,reason:'busy'});}
    // A source configuration can change while hidden. Re-evaluate its normal
    // cadence, retaining the failure backoff rather than retrying on every focus.
    if(lastSettledAt!==null&&nextDueAt!==null)nextDueAt=Math.min(nextDueAt,lastSettledAt+retryDelay());
    if(nextDueAt===null||nextDueAt<=now())return attempt(false,why);
    arm();emit();return Promise.resolve({accepted:false,reason:'fresh'});
  }
  const onFocus=()=>{void resume('focus');};
  const onVisibility=()=>{void resume('visibility');};
  function attach(){if(attached)return;eventTarget?.addEventListener?.('focus',onFocus);visibilityTarget?.addEventListener?.('visibilitychange',onVisibility);attached=true;}
  function detach(){if(!attached)return;eventTarget?.removeEventListener?.('focus',onFocus);visibilityTarget?.removeEventListener?.('visibilitychange',onVisibility);attached=false;}
  function stop(notify=true){
    started=false;generation++;clearTimer();detach();nextDueAt=null;active?.controller.abort();if(notify)emit();return status();
  }
  return {
    start({immediate=true}={}){
      if(disposed)return status();if(started)return status();started=true;generation++;nextDueAt=now()+(immediate?0:interval());attach();
      if(immediate&&!active&&visible())void attempt(false,'startup');else {arm();emit();}return status();
    },
    request(userTriggered=true){
      if(typeof userTriggered!=='boolean')return Promise.reject(new TypeError('Ungültige Aktualisierungsart.'));
      // Explicit integration invalidation also bypasses the due date, but a
      // hidden app defers its automatic read until it becomes visible again.
      if(!userTriggered&&started&&!disposed&&!active)nextDueAt=now();
      return attempt(userTriggered,userTriggered?'manual':'requested');
    },
    resume,
    visibilityChanged:()=>resume('visibility'),
    stop:()=>stop(),
    dispose(){if(disposed)return;disposed=true;stop(false);},
    status,
  };
}
