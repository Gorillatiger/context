const aborted=()=>new DOMException('Anfrage abgebrochen.','AbortError');
function sleepFor(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted){reject(aborted());return;}const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(aborted());};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});});}

// RAM only. This gate counts model calls in this renderer, not the account's
// total across other tabs/apps. Provider 429 remains authoritative.
export function createAIRateGate({now=Date.now,sleep=sleepFor,setTimer=setTimeout,clearTimer=clearTimeout,slowMs=15000,windowMs=60000,limit=10,maxPending=4}={}){
  let times=[],cooldown=0,pending=0;
  const clean=()=>{const at=now();times=times.filter(t=>t>at-windowMs&&t<=at);return at;};
  return {snapshot(){const at=clean();return {used:times.length,remaining:Math.max(0,limit-times.length),retryAfterMs:Math.max(0,cooldown-at,times.length>=limit?times[0]+windowMs-at:0)};},
    async run(provider,work,{signal,onWait=()=>{}}={}){
      if(signal?.aborted)throw aborted();
      if(provider!=='kiconnect'){const value=await work();if(signal?.aborted)throw aborted();return value;}
      if(pending>=maxPending){const e=new Error('Mehrere Hochschul-KI-Aufträge warten bereits. Bitte einen Auftrag abschließen.');e.code='busy';throw e;}
      pending++;let timer;
      try{
        for(;;){if(signal?.aborted)throw aborted();const at=clean(),wait=Math.max(0,cooldown-at,times.length>=limit?times[0]+windowMs-at:0);if(!wait){times.push(at);break;}onWait({provider,reason:'rate',retryAfterMs:Math.ceil(wait),elapsedMs:0});await sleep(Math.min(1000,wait),signal);}
        onWait(null);const started=now();timer=setTimer(()=>{if(!signal?.aborted)onWait({provider,reason:'slow',retryAfterMs:0,elapsedMs:Math.max(slowMs,now()-started)});},slowMs);
        const result=await work();if(signal?.aborted)throw aborted();return result;
      }catch(error){
        if(['local_limit','provider_limit'].includes(error.code)){
          const ms=Number.isFinite(error.retryAfterMs)?Math.min(windowMs,Math.max(1000,error.retryAfterMs)):windowMs;
          cooldown=Math.max(cooldown,now()+ms);error.retryAfterMs=ms;
        }
        // A possibly submitted request is never retried automatically.
        throw error;
      }finally{clearTimer(timer);pending--;onWait(null);}
    }
  };
}

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderAIWait(notice,{busy=false}={}){
  if(!notice||notice.provider!=='kiconnect'||!['rate','slow'].includes(notice.reason))return '';
  const message=notice.reason==='rate'?busy?'Hochschul-KI: Minutenlimit. Weiter in etwa '+Math.max(1,Math.ceil((notice.retryAfterMs||60000)/1000))+' s.':'Hochschul-KI: Minutenlimit erreicht. Bitte kurz warten.':'Die Hochschul-KI antwortet seit über 15 Sekunden. Die Ursache ist noch unbekannt.';
  return `<div class="ki-wait-notice" role="status"><span>${esc(message)}</span><button type="button" class="text-link" data-ki-action="switch-openrouter">Zu OpenRouter wechseln ↗</button><small>Kein automatischer Versand. OpenRouter erhält erst beim Senden den freigegebenen Kontext; Kosten sind möglich.</small></div>`;
}
