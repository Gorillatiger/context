import {createHash} from 'node:crypto';
import {normalizeOpenRouterUsage} from './ai-usage.mjs';

const BASE='https://chat.kiconnect.nrw/api/v1';
export const AI_PROVIDERS={kiconnect:{name:'KI:connect NRW',base:BASE},openrouter:{name:'OpenRouter',base:'https://openrouter.ai/api/v1'}};
export class KIError extends Error {
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}
export async function readKIKey(env=process.env){
  const key=env.KICONNECT_API_KEY?.trim();
  if(key&&key.length<=4096&&!/[\r\n]/.test(key))return {key,storage:'session'};
  return null;
}
export function validateChat(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['model','messages'].includes(k)))throw new KIError(400,'invalid_request','Ungültige KI-Anfrage.');
  if(typeof value.model!=='string'||!value.model.trim()||value.model.length>160||/[\x00-\x1f\x7f]/.test(value.model))throw new KIError(400,'invalid_model','Bitte ein verfügbares Modell wählen.');
  if(!Array.isArray(value.messages)||!value.messages.length||value.messages.length>24)throw new KIError(400,'conversation_limit','Bitte einen neuen Chat beginnen. Höchstens 24 Nachrichten pro Anfrage.');
  let total=0;
  const messages=value.messages.map((m,index)=>{
    if(!m||Object.keys(m).some(k=>!['role','content'].includes(k))||!['user','assistant'].includes(m.role)||m.role!==(index%2?'assistant':'user')||typeof m.content!=='string'||!m.content.trim()||m.content.length>(m.role==='assistant'?50000:12000))throw new KIError(400,'invalid_message','Ungültiger Nachrichtenverlauf. Deine Nachrichten dürfen höchstens 12.000 Zeichen haben.');
    total+=m.content.length;
    return {role:m.role,content:m.content};
  });
  if(messages.at(-1).role!=='user'||total>100000)throw new KIError(400,'conversation_limit','Der Chat ist zu lang. Bitte einen neuen Chat beginnen.');
  return {model:value.model,messages};
}
async function limitedJSON(response,limit=1000000){
  if(!response.headers.get('content-type')?.includes('json'))throw new KIError(502,'invalid_response','Die KI-Verbindung hat keine gültige Antwort geliefert.');
  const reader=response.body?.getReader();
  if(!reader)throw new KIError(502,'invalid_response','Die KI-Verbindung hat keine Antwort geliefert.');
  let length=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit)throw new KIError(502,'response_limit','Die KI-Antwort war zu groß. Bitte die Frage eingrenzen.');chunks.push(Buffer.from(value));}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
}
export function createKIClient({provider='kiconnect',getKey,fetcher=fetch,now=Date.now}={}){
  if(!Object.hasOwn(AI_PROVIDERS,provider))throw new KIError(400,'invalid_provider','Unbekannter KI-Anbieter.');
  const config=AI_PROVIDERS[provider],name=config.name;
  getKey||=provider==='kiconnect'?readKIKey:()=>readKIKey({KICONNECT_API_KEY:process.env.OPENROUTER_API_KEY});
  let cachedModels=null,cachedKey='',cachedAt=0,active=false,sessionCredential=null;
  let usageCache=null,usagePending=null,usageRevision=0;
  let requests=[];
  const fingerprint=key=>createHash('sha256').update(key).digest('hex');
  const invalidateUsage=()=>{usageRevision++;usageCache=null;usagePending?.controller.abort();usagePending=null;};
  const currentCredential=async()=>sessionCredential||await getKey();
  async function credential(){const result=await currentCredential();if(!result?.key)throw new KIError(503,'not_configured',name+' ist noch nicht eingerichtet. Verbinde deinen API-Schlüssel in dieser Ansicht.');return result;}
  async function request(path,key,body,signal){
    try{
      const response=await fetcher(config.base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+key,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(body?60000:15000),...(signal?[signal]:[])])});
      if(response.redirected||response.url&&response.url!==config.base+path){await response.body?.cancel().catch(()=>{});throw new KIError(502,'redirect_blocked','Die KI-Verbindung hat eine gesperrte Weiterleitung versucht.');}
      if(!response.ok){
        await response.body?.cancel().catch(()=>{});
        if([401,403].includes(response.status))throw new KIError(502,'access_denied',name+' hat den API-Zugriff abgelehnt. Schlüssel und Berechtigung prüfen.');
        if(response.status===429)throw new KIError(429,'provider_limit','Das '+name+'-Limit ist erreicht. Bitte später erneut versuchen.');
        if(response.status===402)throw new KIError(402,'credits_required','Das OpenRouter-Guthaben reicht nicht aus. Bitte dein Konto prüfen.');
        throw new KIError(502,'provider_error',name+' konnte die Anfrage nicht beantworten. Bei OpenRouter muss das Modell einen ZDR-Endpunkt anbieten. Bitte erneut versuchen oder ein anderes Modell wählen.');
      }
      return await limitedJSON(response,path==='/key'?64000:provider==='openrouter'&&path==='/models'?6000000:1000000);
    }catch(error){
      if(error instanceof KIError)throw error;
      if(signal?.aborted)throw new KIError(499,'cancelled','Anfrage abgebrochen.');
      if(error?.name==='TimeoutError')throw new KIError(504,'timeout','Die KI hat zu lange gebraucht. Bitte erneut versuchen.');
      throw new KIError(502,'connection_failed',name+' ist gerade nicht erreichbar. Bitte erneut versuchen.');
    }
  }
  async function modelsWithKey(auth,signal){
    const fingerprint=createHash('sha256').update(auth.key).digest('hex');
    if(cachedModels&&cachedKey===fingerprint&&now()-cachedAt<300000)return cachedModels;
    const data=await request('/models',auth.key,undefined,signal);
    if(!Array.isArray(data.data)||data.data.length>(provider==='openrouter'?3000:200))throw new KIError(502,'invalid_models',name+' hat keine gültige Modellliste geliefert.');
    const textModels=data.data.filter(m=>provider!=='openrouter'||!Array.isArray(m?.architecture?.output_modalities)||m.architecture.output_modalities.includes('text'));
    const models=[...new Set(textModels.map(m=>m?.id).filter(id=>typeof id==='string'&&id.trim()&&id.length<=160&&!/[\x00-\x1f\x7f]/.test(id)))].map(id=>({id}));
    if(!models.length)throw new KIError(502,'no_models','Für diesen Schlüssel sind keine Modelle verfügbar.');
    cachedModels=models;cachedKey=fingerprint;cachedAt=now();return models;
  }
  function waitForUsage(record,signal){
    return new Promise((resolve,reject)=>{
      const waiter={};record.waiters.add(waiter);let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;record.waiters.delete(waiter);signal?.removeEventListener('abort',abort);if(!record.waiters.size&&!record.done)record.controller.abort();error?reject(error):resolve(structuredClone(value));};
      const abort=()=>finish(new KIError(499,'cancelled','Limitabfrage abgebrochen.'));
      signal?.addEventListener('abort',abort,{once:true});
      record.promise.then(value=>finish(null,value),error=>finish(error));
      if(signal?.aborted)abort();
    });
  }
  return {
    async status(){const auth=await currentCredential();return {configured:!!auth?.key,storage:auth?.storage||null,provider:name};},
    async models(){const auth=await credential();return {models:await modelsWithKey(auth),storage:auth.storage,provider:name};},
    async usage(signal){
      if(signal!==undefined&&!(signal instanceof AbortSignal))throw new KIError(400,'invalid_request','Ungültige Limitabfrage.');
      if(signal?.aborted)throw new KIError(499,'cancelled','Limitabfrage abgebrochen.');
      const requestedRevision=usageRevision,auth=await credential();
      if(signal?.aborted)throw new KIError(499,'cancelled','Limitabfrage abgebrochen.');
      if(requestedRevision!==usageRevision)throw new KIError(499,'usage_changed','Die KI-Verbindung wurde geändert. Limit erneut prüfen.');
      if(provider==='kiconnect')return {provider,status:'unknown',checkedAt:new Date(now()).toISOString(),reason:'not_exposed'};
      const keyId=fingerprint(auth.key),revision=usageRevision,current=now();
      if(usageCache?.keyId===keyId&&usageCache.revision===revision&&current>=usageCache.at&&current-usageCache.at<30000)return structuredClone(usageCache.value);
      if(usagePending&&(usagePending.keyId!==keyId||usagePending.revision!==revision||usagePending.controller.signal.aborted)){usagePending.controller.abort();usagePending=null;}
      if(!usagePending){
        const record={keyId,revision,controller:new AbortController(),waiters:new Set(),done:false,promise:null};
        record.promise=Promise.resolve().then(async()=>{
          const raw=await request('/key',auth.key,undefined,record.controller.signal);
          const currentAuth=await currentCredential();
          if(record.controller.signal.aborted||revision!==usageRevision||!currentAuth?.key||fingerprint(currentAuth.key)!==keyId)throw new KIError(499,'usage_changed','Die KI-Verbindung wurde geändert. Limit erneut prüfen.');
          const value=normalizeOpenRouterUsage(raw,now());usageCache={keyId,revision,at:now(),value};return value;
        }).finally(()=>{record.done=true;if(usagePending===record)usagePending=null;});
        usagePending=record;
      }
      return waitForUsage(usagePending,signal);
    },
    async configure(value){
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>k!=='key')||typeof value.key!=='string'||!value.key.trim()||value.key.length>4096||/[\r\n]/.test(value.key))throw new KIError(400,'invalid_key','Bitte einen gültigen API-Schlüssel eingeben.');
      if(active)throw new KIError(429,'busy','Eine KI-Anfrage läuft bereits. Bitte kurz warten.');
      requests=requests.filter(at=>now()-at<60000);
      if(requests.length>=10)throw new KIError(429,'local_limit','Bitte kurz warten. Höchstens zehn KI-Anfragen pro Minute.');
      active=true;requests.push(now());
      try{
        const auth={key:value.key.trim(),storage:'session'};
        if(provider==='openrouter'){
          const checked=await request('/key',auth.key);
          if(!checked.data||typeof checked.data!=='object'||Array.isArray(checked.data)||typeof checked.data.is_free_tier!=='boolean')throw new KIError(502,'invalid_key_response','OpenRouter konnte den Schlüssel nicht bestätigen.');
          if(checked.data.is_management_key===true)throw new KIError(400,'management_key','Bitte einen Modell-API-Schlüssel verwenden, keinen Management-Schlüssel.');
        }
        const models=await modelsWithKey(auth);
        sessionCredential=auth;
        invalidateUsage();
        return {models,storage:auth.storage,provider:name};
      }finally{active=false;}
    },
    async complete(value,signal){
      const input=validateChat(value);
      if(active)throw new KIError(429,'busy','Eine KI-Anfrage läuft bereits. Bitte kurz warten.');
      requests=requests.filter(at=>now()-at<60000);
      if(requests.length>=10)throw new KIError(429,'local_limit','Bitte kurz warten. Höchstens zehn KI-Anfragen pro Minute.');
      active=true;
      try{
        const auth=await credential();const models=await modelsWithKey(auth,signal);
        if(!models.some(m=>m.id===input.model))throw new KIError(400,'unknown_model','Dieses Modell ist nicht in deiner '+name+'-Modellliste.');
        requests.push(now());
        const result=await request('/chat/completions',auth.key,{...input,stream:false,...(provider==='openrouter'?{max_tokens:3000,provider:{data_collection:'deny',zdr:true}}:{})},signal);
        const content=result.choices?.[0]?.message?.content;
        if(typeof content!=='string'||!content.trim()||content.length>50000)throw new KIError(502,'invalid_completion','Die KI hat keine verwendbare Textantwort geliefert.');
        return {content,model:input.model,finishReason:typeof result.choices?.[0]?.finish_reason==='string'?result.choices[0].finish_reason.slice(0,30):null,...(Number.isSafeInteger(result.usage?.total_tokens)&&result.usage.total_tokens>=0?{totalTokens:result.usage.total_tokens}:{})};
      }finally{active=false;invalidateUsage();}
    }
  };
}
