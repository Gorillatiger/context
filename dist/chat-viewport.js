export function chatViewport(document=globalThis.document,style=globalThis.getComputedStyle){
  const thread=document?.querySelector('.ki-thread');
  if(!thread)return null;
  const host=style(thread).overflowY==='visible'?thread.closest('.ki-workspace')||thread:thread;
  return {host,thread,key:thread.dataset?.viewportKey||''};
}

export function captureChatViewport(document,style){
  const viewport=chatViewport(document,style);if(!viewport)return null;
  const {host,key,thread}=viewport,container=thread.closest('.ki-workspace')||thread;
  const details=[...(container.querySelectorAll?.('details[data-chat-detail]')||[])].map(detail=>[detail.dataset.chatDetail,detail.open]);
  return {key,top:host.scrollTop,follow:host.scrollHeight-host.clientHeight-host.scrollTop<=36,details};
}

export function restoreChatViewport(snapshot,document,style){
  const viewport=chatViewport(document,style);
  if(!snapshot||!viewport||snapshot.key!==viewport.key)return;
  const details=new Map(snapshot.details||[]),container=viewport.thread.closest('.ki-workspace')||viewport.thread;
  for(const detail of container.querySelectorAll?.('details[data-chat-detail]')||[])if(details.has(detail.dataset.chatDetail))detail.open=details.get(detail.dataset.chatDetail);
  viewport.host.scrollTop=snapshot.follow?viewport.host.scrollHeight:snapshot.top;
}

export function scrollChatViewport(force=false,document,style){
  const viewport=chatViewport(document,style);if(!viewport)return;
  const host=viewport.host;
  if(force||host.scrollHeight-host.clientHeight-host.scrollTop<=36)host.scrollTo({top:host.scrollHeight,behavior:'instant'});
}
