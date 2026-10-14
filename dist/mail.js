import {createMailContacts,verifiedMailAddress} from './mail-contacts.js';
import {createMailRecipientUI} from './mail-recipient-ui.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const addressPattern=/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
export function mailRecipients(value){
  if(!String(value).trim())return [];
  const result=[...new Set(String(value).split(/[,;]/).map(v=>v.trim()))];
  if(result.length>50||result.some(v=>v.length>254||!addressPattern.test(v)))throw new Error('Bitte nur E-Mail-Adressen eingeben, getrennt durch Komma oder Semikolon.');
  return result;
}
const sizeLabel=bytes=>bytes>=1024*1024?(bytes/(1024*1024)).toFixed(1)+' MB':Math.max(1,Math.round(bytes/1024))+' KB';
const dateLabel=value=>{try{return new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}catch{return 'Datum fehlt';}};
const blankDraft=()=>({to:'',cc:'',bcc:'',subject:'',text:'',inReplyTo:'',attachments:[]});
const draftHasContent=draft=>['to','cc','bcc','subject','text','inReplyTo'].some(field=>String(draft[field]||'').trim())||draft.attachments.length>0;
export function createMailView({onChange,onConnection,request,service='th',isActive=()=>true}){
  if(!['th','outlook','gmail'].includes(service)||service!=='th'&&typeof request!=='function')throw new Error('Die Cloud-Mailansicht benötigt eine lokale Verbindung.');
  const cloud=service!=='th',providerName={th:'TH-Mail',outlook:'Outlook',gmail:'Gmail'}[service],serverLabel=cloud?providerName:'TH-Mailserver',webmailLabel=cloud?providerName:'TH-Webmail';
  const active=()=>isActive()===true,canModify=()=>!cloud||state.capabilities?.mailModify===true,canSend=()=>!cloud||state.configured&&state.smtpReady&&state.capabilities?.mailSend===true;
  const state={loaded:false,loading:false,configured:false,address:'',setupUser:'',setupAddress:'',smtpReady:false,capabilities:{},accountKey:'',folders:[],folder:cloud?'INBOX':'SU5CT1g',items:[],uidValidity:'',total:0,matched:0,offset:0,nextOffset:null,query:'',search:'',unread:false,selected:'',message:null,listBusy:false,listError:'',messageBusy:false,connecting:false,disconnecting:false,sending:false,flagBusy:false,downloadBusy:false,attachmentPending:0,error:'',notice:'',compose:false,draft:blankDraft(),review:null,reviewAccountKey:'',requestId:'',deliveryUnknown:false};
  let listVersion=0,messageVersion=0,connectionVersion=0,loadVersion=0,openVersion=0,draftVersion=0,flagVersion=0,downloadVersion=0,loadPromise=null,readyDownload=null;
  const contacts=createMailContacts();
  const contactAccount=()=>{const identity=cloud?state.accountKey:verifiedMailAddress(state.address).toLowerCase();return state.configured&&identity?service+':'+identity+':'+connectionVersion:'';};
  const syncContacts=()=>contacts.setAccount(contactAccount());
  const recipientUI=createMailRecipientUI({contacts,owner:service,getAccount:contactAccount,getDraft:()=>state.draft,enabled:()=>active()&&state.configured&&state.compose&&!state.review&&!state.sending&&!state.disconnecting&&!state.connecting,onSelect:(field,value)=>{state.draft[field]=value;}});
  const clearDownload=()=>{if(readyDownload?.url.startsWith('blob:'))URL.revokeObjectURL(readyDownload.url);readyDownload=null;};
  const update=focus=>{onChange({intentFocus:active()?(focus||''):''});if(focus&&active())document.getElementById(focus)?.focus();};
  const invalidateMessage=()=>{messageVersion++;flagVersion++;downloadVersion++;state.messageBusy=false;state.flagBusy=false;state.downloadBusy=false;clearDownload();};
  const invalidateConnection=()=>{recipientUI.close();contacts.setAccount('');connectionVersion++;loadVersion++;listVersion++;openVersion++;loadPromise=null;state.loading=false;state.listBusy=false;invalidateMessage();};
  const replaceDraft=draft=>{recipientUI.close();draftVersion++;state.draft=draft;state.attachmentPending=0;state.review=null;state.reviewAccountKey='';state.requestId='';state.deliveryUnknown=false;};
  function resetConnection(status={}){
    const uncertain=state.sending||state.deliveryUnknown;
    invalidateConnection();draftVersion++;
    Object.assign(state,{loaded:false,configured:false,address:'',smtpReady:false,capabilities:{},accountKey:'',folders:[],items:[],folder:cloud?'INBOX':'SU5CT1g',uidValidity:'',total:0,matched:0,offset:0,nextOffset:null,query:'',search:'',unread:false,selected:'',message:null,listError:'',connecting:false,disconnecting:false,sending:false,attachmentPending:0,review:null,reviewAccountKey:'',requestId:'',error:'',compose:draftHasContent(state.draft),deliveryUnknown:uncertain,...status});
    state.notice=uncertain?`Verbindung geändert. Der Versandstatus ist unklar; prüfe ${webmailLabel}, bevor du eine neue Nachricht sendest.`:draftHasContent(state.draft)?'Verbindung geändert. Entwurf vor Versand erneut prüfen.':'';
  }
  async function api(action,body){
    if(request)return request(action,body);
    const response=await fetch('/api/mail/'+action,{credentials:'same-origin',...(body!==undefined?{method:'POST',headers:{'Content-Type':'application/json','X-Context-Request':'mail-request'},body:JSON.stringify(body)}:{})});
    if(action==='attachment'&&response.ok)return response.blob();
    let result;try{result=await response.json();}catch{const error=new Error(response.status===403?'Die lokale Sitzung ist nicht mehr gültig. Sichere offene Entwürfe und lade den Arbeitsbereich neu.':'Der lokale Mailserver ist nicht erreichbar. Starte die aktuelle Context-Version.');error.httpStatus=response.status;if(response.status===403)error.code='session_expired';throw error;}
    if(!response.ok){const error=new Error(result.message||'Die Mail-Anfrage ist fehlgeschlagen.');error.code=result.error;error.httpStatus=response.status;throw error;}
    return result;
  }
  const target=()=>({folder:state.folder,uid:state.selected,uidValidity:state.message?.uidValidity||state.uidValidity});
  async function readList(offset=0){
    const version=++listVersion,connection=connectionVersion,context={folder:state.folder,query:state.query,unread:state.unread,offset};
    state.listBusy=true;state.listError='';state.error='';state.offset=offset;update();
    try{
      const result=await api('list',context);
      if(version!==listVersion||connection!==connectionVersion)return null;
      if(state.uidValidity&&state.uidValidity!==result.uidValidity){state.selected='';state.message=null;invalidateMessage();}
      Object.assign(state,{items:result.items,uidValidity:result.uidValidity,total:result.total,matched:result.matched,nextOffset:result.nextOffset});
      syncContacts();contacts.ingest(result.items);
      return result;
    }catch(error){if(version===listVersion&&connection===connectionVersion){state.error=error.message;state.listError=error.message;}}
    finally{if(version===listVersion&&connection===connectionVersion){state.listBusy=false;update();}}
    return null;
  }
  function load(force=false){
    if(state.connecting||state.disconnecting)return Promise.resolve();
    if(state.loading)return loadPromise;
    if(state.loaded&&!force)return Promise.resolve();
    const version=++loadVersion,connection=connectionVersion,current=()=>version===loadVersion&&connection===connectionVersion;
    state.loading=true;state.error='';
    loadPromise=(async()=>{
      try{
        const status=await api('status');if(!current())return;
        if(cloud&&state.accountKey&&(state.accountKey!==status.accountKey||JSON.stringify(state.capabilities)!==JSON.stringify(status.capabilities))){resetConnection(status);return load(true);}
        if(!cloud&&state.configured&&(status.configured!==true||state.address.toLowerCase()!==String(status.address||'').toLowerCase())){resetConnection(status);return load(true);}
        Object.assign(state,status);
        syncContacts();
        if(state.configured){
          const result=await api('folders',{});if(!current())return;
          state.folders=result.folders;
          if(!state.folders.some(f=>f.id===state.folder)){state.folder=state.folders.find(f=>f.kind==='inbox')?.id||state.folders[0]?.id||'SU5CT1g';state.uidValidity='';state.selected='';state.message=null;invalidateMessage();}
          await readList();
        }
      }catch(error){if(current()){state.error=error.message;if(state.configured)state.listError=error.message;}}
      finally{if(current()){state.loaded=true;state.loading=false;loadPromise=null;update();}}
    })();update();return loadPromise;
  }
  async function connect(form){
    if(cloud||state.connecting||state.disconnecting)return;
    const data={user:form.elements.user.value.trim(),address:form.elements.address.value.trim(),password:form.elements.password.value};
    invalidateConnection();const connection=connectionVersion;
    state.setupUser=data.user;state.setupAddress=data.address;form.elements.password.value='';state.connecting=true;state.error='';update();
    try{
      const result=await api('connection',data);if(connection!==connectionVersion)return;Object.assign(state,result);state.folder=state.folders.find(f=>f.kind==='inbox')?.id||state.folders[0]?.id||'SU5CT1g';state.uidValidity='';state.selected='';state.message=null;
      state.notice=result.smtpWarning?'Posteingang verbunden. Die SMTP-Anmeldung konnte noch nicht bestätigt werden. Beim Senden wird sie erneut geprüft.':'';
      await readList();onConnection({action:'connection',configured:state.configured});
    }catch(error){if(connection===connectionVersion)state.error=error.message;}
    finally{if(connection===connectionVersion){state.connecting=false;state.loaded=true;update();}}
  }
  async function disconnect(){
    if(state.sending||state.connecting||state.disconnecting)return;
    invalidateConnection();const connection=connectionVersion;state.disconnecting=true;state.error='';update();
    try{
      await api('connection',{disconnect:true});if(connection!==connectionVersion)return;
      if(cloud){state.review=null;state.reviewAccountKey='';state.requestId='';state.attachmentPending=0;draftVersion++;}else replaceDraft(blankDraft());
      Object.assign(state,{configured:false,address:'',smtpReady:false,capabilities:{},accountKey:'',folders:[],items:[],uidValidity:'',listError:'',total:0,matched:0,offset:0,nextOffset:null,query:'',search:'',unread:false,selected:'',message:null,compose:cloud&&draftHasContent(state.draft),error:'',notice:cloud?'Lokale Kontoverknüpfung getrennt. Dein Entwurf bleibt im Arbeitsspeicher. OAuth-Freigaben verwaltest du in Nango.':'Mailkonto getrennt. Zugangsdaten und die Mailansicht wurden geleert.'});onConnection({action:'connection',configured:state.configured});
    }catch(error){if(connection===connectionVersion)state.error=error.message;}
    finally{if(connection===connectionVersion){state.disconnecting=false;update(state.configured||cloud?undefined:'mail-user');}}
  }
  async function openMessage(uid,intent=++openVersion){
    if(state.disconnecting||state.connecting)return;
    invalidateMessage();
    const version=++messageVersion,connection=connectionVersion;
    state.selected=uid;state.message=null;state.messageBusy=true;state.compose=false;state.error='';const selected=target();update();
    try{const message=await api('message',selected);if(version===messageVersion&&connection===connectionVersion&&intent===openVersion){state.message=message;syncContacts();contacts.ingest([message]);}}
    catch(error){if(version===messageVersion&&connection===connectionVersion)state.error=error.message;}
    finally{if(version===messageVersion&&connection===connectionVersion&&intent===openVersion){state.messageBusy=false;update(state.message?'mail-message-heading':undefined);}}
  }
  function selectFolder(id){
    if(state.listBusy||state.disconnecting||state.connecting)return;
    openVersion++;invalidateMessage();state.folder=id;state.uidValidity='';state.selected='';state.message=null;state.compose=false;void readList();
  }
  function compose(mode='new'){
    if(state.sending||state.disconnecting||state.connecting)return;
    recipientUI.close();syncContacts();
    openVersion++;invalidateMessage();
    if(mode==='reply'&&state.message){
      if(draftHasContent(state.draft)||state.attachmentPending){state.error='Dein Entwurf bleibt erhalten. Verwirf ihn zuerst, bevor du eine andere Antwort beginnst.';state.compose=true;update();return;}
      const message=state.message;
      const recipients=(message.replyTo?.length?message.replyTo:message.from||[]).map(p=>p.address).filter(a=>addressPattern.test(a));
      state.draft={...blankDraft(),to:recipients.join(', '),subject:/^re:/i.test(message.subject)?message.subject:'Re: '+message.subject,
        text:'\n\nAm '+dateLabel(message.date)+' schrieb '+message.sender+':\n'+message.text.slice(0,85000).split('\n').map(line=>'> '+line).join('\n'),
        inReplyTo:/^<[^<>\s\x00-\x1f]{1,480}>$/.test(message.messageId)?message.messageId:''};
    }
    state.compose=true;state.review=null;state.reviewAccountKey='';state.error='';update('mail-to');
  }
  function review(){
    if(state.sending)return;
    recipientUI.close();
    try{
      if(state.disconnecting||state.connecting)return;
      if(!canSend())throw new Error(`Versand für ${providerName} ist nicht freigegeben. Aktiviere die Versandberechtigung unter Verbindungen.`);
      if(cloud&&!/^[a-f0-9]{64}$/.test(state.accountKey))throw new Error('Die Kontoverbindung hat sich geändert. Aktualisiere die Mailansicht und prüfe den Entwurf erneut.');
      if(state.deliveryUnknown)throw new Error(`Der Versandstatus ist weiterhin unklar. Prüfe ${webmailLabel} oder den Empfänger. Dieser Entwurf bleibt für erneuten Versand gesperrt.`);
      if(state.attachmentPending)throw new Error('Die Anhänge werden noch eingelesen. Warte, bevor du den Versand prüfst.');
      const draft={...state.draft,to:mailRecipients(state.draft.to),cc:mailRecipients(state.draft.cc),bcc:mailRecipients(state.draft.bcc),attachments:state.draft.attachments.map(file=>Object.freeze({...file}))};
      if(!draft.to.length)throw new Error('Trage mindestens einen Empfänger unter An ein.');
      if(draft.to.length+draft.cc.length+draft.bcc.length>50)throw new Error('Höchstens 50 Empfänger pro Nachricht.');
      if(!draft.subject.trim()||/[\x00-\x1f\x7f]/.test(draft.subject))throw new Error('Bitte einen Betreff ohne Zeilenumbrüche eingeben.');
      if(!draft.text.trim())throw new Error('Bitte einen Nachrichtentext eingeben.');
      for(const field of ['to','cc','bcc','attachments'])Object.freeze(draft[field]);
      state.review=Object.freeze(draft);state.reviewAccountKey=cloud?state.accountKey:'';state.requestId=crypto.randomUUID();state.error='';update('mail-send-now');
    }catch(error){state.error=error.message;update();}
  }
  async function send(){
    if(state.sending||state.disconnecting||state.connecting||state.attachmentPending||!state.review||state.deliveryUnknown||!canSend())return;
    if(cloud&&(!state.reviewAccountKey||state.reviewAccountKey!==state.accountKey)){state.review=null;state.reviewAccountKey='';state.error='Die Kontoverbindung hat sich geändert. Prüfe den Entwurf erneut.';update();return;}
    const approved=state.review,connection=connectionVersion;let focus;
    state.sending=true;state.error='';update();
    try{
      const result=await api('send',{requestId:state.requestId,draft:approved,...(cloud?{accountKey:state.reviewAccountKey}:{})});if(connection!==connectionVersion)return;
      if(Number.isSafeInteger(result.accepted)&&result.accepted>0){syncContacts();contacts.learnSent(approved,{refused:result.refused||[]});}
      const copy=cloud?(result.sentCopySaved?'Eine Kopie liegt im Gesendet-Ordner.':result.sentCopyRequested?'Eine Kopie für den Gesendet-Ordner wurde angefordert.':'Prüfe den Gesendet-Ordner beim Anbieter.'):(result.sentCopySaved?'Eine Kopie liegt im Gesendet-Ordner.':'Eine Kopie konnte nicht im Gesendet-Ordner abgelegt werden.');
      state.notice=`${result.accepted} Empfänger ${cloud?'von '+serverLabel:'vom TH-Mailserver'} angenommen. ${cloud&&result.deliveryConfirmed===false?'Die Zustellung ist noch nicht bestätigt. ':''}${copy}${result.refused?.length?' Abgelehnte Empfänger: '+result.refused.join(', ')+'. Für diese wurde keine Mail versendet.':''}`;
      if(result.refused?.length){
        const refused=new Set(result.refused);replaceDraft({...blankDraft(),subject:approved.subject,text:approved.text,inReplyTo:approved.inReplyTo,attachments:approved.attachments.map(file=>({...file})),...Object.fromEntries(['to','cc','bcc'].map(field=>[field,approved[field].filter(address=>refused.has(address)).join(', ')]))});state.compose=true;state.notice+=' Für die abgelehnten Empfänger bleibt ein Entwurf erhalten. Prüfe An, Cc und Bcc vor einem neuen Versand.';focus='mail-to';
      }else{replaceDraft(blankDraft());state.compose=false;}onConnection({action:'send'});
      if(state.folders.find(f=>f.id===state.folder)?.kind==='sent')await readList();
    }catch(error){if(connection===connectionVersion){state.error=error.message;state.deliveryUnknown=error.code==='delivery_unknown'||!error.code;}}
    finally{if(connection===connectionVersion){state.sending=false;update(focus);}}
  }
  async function flag(){
    if(!canModify()||state.flagBusy||state.disconnecting||state.connecting||!state.message)return;
    const item=state.items.find(item=>item.uid===state.selected);if(!item)return;
    const version=++flagVersion,message=messageVersion,connection=connectionVersion,selected=target(),current=()=>version===flagVersion&&message===messageVersion&&connection===connectionVersion;
    state.flagBusy=true;state.error='';update();
    try{const result=await api('flag',{...selected,unread:!item.unread});if(!current())return;const currentItem=state.items.find(candidate=>candidate.uid===selected.uid);if(currentItem)currentItem.unread=result.unread;onConnection({action:'flag'});if(state.unread)await readList(state.offset);}
    catch(error){if(current())state.error=error.message;}
    finally{if(current()){state.flagBusy=false;update();}}
  }
  async function download(part){
    if(state.downloadBusy||state.disconnecting||state.connecting)return;
    const attachment=state.message?.attachments.find(a=>a.part===part);if(!attachment)return;
    const version=++downloadVersion,message=messageVersion,connection=connectionVersion,selected=target(),current=()=>version===downloadVersion&&message===messageVersion&&connection===connectionVersion;let focus;
    state.downloadBusy=true;state.error='';update();
    try{
      let file;
      if(cloud){const blob=await api('attachment',{...selected,part});if(!current())return;if(!(blob instanceof Blob)||blob.size>8*1024*1024)throw new Error('Der Anhang konnte nicht sicher geladen werden.');clearDownload();readyDownload={url:URL.createObjectURL(blob),name:attachment.name};focus='mail-save-file';return;}
      try{file=await api('attachment-link',{...selected,part});}
      catch(error){
        // Keep an already connected server usable during a source update.
        if(!current())return;if(![404,405].includes(error.httpStatus))throw error;
        const blob=await api('attachment',{...selected,part});
        if(!current())return;
        clearDownload();readyDownload={url:URL.createObjectURL(blob),name:attachment.name};focus='mail-save-file';return;
      }
      if(!current())return;
      if(typeof file.url!=='string'||!/^\/api\/mail\/download\/[0-9a-f]{64}$/.test(file.url))throw new Error('Der Download-Link ist nicht gültig.');
      clearDownload();readyDownload={url:file.url,name:attachment.name};focus='mail-save-file';
    }
    catch(error){if(current())state.error=error.message;}
    finally{if(current()){state.downloadBusy=false;update(focus);}}
  }
  async function addFiles(input){
    const files=[...input.files];input.value='';
    if(state.sending||state.review||state.disconnecting||state.connecting||!files.length)return;
    const connection=connectionVersion,draft=state.draft,version=draftVersion,current=()=>connection===connectionVersion&&draft===state.draft&&version===draftVersion;
    state.attachmentPending++;state.error='';update();
    const checkLimits=additions=>{const total=additions.reduce((sum,f)=>sum+f.size,draft.attachments.reduce((sum,f)=>sum+f.size,0));if(additions.length+draft.attachments.length>10||total>8*1024*1024)throw new Error('Höchstens 10 Anhänge mit zusammen 8 MB auswählen.');};
    try{
      checkLimits(files);
      const additions=[];
      for(const file of files){
        if(!file.name||file.name.length>180||/[\x00-\x1f\x7f/\\]/.test(file.name))throw new Error('Ein Dateiname ist nicht gültig.');
        const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
        additions.push({name:file.name,size:file.size,data:btoa(binary)});
      }
      if(!current()||state.review||state.sending)return;
      checkLimits(additions);state.draft.attachments=[...draft.attachments,...additions];state.error='';
    }catch(error){if(current())state.error=error.message;}
    finally{if(current()){state.attachmentPending--;update();}}
  }
  document.addEventListener('input',event=>{
    if(!active())return;
    if(event.target.id==='mail-user')state.setupUser=event.target.value;
    if(event.target.id==='mail-address')state.setupAddress=event.target.value;
    if(event.target.id==='mail-search')state.search=event.target.value;
    if(event.target.dataset.mailField&&!state.sending&&!state.review)state.draft[event.target.dataset.mailField]=event.target.value;
  });
  document.addEventListener('change',event=>{if(!active())return;if(event.target.id==='mail-files')void addFiles(event.target);});
  document.addEventListener('submit',event=>{
    if(!active())return;
    if(event.target.id==='mail-connect'){event.preventDefault();void connect(event.target);}
    if(event.target.id==='mail-search-form'){event.preventDefault();if(state.disconnecting||state.connecting)return;openVersion++;invalidateMessage();state.query=state.search.trim();state.selected='';state.message=null;void readList();}
    if(event.target.id==='mail-compose'){event.preventDefault();review();}
  });
  document.addEventListener('click',event=>{
    if(!active())return;
    const button=event.target.closest('[data-mail-action]');if(!button)return;
    const {mailAction:action,id}=button.dataset;
    if(action==='refresh')void load(true);
    if(action==='retry-list'&&!state.listBusy&&!state.disconnecting)void readList(state.offset);
    if(action==='disconnect')void disconnect();
    if(action==='folder')selectFolder(id);
    if(action==='open')void openMessage(id);
    if(action==='filter'&&!state.disconnecting&&!state.connecting){openVersion++;invalidateMessage();state.unread=!state.unread;state.selected='';state.message=null;void readList();}
    if(action==='next'&&!state.listBusy&&!state.disconnecting&&state.nextOffset!==null)void readList(state.nextOffset);
    if(action==='previous'&&!state.listBusy&&!state.disconnecting)void readList(Math.max(0,state.offset-40));
    if(action==='compose'||action==='reply')compose(action==='reply'?'reply':'new');
    if(['back','close-compose','discard','edit','folder','open','filter'].includes(action))recipientUI.close();
    if(action==='back'){openVersion++;invalidateMessage();state.selected='';state.message=null;state.compose=false;update();}
    if(action==='close-compose'&&!state.sending){state.compose=false;state.review=null;update();}
    if(action==='discard'&&!state.sending){replaceDraft(blankDraft());state.error='';update('mail-to');}
    if(action==='edit'&&!state.sending){state.review=null;update('mail-to');}
    if(action==='send')void send();
    if(action==='flag')void flag();
    if(action==='download')void download(id);
    if(action==='remove-file'&&!state.sending&&!state.review){state.draft.attachments.splice(Number(id),1);update();}
  });
  window.addEventListener('beforeunload',event=>{if(draftHasContent(state.draft)||state.attachmentPending){event.preventDefault();event.returnValue='';}});
  const people=items=>(items||[]).map(p=>p.name?`${p.name} <${p.address}>`:p.address).join(', ');
  function reader(){
    if(state.messageBusy)return `<div class="mail-placeholder" role="status">Nachricht wird ${cloud?'von '+serverLabel:'vom TH-Mailserver'} geladen …</div>`;
    const m=state.message;
    if(!m)return '<div class="mail-placeholder"><span class="mail-big-mark" aria-hidden="true">✉</span><h2>Platz für deine Post.</h2><p>Wähle eine Nachricht zum Lesen.<br>Beim Öffnen bleibt ihr Lesestatus unverändert.</p></div>';
    const item=state.items.find(item=>item.uid===state.selected);
    return `<article class="mail-message"><div class="mail-reader-actions"><button class="text-link mail-mobile-back" data-mail-action="back">← Zur Liste</button><button class="button secondary" data-mail-action="reply">Antworten ↗</button>${item&&canModify()?`<button class="text-link" data-mail-action="flag" ${state.flagBusy?'disabled':''}>${state.flagBusy?'Wird gespeichert …':item.unread?'Als gelesen markieren':'Als ungelesen markieren'}</button>`:''}</div><header><time>${esc(dateLabel(m.date))}</time><h2 id="mail-message-heading" tabindex="-1">${esc(m.subject)}</h2><dl><dt>Von</dt><dd>${esc(people(m.from)||m.sender)}</dd><dt>An</dt><dd>${esc(people(m.to))}</dd>${m.cc?.length?`<dt>Cc</dt><dd>${esc(people(m.cc))}</dd>`:''}</dl></header>${m.convertedHTML?'<p class="mail-format-note">HTML-Mail als Text · Externe Bilder werden nicht geladen.</p>':''}${m.partsLimited?`<p class="mail-format-note">${cloud?'Einige Bestandteile werden hier nicht angezeigt.':'Diese Mail enthält mehr als 200 Bestandteile.'} Weitere Inhalte und Anhänge findest du in ${webmailLabel}.</p>`:''}${m.truncated?`<p class="mail-format-note">Der Text wurde nach 200.000 Zeichen gekürzt. Die vollständige Nachricht liegt in ${webmailLabel}.</p>`:''}<div class="mail-body">${esc(m.text)||'<span class="mail-format-note">Diese Nachricht enthält keinen lesbaren Text.</span>'}</div>${m.attachments?.length?`<section class="mail-attachments" aria-label="Anhänge"><h3>${m.attachments.length} ${m.attachments.length===1?'Anhang':'Anhänge'}</h3>${m.attachments.map(a=>`<button data-mail-action="download" data-id="${esc(a.part)}" ${state.downloadBusy?'disabled':''}><span>↓ ${esc(a.name)}</span><small>${sizeLabel(a.size)}</small></button>`).join('')}${readyDownload?`<a id="mail-save-file" class="button secondary mail-save-file" href="${esc(readyDownload.url)}" download="${esc(readyDownload.name)}">Datei speichern: ${esc(readyDownload.name)} ↓</a>`:''}</section>`:''}</article>`;
  }
  function composer(){
    const d=state.draft;
    if(state.review){const r=state.review;return `<section class="mail-compose-review"><div class="mail-compose-head"><button type="button" class="text-link mail-mobile-back" data-mail-action="back">← Zur Liste</button><button type="button" class="icon-button" data-mail-action="close-compose" aria-label="Entwurf schließen und behalten" ${state.sending?'disabled':''}>×</button></div><p class="eyebrow">VOR DEM VERSAND</p><h2>Alles bereit?</h2><dl><dt>Von</dt><dd>${esc(state.address)}</dd>${['to','cc','bcc'].filter(f=>r[f].length).map(f=>`<dt>${{to:'An',cc:'Cc',bcc:'Bcc'}[f]}</dt><dd>${esc(r[f].join(', '))}</dd>`).join('')}</dl><h3>${esc(r.subject)}</h3><div class="mail-body">${esc(r.text)}</div>${r.attachments.length?`<p class="mail-format-note">${r.attachments.length} Anhänge: ${esc(r.attachments.map(f=>f.name).join(', '))}</p>`:''}<div class="mail-compose-actions"><button id="mail-send-now" class="button primary" data-mail-action="send" ${state.sending||state.deliveryUnknown||!canSend()?'disabled':''}>${state.sending?serverLabel+' sendet …':'Jetzt senden ↑'}</button><button class="text-link" data-mail-action="edit" ${state.sending?'disabled':''}>Zurück zum Entwurf</button></div><p class="mail-format-note">Versand über ${cloud?providerName+' mit der freigegebenen Nango-Verbindung':'deinen TH-Mailserver'}. Diese Aktion verschickt die Nachricht an die angezeigten Empfänger.</p></section>`;}
    return `<form id="mail-compose" class="mail-compose"><button type="button" class="text-link mail-mobile-back" data-mail-action="back">← Zur Liste</button><div class="mail-compose-head"><h2>${d.inReplyTo?'Deine Antwort.':'Neue Nachricht.'}</h2><button type="button" class="icon-button" data-mail-action="close-compose" aria-label="Entwurf schließen und behalten">×</button></div><p class="mail-from">Von ${esc(state.address)}</p>${[['to','An'],['cc','Cc'],['bcc','Bcc']].map(([field,label])=>recipientUI.render(field,d[field],label)).join('')}<p class="mail-format-note">Mehrere E-Mail-Adressen durch Komma oder Semikolon trennen.</p><label for="mail-subject">Betreff<input id="mail-subject" data-mail-field="subject" value="${esc(d.subject)}" maxlength="300" required></label><label for="mail-text" class="sr-only">Nachrichtentext</label><textarea id="mail-text" data-mail-field="text" rows="14" maxlength="100000" placeholder="Deine Nachricht …" required>${esc(d.text)}</textarea>${d.attachments.length?`<ul class="mail-draft-files">${d.attachments.map((f,i)=>`<li><span>${esc(f.name)} · ${sizeLabel(f.size)}</span><button type="button" class="icon-button" data-mail-action="remove-file" data-id="${i}" aria-label="${esc(f.name)} entfernen">×</button></li>`).join('')}</ul>`:''}${!canSend()?`<p class="mail-format-note">Versand für ${providerName} ist nicht freigegeben. <button type="button" class="text-link" data-view="connections">Berechtigung unter Verbindungen freigeben →</button></p>`:''}<div class="mail-compose-actions"><button type="submit" class="button primary" ${state.attachmentPending||state.deliveryUnknown||state.disconnecting||!canSend()?'disabled':''}>${state.attachmentPending?'Anhänge werden eingelesen …':state.deliveryUnknown?'Versandstatus unklar':'Versand prüfen →'}</button><label for="mail-files" class="button secondary">Dateien anhängen<input id="mail-files" type="file" multiple class="sr-only"></label><button type="button" class="text-link" data-mail-action="discard">Entwurf verwerfen</button></div><p class="mail-format-note">Entwurf nur im Arbeitsspeicher · 10 Anhänge / zusammen ${service==='outlook'?'8 MB; Outlook-Versand unter 3 MB je Datei und 4 MB gesamt':'8 MB'} · Kein Versand mit Enter im Nachrichtentext.</p></form>`;
  }
  function searchSources() {
    // Project only already-delivered mail data. No new IMAP/Graph/Gmail request,
    // no composer, account settings, attachments or authentication material.
    if (!state.configured || state.disconnecting || state.connecting || state.listBusy || state.listError || !state.uidValidity) return [];
    return state.items.map(item=>{
      const message=!state.messageBusy && state.selected===item.uid && state.message?.uid===item.uid && state.message?.uidValidity===state.uidValidity ? state.message : null;
      const names=people(item.from);
      return {service,identity:JSON.stringify([service,state.accountKey||state.address,state.folder,state.uidValidity,item.uid]),title:item.subject||'(Ohne Betreff)',text:[names,item.date||'',message?.text||''].filter(Boolean).join('\n'),status:message?.text ? (message.truncated?'excerpt':'full') : 'metadata',updatedAt:item.date||'',target:{service,folder:state.folder,uid:item.uid,uidValidity:state.uidValidity}};
    });
  }
  return {hideRecipientSuggestions:()=>recipientUI.close(),load,searchSources,refreshConnection(){resetConnection();update();return active()?load(true):Promise.resolve();},async open(targetValue){
    const intent=++openVersion,connection=connectionVersion,current=()=>intent===openVersion&&connection===connectionVersion;
    await load();if(!current()||!state.configured||state.connecting||state.disconnecting||!targetValue)return;
    invalidateMessage();state.folder=targetValue.folder;state.uidValidity='';state.selected='';state.message=null;state.compose=false;
    const result=await readList();if(!current()||!result)return;
    if(result.uidValidity===targetValue.uidValidity)await openMessage(targetValue.uid,intent);else{state.error='Die Nachricht ist nicht mehr in diesem Postfach. Bitte neu auswählen.';update();}
  },render(){
    const current=state.folders.find(f=>f.id===state.folder);
    const listKey=esc(JSON.stringify([...(cloud?[service,state.accountKey]:[]),state.folder,state.uidValidity,state.query,state.unread,state.offset])),readerKey=state.compose?(cloud?esc(JSON.stringify([service,state.accountKey,state.review?'review':'draft'])):(state.review?'review':'draft')):esc(JSON.stringify([...(cloud?[service,state.accountKey]:[]),state.folder,state.uidValidity,state.selected]));
    const foldersKey=cloud?esc(JSON.stringify([service,state.accountKey,'folders'])):'folders';
    const cloudSetup=`<section class="mail-setup"><div><span class="mail-big-mark" aria-hidden="true">✉</span><h2>Dein ${providerName}-Postfach.</h2><p>Verbinde ${providerName} unter Verbindungen. Leserechte sind vom Versand und vom Ändern des Lesestatus getrennt.</p><ul><li>Mailordner, Nachrichtentext und Anhänge hier lesen</li><li>Lesestatus bleibt beim Öffnen unverändert</li><li>Versand nur mit Freigabe und eigener Vorschau</li></ul></div><div><button class="button primary" data-view="connections">${providerName} verbinden →</button><p class="mail-format-note">OAuth-Tokens verwaltet Nango. Entwürfe bleiben nur im lokalen Arbeitsspeicher; sie werden nicht in Backups gespeichert.</p></div></section>`;
    const privacy=cloud?`Das ${providerName}-Postfach zeigt alle Kurse. OAuth-Tokens verwaltet Nango. Mailtexte und Entwürfe werden nicht in Context-Backups gespeichert; Entwürfe liegen nur im lokalen Arbeitsspeicher. HTML-Mails werden als Text gezeigt, externe Bilder und Skripte bleiben aus. Eine lokale Trennung entfernt die Verknüpfung in Context; OAuth-Freigaben verwaltest du im Nango-Dashboard.`:'Das Mailpostfach zeigt alle Kurse. IMAP mit TLS · SMTP mit STARTTLS · Mailtexte, Entwürfe und Passwörter werden nicht in Context-Backups gespeichert. HTML-Mails werden als Text gezeigt; externe Bilder und Scripts bleiben aus. <a href="https://www.th-koeln.de/hochschule/e-mail_25805.php" target="_blank" rel="noopener noreferrer">TH-Mailkonfiguration ↗</a>';
    return `<div class="page-heading mail-heading"><div><p class="eyebrow">${cloud?providerName.toUpperCase()+' · CLOUD-MAIL':'TH KÖLN · STUDENTISCHE MAIL'}</p><h1>Deine Post. An einem Ort.</h1><p class="page-description">${state.configured?esc(state.address||(cloud?'Dein '+providerName+'-Postfach':'Dein TH-Postfach'))+(cloud?' · mit Nango verbunden':' · direkt mit dem Mailserver verbunden'):(cloud?'Dein '+providerName+'-Postfach, lokal in Context.':'Ein echter Posteingang für deine Hochschul-Mail.')}</p></div>${state.configured?`<button class="button primary" data-mail-action="compose" ${state.sending||state.disconnecting?'disabled':''}>＋ Nachricht schreiben</button>`:''}</div>${state.error?`<p class="mail-alert" role="alert">${esc(state.error)}</p>`:''}${state.notice?`<p class="mail-notice" role="status">${esc(state.notice)}</p>`:''}${!state.loaded&&state.loading?'<div class="mail-setup" role="status">Mail-Verbindung wird geprüft …</div>':!state.configured?(cloud?cloudSetup:`<section class="mail-setup"><div><span class="mail-big-mark" aria-hidden="true">✉</span><h2>Dein Hochschul-Postfach.</h2><p>Lesen, antworten und senden — direkt über IMAP und SMTP der TH Köln.</p><ul><li>Alle Mailordner und eine Suche im Postfach</li><li>Nachrichtentext und Anhänge direkt hier</li><li>Vorschau mit Empfängern vor jedem Versand</li></ul></div><form id="mail-connect" autocomplete="off"><label for="mail-user">campusID<input id="mail-user" name="user" value="${esc(state.setupUser)}" autocomplete="username" maxlength="100" required placeholder="Deine campusID" ${state.connecting||state.disconnecting?'disabled':''}></label><label for="mail-address">Deine TH-Mailadresse<input id="mail-address" name="address" value="${esc(state.setupAddress)}" type="email" autocomplete="email" maxlength="254" required placeholder="vorname.nachname@smail.th-koeln.de" ${state.connecting||state.disconnecting?'disabled':''}></label><label for="mail-password">campusID-Passwort<input id="mail-password" name="password" type="password" autocomplete="current-password" maxlength="2048" required ${state.connecting||state.disconnecting?'disabled':''}></label><button class="button primary" type="submit" ${state.connecting||state.disconnecting?'disabled':''}>${state.connecting?'Mailserver werden geprüft …':'Mailkonto verbinden ↗'}</button><p class="mail-format-note">Zugangsdaten bleiben im lokalen Server-Speicher. Nach einem Neustart erneut anmelden. Das bestehende Browser-Login kann IMAP nicht ersetzen.</p></form></section>`):`<section class="mail-workspace ${state.selected||state.compose?'mail-has-detail':''}" aria-label="${cloud?providerName+'-Postfach':'TH-Mailpostfach'}"><aside class="mail-folders"><p class="mail-folder-label">DEIN POSTFACH</p><nav id="mail-folder-nav" data-mail-scroll-key="${foldersKey}" aria-label="Mailordner">${state.folders.map(f=>`<button data-mail-action="folder" data-id="${esc(f.id)}" ${state.listBusy||state.disconnecting?'disabled':''} ${f.id===state.folder?'aria-current="page"':''}><span aria-hidden="true">${{inbox:'▱',sent:'↗',drafts:'✎',trash:'▧',junk:'◇',folder:'▱'}[f.kind]}</span>${esc(f.label)}</button>`).join('')}</nav><div class="mail-account-actions"><button class="text-link" data-mail-action="refresh" ${state.loading||state.disconnecting?'disabled':''}>↻ Aktualisieren</button><button class="text-link" data-mail-action="disconnect" ${state.sending||state.connecting||state.disconnecting?'disabled':''}>${state.disconnecting?'Wird getrennt …':'Konto trennen'}</button></div></aside><div class="mail-list-pane"><div class="mail-list-head"><div><h2>${esc(current?.label||'Postfach')}</h2><span>${state.matched} ${state.unread?'ungelesene ':''}${state.matched===1?'Nachricht':'Nachrichten'}${state.query?' zur Suche':''}</span></div><button class="mail-unread-toggle" data-mail-action="filter" aria-pressed="${state.unread}" ${state.listBusy?'disabled':''}>Ungelesen</button></div><form id="mail-search-form" class="mail-search"><label class="sr-only" for="mail-search">Im Mailordner suchen</label><input id="mail-search" type="search" maxlength="200" value="${esc(state.search)}" placeholder="Im Ordner suchen …"><button type="submit" class="icon-button" aria-label="Mails suchen" ${state.listBusy?'disabled':''}>⌕</button></form><div id="mail-list" class="mail-list" data-mail-scroll-key="${listKey}" role="region" tabindex="0" aria-label="Nachrichtenliste" ${state.listBusy?'aria-busy="true"':''}>${state.listBusy?'<p class="mail-list-status" role="status">Nachrichten werden geladen …</p>':state.listError?'<div class="mail-list-status" role="status"><p>Nachrichten konnten nicht geladen werden.</p><button class="button secondary" data-mail-action="retry-list">Erneut laden ↻</button></div>':state.items.length?state.items.map(item=>`<button class="mail-row ${item.unread?'unread':''} ${item.uid===state.selected?'selected':''}" data-mail-action="open" data-id="${esc(item.uid)}" ${item.uid===state.selected?'aria-current="true"':''}><span class="mail-row-from">${item.unread?'<span class="mail-unread-dot" aria-label="Ungelesen"></span>':''}${esc(item.from?.[0]?.name||item.from?.[0]?.address||item.sender)}</span><strong>${esc(item.subject)}</strong><time>${esc(dateLabel(item.date))}</time></button>`).join(''):'<p class="mail-list-status">'+(state.query?'Keine Mails zu dieser Suche.':state.unread?'Keine ungelesenen Mails in diesem Ordner.':'Dieser Ordner ist leer.')+'</p>'}</div><div class="mail-pagination"><span>${state.matched?state.offset+1:0}–${Math.min(state.offset+40,state.matched)} / ${state.matched}</span><button class="icon-button" data-mail-action="previous" aria-label="Vorherige 40 Nachrichten" ${!state.offset||state.listBusy?'disabled':''}>←</button><button class="icon-button" data-mail-action="next" aria-label="Nächste 40 Nachrichten" ${state.nextOffset===null||state.listBusy?'disabled':''}>→</button></div></div><div id="mail-reader" class="mail-reader" data-mail-scroll-key="${readerKey}" role="region" tabindex="0" aria-label="Nachrichtenansicht">${state.compose?composer():reader()}</div></section>`}<details class="mail-privacy"><summary>Verbindung &amp; Datenschutz</summary><p>${privacy}</p></details>`;
  }};
}
