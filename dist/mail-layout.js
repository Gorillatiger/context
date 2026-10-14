// Keep a mail reader's place through ordinary state updates. No message content
// or draft text is copied; different folders/pages/messages start at the top.
const areaIds=['mail-folder-nav','mail-list','mail-reader','mail-text'];
const positions=new Map();
function key(element,root){
  if(element.id==='mail-text')return root.getElementById('mail-reader')?.dataset.mailScrollKey||'';
  return element.dataset.mailScrollKey||'';
}
function focusIdentity(element,root){
  if(!element?.closest?.('.mail-workspace,.mail-heading,.mail-setup'))return null;
  const owner=element.closest('[data-mail-scroll-key]');
  const identity={id:element.id||'',action:element.dataset?.mailAction||'',target:element.dataset?.id||'',owner:owner?.id||'',key:owner?key(owner,root):''};
  if(!identity.id&&!identity.action)return null;
  if(typeof element.selectionStart==='number')identity.selection=[element.selectionStart,element.selectionEnd,element.selectionDirection];
  return identity;
}
export function captureMailViewport(root=document){
  const areas=areaIds.flatMap(id=>{
    const e=root.getElementById(id);if(!e)return[];
    const scope=key(e,root),cacheKey=id+'\n'+scope;
    const visible=(!e.getClientRects||e.getClientRects().length>0)&&e.getAttribute?.('aria-busy')!=='true';
    const saved=visible?{id,key:scope,top:e.scrollTop,left:e.scrollLeft}:positions.get(cacheKey)||{id,key:scope,top:0,left:0};
    positions.delete(cacheKey);positions.set(cacheKey,saved);
    while(positions.size>32)positions.delete(positions.keys().next().value);
    return[saved];
  });
  if(!areas.length)positions.clear();
  if(!areas.length&&!root.querySelector('.mail-setup'))return null;
  return{areas,focus:focusIdentity(root.activeElement,root)};
}
export function restoreMailViewport(snapshot,root=document){
  if(!snapshot)return;
  const focus=snapshot.focus;
  if(focus&&(!focus.owner||key(root.getElementById(focus.owner)||{id:'',dataset:{}},root)===focus.key)){
    const replacement=focus.id?root.getElementById(focus.id):Array.from(root.querySelectorAll('[data-mail-action]')).find(e=>e.dataset.mailAction===focus.action&&(e.dataset.id||'')===focus.target);
    if(replacement&&!replacement.disabled){
      replacement.focus({preventScroll:true});
      if(focus.selection)try{replacement.setSelectionRange(...focus.selection);}catch{}
    }
  }
  // Restore after focus and selection: browsers may scroll textareas to the caret.
  for(const area of snapshot.areas){const e=root.getElementById(area.id);if(e&&key(e,root)===area.key){e.scrollTop=area.top;e.scrollLeft=area.left;}}
}
