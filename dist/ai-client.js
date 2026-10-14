import {createAIRateGate} from './ai-rate-limit.js';
export const PROVIDERS={kiconnect:'KI:connect NRW',openrouter:'OpenRouter',local:'Lokales Modell · LM Studio / Ollama'};
export const providerName=id=>PROVIDERS[id]||PROVIDERS.kiconnect;
const campusGate=createAIRateGate();
export async function aiRequest(provider,action,{body,signal,onWait}={}){
  return action==='chat'?campusGate.run(provider,()=>request(provider,action,{body,signal}),{signal,onWait}):request(provider,action,{body,signal});
}
async function request(provider,action,{body,signal}={}){
  if(!Object.hasOwn(PROVIDERS,provider)||!['models','status','chat','connection','usage','forget'].includes(action)||action==='usage'&&body!==undefined||action==='forget'&&(provider==='local'||!body||Object.keys(body).length))throw new Error('Ungültige KI-Verbindung.');
  if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');
  if(['openrouter','local'].includes(provider)&&typeof window.contextDesktop?.ai==='function'){
    const id=crypto.randomUUID(),cancel=()=>{try{void Promise.resolve(window.contextDesktop.ai({action:'cancel',id,provider})).catch(()=>{});}catch{}};
    signal?.addEventListener('abort',cancel,{once:true});
    try{const result=await window.contextDesktop.ai({action,provider,...(body?{body}:{}),...(['chat','usage'].includes(action)?{id}:{})});
      if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');
      if(!result.ok){const error=new Error(result.error||providerName(provider)+' ist nicht erreichbar.');error.code=result.code;throw error;}return result.value;
    }finally{signal?.removeEventListener('abort',cancel);}
  }
  if(provider==='local')throw new Error('Lokale Modelle werden in der aktuellen Context-Mac-App verbunden. Es wird kein Cloud-Anbieter verwendet.');
  const response=await fetch('/api/ai/'+action+(provider==='openrouter'&&!body?'?provider=openrouter':''),{credentials:'same-origin',signal,...(body?{method:'POST',headers:{'Content-Type':'application/json','X-Context-Request':'ki-request'},body:JSON.stringify({...body,...(provider==='openrouter'?{provider}:{})})}:{})});
  let result;try{result=await response.json();}catch{throw new Error('Die lokale KI-Verbindung ist nicht erreichbar.');}
  if(!response.ok){const error=new Error(result.message||'Die KI-Anfrage konnte nicht abgeschlossen werden.');error.status=response.status;error.code=result.error;if(Number.isFinite(result.retryAfterMs)&&result.retryAfterMs>=0&&result.retryAfterMs<=60000)error.retryAfterMs=result.retryAfterMs;throw error;}
  return result;
}
