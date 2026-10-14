const pending=new Map();
const send=message=>{if(window.contextDesktop?.agent)void window.contextDesktop.agent(message);else window.webkit.messageHandlers.contextAgent.postMessage(message);};
export const agentBrowserAvailable=()=>typeof window.contextDesktop?.agent==='function'||typeof window.webkit?.messageHandlers?.contextAgent?.postMessage==='function';
export function safeSpacesURL(value){
  const u=new URL(value);let path=u.pathname;for(let i=0;i<3;i++){const decoded=decodeURIComponent(path);if(decoded===path)break;path=decoded;}
  if(u.protocol!=='https:'||u.hostname!=='spaces.th-koeln.de'||u.port||u.username||u.password||/[\x00-\x20]/.test(value)||/\/(?:wp-admin|wp-login\.php|[^/]*(?:logout|delete|remove|edit|create|submit|update|auth|login|register|account|password)[^/]*)(?:\/|$)/i.test(path)||/\.(?:pdf|zip|docx?|xlsx|png|jpg)$/i.test(path)||[...u.searchParams.keys()].some(k=>!['s','paged','page_id'].includes(k)))throw new Error('Der Assistent kann nur lesende Spaces-Seiten öffnen.');
  u.hash='';return u.href;
}
export function requestAgentBrowser(command,{signal}={}){
  if(!agentBrowserAvailable())return Promise.reject(new Error('Spaces-Browserwerkzeuge benötigen die aktuelle Context-Mac-App.'));
  const id=crypto.randomUUID();
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);pending.delete(id);};
    const abort=()=>{cleanup();send({type:'cancel',id});reject(new DOMException('Abgebrochen','AbortError'));};
    const timer=setTimeout(()=>{cleanup();send({type:'cancel',id});reject(new Error('Spaces hat zu lange gebraucht. Prüfe den eingebauten Browser.'));},30000);
    pending.set(id,{resolve:value=>{cleanup();value.error?reject(new Error(value.error)):resolve(value);},reject});
    if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
    send({type:'request',id,...command});
  });
}
if(typeof window!=='undefined')window.addEventListener('context-agent-browser',event=>{
  const data=event.detail;if(data&&typeof data.id==='string')pending.get(data.id)?.resolve(data);
});
