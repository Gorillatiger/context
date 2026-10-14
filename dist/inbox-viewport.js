const controls='button,select,summary,a';
function identity(node){
  if(!node)return '';
  if(node.id)return 'id:'+node.id;
  if(node.getAttribute?.('data-notification-course'))return 'course:'+node.getAttribute('data-notification-course');
  if(node.tagName==='SUMMARY')return 'detail:'+node.parentElement?.dataset?.inboxDetail;
  if(node.dataset?.action)return ['action',node.dataset.action,node.dataset.id||'',node.dataset.value||''].join(':');
  return '';
}
export function captureInboxViewport(document=globalThis.document){
  const container=document?.querySelector('.inbox-workspace');if(!container)return null;
  return {key:container.dataset.inboxScope,top:document.scrollingElement?.scrollTop||0,
    details:[...container.querySelectorAll('details[data-inbox-detail]')].map(detail=>[detail.dataset.inboxDetail,detail.open]),
    focus:container.contains(document.activeElement)?identity(document.activeElement):''};
}
export function restoreInboxViewport(snapshot,document=globalThis.document){
  const container=document?.querySelector('.inbox-workspace');if(!snapshot||!container||snapshot.key!==container.dataset.inboxScope)return;
  const expanded=new Map(snapshot.details);
  for(const detail of container.querySelectorAll('details[data-inbox-detail]'))if(expanded.has(detail.dataset.inboxDetail))detail.open=expanded.get(detail.dataset.inboxDetail);
  if(snapshot.focus){const control=[...container.querySelectorAll(controls)].find(node=>identity(node)===snapshot.focus);if(control&&!control.disabled)control.focus({preventScroll:true});}
  if(document.scrollingElement)document.scrollingElement.scrollTop=snapshot.top;
}
