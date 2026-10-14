import {chatIcon} from './ki.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function createFloatingAgent({agent,getContext,onOpenChange,native=false}){
  let attention=0,opened=false,returnFocus,contextKey='',rendering=false;
  const scrollPositions=new Map();
  const scrollHost=()=>{const thread=panel.querySelector('.ki-thread');return thread&&getComputedStyle(thread).overflowY==='visible'?thread.closest('.ki-workspace'):thread;};
  const scrollKey=scope=>JSON.stringify([scope,panel.querySelector('#ki-history')?.value||'']);
  const launcher=document.createElement('button');
  launcher.id='context-agent-launcher';launcher.type='button';launcher.className='context-agent-launcher';
  launcher.setAttribute('aria-label','Kontextassistent öffnen');launcher.setAttribute('aria-controls','context-agent-panel');
  launcher.innerHTML='<span aria-hidden="true">✳</span><span class="agent-launcher-label">Frag Context</span>';
  const panel=document.createElement('section');
  panel.id='context-agent-panel';panel.className='context-agent-panel';panel.hidden=true;
  panel.setAttribute('aria-label','Kontextassistent');
  if(native)launcher.classList.add('native-launcher');

  function mount(){
    const dialog=document.querySelector('#modal[open]');
    const slot=dialog?.querySelector('#project-agent-slot')||(!dialog?document.querySelector('#browser-agent-slot'):null);
    const host=slot||dialog||document.body;
    if(panel.parentElement!==host)host.append(panel);
    const launchHost=dialog||document.body;
    if(launcher.parentElement!==launchHost)launchHost.append(launcher);
    panel.classList.toggle('docked',!!slot);
    dialog?.querySelector('.project-workbench')?.classList.toggle('agent-open',opened);
    document.querySelector('.browser-workbench')?.classList.toggle('agent-open',opened);
    if(dialog?.classList.contains('project-workspace'))dialog.classList.toggle('with-agent',opened);
    launcher.setAttribute('aria-expanded',String(opened));
    launcher.setAttribute('aria-label',opened?'Kontextassistent schließen':'Kontextassistent öffnen');
    launcher.classList.toggle('is-open',opened);
    document.querySelectorAll('[data-action="context-agent"]').forEach(b=>{b.setAttribute('aria-expanded',String(opened));b.setAttribute('aria-label',opened?'Kontextassistent schließen':'Kontextassistent öffnen');});
    window.webkit?.messageHandlers?.contextFloating?.postMessage({type:'state',open:opened});
    window.dispatchEvent(new Event('context-agent-layout'));
  }
  function render(){
    if(rendering)return;
    rendering=true;
    const c=getContext();
    const previous=scrollHost();
    if(previous?.clientHeight>0){
      const key=scrollKey(contextKey),following=previous.scrollHeight-previous.clientHeight-previous.scrollTop<=48;
      if(scrollPositions.size>=100&&!scrollPositions.has(key))scrollPositions.delete(scrollPositions.keys().next().value);
      scrollPositions.set(key,{top:previous.scrollTop,left:previous.scrollLeft||0,following});
    }
    if(contextKey&&contextKey!==c.projectId&&agent.isBusy())agent.stop();
    contextKey=c.projectId;
    const active=document.activeElement,id=active?.id;
    const selection=active instanceof HTMLTextAreaElement?[active.selectionStart,active.selectionEnd,active.selectionDirection]:null;
    const details=new Map([...panel.querySelectorAll?.('details[data-chat-detail]')||[]].map(d=>[d.dataset.chatDetail,d.open]));
    mount();panel.hidden=!opened;
    if(!opened)panel.innerHTML="";
    if(opened){
      panel.innerHTML=`<header class="context-agent-header"><span class="context-agent-mark" aria-hidden="true">✳</span><div><strong>Context</strong><span>${esc(c.projectName)}</span></div><button type="button" aria-label="Kursaufgaben${attention?', '+attention+' neue Hinweise':''}" title="Kursaufgaben" data-view="companion">${chatIcon('tasks')}${attention?`<span class="context-agent-attention" aria-hidden="true">${attention}</span>`:''}</button><button type="button" class="context-agent-close" aria-label="Kontextassistent schließen" title="Chat schließen" data-floating-action="close">${chatIcon('close')}</button></header>${c.browserCurrent?`<div class="context-agent-location" title="${esc(c.label)}"><span class="tiny-dot"></span>${esc('Geöffnete Spaces-Seite · '+c.label)}</div>`:''}<div class="context-agent-content">${agent.render({compact:true})}</div>`;
      for(const d of panel.querySelectorAll?.('details[data-chat-detail]')||[])if(details.has(d.dataset.chatDetail))d.open=details.get(d.dataset.chatDetail);
      const candidate=id?document.getElementById(id):null;const replacement=candidate&&panel.contains(candidate)?candidate:null;
      if(replacement){replacement.focus({preventScroll:true});if(selection)replacement.setSelectionRange(...selection);}
      const host=scrollHost(),position=scrollPositions.get(scrollKey(c.projectId));
      if(host?.clientHeight>0){
        const end=Math.max(0,host.scrollHeight-host.clientHeight);
        host.scrollTop=position?(position.following?end:Math.max(0,Math.min(position.top,end))):panel.querySelector('.ki-message,.ki-thinking')?end:0;
        if(position)host.scrollLeft=position.left;
      }
    }
    rendering=false;
  }
  function toggle(next=!opened){
    if(next===opened){render();return;}
    if(next)returnFocus=document.activeElement;
    if(!next)agent.closeMenus?.();
    opened=next;onOpenChange(opened);render();
    if(opened){const focusPrompt=()=>{if(opened&&(document.activeElement===returnFocus||document.activeElement===launcher||document.activeElement===document.body))panel.querySelector('#ki-prompt,#ki-key')?.focus({preventScroll:true});};void agent.load().then(focusPrompt);focusPrompt();}
    else{if(returnFocus?.isConnected&&!returnFocus.closest('[inert]'))returnFocus.focus({preventScroll:true});else if(!native)(document.querySelector('#browser-assistant-toggle')||launcher).focus({preventScroll:true});}
  }
  launcher.addEventListener('click',()=>toggle());
  panel.addEventListener('click',e=>{const action=e.target.closest('[data-floating-action]')?.dataset.floatingAction;if(action==='close')toggle(false);if(action==='new'){agent.newChat();render();}});
  document.addEventListener('keydown',e=>{
    if(e.defaultPrevented||e.key==='Escape'&&panel.querySelector('[data-ki-menu]:not([hidden])'))return;
    if(e.key==='Escape'&&opened&&!document.querySelector('#search-modal[open]')){e.preventDefault();e.stopImmediatePropagation();toggle(false);}
    else if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==='k'){e.preventDefault();toggle();}
  },true);
  document.querySelector('#modal').addEventListener('cancel',e=>{if(opened){e.preventDefault();toggle(false);}});
  window.addEventListener('context-agent-toggle',e=>toggle(typeof e.detail?.open==='boolean'?e.detail.open:!opened));
  render();
  return {render,toggle,setAttention(count){attention=Math.max(0,Math.min(150,Number(count)||0));launcher.innerHTML='<span aria-hidden="true">✳</span><span class="agent-launcher-label">Frag Context</span>'+(attention?'<span class="agent-attention">'+attention+'<span class="sr-only"> neue Aufgabenhinweise</span></span>':'');},isOpen:()=>opened};
}
