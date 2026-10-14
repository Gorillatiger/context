import {activeRecipientToken,replaceRecipientToken} from './mail-contacts.js';
const fields=new Set(['to','cc','bcc']);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Small synchronous, local combobox. Typing updates only the suggestion list;
// it never rerenders the mail reader, persists contacts or makes a request.
export function createMailRecipientUI({contacts,getDraft,getAccount,enabled,onSelect,owner='th',document:doc=globalThis.document}={}){
  if(!['th','outlook','gmail'].includes(owner))throw new Error('Ungültiges Mailkonto.');
  let current=null,composing=false,disposed=false;
  const handlers=[];
  const inputFor=field=>doc.getElementById?.('mail-'+field);
  const owns=input=>fields.has(input?.dataset?.mailField)&&input.dataset.mailContactOwner===owner;
  const usable=()=>!disposed&&enabled()===true&&!!getAccount();
  function close(){
    const previous=current;current=null;
    if(!previous)return;
    const input=inputFor(previous.field);if(!owns(input))return;
    input.setAttribute?.('aria-expanded','false');input.removeAttribute?.('aria-activedescendant');
    const list=doc.getElementById?.('mail-'+previous.field+'-contacts');if(list){list.hidden=true;list.innerHTML='';}
    const status=doc.getElementById?.('mail-'+previous.field+'-contact-status');if(status)status.textContent='';
  }
  function paint(){
    if(!current)return;const input=inputFor(current.field),list=doc.getElementById?.('mail-'+current.field+'-contacts');
    if(!owns(input)||!list||!usable()||current.account!==getAccount()){close();return;}
    list.innerHTML=current.rows.map((row,index)=>`<button type="button" role="option" tabindex="-1" id="mail-${current.field}-contact-${index}" data-mail-contact="${index}" data-contact-field="${current.field}" data-contact-owner="${owner}" aria-selected="${index===current.index}" class="mail-contact-option${index===current.index?' selected':''}"><span class="mail-contact-avatar" aria-hidden="true">${escape(Array.from(row.name||row.address)[0].toLocaleUpperCase('de'))}</span><span class="mail-contact-name"><strong>${escape(row.name||row.address)}</strong>${row.name?`<small dir="ltr">${escape(row.address)}</small>`:''}</span></button>`).join('');
    list.hidden=false;input.setAttribute('aria-expanded','true');
    if(current.index>=0)input.setAttribute('aria-activedescendant','mail-'+current.field+'-contact-'+current.index);else input.removeAttribute('aria-activedescendant');
    const status=doc.getElementById?.('mail-'+current.field+'-contact-status');if(status)status.textContent=current.rows.length+' Kontaktvorschläge';
    if(current.index>=0)doc.getElementById?.('mail-'+current.field+'-contact-'+current.index)?.scrollIntoView?.({block:'nearest'});
  }
  function refresh(input){
    if(!owns(input)||!usable()||composing){close();return;}
    const draft=getDraft(),field=input.dataset.mailField,value=input.value,cursor=input.selectionStart??value.length,end=input.selectionEnd??cursor;
    const token=activeRecipientToken(value,cursor,end);if(!token?.query){close();return;}
    const rows=contacts.suggest({value,cursor,selectionEnd:end,field,fields:draft});
    close();if(!rows.length)return;
    current={field,value,cursor,end,rows,index:-1,account:getAccount()};paint();
  }
  function choose(index){
    const snapshot=current,row=snapshot?.rows[index],input=snapshot&&inputFor(snapshot.field);
    if(!row||!owns(input)||!usable()||snapshot.account!==getAccount()||input.value!==snapshot.value||getDraft()[snapshot.field]!==snapshot.value){close();return false;}
    const replacement=replaceRecipientToken(snapshot.value,snapshot.cursor,row.address,snapshot.end);if(!replacement){close();return false;}
    // Re-resolve against current recipients: another field may have changed.
    if(!contacts.suggest({value:snapshot.value,cursor:snapshot.cursor,selectionEnd:snapshot.end,field:snapshot.field,fields:getDraft()}).some(value=>value.address===row.address)){close();return false;}
    onSelect(snapshot.field,replacement.value);input.value=replacement.value;close();input.focus?.({preventScroll:true});input.setSelectionRange?.(replacement.selectionStart,replacement.selectionEnd);return true;
  }
  const listen=(type,handler)=>{doc.addEventListener(type,handler);handlers.push([type,handler]);};
  listen('input',event=>{if(owns(event.target)&&!event.isComposing)refresh(event.target);});
  listen('focusin',event=>{if(owns(event.target))refresh(event.target);});
  listen('focusout',event=>{if(owns(event.target)&&!event.relatedTarget?.closest?.('[data-mail-contact]'))close();});
  listen('compositionstart',event=>{if(owns(event.target)){composing=true;close();}});
  listen('compositionend',event=>{if(owns(event.target)){composing=false;refresh(event.target);}});
  listen('click',event=>{
    const option=event.target.closest?.('[data-mail-contact]');
    if(option?.dataset.contactOwner===owner&&usable()){event.preventDefault();if(option.dataset.contactField===current?.field)choose(Number(option.dataset.mailContact));return;}
    if(owns(event.target)){refresh(event.target);return;}
    if(current&&enabled()===true)close();
  });
  listen('keydown',event=>{
    if(!owns(event.target)||!usable()||event.isComposing||composing||event.keyCode===229)return;
    if(event.key==='Enter'){
      event.preventDefault();event.stopImmediatePropagation?.();
      if(current)choose(current.index>=0?current.index:current.rows.length===1?0:-1);return;
    }
    if(event.key==='Escape'&&current){event.preventDefault();event.stopImmediatePropagation?.();close();return;}
    if(['ArrowDown','ArrowUp'].includes(event.key)){
      if(!current)refresh(event.target);if(!current)return;
      event.preventDefault();event.stopImmediatePropagation?.();const length=current.rows.length;
      current.index=event.key==='ArrowDown'?(current.index+1)%length:(current.index<0?length-1:(current.index+length-1)%length);paint();
    }
  });
  listen('keyup',event=>{if(owns(event.target)&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key))refresh(event.target);});
  return {
    render(field,value,label){if(!fields.has(field))throw new Error('Ungültiges Empfängerfeld.');return `<div class="mail-address-line"><label for="mail-${field}">${escape(label)}</label><div class="mail-recipient-control"><input id="mail-${field}" data-mail-field="${field}" data-mail-contact-owner="${owner}" name="${field}" value="${escape(value)}" maxlength="12000" placeholder="${field==='to'?'Name oder E-Mail-Adresse':'Optional'}" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="mail-${field}-contacts" ${field==='to'?'required':''}><div id="mail-${field}-contacts" class="mail-recipient-list" role="listbox" aria-label="Kontaktvorschläge für ${escape(label)}" hidden></div><span id="mail-${field}-contact-status" class="sr-only" role="status" aria-live="polite"></span></div></div>`;},
    close,dispose(){if(disposed)return;close();disposed=true;for(const [type,handler]of handlers)doc.removeEventListener?.(type,handler);}
  };
}
