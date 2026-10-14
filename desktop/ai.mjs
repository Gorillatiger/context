import {createKIClient,KIError} from '../connectors/ki.mjs';
import {createLocalAIClient} from './local-ai.mjs';

// Fixed provider capabilities for the trusted hub, never arbitrary network IPC.
export function createDesktopAI(client=createKIClient({provider:'openrouter'}),localClient=createLocalAIClient()){
  const requests=new Map();
  return async message=>{
    if(!message||typeof message!=='object'||Array.isArray(message)||Object.keys(message).some(k=>!['action','body','id','provider'].includes(k))||message.provider!==undefined&&!['openrouter','local'].includes(message.provider))throw new KIError(400,'invalid_request','Ungültige KI-Anfrage.');
    const provider=message.provider||'openrouter',target=provider==='local'?localClient:client,requestId=provider+':'+message.id;
    if(message.action==='status'&&!message.body)return target.status();
    if(message.action==='models'&&!message.body)return target.models();
    if(message.action==='connection')return target.configure(message.body);
    if(message.action==='forget'&&message.body&&typeof message.body==='object'&&!Array.isArray(message.body)&&!Object.keys(message.body).length&&typeof target.forget==='function')return target.forget();
    if(!/^[a-f0-9-]{36}$/i.test(message.id||''))throw new KIError(400,'invalid_request','Ungültige Anfragekennung.');
    if(message.action==='cancel'){requests.get(requestId)?.abort();return;}
    if(!['chat','usage'].includes(message.action)||message.action==='usage'&&message.body!==undefined||requests.has(requestId))throw new KIError(400,'invalid_request','Ungültige KI-Aktion.');
    const controller=new AbortController();requests.set(requestId,controller);
    try{return message.action==='usage'?await target.usage(controller.signal):await target.complete(message.body,controller.signal);}finally{requests.delete(requestId);}
  };
}
