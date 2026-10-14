const providers=new Set(['kiconnect','openrouter','local']);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12;
const money=value=>new Intl.NumberFormat('de-DE',{minimumFractionDigits:2,maximumFractionDigits:4}).format(value)+' US$';
const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=1e9;
const periods={daily:'täglich',weekly:'wöchentlich',monthly:'monatlich'};
const gauge='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" focusable="false"><path d="M4 19a10 10 0 1 1 16 0M12 12l5-5M7 19h10"/><circle cx="12" cy="12" r="1"/></svg>';
const refreshIcon='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" focusable="false"><path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M19 16a8 8 0 0 1-13 3l-2-3"/></svg>';

function budget(value){return value&&number(value.limit)&&value.limit>=0&&number(value.remaining)?value:null;}
function free(value){return value&&count(value.used)&&count(value.limit)&&count(value.remaining)&&value.remaining<=value.limit?value:null;}
export function usageSummary({provider,value,loading,error,model=''}={}){
  if(loading&&!value)return {text:'Limit wird geprüft',warning:false};
  if(error)return {text:'Limit nicht abrufbar',warning:true};
  if(!value)return {text:'Limit unbekannt',warning:false};
  if(provider==='local')return {text:'Kein Cloud-Limit',warning:false};
  const requests=free(value.freeRequests),chosen=budget(value.effectiveBudget)||budget(value.keyBudget);
  if(provider==='openrouter'&&model.endsWith(':free')&&requests)return {text:requests.remaining.toLocaleString('de-DE')+' / '+requests.limit.toLocaleString('de-DE')+' frei',warning:requests.remaining===0};
  if(provider==='openrouter'&&chosen)return {text:money(Math.max(0,chosen.remaining))+' Restbudget',warning:chosen.remaining<=0};
  if(provider==='openrouter'&&value.keyLimitUnset===true)return {text:'Kein Schlüssellimit',warning:false};
  return {text:'Limit unbekannt',warning:false};
}
export function renderUsagePanel(state){
  const value=state.value,provider=state.provider,rows=[];
  const line=(label,text)=>rows.push(`<div><dt>${escape(label)}</dt><dd>${escape(text)}</dd></div>`);
  if(provider==='local')line('Verarbeitung','Lokal · kein Cloud-Kontingent');
  else if(provider==='kiconnect')line('Kontingent','Über diese API nicht verfügbar');
  else if(value){
    const effective=budget(value.effectiveBudget),key=budget(value.keyBudget),requests=free(value.freeRequests);
    if(effective){line('Wirksames Budget',money(effective.limit));line('Restbudget',money(Math.max(0,effective.remaining)));if(number(effective.used))line('Im Budget verbraucht',money(effective.used));if(periods[effective.resetInterval])line('Zeitraum',periods[effective.resetInterval]);if(typeof effective.resetsAt==='string'&&Number.isFinite(Date.parse(effective.resetsAt)))line('Zurückgesetzt ab',new Date(effective.resetsAt).toLocaleString('de-DE'));}
    if(key){line('Schlüssellimit',money(key.limit));line('Schlüssel-Restbudget',money(Math.max(0,key.remaining)));if(periods[key.resetInterval])line('Schlüssel-Zeitraum',periods[key.resetInterval]);}
    else if(value.keyLimitUnset===true)line('Schlüssellimit','Kein Schlüssellimit gesetzt');
    if(requests)line('Kostenfreie Modelle · heute',requests.remaining.toLocaleString('de-DE')+' von '+requests.limit.toLocaleString('de-DE')+' Anfragen übrig');
    if(number(value.spend?.daily)&&value.spend.daily>=0)line('Schlüsselverbrauch heute',money(value.spend.daily));
    if(!rows.length)line('Kontingent','Anbieter liefert keine verwendbaren Werte');
  }else line('Kontingent','Noch nicht abgerufen');
  let meter='';const selected=budget(value?.effectiveBudget)||budget(value?.keyBudget);
  if(provider==='openrouter'&&selected&&selected.limit>0){const percent=Math.max(0,Math.min(100,100*selected.remaining/selected.limit));meter=`<meter min="0" max="100" value="${percent}" aria-label="Verbleibender Anteil des Budgets">${Math.round(percent)} %</meter>`;}
  const checked=provider==='openrouter'&&value?.status==='available'&&typeof value.checkedAt==='string'&&Number.isFinite(Date.parse(value.checkedAt))?new Date(value.checkedAt).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}):'';
  const notice=provider==='openrouter'?'Budget des Schlüssels/der Organisation, kein Kontoguthaben. Modellanbieter können zusätzlich begrenzen. Kostenfreie Zähler gelten für :free-Varianten; BYOK/ausgenommene Konten können abweichen.':provider==='kiconnect'?'KI:connect zählt API und Webnutzung gemeinsam. Den verbleibenden Betrag liefert die dokumentierte API derzeit nicht.':'Dein Rechner und Modellserver können eigene Grenzen haben.';
  return `<div class="ki-menu-heading"><h2 id="ki-usage-title">Nutzung & Limit</h2><div class="ki-usage-actions"><button type="button" id="ki-usage-refresh" class="ki-icon-action" data-ki-action="usage-refresh" aria-label="Nutzungslimit aktualisieren" title="Nutzungslimit aktualisieren" ${state.loading?'disabled':''}>${refreshIcon}</button><button type="button" id="ki-usage-close" class="ki-icon-action" data-ki-action="menu-close" aria-label="Limitanzeige schließen" title="Limitanzeige schließen"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" focusable="false"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div></div>${meter}<dl class="ki-usage-values">${rows.join('')}</dl>${state.loading?'<p class="ki-usage-note" role="status">Wird aktualisiert …</p>':''}${state.error?`<p class="ki-usage-error" role="status">${escape(state.error)}</p>`:''}<p class="ki-usage-note">${escape(notice)}</p>${checked?`<p class="ki-usage-note">Anbieterstand ${escape(checked)} · kann verzögert sein</p>`:''}`;
}
export function createAIUsage({provider='kiconnect',request,onChange=()=>{}}={}){
  if(!providers.has(provider)||typeof request!=='function')throw new Error('Ungültige Limitverbindung.');
  const state={provider,value:null,loading:false,error:''};let revision=0,controller=null,disposed=false;
  const notify=()=>{if(!disposed)onChange();};
  function reset(next=state.provider){if(!providers.has(next))throw new Error('Ungültiger KI-Anbieter.');revision++;controller?.abort();controller=null;state.provider=next;state.value=null;state.loading=false;state.error='';notify();}
  async function refresh(){
    if(disposed)return;const current=++revision,selected=state.provider;controller?.abort();const abort=new AbortController();controller=abort;state.loading=true;state.error='';notify();
    try{const value=await request(selected,'usage',{signal:abort.signal});if(disposed||abort.signal.aborted||revision!==current||state.provider!==selected)return;
      state.value=value&&value.provider===selected&&['available','unknown','not_applicable'].includes(value.status)?value:{provider:selected,status:'unknown'};
    }catch(error){if(!disposed&&!abort.signal.aborted&&revision===current&&state.provider===selected){state.value=null;state.error='Der Anbieterstand ist gerade nicht verfügbar. Erneut aktualisieren.';}}
    finally{if(!disposed&&revision===current&&state.provider===selected){state.loading=false;controller=null;notify();}}
  }
  return {state,reset,refresh,dispose(){if(disposed)return;disposed=true;revision++;controller?.abort();controller=null;state.value=null;},trigger(model,open=false){const summary=usageSummary({...state,model});return `<button type="button" id="ki-usage-toggle" class="ki-usage-toggle${summary.warning?' is-warning':''}" data-ki-action="menu" data-ki-menu-toggle="usage" aria-controls="ki-usage-panel" aria-haspopup="dialog" aria-expanded="${open}" aria-label="Nutzung und Limit: ${escape(summary.text)}" title="Nutzung und Limit">${gauge}<span>${escape(summary.text)}</span></button>`;},panel(open=false){return `<div class="ki-chat-menu ki-usage-panel" id="ki-usage-panel" data-ki-menu="usage" role="dialog" aria-labelledby="ki-usage-title" ${open?'':'hidden'}>${renderUsagePanel(state)}</div>`;}};
}
