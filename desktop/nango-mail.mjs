import {AsyncLocalStorage} from 'node:async_hooks';
import {createNangoMailClient} from '../connectors/nango-mail.mjs';
import {MailError} from '../connectors/mail.mjs';

// Only typed mail operations are exposed to the trusted main-frame renderer.
export function createDesktopNangoMail({nango}) {
  const context = new AsyncLocalStorage(), requests = new Map();
  const check = () => {if(context.getStore()?.aborted) throw new MailError('cancelled');};
  const api = {
    async status(service) {check(); const result=await nango.status(service); check(); return result;},
    proxy(service, options, signal) {check(); const active=context.getStore(); return nango.proxy(service,options,active&&signal?AbortSignal.any([active,signal]):active||signal);},
    disconnect:service=>nango.disconnect(service)
  };
  const clients = Object.fromEntries(['outlook','gmail'].map(service=>[service,createNangoMailClient({nango:api,service})]));
  const validID=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
  const allowed={status:[],folders:[],list:['folder','offset','query','unread'],message:['folder','uid','uidValidity'],attachment:['folder','uid','uidValidity','part'],flag:['folder','uid','uidValidity','unread'],send:['requestId','draft','accountKey'],connection:['disconnect']};
  const handle=async message=>{
    if(!message||typeof message!=='object'||Array.isArray(message)||Object.keys(message).some(key=>!['action','service','body','id'].includes(key))) throw new MailError('invalid_request');
    const {action,service,body,id}=message;
    if(action==='cancel') {if(!validID(id))throw new MailError('invalid_request');requests.get(id)?.abort();return;}
    if(!clients[service]||!Object.hasOwn(allowed,action)||!validID(id)||requests.has(id))throw new MailError('invalid_request');
    if(body!==undefined&&(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!allowed[action].includes(key)))||action==='connection'&&body?.disconnect!==true)throw new MailError('invalid_request');
    const controller=new AbortController(); requests.set(id,controller);
    try {return await context.run(controller.signal,async()=>{
      const result=await clients[service][action==='connection'?'configure':action](body);
      if(controller.signal.aborted&&action==='send')throw new MailError('delivery_unknown');
      check(); return result;
    });} catch(error){if(action==='send'&&controller.signal.aborted)throw new MailError('delivery_unknown');throw error;}finally {requests.delete(id);}
  };
  handle.dispose=()=>{for(const controller of requests.values())controller.abort();requests.clear();};
  return handle;
}
