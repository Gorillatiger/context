import {createMailView} from './mail.js';
const labels={th:'TH-Mail',outlook:'Outlook',gmail:'Gmail'};

export function createMailAccounts({onChange,onConnection,bridge=()=>window.contextDesktop?.nangoMail,createView=createMailView}) {
  let active='th';
  const request=service=>async(action,body)=>{
    const native=bridge();
    if(typeof native!=='function'){const error=new Error('Öffne die aktuelle Context Browser-App, um Outlook oder Gmail zu verbinden.');error.code='native_unavailable';throw error;}
    const reply=await native({action,service,id:crypto.randomUUID(),...(body!==undefined?{body}:{})});
    if(!reply?.ok){const error=new Error(reply?.error||'Die Cloud-Mailverbindung ist nicht erreichbar.');error.code=reply?.code||'connection_failed';throw error;}
    if(action!=='attachment')return reply.value;
    const file=reply.value;
    if(typeof file?.data!=='string'||file.data.length>Math.ceil(8*1024*1024/3)*4+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))throw new Error('Der Anhang ist ungültig oder zu groß.');
    const decoded=atob(file.data),bytes=Uint8Array.from(decoded,char=>char.charCodeAt(0));
    if(bytes.length>8*1024*1024)throw new Error('Der Anhang ist zu groß.');
    return new Blob([bytes],{type:'application/octet-stream'});
  };
  const views=Object.fromEntries(Object.keys(labels).map(service=>[service,createView({service,isActive:()=>active===service,onChange:()=>{if(active===service)onChange();},onConnection:change=>onConnection(service,change),...(service==='th'?{}:{request:request(service)})})]));
  return {
    render(){return `<nav class="mail-account-picker" aria-label="Mailkonto auswählen">${Object.entries(labels).map(([id,label])=>`<button type="button" data-mail-account="${id}" class="${active===id?'selected':''}" aria-pressed="${active===id}">${label}${id==='th'?'':' · Nango'}</button>`).join('')}<button type="button" data-view="connections" class="mail-manage-connections">Verbindungen verwalten ↗</button></nav>`+views[active].render();},
    select(service){if(!Object.hasOwn(views,service))return false;views[active].hideRecipientSuggestions?.();active=service;onChange();void views[active].load();return true;},
    load:force=>views[active].load(force),
    open:target=>views[active].open(target),
    refreshCloud(){for(const service of ['outlook','gmail'])views[service].refreshConnection?.();},
    searchSources:()=>Object.values(views).flatMap(view=>view.searchSources?.()||[]),
    active:()=>active
  };
}
