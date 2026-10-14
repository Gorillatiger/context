export const nativeSpacesAvailable=()=>typeof window.contextDesktop?.space==='function'||typeof window.webkit?.messageHandlers?.contextSpace?.postMessage==='function';
const send=message=>{if(window.contextDesktop?.space)void window.contextDesktop.space(message);else if(nativeSpacesAvailable())window.webkit.messageHandlers.contextSpace.postMessage(message);};
export function openNativeSpace(url){send({type:'open',url});}

let release;
export function detachNativeSpace(){release?.();release=undefined;}

// Only geometry is shared with the native host. The provider page has no bridge.
export function mountNativeSpace(url,slot,dialog){
  detachNativeSpace();
  if(!nativeSpacesAvailable()||!slot)return;
  send({type:'embed',url});
  let pending=false,released=false,last='';
  const update=()=>{
    const r=slot.getBoundingClientRect(),d=(dialog.querySelector('.project-scroll-body')||dialog).getBoundingClientRect();
    const visible=slot.isConnected&&dialog.open&&r.width>0&&r.height>0&&!document.querySelector('#search-modal[open]');
    const message={type:'frame',visible,viewport:{width:innerWidth,height:innerHeight},rect:{x:r.x,y:r.y,width:r.width,height:r.height},clip:{x:Math.max(0,d.left+dialog.clientLeft),y:Math.max(0,d.top+dialog.clientTop),width:Math.min(innerWidth,d.right-dialog.clientLeft)-Math.max(0,d.left+dialog.clientLeft),height:Math.min(innerHeight,d.bottom-dialog.clientTop)-Math.max(0,d.top+dialog.clientTop)}};
    const serialized=JSON.stringify(message);
    if(serialized!==last){last=serialized;send(message);}
  };
  const schedule=()=>{if(!pending){pending=true;queueMicrotask(()=>{pending=false;if(!released)update();});}};
  const resize=new ResizeObserver(schedule);
  resize.observe(slot);resize.observe(dialog);
  const mutation=new MutationObserver(schedule);
  mutation.observe(dialog,{attributes:true,attributeFilter:['open','class']});
  const search=document.querySelector('#search-modal');
  if(search)mutation.observe(search,{attributes:true,attributeFilter:['open']});
  document.addEventListener('scroll',schedule,true);
  window.addEventListener('resize',schedule);
  window.addEventListener('context-agent-layout',schedule);
  document.addEventListener('visibilitychange',schedule);
  window.addEventListener('pagehide',detachNativeSpace);
  release=()=>{
    released=true;resize.disconnect();mutation.disconnect();
    document.removeEventListener('scroll',schedule,true);
    window.removeEventListener('resize',schedule);
    window.removeEventListener('context-agent-layout',schedule);
    document.removeEventListener('visibilitychange',schedule);
    window.removeEventListener('pagehide',detachNativeSpace);
    send({type:'detach'});
  };
  update();
}
