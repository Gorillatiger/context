import {createSourceHub} from './source-hub.js';
import {createPlatformDiscovery} from './platform-discovery.js';
import {captureInboxViewport,restoreInboxViewport} from './inbox-viewport.js';
import {createFeedRefresh} from './feed-refresh.js';
import {parseFeedSnapshot} from './feed-state.js';
import {createSpacesSearchClient} from './spaces-search-client.js';
import {createSearchView} from './search-view.js';
import {createSpacesCrawlView} from './spaces-crawl-view.js';
import {buildSearchDocuments} from './search-documents.js';
import {captureCalendarDayViewport,mountCalendarDayViewport} from './calendar-day.js';
import {captureChatViewport,restoreChatViewport} from './chat-viewport.js';
import {createDevDiaryView} from './dev-diaries.js';
import {validateDevDiary,validateDevDiaries,devDiaryReminderNotifications} from './dev-diary-engine.js';
import {createBoardView} from './boards.js';
import {renderPluginCatalog} from './plugin-catalog.js';
import {brandLogo,brandClass} from './brand-logos.js';
import {prepareCalendarAction,undoCalendarEvents,calendarICSForIds} from './calendar-agent.js';
import {validateCalendarSync} from './calendar-sync.js';
import {createCalendarView} from './calendar.js';
import {matchingTask} from './companion-engine.js';
import {createCompanion} from './companion.js';
import {createBrowserView,desktopBrowserAvailable} from './browser-view.js';
import {createInventoryView,isInventoryEntryURL} from './inventory-browser.js';
import { STORAGE_KEY, TOOL_META, LINK_META, initialState, safeURL, cleanText, requireText, validateState, validateDate, dateKey, taskCounts, notificationKey, taskNotifications, courseMatches, notificationCourse, resolveNotificationCourse } from './core.js';

import { BUILTIN_PLUGINS, planImport, applyImport } from './importers.js';
import { renderMarkdown } from './markdown.js';
import {notificationGroup,notificationGroups,previewContent,formatSnapshotTime,resolveNotificationGroup,parseNotificationItems,compareNotificationTime,notificationTime} from './inbox.js';
import { createZIP, hasCredentialMaterial, githubRepositoryURL } from './zip.js';
import {spaceBrowserURL} from './spaces.js';
import {nativeSpacesAvailable,openNativeSpace,mountNativeSpace,detachNativeSpace} from './native-space.js';
import {createKIView} from './ki.js';
import {createMailAccounts} from './mail-accounts.js';
import {createNangoConnectionsView} from './nango-connections.js';
import {captureMailViewport,restoreMailViewport} from './mail-layout.js';
import {validateLocalAction} from './knowledge.js';
import {resolveAgentContext} from './agent-context.js';
import {planCurrentBoard} from './current-board.js';
import {createFloatingAgent} from './floating-agent.js';
import {serviceConnectable,serviceConnectHTML,loadServiceStatus,saveServiceToken,forgetServiceToken} from './service-connect.js';

const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const uid = () => crypto.randomUUID();
const meta = id => LINK_META.find(t => t.id === id);
const project = id => state.projects.find(p => p.id === id);
const modal = $('#modal');
const searchModal = $('#search-modal');
let modalReturnFocus,projectLayoutCleanup;
function mountProjectLayout(){
  const body=modal.querySelector('.project-scroll-body');if(!body)return;
  const update=()=>{
    const style=getComputedStyle(body),summary=modal.querySelector('.project-management>summary');
    const available=body.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)-(summary?.getBoundingClientRect().height||52)-18;
    modal.style.setProperty('--project-browser-height',Math.max(300,Math.min(608,Math.floor(available-70)))+'px');
  };
  const observer=new ResizeObserver(update);observer.observe(body);update();body.scrollTop=0;
  projectLayoutCleanup=()=>observer.disconnect();
}
let state = initialState();
let storageAvailable = true;
const views=new Set(['today','inbox','projects','tasks','notes','links','submissions','imports','plugins','tools','settings','ai','mail','browser','companion','calendar','boards','inventory','connections','sources']);
let view = views.has(location.hash.slice(1)) ? location.hash.slice(1) : 'today';
let taskFilter = 'open';
let taskProject = '';
let showArchived = false;
let searchView,searchSnapshot,searchDirty=true,searchRefreshTimer;
let pendingImport;
let pendingPluginImport;
let importPlugin='obsidian';
let submissionFiles=[];
let submissionURL='';
let corruptStorage=false;
const noteDrafts=new Map();
let undo;
let toastTimer;
let inboxFilter='all';
let inboxSource='all';
let inboxGroup='all';
let remoteItems=[];
let inboxLimit=50;
let sourceStates=['spaces','mattermost','gitlab','webmail'].map(source=>({source,status:'not_configured'}));
let feedBusy=false;
let feedRefresh,feedRefreshStatus={};
let feedLastError='';
let feedEpoch=0,feedNeedsRefresh=false;
let feedCheckedAt='';
let hasLocalConnector=false;
let seenRemoteIds=new Set();
let initialFeed=true;
let lastSavedRaw=null;
let storageConflict=false;
let floatingAgent, companion, crawlerView, floatingOpen=false;
let browserContext={visible:false,readable:false};
function currentAgentContext(){
  return resolveAgentContext(state,remoteItems,{view,...(modal.open?modal.dataset:{}),browser:browserContext});
}
function syncAgentContext(){floatingAgent?.render();}
window.addEventListener('context-browser-page',event=>{
  const detail=event.detail||{};
  browserContext={visible:detail.visible===true,current:detail.current===true,readable:detail.readable===true,miroBoard:detail.miroBoard&&typeof detail.miroBoard.url==='string'?{url:detail.miroBoard.url.slice(0,2048),title:String(detail.miroBoard.title||'').slice(0,200)}:null};
  syncAgentContext();
});

try { const raw = localStorage.getItem(STORAGE_KEY); lastSavedRaw=raw; if (raw) { const parsed=JSON.parse(raw); state=validateState(parsed); state.activity=Array.isArray(parsed.activity) ? parsed.activity.filter(a => a && typeof a.title==='string' && typeof a.at==='string').slice(0,60) : []; } }
catch { storageAvailable=false; corruptStorage=true; }

const icon = (name, size = 20) => {
  const paths = {
    moon:'<path d="M20.8 13.1A9 9 0 0 1 10.9 3.2 9 9 0 1 0 20.8 13.1Z"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
    home:'<path d="M3 10 12 3l9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
    projects:'<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    tasks:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m7 9 2 2 4-4m-6 9h2m4 0h4"/>',
    links:'<path d="m9 15 6-6m-7 8-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1"/>',
    tools:'<path d="M3 4h18v6H3Zm0 10h18v6H3ZM7 7h1m-1 10h1m5-10h5m-5 10h5"/>',
    settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
    back:'<path d="M19 12H5m6-6-6 6 6 6"/>',
    external:'<path d="M9 4H4v16h16v-5m-7-11h7v7m-11 4L20 4"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    edit:'<path d="m14 4 6 6M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16Zm0 0 4-1"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
    trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    file:'<path d="M5 3h9l5 5v13H5Zm9 0v5h5M9 12h6m-6 4h6"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    star:'<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4L2.8 9.7l6.4-.9Z"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h1m5 0h1"/>',
    download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    upload:'<path d="M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
    menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
    dot:'<circle cx="12" cy="12" r="3"/>',
    archive:'<path d="M4 9v12h16V9M3 3h18v6H3Zm6 11h6"/>',
    note:'<path d="M4 3h16v18H4Zm4 5h8M8 12h8m-8 4h5"/>',
    bell:'<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5Zm5 4h4M12 2v2"/>',
    mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
    refresh:'<path d="M20 9a8 8 0 0 0-14-3L3 9m0-6v6h6m-5 6a8 8 0 0 0 14 3l3-3m0 6v-6h-6"/>'
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.dot}</svg>`;
};
const monogram = (id, small = false) => brandLogo(id,{small,color:meta(id)?.color,fallback:meta(id)?.short || 'LK'});
const external = (url, text, classes='', extras='') => `<a href="${esc(safeURL(url))}" target="_blank" rel="noopener noreferrer" class="${classes}" data-open="${esc(text)}" ${extras}>${esc(text)}${icon('external',15)}</a>`;
const iconAction=(name,label,attributes='',classes='')=>`<button type="button" class="icon-button app-icon-action ${classes}" aria-label="${esc(label)}" title="${esc(label)}" ${attributes}>${icon(name,18)}</button>`;
const detailHint=(label,content,classes='')=>`<details class="app-details ${classes}"><summary>${icon('info',16)}<span>${esc(label)}</span></summary><div class="app-details-content">${content}</div></details>`;
const dateLabel = date => date ? new Intl.DateTimeFormat('de-DE',{ day:'numeric',month:'short' }).format(new Date(date+'T12:00:00Z')) : '';

function save() {
  try {
    if(corruptStorage){toast('Der vorhandene Speicher ist beschädigt. Exportiere deinen Stand, bevor du ein geprüftes Backup übernimmst.');return false;}
    if(storageConflict||localStorage.getItem(STORAGE_KEY)!==lastSavedRaw){storageConflict=true;storageAvailable=false;toast('Ein anderer Tab hat einen neueren Stand. Exportiere deine Änderungen und lade neu.');return false;}
    const next=JSON.stringify(state);localStorage.setItem(STORAGE_KEY,next);lastSavedRaw=next;storageAvailable=true;invalidateSearch(); return true;
  }
  catch { storageAvailable=false; toast('Speichern ist hier nicht möglich. Bitte ein Backup exportieren.'); return false; }
}
function activity(title) { state.activity.unshift({ id:uid(), title, at:new Date().toISOString() }); state.activity=state.activity.slice(0,60); }
function commit(title) { if(title) activity(title); const ok=save(); if(ok)syncDiaryReminders(); companion?.update(); render(); return ok; }
// The assistant may read the board open in the browser. A board that is not yet
// a course source is assigned to the chat's course (announced with undo); the
// read itself stays an ordinary scope-checked platform source read.
async function ensureCurrentBoard({projectId='',signal}={}){
  const board=currentAgentContext().currentBoard,plan=planCurrentBoard(state,board,projectId);
  if(!plan.assigned)return plan.sourceId;
  const previous=state;state={...state,boardFindings:plan.boardFindings};
  if(!save()){state=previous;throw new Error('Das Board konnte nicht gespeichert werden. Bitte zuerst den Workspace-Speicher prüfen.');}
  const release=()=>{state={...state,boardFindings:(state.boardFindings||[]).filter(row=>row.id!==plan.findingId)};save();render();};
  toast(`„${plan.boardTitle}“ wurde dem Kurs „${plan.courseName}“ zugeordnet.`,release);
  render();if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');
  await sourceHub.sync();const ready=planCurrentBoard(state,board,projectId);
  if(ready.assigned){release();throw new Error('Das Board konnte nicht als Kursquelle freigegeben werden.');}
  // Unreadable boards (private, removed) must not stay attached to the course.
  return {sourceId:ready.sourceId,undo:release,
    // Announced only after a successful read, with the board's real title (also kept in the directory).
    done:title=>{const name=String(title||'').trim().slice(0,240)||plan.boardTitle;state={...state,boardFindings:(state.boardFindings||[]).map(row=>row.id===plan.findingId&&name!=='Miro-Board'?{...row,miroTitle:name}:row)};save();render();toast(`„${name}“ ist jetzt eine Quelle im Kurs „${plan.courseName}“.`,release);}};
}
function toast(text, undoCallback) {
  clearTimeout(toastTimer); undo=undoCallback;
  $('#toast').innerHTML=`<span>${esc(text)}</span>${undoCallback?'<button data-action="undo">Rückgängig</button>':''}`;
  $('#toast').classList.add('visible'); toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),7000);
}
function setView(next) { if(!views.has(next))return;view=next;if(location.hash!=='#'+next)history.pushState(null,'','#'+next);document.body.classList.remove('nav-open');render();$('#main').focus({preventScroll:true});window.scrollTo(0,0);if(next==='connections')void nangoConnections.open(); }
const inCourse=item=>courseMatches(item.projectId,state.activeCourse);
const scopedState=()=>({...state,tasks:state.tasks.filter(inCourse)});
function courseOptions(){return `<option value="">Alle Kurse</option>${state.projects.filter(p=>!p.archived||p.id===state.activeCourse).map(p=>`<option value="${p.id}" ${state.activeCourse===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}`;}

const agentActions=new Map();
function applyAgentAction(action){
  if(agentActions.has(action.id))return agentActions.get(action.id).result;
  if(currentAgentContext().projectId!==action.scope)throw new Error('Der Projektkontext hat sich geändert. Starte den Auftrag erneut.');
  if(action.tool==='create_calendar'){
    const {calendarEvents,added,eventIds}=prepareCalendarAction(action,state),before=state;
    state={...state,calendarEvents};
    if(!save()){state=before;render();throw new Error('Die Termine konnten nicht lokal gespeichert werden. Es wurde nichts übernommen.');}
    const result={saved:true,id:action.id,eventIds,count:eventIds.length,title:eventIds.length+' Termine',kind:'calendarEvents',duplicate:!added.length};
    agentActions.set(action.id,{kind:'calendarEvents',added,result});calendarView.notifyLocalChange();companion.update();render();return result;
  }
  const args=validateLocalAction(action.tool,action.args,state,action.scope);
  const kind=action.tool==='create_note'?'notes':'tasks';
  const duplicate=state[kind].find(item=>item.projectId===args.projectId&&item.title===args.title&&(kind==='notes'?item.content===args.content:item.due===args.due));
  if(duplicate)return {saved:true,duplicate:true,title:args.title};
  const item={id:uid(),...args,...(kind==='notes'?{updatedAt:new Date().toISOString()}:{status:'todo',url:'',createdAt:new Date().toISOString()})};
  const before=state;
  state={...state,[kind]:[...state[kind],item],activity:[{id:uid(),title:`KI: ${kind==='notes'?'Notiz':'Aufgabe'} „${args.title}“ angelegt`,at:new Date().toISOString()},...state.activity].slice(0,60)};
  if(!save()){state=before;render();throw new Error('Die Änderung konnte nicht gespeichert werden. Es wurde nichts angelegt.');}
  const result={saved:true,id:action.id,itemId:item.id,title:args.title,kind};agentActions.set(action.id,{kind,item:JSON.stringify(item),itemId:item.id,result});render();return result;
}
function undoAgentAction(id){
  const record=agentActions.get(id);if(!record)throw new Error('Diese Änderung ist nicht mehr in dieser Sitzung verfügbar.');
  if(record.undone)return;
  if(record.kind==='calendarEvents'){
    const calendarEvents=undoCalendarEvents(state.calendarEvents,record.added),before=state;state={...state,calendarEvents};
    if(!save()){state=before;render();throw new Error('Rückgängig konnte nicht gespeichert werden.');}
    record.undone=true;calendarView.notifyLocalChange();companion.update();render();toast('Termine lokal entfernt. Bereits nach Outlook synchronisierte Termine bleiben dort erhalten.');return;
  }
  const item=state[record.kind].find(item=>item.id===record.itemId);
  if(!item){record.undone=true;return;}
  if(JSON.stringify(item)!==record.item)throw new Error('Der Eintrag wurde inzwischen bearbeitet. Öffne ihn, um deine aktuellen Änderungen zu behalten.');
  const before=state;state={...state,[record.kind]:state[record.kind].filter(item=>item.id!==record.itemId)};
  if(!save()){state=before;render();throw new Error('Rückgängig konnte nicht gespeichert werden.');}
  record.undone=true;render();
}
const browserView=createBrowserView({onChange:()=>{if(view!=='browser')return;const input=document.activeElement,id=input?.id,value=input?.value,selection=input instanceof HTMLInputElement||input instanceof HTMLTextAreaElement?[input.selectionStart,input.selectionEnd,input.selectionDirection]:null;render();const replacement=id?document.getElementById(id):null;if(replacement){if(value!==undefined)replacement.value=value;replacement.focus({preventScroll:true});if(selection&&selection[0]!==null)replacement.setSelectionRange(...selection);}},onOpen:()=>setView('browser'),onError:message=>toast(message)});
const sourceHub=createSourceHub({getWorkspace:()=>state,onChange:()=>{invalidateSearch();if(view==='sources'&&!modal.open&&!searchModal.open)render();},onNotice:toast,onOpen:url=>{if(desktopBrowserAvailable()){setView('browser');void window.contextDesktop.browser({type:'new',url});}else window.open(url,'_blank','noopener,noreferrer');},onConnections:()=>setView('connections'),onDiscover:()=>crawlerView?.open()});
const platformDiscovery=createPlatformDiscovery({getWorkspace:()=>state,onCatalog:()=>sourceHub.sync(),onSave:(platformFindings,{workspace,signal})=>{
 if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');
 if(state!==workspace)throw new Error('Der Arbeitsbereich wurde inzwischen geändert. Bitte die Kursseite erneut lesen.');
 const previous=state;state={...state,platformFindings};if(!save()){state=previous;return false;}return true;
}});
const spacesSearch=createSpacesSearchClient({getWorkspace:()=>state});
const kiView=createKIView({onSpaces:(tool,args,signal)=>spacesSearch.tool(tool,args,signal),onChange:()=>{
  if(view!=='ai'){syncAgentContext();return;}
  const active=document.activeElement,id=active?.id,selection=(active instanceof HTMLTextAreaElement||active instanceof HTMLInputElement)&&active.selectionStart!==null?[active.selectionStart,active.selectionEnd,active.selectionDirection]:null;
  render();const replacement=id?document.getElementById(id):null;if(replacement){replacement.focus({preventScroll:true});if(selection&&typeof replacement.setSelectionRange==='function')replacement.setSelectionRange(...selection);}
},getContext:()=>{const context=currentAgentContext();return {workspace:{...state,activeCourse:context.projectId},updates:remoteItems,browserSources:allBrowserSources(),platformSources:sourceHub.documents(),sources:sourceStates,pageContext:context};},onPlatform:(name,args,signal,scope)=>sourceHub.tool(name,args,signal,scope),onCurrentBoard:options=>ensureCurrentBoard(options),onBoardShot:({sourceId,...options})=>sourceHub.shot(sourceId,options),onBrowserRead:(page,scope)=>platformDiscovery.discover(page,scope),onAction:applyAgentAction,onUndo:undoAgentAction,onCalendarOpen:()=>calendarView.open(),onCalendarExport:ids=>{const value=calendarICSForIds(ids,state),url=URL.createObjectURL(new Blob([value],{type:'text/calendar;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='context-terminplan-'+dateKey()+'.ics';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);},onSource:source=>{
 if(['miro','service'].includes(source.kind)&&source.url&&desktopBrowserAvailable()){setView('browser');void window.contextDesktop.browser({type:'new',url:source.url});return;}
  if(source.id?.startsWith('n:diary:'))diaryView.open(source.targetId,/\d{4}-\d{2}-\d{2}$/.test(source.id)?source.id.slice(-10):undefined);
  else if(source.kind==='notes')editMarkdownNote(source.targetId);
  else if(source.kind==='tasks')editTask(source.targetId);
  else if(source.kind==='projects'&&source.targetId)showProject(source.targetId);
  else{const item=remoteItems.find(n=>n.id===source.targetId);if(item)previewNotification(item);else openModal(modalHead(source.title||'Gespeicherte Quelle','Im Chat verwendeter Textausschnitt')+`<div class="markdown-content">${renderMarkdown(source.text||'Kein Textausschnitt gespeichert.',[])}</div>${source.url?external(source.url,'Originalquelle öffnen','button secondary'):''}`);}
},onNote:draft=>{noteDrafts.set('',{...draft,content:draft.content.slice(0,50000),projectId:currentAgentContext().projectId});editMarkdownNote('');}});
floatingAgent=createFloatingAgent({agent:kiView,getContext:currentAgentContext,native:!!window.webkit?.messageHandlers?.contextFloating,onOpenChange:opened=>{floatingOpen=opened;if(view==='ai')render();}});
companion=createCompanion({onRefreshSources:()=>refreshFeed(),getContext:()=>({workspace:state,updates:remoteItems,sources:sourceStates,platformSources:sourceHub.documents(),browserSources:crawlerView?.sources()||[]}),getAI:()=>({...kiView.configuration(),busy:kiView.isBusy(),load:()=>kiView.load()}),onChange:()=>{invalidateSearch();if(['today','companion'].includes(view)&&!modal.open&&!searchModal.open){const active=document.activeElement,id=active?.id,value=active?.value;render();const replacement=id?document.getElementById(id):null;if(replacement){if(value!==undefined)replacement.value=value;replacement.focus({preventScroll:true});}}},onAttention:count=>floatingAgent?.setAttention(count),onTask:finding=>{
  const existing=matchingTask(state,finding);if(existing){if(finding.changed){const previous={...existing};existing.due=finding.due||'';existing.url=finding.source.url||existing.url;if(!save()){Object.assign(existing,previous);throw new Error('Die Änderung konnte nicht gespeichert werden.');}toast('Aufgabenfrist aktualisiert.');}return existing;}
  if(state.tasks.length>=2000)throw new Error('Der Aufgabenbereich ist voll.');
  const task={id:uid(),title:finding.title,projectId:state.projects.some(p=>p.id===finding.projectId)?finding.projectId:'',due:finding.due||'',status:'todo',url:finding.source.url||'',createdAt:new Date().toISOString()};
  const before=state;state={...state,tasks:[...state.tasks,task]};if(!save()){state=before;throw new Error('Die Aufgabe konnte nicht gespeichert werden.');}activity('Begleiter: '+task.title);save();toast('Aufgabe übernommen.');return task;
},onSource:source=>{
 if(['miro','service'].includes(source.kind)&&source.url&&desktopBrowserAvailable()){setView('browser');void window.contextDesktop.browser({type:'new',url:source.url});return;}
  if(source.id?.startsWith('n:diary:'))diaryView.open(source.targetId,/\d{4}-\d{2}-\d{2}$/.test(source.id)?source.id.slice(-10):undefined);else if(source.kind==='notes')editMarkdownNote(source.targetId);else if(source.kind==='projects'&&source.targetId)showProject(source.targetId);else{const item=remoteItems.find(n=>n.id===source.targetId);if(item)previewNotification(item);else openModal(modalHead(source.title,'Beleg des Studienbegleiters')+`<div class="markdown-content">${renderMarkdown(source.text||'',[])}</div>${source.url?external(source.url,'Originalquelle öffnen','button secondary'):''}`);}
},onAsk:(prompt,projectId)=>{if(state.projects.some(p=>p.id===projectId)){state.activeCourse=projectId;save();kiView.scopeChanged();}kiView.prefill(prompt);setView('ai');}});
const mailView=createMailAccounts({onChange:()=>{invalidateSearch();if(view==='mail')render();},onConnection:mailConnectionChanged});
const nangoConnections=createNangoConnectionsView({onChange:()=>{if(view==='connections')render();},onNotice:toast,onMail:service=>{mailView.select(service);setView('mail');},onConnectionChange:({service,action})=>{if(service==='miro'){kiView.stop();sourceHub.invalidate('miro');return;}if(!service){kiView.stop();void sourceHub.invalidate();}if(service&&!['outlook','google-calendar'].includes(service)){mailView.refreshCloud();return;}mailView.refreshCloud();state={...state,calendarSync:{...state.calendarSync,automatic:false,target:{calendarId:'',title:''}}};save();void calendarView.load(true);},onMiro:()=>setView('sources'),onCalendar:service=>calendarView.open(service==='google-drive'?'drive':'')});

const calendarView=createCalendarView({onAsk:prompt=>{kiView.prefill(prompt);setView('ai');},onSyncSave:settings=>{const previous=state;state={...state,calendarSync:validateCalendarSync(settings)};if(!save()){state=previous;return false;}return true;},getContext:()=>({workspace:state,updates:remoteItems}),onChange:()=>{if(view!=='calendar'&&view!=='today')return;const active=document.activeElement,id=active?.id;render();if(id)document.getElementById(id)?.focus({preventScroll:true});},onShow:()=>setView('calendar'),onTask:id=>editTask(id),onNotice:toast,onSave:(calendarEvents,label)=>{const previous=state;state={...state,calendarEvents,activity:[{id:uid(),title:label,at:new Date().toISOString()},...state.activity].slice(0,60)};if(!save()){state=previous;return false;}companion.update();return true;}});

const boardView=createBoardView({getAI:()=>({...kiView.configuration(),busy:kiView.isBusy(),load:()=>kiView.load()}),onArchive:run=>kiView.archiveBoardSearch(run),getContext:()=>({workspace:state,updates:remoteItems,browserSources:allBrowserSources(),courseOf:u=>notificationCourse(u,state)}),isBusy:()=>kiView.isBusy()||companion?.isBusy()||crawlerView?.isBusy(),onRefresh:()=>refreshFeed(),onSave:rows=>{const previous=state;state={...state,boardFindings:rows};if(!save()){state=previous;return false;}return true;},onChange:()=>{if(view!=='boards')return;const active=document.activeElement,id=active?.id,selection=active instanceof HTMLInputElement?[active.selectionStart,active.selectionEnd]:null;render();const replacement=id?document.getElementById(id):null;if(replacement){replacement.focus({preventScroll:true});if(selection&&selection[0]!==null)replacement.setSelectionRange(...selection);}}});
let diaryReminderConfig='',diaryReminderWarnings='';
function syncDiaryReminders(){
 if(typeof window.contextDesktop?.diaryReminders!=='function')return;
 const diaries=(state.devDiaries||[]).map(d=>({id:d.id,courseName:d.courseName,startDate:d.startDate,endDate:d.endDate,archived:d.archived,reminder:{enabled:d.reminder.enabled,time:d.reminder.time,weekdays:d.reminder.weekdays},entries:d.entries.map(e=>({date:e.date,completed:e.completed}))}));
 const signature=JSON.stringify(diaries);if(signature===diaryReminderConfig)return;diaryReminderConfig=signature;
 void window.contextDesktop.diaryReminders({op:'configure',diaries}).then(reply=>{if(signature!==diaryReminderConfig)return;if(reply?.ok===false){diaryReminderConfig='';toast(reply.error);return;}const result=reply?.ok===true?reply.value:reply;if(result?.warning&&result.warning!==diaryReminderWarnings){diaryReminderWarnings=result.warning;toast(result.warning);}}).catch(()=>{diaryReminderConfig='';});
}
const diaryView=createDevDiaryView({getState:()=>state,onNotice:toast,onChange:()=>render(),onSave:diary=>{
 const validated=validateDevDiary(diary,state.projects),before=state;state={...state,devDiaries:validateDevDiaries([...(state.devDiaries||[]).filter(d=>d.id!==validated.id),validated],state.projects)};
 if(!save()){state=before;return false;}syncDiaryReminders();return true;
},onModal:(title,subtitle,body,projectId)=>{
 const content=modalHead(title,subtitle)+body;
 if(modal.open&&modal.querySelector('.dd-setup,.dd-studio,.dd-empty'))modal.innerHTML=content;else openModal(content,true);
 modal.classList.add('dev-diary-modal');
 if(projectId)modal.dataset.projectId=projectId;syncAgentContext();
}});
window.contextDesktop?.onEvent?.(({type,detail})=>{if(type==='context-platform-auth')kiView.stop();if(type==='context-spaces-auth'){spacesSearch.invalidate();kiView.stop();}if(type==='context-diary-reminder-open'&&state.devDiaries?.some(d=>d.id===detail?.diaryId)){setView('notes');diaryView.open(detail.diaryId,detail.date);}});
crawlerView=createSpacesCrawlView({dialog:modal,getWorkspace:()=>state,onModal:body=>{openModal(modalHead('Spaces indexieren','Kursseiten lokal durchsuchbar machen')+body,true);modal.classList.add('spaces-crawl-modal');modal.dataset.crawl='true';},onChange:invalidateSearch,onDiscovery:(page,scope)=>platformDiscovery.discover(page,scope),onSearch:()=>openSearch(),isOtherBusy:()=>kiView.isBusy()||companion.isBusy()||boardView.isBusy()});
function allBrowserSources(){return [...(companion?.sources()||[]),...(crawlerView?.sources()||[])];}
searchView=createSearchView({dialog:searchModal,getContext:()=>({workspace:state,sources:sourceStates}),getDocuments:getSearchDocuments,onOpen:openIndexedResult,onLiveSearch:options=>spacesSearch.search(options),onOpenLive:async item=>{try{const value=await spacesSearch.read({projectId:item.projectId,id:item.id});openModal(modalHead(value.title,'Spaces · direkt gelesen')+`<div class="markdown-content search-source-preview">${renderMarkdown(value.text,[])}</div>${value.hasMore?'<p class="subtle-note">Auszug. Den vollständigen Beitrag im Original öffnen.</p>':''}<div class="form-footer">${external(value.url,'Original öffnen','button primary')}</div>`);}catch(error){toast(error.message);}},onCrawl:()=>crawlerView.open(),onRefreshSources:options=>sourceHub.refresh(options),onAgentSearch:({query,projectId})=>{if(kiView.isBusy()){toast('Der Agent arbeitet gerade.');return;}state.activeCourse=projectId||'';save();kiView.scopeChanged();kiView.prefill('Suche in meinen verknüpften Kursquellen, lies passende Miro-Boards, Sciebo-Ordner und GitLab-Seiten und belege die Antwort: '+query);setView('ai');}});
window.addEventListener('context-chat-saved',invalidateSearch);
window.addEventListener('pagehide',event=>{if(event.persisted)crawlerView.pause();else{searchView.dispose();crawlerView.dispose();sourceHub.dispose();spacesSearch.dispose();}});
const inventoryView=createInventoryView({onChange:()=>{if(view==='inventory')render();},onError:toast});
function renderInventory(){return inventoryView.render();}
function render() {
  if(document.getElementById('board-edit-dialog')?.open)return;
  const inboxViewport=view==='inbox'?captureInboxViewport():null;
  const calendarViewport=view==='calendar'?captureCalendarDayViewport():null;
  const mailViewport=view==='mail'?captureMailViewport():null;
  const chatViewport=view==='ai'&&!floatingOpen?captureChatViewport():null;
  document.body.classList.toggle('mail-active',view==='mail');
  document.body.classList.toggle('browser-active',view==='browser'||view==='inventory');
  document.body.classList.toggle('ai-active',view==='ai'&&!floatingOpen);
  const c=taskCounts(scopedState());
  const unread=inboxItems().filter(n=>!state.inboxRead.includes(notificationKey(n))).length;
  const names={sources:'Quellen',connections:'Verbindungen',boards:'Miro-Boards',inventory:'Studio-Inventar',today:'Heute',calendar:'Kalender',companion:'Begleiter',inbox:'Mitteilungen',mail:'Mail',projects:'Projekte',tasks:'Aufgaben',links:'Ablage',notes:'Notizen',ai:'Hochschul-KI',browser:'Browser',imports:'Importieren',plugins:'Plugins',submissions:'Abgaben',tools:'Tools',settings:'Einstellungen'};
  $('#app').innerHTML=`
  <aside class="sidebar" aria-label="Hauptnavigation">
    <a class="brand" href="#today" data-view="today"><span class="brand-mark" aria-hidden="true">✳</span><span>context<span class="brand-sub">CODE & CONTEXT</span></span></a>
    <button class="workspace" data-view="settings"><span class="workspace-avatar">C&C</span><span>Dein Arbeitsbereich<small>TH Köln · persönlich</small></span><span class="workspace-chevron">⌄</span></button>
    <p class="nav-label">ARBEITSBEREICH</p>
    <nav aria-label="Arbeitsbereich">${renderNavigation()}</nav>
    <div class="sidebar-bottom"><button data-view="settings" class="nav-item ${view==='settings'?'active':''}">${icon('settings')}<span>Einstellungen</span></button><div class="profile"><span class="user-avatar">${esc(state.profile.name?state.profile.name.slice(0,1).toUpperCase():'C')}</span><span>${esc(state.profile.name || 'Dein persönlicher Hub')}<small>Code & Context</small></span><span class="version">v0.18.4</span></div></div>
  </aside>
  <div class="page-shell"><header class="topbar"><div class="breadcrumb"><button class="mobile-menu icon-button" data-action="menu" aria-label="Navigation öffnen" title="Navigation öffnen">${icon('menu')}</button><strong>${names[view]}</strong></div><label class="course-switch"><span>KURS</span><select id="course-switch" aria-label="Kurs auswählen" ${kiView.isBusy()?'disabled':''}>${courseOptions()}</select></label><button class="search-trigger" data-action="search" aria-label="Arbeitsbereich durchsuchen" title="Arbeitsbereich durchsuchen">${icon('search',17)}<span>Suche</span><kbd>⌘ K</kbd></button><button class="theme-toggle icon-button" type="button" data-action="toggle-theme" data-theme-toggle aria-label="Darkmode aktivieren" aria-pressed="false"><span class="theme-moon" aria-hidden="true">${icon('moon',18)}</span><span class="theme-sun" aria-hidden="true">${icon('sun',18)}</span></button><button class="inbox-trigger icon-button" data-view="inbox" aria-label="Posteingang öffnen${unread?', '+unread+' neue Hinweise':''}">${icon('bell',18)}${unread?'<span class="bell-dot"></span>':''}</button><span class="local-indicator"><span class="tiny-dot ${storageAvailable?'':'warning'}"></span>${storageAvailable?'Lokal gespeichert':'Nicht gespeichert'}</span></header>
  <main id="main" tabindex="-1">${({sources:()=>sourceHub.render(),connections:()=>nangoConnections.render(),boards:()=>boardView.render(),inventory:renderInventory,today:renderToday,calendar:()=>calendarView.render(),companion:()=>companion.render(),browser:()=>browserView.render(),inbox:renderInbox,mail:()=>mailView.render(),projects:renderProjects,tasks:renderTasks,links:renderBookmarks,notes:renderNotes,ai:()=>floatingOpen?heading('DEIN KONTEXTASSISTENT','Chat im Panel','',`<button class="button secondary" data-action="context-agent">${icon('star',17)} Chat hier anzeigen</button>`):kiView.render(),imports:renderImports,plugins:renderPlugins,submissions:renderSubmissions,tools:renderTools,settings:renderSettings}[view])()}</main>
  <footer class="page-footer"><span>context <span class="footer-dot">·</span> Code & Context, TH Köln</span><button data-action="about" title="Informationen über Context">${icon('info',15)} Über Context</button></footer></div>`;
  if(view==='inventory'){if(!modal.open)browserView.hide();inventoryView.mount();}
  else{inventoryView.hide();if(view==='browser')browserView.mount();else if(!modal.open)browserView.hide();}
  if(view==='ai')void kiView.load();
  if(view==='mail')void mailView.load();
  if(view==='calendar')void calendarView.load();
  if(view==='connections'&&!nangoConnections.state().loaded&&!nangoConnections.state().busy)void nangoConnections.load();
  const openProject=modal.open&&modal.classList.contains('project-workspace')?project(modal.dataset.projectId):null;
  if(openProject){
    const tasks=state.tasks.filter(t=>t.projectId===openProject.id),summary=modal.querySelector('.project-management>summary>span'),list=modal.querySelector('.project-detail .task-list');
    if(summary)summary.textContent=tasks.length+' Aufgaben · '+openProject.links.length+' Verbindungen';
    if(list)list.innerHTML=tasks.length?tasks.map(t=>taskRow(t,true)).join(''):'<p class="quiet-row">Noch keine Aufgaben für dieses Projekt.</p>';
  }
  window.contextTheme?.refreshControls();
  restoreInboxViewport(inboxViewport);
  restoreMailViewport(mailViewport);
  restoreChatViewport(chatViewport);
  if(view==='calendar')mountCalendarDayViewport(calendarViewport);
  syncAgentContext();
}
function heading(eyebrow,title,subtitle,action='') {
  const kind=({today:'home',inbox:'bell',projects:'projects',tasks:'tasks',notes:'note',links:'links',tools:'tools',settings:'settings',imports:'download',submissions:'upload',ai:'star'})[view]||'projects';
  return `<div class="page-heading app-heading"><div class="app-heading-copy"><div class="app-title-line"><span class="app-heading-icon">${icon(kind,26)}</span><h1>${esc(title)}</h1></div>${subtitle?`<p class="page-description">${esc(subtitle)}</p>`:''}</div>${action}</div>`;
}
function sectionTitle(title,actionText,action) { return `<div class="section-title"><h2>${title}</h2>${actionText?`<button ${action}>${actionText} ${icon('arrow',16)}</button>`:''}</div>`; }
function empty(title,text,actionText,action,kind='note') { return `<div class="empty-state">${icon(kind,28)}<h3>${esc(title)}</h3><p>${esc(text)}</p>${actionText?`<button class="button secondary" ${action}>${esc(actionText)}</button>`:''}</div>`; }
function renderNavigation(){
 const primary=[['today','home','Heute'],['projects','projects','Kurse'],['inbox','bell','Mitteilungen'],['mail','mail','Mail'],['calendar','calendar','Kalender'],['notes','note','Notizen'],['ai','star','Context Agent'],['sources','links','Quellen'],['inventory','tools','Studio-Inventar']];
 const secondary=[['tasks','tasks','Aufgaben'],['companion','star','Begleiter'],['boards','projects','Miro-Boards'],['browser','external','Browser'],['links','links','Ablage'],['submissions','upload','Abgaben'],['imports','download','Importieren'],['plugins','tools','Plugins'],['connections','links','Verbindungen'],['tools','tools','Alle Tools']];
 const button=([id,name,label])=>`<button data-view="${id}" class="nav-item ${view===id?'active':''}" ${view===id?'aria-current="page"':''}>${icon(name)}<span>${label}</span></button>`;
 return primary.map(button).join('')+`<details class="nav-more" ${secondary.some(row=>row[0]===view)?'open':''}><summary>${icon('menu',18)}<span>Mehr</span><span aria-hidden="true">⌄</span></summary><div>${secondary.map(button).join('')}</div></details>`;
}
function renderToday() {
 const active=state.projects.filter(p=>!p.archived&&courseMatches(p.id,state.activeCourse));
 const tasks=state.tasks.filter(t=>inCourse(t)&&t.status!=='done').sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999')).slice(0,4);
 const events=(state.calendarEvents||[]).filter(e=>inCourse(e)&&Date.parse(e.end)>Date.now()).sort((a,b)=>a.start.localeCompare(b.start)).slice(0,4);
 const greeting=state.profile.name?`Hallo ${state.profile.name.split(' ')[0]}`:'Dein Kontext.';
 return `<section class="home-focus"><header><p class="small-label">CODE & CONTEXT</p><h1>${esc(greeting)}</h1></header><form id="workspace-search"><label class="sr-only" for="home-search-query">Alles durchsuchen</label>${icon('search',22)}<input id="home-search-query" name="query" maxlength="200" placeholder="Kurse, Aufgaben, Boards …"><button type="submit" class="icon-button" aria-label="Alles durchsuchen" title="Suchen">${icon('arrow',20)}</button></form><div class="home-search-options"><button class="text-link" data-action="home-agent">${icon('star',17)} Agent fragen</button><button class="text-link" data-view="sources">${icon('links',17)} Quellen</button></div><div class="home-service-row">${state.tools.filter(t=>t.pinned).map(t=>`<a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer" data-open="${esc(meta(t.id).name)}" title="${esc(meta(t.id).name)}">${monogram(t.id,true)}<span>${esc(meta(t.id).name)}</span></a>`).join('')}</div></section><div class="home-next"><section>${sectionTitle('Deine nächsten Schritte','Alle Aufgaben','data-view="tasks"')}<div class="task-list">${tasks.map(t=>taskRow(t,true)).join('')||'<p class="home-quiet">Keine offenen Aufgaben.</p>'}</div><button class="text-link" data-view="companion">${icon('star',16)} Kursaufgaben prüfen</button></section><section>${sectionTitle('Als Nächstes','Kalender','data-view="calendar"')}<div class="home-agenda">${events.map(e=>`<button data-calendar-event="${esc(e.id)}"><time>${esc(new Date(e.start).toLocaleDateString('de-DE',{day:'numeric',month:'short'}))}<small>${e.allDay?'Ganztägig':esc(new Date(e.start).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}))}</small></time><span>${esc(e.title)}<small>${esc(project(e.projectId)?.name||'Persönlich')}</small></span></button>`).join('')||'<p class="home-quiet">Keine anstehenden Termine.</p>'}</div></section></div><section class="home-courses">${sectionTitle('Deine Kurse','Alle Kurse','data-view="projects"')}<div>${active.slice(0,4).map(p=>`<button data-action="project" data-id="${esc(p.id)}"><span class="project-dot ${p.color}"></span><strong>${esc(p.name)}</strong>${icon('arrow',17)}</button>`).join('')||'<button class="text-link" data-action="add-project">Kurs hinzufügen</button>'}</div></section>`;
}

function relativeTime(at) { const mins=Math.floor((Date.now()-new Date(at).getTime())/60000); return Number.isNaN(mins)?'':mins<1?'gerade eben':mins<60?`vor ${mins} Min.`:mins<1440?`vor ${Math.floor(mins/60)} Std.`:dateLabel(dateKey(new Date(at))); }
function projectCard(p) {
  const tasks=state.tasks.filter(t=>t.projectId===p.id), done=tasks.filter(t=>t.status==='done').length;
  return `<article class="project-card"><div class="project-card-top"><span class="project-symbol ${p.color}">${esc(p.name.slice(0,2).toUpperCase())}</span><span class="tag">${p.archived?'Archiviert':'Kurs / Projekt'}</span></div><button class="project-name" data-action="project" data-id="${p.id}">${esc(p.name)}${icon('arrow',18)}</button>${p.subtitle?`<p>${esc(p.subtitle)}</p>`:''}<div class="project-connections">${p.links.length?p.links.map(l=>`<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" data-open="${esc(l.title)}" title="${esc(l.title)}">${monogram(l.tool,true)}<span>${esc(meta(l.tool).name)}</span></a>`).join(''):'<span class="subtle-note">Noch keine Links verknüpft</span>'}</div><div class="project-card-bottom"><span>${p.links.length} ${p.links.length===1?'Verbindung':'Verbindungen'}</span><span>${tasks.length?`${done}/${tasks.length} erledigt`:'Keine offenen Aufgaben'}</span></div></article>`;
}
function renderProjects() {
  const list=state.projects.filter(p=>showArchived?p.archived:!p.archived);
  return heading('DEIN KONTEXT','Projekte','',`<div class="companion-heading-actions"><button class="button secondary" data-action="spaces-crawl">${icon('search',17)} Spaces indexieren</button><button class="button primary" data-action="add-project">${icon('plus',17)} Neues Projekt</button></div>`)+`<div class="filter-row"><button class="filter ${showArchived?'':'selected'}" data-action="project-filter" data-value="active">Aktiv <span>${state.projects.filter(p=>!p.archived).length}</span></button><button class="filter ${showArchived?'selected':''}" data-action="project-filter" data-value="archived">Archiv <span>${state.projects.filter(p=>p.archived).length}</span></button></div><div class="projects-page-grid">${list.map(projectCard).join('')||empty(showArchived?'Archiv leer':'Noch keine Projekte',showArchived?'Projekte lassen sich jederzeit wiederherstellen.':'Kurs-Space, Channel und Repository verbinden.',showArchived?'':'Projekt anlegen','data-action="add-project"','projects')}</div>`;
}
function taskRow(t,compact=false) {
  const overdue=t.due&&t.due<dateKey()&&t.status!=='done';
  return `<div class="task-row ${compact?'compact':''} ${t.status==='done'?'completed':''}"><button class="task-check ${t.status==='done'?'checked':''}" data-action="toggle-task" data-id="${t.id}" aria-label="${esc(t.title)} ${t.status==='done'?'wieder öffnen':'erledigen'}" aria-pressed="${t.status==='done'}">${t.status==='done'?icon('check',14):''}</button><div class="task-body"><button data-action="edit-task" data-id="${t.id}">${esc(t.title)}</button><div class="task-meta">${t.projectId?`<span class="project-dot ${project(t.projectId)?.color}"></span>${esc(project(t.projectId)?.name || '')}`:'Persönlich'}${t.due?`<span class="due ${overdue?'overdue':''}">${icon('calendar',12)}${dateLabel(t.due)}</span>`:''}</div></div>${!compact?`<span class="task-status ${t.status}">${({todo:'Offen',doing:'In Arbeit',done:'Erledigt'})[t.status]}</span>${t.url?`<a class="icon-button" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer" data-open="Aufgabenquelle" aria-label="Quelle der Aufgabe öffnen">${icon('external',16)}</a>`:''}${iconAction('edit','Aufgabe bearbeiten: '+t.title,`data-action="edit-task" data-id="${t.id}"`)}`:''}</div>`;
}
function renderTasks() {
  const c=taskCounts(scopedState());
  let list=state.tasks.filter(t=>inCourse(t)&&(!taskProject||t.projectId===taskProject)&&(taskFilter==='all'||(taskFilter==='done'?t.status==='done':taskFilter==='due'?t.status!=='done'&&t.due&&t.due<=dateKey():t.status!=='done'))).sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999'));
  return heading('EIN SCHRITT NACH DEM ANDEREN','Aufgaben','Fristen und nächste Schritte.',`<button class="button primary" data-action="add-task">${icon('plus',17)} Neue Aufgabe</button>`)+`<div class="filter-row wrap"><div class="filters">${[['open','Offen',c.open],['due','Fällig',c.due],['done','Erledigt',c.done],['all','Alle',state.tasks.filter(inCourse).length]].map(([id,n,count])=>`<button class="filter ${taskFilter===id?'selected':''}" data-action="task-filter" data-value="${id}">${n}<span>${count}</span></button>`).join('')}</div><label class="select-label">Projekt<select id="task-project-filter"><option value="">Alle Projekte</option>${state.projects.map(p=>`<option value="${p.id}" ${state.activeCourse===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label></div><section class="task-list">${list.length?list.map(t=>taskRow(t)).join(''):empty(taskFilter==='done'?'Noch nichts abgeschlossen.':taskFilter==='due'?'Alles im grünen Bereich.':'Platz für deinen nächsten Schritt.',taskFilter==='due'?'Keine offenen Aufgaben sind heute fällig.':'Füge eine Aufgabe hinzu und verknüpfe sie bei Bedarf mit einem Projekt.','Aufgabe anlegen','data-action="add-task"','tasks')}</section><p class="subtle-note">Persönliche Aufgaben. GitLab-Issues werden hier noch nicht automatisch synchronisiert.</p>`;
}
function renderBookmarks() {
  return heading('GUT AUFGEHOBEN','Ablage','',`<button class="button primary" data-action="add-link">${icon('plus',17)} Neuer Link</button>`)+`<div class="bookmark-grid">${state.bookmarks.filter(inCourse).map(b=>`<article class="bookmark-card"><div class="bookmark-top">${monogram(b.tool)}<span class="tag">${esc(meta(b.tool).name)}</span>${iconAction('edit',b.title+' bearbeiten',`data-action="edit-link" data-id="${b.id}"`)}</div>${external(b.url,b.title,'bookmark-title')}<p>${esc(b.note)||esc(new URL(b.url).hostname)}</p><div class="bookmark-footer"><span>${esc(project(b.projectId)?.name || 'Persönliche Ablage')}</span></div></article>`).join('')||empty('Noch keine Links','Beiträge, Dateien und Repositories hier ablegen.','Link hinzufügen','data-action="add-link"','links')}</div>`;
}
function inboxItems() { return [...taskNotifications(state),...devDiaryReminderNotifications(state),...remoteItems].filter(n=>!['archived','manual-unavailable','unsafe-url','unsafe-group-url'].includes(resolveNotificationCourse(n,state).reason)&&(view==='inbox'&&inboxGroup==='__unassigned__'?notificationCourse(n,state)==='':courseMatches(notificationCourse(n,state),state.activeCourse))).sort(compareNotificationTime); }
function sourceName(source) { return source==='context'?'Context':meta(source)?.name||source; }
function notificationRow(n,compact=false) {
  const read=state.inboxRead.includes(notificationKey(n));
  const stale=sourceStates.find(s=>s.source===n.source)?.status==='error';
  const course=notificationCourse(n,state),courseName=project(course)?.name||'Ohne Kurszuordnung';
  const assignment=typeof resolveNotificationCourse==='function'?resolveNotificationCourse(n,state):null;
  const courseReason=assignment?.ambiguous?'Mehrere passende Kurse — bitte zuordnen':assignment?.manual?'Manuell zugeordnet':course&&n.source!=='context'?'Aus der Quelle zugeordnet':'Kurszuordnung ändern';
  const group=notificationGroup(n,state),excerpt=String(n.content||n.summary||'').replace(/\s+/g,' ').trim();
  const contentLabel=n.source==='context'?'':n.kind==='summary'?'Zusammenfassung':n.content?(n.contentStatus==='full'?'Volltext':'Auszug'):n.source==='webmail'?'Kopfzeile':'Nur Metadaten';
  const readLabel=n.title+' '+(read?'als neu markieren':'im Hub abhaken');
  let original='';try{if(n.url)original=safeURL(n.url);}catch{}
  return `<article class="notification-row inbox-notice ${read?'read':''} ${compact?'compact':''}"><span class="notification-source" aria-hidden="true">${n.source==='context'?icon(n.diaryId?'note':'calendar',20):monogram(n.source,true)}</span><div class="notification-body"><div class="inbox-notice-head"><button class="notification-title" data-action="open-notification" data-id="${esc(n.id)}">${!read?'<span class="inbox-new-dot" aria-hidden="true"></span><span class="sr-only">Neu: </span>':''}${esc(n.title)}</button><time class="inbox-notice-time">${esc(notificationTime(n))}</time></div>${excerpt?`<p class="inbox-notice-excerpt">${esc(excerpt.slice(0,compact?130:240))}${excerpt.length>(compact?130:240)?'…':''}</p>`:''}<div class="notification-meta"><strong>${esc(sourceName(n.source))}</strong>${group.name&&group.name!==courseName&&group.name!=='Weitere Hinweise'?`<span class="inbox-group-name">${esc(group.name)}</span>`:''}${n.relatedTool?`<span>über ${esc(meta(n.relatedTool)?.name||n.relatedTool)}</span>`:''}${compact?`<span class="notification-course-name">${esc(courseName)}</span>`:`<details class="inbox-assignment" data-inbox-detail="assign:${esc(n.id)}"><summary aria-label="Kurs zuordnen: ${esc(n.title)}" aria-description="${esc(courseReason)}" title="${esc(courseReason)}">${icon('projects',12)}<span>${esc(courseName)}</span>${icon('edit',12)}</summary><label class="notification-course-label">Kurszuordnung<select data-notification-course="${esc(n.id)}" aria-label="Kurs für ${esc(n.title)}">${projectOptions(course)}</select></label></details>`}${contentLabel?`<span class="inbox-content-label">${contentLabel}</span>`:''}${n.mode==='snapshot'?'<span class="stale-tag">Browser-Stand</span>':''}${stale?'<span class="stale-tag">Letzter Stand</span>':''}</div></div><div class="inbox-notice-actions"><button class="icon-button ${read?'is-read':''}" data-action="read-notification" data-id="${esc(n.id)}" aria-label="${esc(readLabel)}" title="${esc(readLabel)}" aria-pressed="${read}">${icon(read?'check':'dot',17)}</button>${!compact&&original?`<a class="icon-button inbox-original" href="${esc(original)}" target="_blank" rel="noopener noreferrer" data-open="${esc(sourceName(n.source))}" aria-label="Original öffnen: ${esc(n.title)}" title="Original öffnen">${icon('external',15)}</a>`:''}</div></article>`;
}
function filteredInboxItems(){return inboxItems().filter(n=>(inboxSource==='all'||n.source===inboxSource)&&(inboxGroup==='all'||(inboxGroup==='__unassigned__'?notificationCourse(n,state)==='':notificationGroup(n,state).id===inboxGroup))&&(inboxFilter==='all'||!state.inboxRead.includes(notificationKey(n))));}
function renderInbox() {
  const groups=notificationGroups(inboxItems().filter(n=>inboxSource==='all'||n.source===inboxSource),state);
  if(inboxGroup!=='__unassigned__')inboxGroup=resolveNotificationGroup(inboxGroup,groups);
  const items=filteredInboxItems();
  const count=inboxItems().filter(n=>!state.inboxRead.includes(notificationKey(n))).length;
  const providers=[...new Set(['context','spaces','mattermost','gitlab','webmail',...sourceStates.map(s=>s.source),...inboxItems().map(n=>n.source)])];
  const issues=sourceStates.filter(s=>s.status==='error'||s.status==='login_required').length;
  const available=sourceStates.filter(s=>s.status==='connected'||s.status==='snapshot').length;
  const scope=inboxGroup==='__unassigned__'?'Ohne Kurs · alle Kurse':state.activeCourse?project(state.activeCourse)?.name||'Gewählter Kurs':'Alle Kurse';
  const syncStatus=typeof inboxSyncStatus==='function'?inboxSyncStatus():'';
  const checked=feedCheckedAt&&!Number.isNaN(Date.parse(feedCheckedAt))?formatSnapshotTime(feedCheckedAt):'';
  return heading('DAS WICHTIGE ZUERST','Mitteilungen','',`<button class="button secondary" data-action="refresh-feed" aria-label="Mitteilungen aktualisieren" title="Eingerichtete Quellen prüfen" ${feedBusy?'disabled':''}>${icon('refresh',16)} ${feedBusy?'Prüfen …':'Aktualisieren'}</button>`)+`<div class="inbox-layout inbox-workspace" data-inbox-scope="${esc([state.activeCourse,inboxFilter,inboxSource,inboxGroup,inboxLimit].join('|'))}"><section class="inbox-main" aria-label="Mitteilungen"><div class="inbox-toolbar"><div class="filters inbox-read-filters" role="group" aria-label="Hinweise filtern"><button class="filter ${inboxFilter==='new'?'selected':''}" data-action="inbox-filter" data-value="new" aria-pressed="${inboxFilter==='new'}">Neu <span>${count}</span></button><button class="filter ${inboxFilter==='all'?'selected':''}" data-action="inbox-filter" data-value="all" aria-pressed="${inboxFilter==='all'}">Alle</button></div><label class="inbox-filter-label" for="inbox-source">${icon('links',14)}<span>Quelle</span><select id="inbox-source"><option value="all">Alle Quellen</option>${providers.map(s=>`<option value="${esc(s)}" ${inboxSource===s?'selected':''}>${esc(sourceName(s))}</option>`).join('')}</select></label><label class="inbox-filter-label inbox-group-filter" for="inbox-group">${icon('projects',14)}<span>Gruppe / Kanal</span><select id="inbox-group"><option value="all">Alle Gruppen</option><option value="__unassigned__" ${inboxGroup==='__unassigned__'?'selected':''}>Ohne Kurszuordnung</option>${groups.map(g=>`<option value="${esc(g.id)}" ${inboxGroup===g.id?'selected':''}>${esc(sourceName(g.source))} · ${esc(g.name)} (${g.count})</option>`).join('')}</select></label></div><div class="inbox-sync-slot">${syncStatus}</div><details class="inbox-sources" data-inbox-detail="sources"><summary>${icon('links',16)}<span>Quellen &amp; Status</span><span class="inbox-source-count">Context + ${available} ${available===1?'Quelle':'Quellen'}</span>${issues?`<span class="inbox-status-alert">${issues} ${issues===1?'Hinweis':'Hinweise'}</span>`:''}${icon('arrow',14)}</summary><div class="inbox-source-grid"><div class="source-status"><span class="source-status-icon">${icon('calendar',18)}</span><div><strong>Context</strong><small>Fällige Aufgaben · aktiv</small></div><span class="source-status-dot connected" aria-hidden="true"></span></div>${sourceStates.map(s=>{const status=['connected','snapshot','login_required','error','not_configured'].includes(s.status)?s.status:'not_configured';return `<button class="source-status" data-action="connection-help" data-id="${esc(s.source)}" aria-label="${esc(sourceName(s.source))}: Verbindung und Hinweise" title="Verbindung und Hinweise öffnen">${monogram(s.source,true)}<span><strong>${esc(sourceName(s.source))}</strong><small>${status==='connected'?'Verbunden · nur lesen':status==='snapshot'?'Browser-Stand · '+esc(formatSnapshotTime(s.capturedAt)):status==='login_required'?'Erneute Anmeldung erforderlich':status==='error'?'Abruf fehlgeschlagen':'Noch nicht eingerichtet'}</small>${s.message?`<small class="source-detail">${esc(s.message)}</small>`:''}</span><span class="source-status-dot ${status}" aria-hidden="true"></span></button>`;}).join('')}</div><div class="inbox-source-settings"><div class="connection-footnote">${sourceStates.some(s=>s.status==='snapshot'&&!s.complete)?'<p class="snapshot-incomplete">Browser-Stand: nur ein Teil der Hinweise. Weitere Einträge können beim Anbieter vorhanden sein.</p>':''}<details class="app-details"><summary>${icon('info',16)}<span>Browser-Stand &amp; Aktualisieren</span></summary><div class="app-details-content"><p>Browser-Stände enthalten bereits vorhandene Hinweise mit Abrufzeit und bleiben lokal auf diesem Mac. Aktualisieren prüft eingerichtete APIs; es lädt keinen neuen Browser-Stand.</p></div></details><button class="text-link" data-action="connection-help" data-id="overview">${icon('settings',15)} Verbindungen einrichten</button></div><div class="desktop-notifications"><h3>${icon('bell',16)} Desktop-Hinweise</h3><p>Neue Einträge, ohne Betreff auf dem Sperrbildschirm.</p><button class="button secondary" data-action="desktop-notifications" aria-pressed="${state.notificationSettings.desktop}" title="Desktop-Hinweise bei geöffnetem Hub">${icon('bell',15)}${state.notificationSettings.desktop?'Hinweise ausschalten':'Hinweise aktivieren'}</button><small>Hinweise funktionieren bei geöffnetem Hub.</small></div></div></details><div class="inbox-list-heading"><p class="inbox-total"><strong>${items.length}</strong> ${items.length===1?'Hinweis':'Hinweise'}<span>${esc(scope)}</span></p>${checked?`<span class="inbox-checked" title="Letzte Prüfung: ${esc(checked)}">${icon('refresh',13)} ${esc(checked)}</span>`:''}</div><div class="notification-list" aria-label="Hinweise">${items.length?items.slice(0,inboxLimit).map(n=>notificationRow(n)).join(''):empty(inboxFilter==='new'?'Keine neuen Hinweise':'Keine Hinweise',available?'Für diesen Kurs und Filter liegen keine Hinweise vor.':'Fällige Aufgaben erscheinen hier. Weitere Quellen kannst du einrichten.','Aufgabe anlegen','data-action="add-task"','bell')}</div>${items.length>inboxLimit?`<button class="button secondary more-notifications" data-action="more-notifications">${icon('plus',15)} Weitere ${items.length-inboxLimit} Hinweise</button>`:''}<details class="app-details inbox-read-help"><summary>${icon('info',15)}<span>Abhaken im Hub</span></summary><div class="app-details-content"><p>Abhaken wirkt nur in deinem Hub. Mails und Nachrichten bleiben beim Anbieter ungelesen.</p></div></details></section></div>`;
}

function previewNotification(n){
  if(n.source==='webmail'&&n.mailTarget){if(modal.open)modal.close();setView('mail');void mailView.open(n.mailTarget);return;}
  const content=previewContent(n);const group=notificationGroup(n,state);const read=state.inboxRead.includes(notificationKey(n));
  const items=filteredInboxItems();const index=items.findIndex(item=>item.id===n.id);const previous=items[index-1];const next=index>=0?items[index+1]:undefined;
  openModal(modalHead(n.title,sourceName(n.source)+' · '+group.name)+`<div class="message-preview"><div class="message-preview-meta">${monogram(n.source,true)}<span>${esc(n.summary)}</span><time>${esc(notificationTime(n))}</time></div><div class="message-preview-status"><span class="tag">${esc(content.label)}</span>${n.mode==='snapshot'?'<span class="tag">Lokaler Browser-Stand</span>':''}</div>${content.html||`<div class="message-missing"><h3>${n.source==='webmail'?'Der Betreff ist da. Der Mailtext noch nicht.':'Hier fehlt noch der Nachrichtentext.'}</h3><p>${n.kind==='summary'?'Dieser Eintrag fasst ungelesene Nachrichten zusammen. Einzelne Nachrichten sind noch nicht eingelesen.':'Dieser Stand enthält bisher die Kopfzeile. Den vollständigen Inhalt findest du beim Anbieter.'}</p></div>`}${content.text&&!content.full?'<p class="message-excerpt-note">Dieser Text ist ein Auszug. Im Original steht möglicherweise mehr.</p>':''}<div class="message-preview-footer"><button class="button secondary" data-action="preview-read" data-id="${esc(n.id)}">${icon(read?'dot':'check',16)} ${read?'Als neu markieren':'Im Hub abhaken'}</button>${n.url?external(n.url,'Original öffnen','button primary'):''}</div><div class="message-pagination"><button class="text-link" data-action="preview-adjacent" data-id="${esc(previous?.id||'')}" title="Vorherige Nachricht" aria-label="Vorherige Nachricht" ${previous?'':'disabled'}>${icon('back',16)} Vorherige</button><span>${index>=0?index+1:1} / ${items.length||1}</span><button class="text-link" data-action="preview-adjacent" data-id="${esc(next?.id||'')}" title="Nächste Nachricht" aria-label="Nächste Nachricht" ${next?'':'disabled'}>Nächste ${icon('arrow',16)}</button></div>${detailHint('Vorschau & Lesestatus','<p>Abhaken wirkt nur im Hub. Anhänge und eingebettete Medien öffnen beim Anbieter; externe Bilder werden nicht geladen.</p>')}</div>`,true);
  modal.dataset.notificationId=n.id;syncAgentContext();
}

function connectionHelp(source) {
  const content={
    spaces:['TH-Spaces','Die vorhandenen Kurs-Aktivitäten wurden aus deiner angemeldeten Browser-Ansicht gelesen. Ihr Datum und Kurs bleiben sichtbar.','Ein Browser-Stand ist eine lokale Momentaufnahme. Eine automatische Spaces-Synchronisierung ist noch nicht verbunden.'],
    overview:['Deine Quellen verbinden','Der mitgelieferte lokale Server hat lesende Connectoren für Mattermost, GitLab und TH-Webmail. Die lokalen Connectoren laufen auf deinem Mac. Bei einer gehosteten Version müssen sie gesondert verbunden werden.','TH-Mail wird direkt im Mailbereich verbunden. GitLab und Mattermost trägst du bei der jeweiligen Quelle ein: Der Token wird geprüft und verschlüsselt im Schlüsselbund gespeichert; alternativ richtet sie der lokale Start-Assistent ein. Zugangsdaten gehören weder in Projektlinks noch in Backups.'],
    mattermost:['Mattermost','Der Connector liest begrenzte Textvorschauen ungelesener Nachrichten pro Kanal. Original-Links und Kanalzuordnung bleiben erhalten. Er sendet nichts und verändert keine Lesestände.','Benötigt einen persönlichen Mattermost-Zugriffstoken. Der Teilstand prüft bis zu 20 Kanäle und liest für bis zu 10 davon je 10 Textvorschauen. Direktnachrichten, Anhänge und Medien bleiben außerhalb; fehlende Vorschauen werden als Zähler gezeigt.'],
    gitlab:['GitLab','Der Connector liest deine offenen GitLab-To-dos, etwa Erwähnungen und Zuweisungen, von git.coco.study.','Benötigt einen GitLab-Token mit read_api-Zugriff. Er öffnet direkt die ursprüngliche Aufgabe. Ein Haken hier schließt kein GitLab-Issue.'],
    webmail:['TH-Mail','Der Mailbereich liest dein Postfach direkt über IMAP und sendet über SMTP der TH Köln. Ordner, Suche, vollständiger Text, Anhänge und Antworten sind dort verfügbar.','Verbinde das Konto unter TH-Mail mit campusID, Hochschul-Adresse und Passwort. Die Zugangsdaten bleiben im Speicher des lokalen Servers. Ungelesene Kopfzeilen erscheinen zusätzlich in den gemeinsamen Mitteilungen.']
  }[source]||[];
  const browserState=sourceStates.find(s=>s.source===source&&s.status==='snapshot');
  openModal(modalHead(content[0]||'Verbindung')+`<div class="about-copy">${browserState?`<p><strong>Bereits lokal eingelesen:</strong> ${esc(browserState.message)} Dieser Browser-Stand wird nicht automatisch beim Anbieter aktualisiert.</p>`:''}<p>${esc(content[1])}</p><p>${esc(content[2])}</p><p class="subtle-note">Die Einrichtung erfordert deine Freigabe des jeweiligen Kontozugriffs. Ein vorhandener Browser-Login allein reicht dafür nicht aus.</p>${serviceConnectable(source)?`<div class="service-connect" data-service-connect="${esc(source)}"><p class="subtle-note" role="status">Verbindung wird geprüft …</p></div>`:''}${source==='webmail'?'<button class="button secondary" data-action="mail">TH-Mail öffnen ↗</button>':''}<button class="button primary" data-action="close">Verstanden ${icon('check',16)}</button></div>`);
  if(serviceConnectable(source))void renderServiceConnect(source);
}
// GitLab and Mattermost tokens are entered here and kept only by the local server (encrypted by the desktop app).
async function renderServiceConnect(service,options={}){
  const box=modal.querySelector(`[data-service-connect="${service}"]`);if(!box)return;
  try{box.innerHTML=serviceConnectHTML(service,await loadServiceStatus(),options);}
  catch{box.innerHTML='<p class="error-message" role="alert">Der lokale Server ist nicht erreichbar.</p>';}
}
// A running read would swallow the request; the new token must be read once it is free.
async function refreshFeedAfterServiceChange(){
  for(let attempt=0;attempt<4;attempt++){const result=await refreshFeed(true);if(result?.accepted!==false||result.reason!=='busy')return;await new Promise(resolve=>setTimeout(resolve,1500));}
}
async function saveServiceForm(form){
  const service=form.dataset.service,token=String(new FormData(form).get('token')||'');form.reset();
  const box=modal.querySelector(`[data-service-connect="${service}"]`);if(box)box.querySelectorAll('button,input').forEach(el=>{el.disabled=true;});
  try{await saveServiceToken(service,token);await renderServiceConnect(service,{message:'Gespeichert. Die Mitteilungen werden jetzt geprüft.'});void refreshFeedAfterServiceChange();}
  catch(error){await renderServiceConnect(service,{message:error.message,error:true});}
}
async function forgetService(service){
  try{await forgetServiceToken(service);await renderServiceConnect(service,{message:'Der Token wurde entfernt.'});void refreshFeedAfterServiceChange();}
  catch(error){await renderServiceConnect(service,{message:error.message,error:true});}
}
function mailConnectionChanged(service,change){
  invalidateSearch();if(service!=='th')return;
  feedEpoch++;
  if(!change||change.action==='connection'){
    remoteItems=remoteItems.filter(item=>item.source!=='webmail');
    sourceStates=sourceStates.map(source=>source.source==='webmail'?{...source,status:'not_configured',message:'Verbindung wird neu geprüft.'}:source);
    feedLastError='';
  }
  if(feedBusy){feedNeedsRefresh=true;return;}
  void refreshFeed();
}
function inboxSyncStatus(){
  const status=feedRefreshStatus,live=sourceStates.some(s=>s.status==='connected'),snapshot=sourceStates.some(s=>s.status==='snapshot');
  const error=feedLastError||status.lastError;
  const due=Number.isFinite(status.nextDueAt)?new Intl.DateTimeFormat('de-DE',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Berlin'}).format(new Date(status.nextDueAt)):'';
  const label=feedBusy?'Quellen werden geprüft …':error?'Abruf fehlgeschlagen. Der letzte Stand bleibt sichtbar.':live?'Automatisch · jede Minute bei geöffneter App':snapshot?'Browser-Stand · keine Live-Synchronisierung':'Keine Live-Quelle verbunden';
  return `<p class="inbox-sync-status ${error?'error':''}" role="status">${icon(error?'info':feedBusy?'refresh':'check',15)}<span>${esc(label)}</span>${error&&due?`<small>Nächster Versuch ${esc(due)} Uhr</small>`:''}</p>`;
}
async function refreshFeed(userTriggered=false){
  return feedRefresh?.request(userTriggered);
}
async function readFeed({signal,manual:userTriggered=false}={}) {
  if(feedBusy)return {ok:false,error:'Eine Prüfung läuft bereits.'};
  feedBusy=true;if(view==='inbox'&&!modal.open&&!searchModal.open)render();
  let result={ok:true};const epoch=feedEpoch;
  try{
    const active=AbortSignal.any([AbortSignal.timeout(25000),...(signal?[signal]:[])]);
    const res=await fetch('/api/notifications'+(userTriggered?'?refresh=1':''),{credentials:'same-origin',cache:'no-store',signal:active});
    if(!res.ok||!res.headers.get('content-type')?.includes('application/json'))throw new Error('no_connector');
    const data=await res.json();if(active.aborted)throw new DOMException('Abgebrochen','AbortError');if(epoch!==feedEpoch)return {ok:true};
    const feed=parseFeedSnapshot(data,remoteItems);
    for(const c of Array.isArray(data.courses)?data.courses.slice(0,300):[]){
      try{
        if(!/^[-a-zA-Z0-9_]{1,80}$/.test(c?.id))continue;
        const url=safeURL(c.url);if(new URL(url).hostname!=='spaces.th-koeln.de')continue;
        let existing=state.projects.find(p=>p.id===c.id||p.links.some(l=>l.url===url));
        if(!existing&&state.projects.length<300){existing={id:c.id,name:requireText(c.name),subtitle:'Kurs aus deinem Browser-Stand',color:'blue',archived:false,links:[],note:''};state.projects.push(existing);}
        if(existing){let changed=false;for(const l of [{id:c.id+'-space',title:'Kurs-Space',tool:'spaces',url},...(Array.isArray(c.links)?c.links.slice(0,40):[])]){
          if(!existing.links.some(link=>link.url===l.url)&&existing.links.length<40&&LINK_META.some(t=>t.id===l.tool)&&/^[-a-zA-Z0-9_]{1,80}$/.test(l.id)){existing.links.push({id:l.id,title:requireText(l.title),tool:l.tool,url:safeURL(l.url)});changed=true;}}
          if(changed)save();}
      }catch{/* Invalid imported course metadata cannot discard a valid message feed. */}
    }
    remoteItems=feed.items;sourceStates=feed.sources;hasLocalConnector=true;feedCheckedAt=feed.checkedAt;
    feedLastError=feed.sources.some(s=>s.status==='error')?'Eine Quelle konnte nicht aktualisiert werden.':'';
    const keys=new Set(remoteItems.map(notificationKey)),fresh=[...keys].filter(key=>!seenRemoteIds.has(key));
    if(!initialFeed&&fresh.length&&state.notificationSettings.desktop&&'Notification' in window&&Notification.permission==='granted'){
      try{new Notification('Context',{body:'Es gibt neue Hinweise in deinem Arbeitsbereich.',icon:'./icon.svg',tag:'context-inbox'});}catch{/* An OS notification failure cannot invalidate the provider result. */}
    }
    seenRemoteIds=keys;initialFeed=false;
    if(feedLastError)result={ok:false,error:feedLastError};
    if(userTriggered)toast(feedLastError?'Einige Quellen konnten nicht aktualisiert werden.':'Quellen geprüft.');
  }catch(err){
    if(signal?.aborted)return {ok:false,error:'Prüfung abgebrochen.'};
    if(epoch!==feedEpoch)return {ok:true};
    feedLastError=hasLocalConnector?'Abruf fehlgeschlagen.':'Kein eingerichteter lokaler Connector erreichbar.';
    if(hasLocalConnector)sourceStates=sourceStates.map(s=>s.status==='connected'?{...s,status:'error'}:s);
    result={ok:false,error:feedLastError};
    if(userTriggered)toast(hasLocalConnector?'Abruf fehlgeschlagen. Der letzte Stand bleibt sichtbar.':'Externe Quellen brauchen den eingerichteten lokalen Connector.');
  }finally{feedBusy=false;if(!signal?.aborted){invalidateSearch();companion?.update();if(!modal.open&&!searchModal.open&&!['mail','ai'].includes(view))render();if(feedNeedsRefresh){feedNeedsRefresh=false;setTimeout(()=>void refreshFeed(),0);}}}
  return result;
}
async function toggleDesktopNotifications() {
  if(state.notificationSettings.desktop){state.notificationSettings.desktop=false;commit();toast('Desktop-Hinweise ausgeschaltet.');return;}
  if(!('Notification' in window)){toast('Dieser Browser unterstützt keine Desktop-Hinweise.');return;}
  const permission=await Notification.requestPermission();
  if(permission==='granted'){state.notificationSettings.desktop=true;commit();toast('Desktop-Hinweise bei neuen Einträgen aktiviert.');}
  else toast('Keine Berechtigung. Hinweise bleiben im Posteingang sichtbar.');
}
function renderTools() {
  return heading('DEINE VORHANDENEN DIENSTE','Tools','')+`<div class="integration-note">${icon('links',19)}<div><strong>Tools öffnen</strong><p>Ein Link erteilt keinen Kontozugriff. Verbindungen richtest du separat ein.</p></div></div><div class="tools-grid">${state.tools.map(t=>{const m=meta(t.id);return `<article class="tool-card ${brandClass(t.id)}"><div class="tool-card-top">${monogram(t.id)}<button class="pin ${t.pinned?'pinned':''}" data-action="pin" data-id="${t.id}" aria-label="${m.name} ${t.pinned?'entpinnen':'anpinnen'}" title="${m.name} ${t.pinned?'entpinnen':'anpinnen'}" aria-pressed="${t.pinned}">${icon('star',19)}</button></div><h2>${m.name}</h2><p>${m.description}</p><span class="tool-host">${esc(new URL(t.url).hostname)}</span><div class="tool-status"><span class="tiny-dot"></span> ${t.id==='signal'&&t.url===m.url?'Desktop-App / Gruppenlink':'Link eingerichtet'}</div><div class="tool-actions">${t.id==='miro'?'<button class="button primary" data-view="boards">Boards finden</button>':''}${external(t.url,t.id==='signal'&&t.url===m.url?'Desktop-App ansehen':'Öffnen','button secondary')}<button class="icon-button" data-action="tool-settings" data-id="${t.id}" aria-label="${m.name} konfigurieren" title="${m.name} konfigurieren">${icon('settings',18)}</button></div></article>`;}).join('')}</div>`;
}
function renderAppearance() {
  return `<section class="settings-panel appearance-panel"><h2>Darstellung</h2><p>Ein ruhiger Darkmode für deinen gesamten Arbeitsbereich. Du kannst selbst wählen oder den Farben deines Systems folgen.</p><label for="theme-preference">Farbschema<select id="theme-preference" data-theme-preference><option value="system">Systemeinstellung</option><option value="light">Hell</option><option value="dark">Dunkel</option></select></label><p class="appearance-status" data-theme-status role="status" aria-live="polite"></p><p class="subtle-note">Der Schalter oben wechselt direkt zwischen hell und dunkel. Eingebundene Websites nutzen ihr eigenes Farbschema, sofern sie den Darkmode unterstützen.</p></section>`;
}

function renderSettings() {
  return heading('DEIN ARBEITSBEREICH','Einstellungen','')+`<div class="settings-grid">${renderAppearance()}<section class="settings-panel"><h2>Persönlich</h2><form id="profile-form"><label>Dein Vorname<input name="name" maxlength="80" value="${esc(state.profile.name)}" placeholder="Wie dürfen wir dich begrüßen?" autocomplete="given-name"></label><label>Semester oder Arbeitskontext<input name="semester" maxlength="100" value="${esc(state.profile.semester)}"></label><button class="button primary" type="submit">Speichern ${icon('check',16)}</button></form></section><section class="settings-panel"><h2>Deinen Kontext mitnehmen</h2><p>Projekte, Aufgaben, Termine, Notizen und Links werden auf diesem Gerät im Browser gespeichert. Ein Backup überträgt sie in einen anderen Browser.</p><div class="backup-actions"><button class="button secondary" data-action="export">${icon('download',17)} Backup exportieren</button><button class="text-link" data-action="view-export">${icon('file',16)} Inhalt ansehen</button><button class="button secondary" data-action="import">${icon('upload',17)} Backup importieren</button><input type="file" id="import-file" accept=".json,application/json" hidden></div><p class="subtle-note">Ein Import wird zuerst geprüft. Du entscheidest danach, ob er deinen aktuellen Arbeitsbereich ersetzt.</p><button class="text-link" data-action="clear-activity">${icon('trash',16)} Verlauf leeren</button></section><section class="settings-panel full"><h2>Was schon funktioniert</h2><div class="capability-grid"><div>${icon('check',20)}<strong>Gemeinsamer Einstieg</strong><p>TH-Spaces, Mattermost, GitLab, Sciebo, WhatsApp, Signal, Miro, Zoom und TH-Webmail.</p></div><div>${icon('check',20)}<strong>Projektkontext</strong><p>Markdown-Notizen mit Wiki-Links, Aufgaben und Fristen pro Projekt. Suche über deinen ganzen Hub.</p></div><div>${icon('links',20)}<strong>Automatische Inhalte</strong><p>TH-Mail ist über den Mailserver verbindbar. Für GitLab und Mattermost sind lesende Connectoren vorhanden; sie brauchen eigene Zugänge.</p></div></div></section></div>`;
}


function renderNotes() {
  return heading('GEDANKEN BRAUCHEN RAUM','Notizen','',`<button class="button primary" data-action="add-note">${icon('plus',17)} Neue Notiz</button>`)+diaryView.banner()+`<div class="app-secondary-toolbar"><button class="text-link" data-action="start-import" data-id="obsidian" title="Markdown und Obsidian-Dateien importieren" aria-label="Markdown und Obsidian-Dateien importieren">${icon('upload',16)} Importieren</button>${detailHint('Markdown-Hilfe','<p>Mit [[Notiztitel]] verbindest du Notizen. Überschriften, Listen, Code und Links bleiben normales Markdown.</p>')}</div><div class="notes-grid">${diaryView.renderCards()}${state.notes.filter(inCourse).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(n=>`<article class="note-card"><span class="small-label">${esc(project(n.projectId)?.name||'PERSÖNLICH')}</span><button class="note-title" data-action="note" data-id="${n.id}">${esc(n.title)} ${icon('arrow',17)}</button><p>${esc(n.content.replace(/[#*`\[\]]/g,'').slice(0,180))||'Leere Notiz'}</p><div class="note-card-foot"><span>${n.content.length.toLocaleString('de-DE')} Zeichen</span><span>${relativeTime(n.updatedAt)}</span></div></article>`).join('')||empty('Noch keine Notizen','Markdown schreiben oder Dateien importieren.','Notiz anlegen','data-action="add-note"')}</div><input id="plugin-files" type="file" multiple accept=".md,.markdown,.txt" hidden>`;
}
function editMarkdownNote(id='') {
  const savedNote=state.notes.find(n=>n.id===id);
  const n=noteDrafts.has(id)?{...savedNote,...noteDrafts.get(id)}:savedNote;
  const backlinks=n?state.notes.filter(other=>other.id!==id&&other.content.toLowerCase().includes('[['+n.title.toLowerCase())):[];
  openModal(modalHead(savedNote?'Notiz':'Neue Notiz','Markdown')+`<div class="dd-note-shortcut"><span>Kursdokumentation</span><button class="button secondary" type="button" data-dd-action="new" title="Dev Diary mit Vorlage anlegen">${icon('note',16)} Dev Diary</button></div><form id="markdown-form" data-id="${id}"><div class="note-form-top"><label>Titel<input name="title" required maxlength="200" value="${esc(n?.title||'')}" placeholder="Ein guter Gedanke" autofocus></label><label>Projekt<select name="projectId">${projectOptions(n?.projectId)}</select></label></div><div class="markdown-workspace"><label>Markdown<textarea name="content" rows="15" maxlength="50000" spellcheck="false" placeholder="# Dein Gedanke\n\nVerknüpfe mit [[Notiztitel]].">${esc(n?.content||'')}</textarea></label><section class="markdown-preview"><p class="small-label">VORSCHAU</p><div id="markdown-preview" class="markdown-content">${renderMarkdown(n?.content||'',state.notes)}</div></section></div>${backlinks.length?`<div class="backlinks"><span class="small-label">VERLINKT AUS</span>${backlinks.map(b=>`<button class="tag" data-action="note" data-id="${b.id}">${esc(b.title)}</button>`).join('')}</div>`:''}${detailHint('Vorschau & Entwurf','<p>Bilder, HTML und eingebettete Inhalte werden nicht ausgeführt. Speichern übernimmt deine Änderungen. Ungespeicherte Entwürfe bleiben bis zum Neuladen in diesem Tab erhalten.</p>')}${formError()}<div class="form-footer"><div class="note-actions">${savedNote?iconAction('trash','Notiz entfernen',`data-action="delete-note" data-id="${id}"`,'danger'):''}<button type="button" class="text-link" data-action="export-note" title="Notiz als Markdown herunterladen" aria-label="Notiz als Markdown herunterladen">${icon('download',16)} Markdown</button></div><button class="button primary" type="submit">Notiz speichern ${icon('check',16)}</button></div></form>`,true);
  if(savedNote)modal.dataset.noteId=savedNote.id;else modal.dataset.projectId=n?.projectId||state.activeCourse;syncAgentContext();
}
function pluginCard(p,importArea=false) {
  return `<article class="plugin-card"><div class="tool-card-top">${brandLogo(p.id,{color:p.color,fallback:p.short})}<span class="tag">Enthalten · ${p.version}</span></div><span class="small-label">${p.tag}</span><h2>${esc(p.name)}</h2><p>${esc(p.description)}</p><div class="plugin-card-footer"><button class="text-link" data-action="paste-import" data-id="${p.id}">${icon('copy',16)} Einfügen</button><button class="button secondary" data-action="start-import" data-id="${p.id}">${icon('download',16)} Importieren</button></div></article>`;
}
function renderImports() {
  return heading('EINFACH WEITERARBEITEN','Importieren','Quelle wählen, Vorschau prüfen, Inhalte übernehmen.')+`<div class="import-steps"><div><span>01</span><strong>Quelle auswählen</strong></div><div><span>02</span><strong>Vorschau prüfen</strong></div><div><span>03</span><strong>Im Hub weiterarbeiten</strong></div></div><div class="plugins-grid">${BUILTIN_PLUGINS.map(p=>pluginCard(p,true)).join('')}</div><div class="local-import-note">${icon('note',21)}<div><strong>Deine Dateien bleiben hier.</strong><p>Der Import läuft in deinem Browser. Es werden keine Dateien zu einem Server hochgeladen. Mehrere Markdown-Dateien lassen sich gemeinsam wählen; Bilder und Anhänge bleiben im ursprünglichen Vault.</p></div></div><input id="plugin-files" type="file" multiple hidden>`;
}
function renderPlugins(){return `<section class="nango-plugin-entry"><div><h2>Outlook und Google verbinden</h2><p>Gmail, Outlook, Kalender und Drive mit OAuth über Nango. Konten und Schreibrechte verwaltest du gemeinsam.</p></div><button class="button primary" data-view="connections">${icon('links',17)} Verbinden</button></section>`+renderPluginCatalog({workspace:state,sourceStates,native:window.contextDesktop||{}});}
function renderSubmissions() {
  return heading('VOM PROJEKT ZUR ABGABE','Abgaben','Dateien prüfen und als Paket exportieren.')+`<div class="submission-layout"><section class="settings-panel"><form id="submission-form"><label>Abgabetitel<input name="title" required maxlength="200" placeholder="z. B. Prototyping Things – Dokumentation"></label><label>Projekt<select name="projectId">${projectOptions()}</select></label><label>GitHub-Repository <span class="optional">optional</span><input type="url" name="repo" placeholder="https://github.com/team/projekt"></label><label>Kurze Dokumentation<textarea name="description" rows="3" maxlength="10000" placeholder="Was ist enthalten? Was muss jemand zum Ausführen wissen?"></textarea></label><div class="submission-file-area"><span class="small-label">DATEIEN FÜR DIE ABGABE</span><label class="file-pick">${icon('plus',23)} Dateien auswählen<input id="submission-files" type="file" multiple></label><button type="button" class="text-link" data-action="add-submission-doc">${icon('file',16)} Dokumentation hinzufügen</button><div id="submission-file-list">${renderSubmissionFiles()}</div><p class="subtle-note">Bis zu 100 Dateien · 20 MB. Keine Passwörter, .env-Dateien oder privaten Schlüssel auswählen.</p></div>${formError()}<div class="form-footer"><button type="submit" class="button primary">${icon('download',17)} Abgabepaket erstellen</button></div></form><div id="submission-result" role="status"></div></section><aside><section class="submission-guide"><span class="small-label">DEINE ABGABE, NACHVOLLZIEHBAR</span><h2>Vor dem Export</h2><ol><li><strong>Vorbereiten</strong><p>Dateien und eine kurze Dokumentation zusammenstellen.</p></li><li><strong>Prüfen</strong><p>Pfadprüfung und Erkennung einiger Zugangsdaten-Muster. Lies die Dateien vor der Abgabe selbst durch.</p></li><li><strong>Übergeben</strong><p>Das ZIP enthält Dokumentation und SHA-256-Prüfsummen. Für GitHub öffnest du danach dein Repository.</p></li></ol></section><div class="privacy-note">${icon('note',18)}<p>Context lädt nichts automatisch hoch. Auf GitHub wählst du die Dateien aus und bestätigst den Commit. Eine direkte GitHub-API-Verbindung ist noch nicht eingerichtet.</p></div></aside></div>`;
}
function renderSubmissionFiles() { return submissionFiles.length?`<ul class="selected-files">${submissionFiles.map(f=>`<li>${icon('note',14)}<span>${esc(f.name)}</span><small>${(f.size/1000).toFixed(1)} KB</small></li>`).join('')}</ul>`:'<p class="file-empty">Noch keine Dateien ausgewählt.</p>'; }
function downloadBlob(blob,name) { const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500); }
async function previewPluginImport(files) {
  try {
    pendingPluginImport=await planImport(importPlugin,files,state);
    const plan=pendingPluginImport;const n=plan.replace||plan;
    const counts={projects:n.projects.length,notes:n.notes.length,bookmarks:n.bookmarks.length};
    openModal(modalHead(plan.replace?'Arbeitsbereich übernehmen?':'Das kommt in deinen Hub.',plan.replace?'Dieses Backup ersetzt deinen aktuellen Stand.':'Deine bestehenden Inhalte bleiben erhalten.')+`<div class="import-review"><div><strong>${counts.notes}</strong> Notizen</div><div><strong>${counts.projects}</strong> Projekte</div><div><strong>${counts.bookmarks}</strong> Links</div></div>${plan.skipped?`<p class="subtle-note">${plan.skipped} bereits vorhandene Links oder Projekte wurden übersprungen.</p>`:''}<ul class="import-preview-list">${[...n.notes,...n.projects,...n.bookmarks].slice(0,12).map(i=>`<li>${esc(i.title||i.name)}</li>`).join('')}</ul><p class="subtle-note">${plan.replace?'Exportiere deinen aktuellen Stand bei Bedarf zuerst.':'Dateiinhalte werden als Daten übernommen. Es wird kein Plugin-Code ausgeführt.'} Den Import kannst du direkt danach rückgängig machen.</p><div class="form-footer"><button class="button secondary" data-action="close">Abbrechen</button><button class="button primary" data-action="apply-plugin-import">${plan.replace?'Backup übernehmen':'Inhalte übernehmen'} ${icon('check',16)}</button></div>`);
  }catch(err){pendingPluginImport=null;toast('Import nicht möglich: '+err.message);}
}
async function packageSubmission(f) {
  const d=new FormData(f);const title=requireText(d.get('title'));const description=cleanText(d.get('description'),10000);const repo=d.get('repo')?githubRepositoryURL(d.get('repo')):'';
  if(!submissionFiles.length)throw new Error('Bitte zuerst Dateien auswählen.');
  if(submissionFiles.length>98||submissionFiles.reduce((s,f)=>s+f.size,0)>19000000)throw new Error('Bitte höchstens 98 Dateien mit insgesamt 19 MB auswählen.');
  const files=[];const sums=[];
  for(const file of submissionFiles){
    const content=new Uint8Array(await file.arrayBuffer());
    if(hasCredentialMaterial(file.name,new TextDecoder().decode(content)))throw new Error('Mögliche Zugangsdaten in '+file.name+'. Bitte Datei zuerst prüfen.');
    const digest=await crypto.subtle.digest('SHA-256',content);const hash=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
    files.push({name:file.name,content});sums.push(hash+'  '+file.name);
  }
  const documentation=`# ${title}\n\n${description}\n\nProjekt: ${project(d.get('projectId'))?.name||'Persönlich'}\nErstellt: ${new Date().toISOString()}\n${repo?'Repository: '+repo+'\n':''}\n## Dateien\n\n${submissionFiles.map(f=>'- '+f.name).join('\n')}\n\nDie Prüfsummen in SHA256SUMS.txt beziehen sich auf die ausgewählten Originaldateien.\n`;
  files.push({name:'context-abgabe.md',content:documentation},{name:'SHA256SUMS.txt',content:sums.join('\n')+'\n'});
  const blob=createZIP(files);submissionURL=repo;downloadBlob(blob,title.replace(/[^a-zA-Z0-9äöüÄÖÜß_-]+/g,'-').slice(0,70)+'.zip');
  $('#submission-result').innerHTML=`<div class="submission-success">${icon('check',21)}<div><strong>Dein Abgabepaket ist erstellt.</strong><p>${submissionFiles.length} Dateien, Dokumentation und Prüfsummen. Nichts wurde hochgeladen.</p>${repo?external(repo,'GitHub-Repository öffnen','button secondary'):''}</div></div>`;
  activity('Abgabepaket erstellt');save();
}

function openModal(content,wide=false,modeless=false) { projectLayoutCleanup?.();projectLayoutCleanup=undefined;modal.style.removeProperty('--project-browser-height'); if(!modal.contains(document.activeElement))modalReturnFocus=document.activeElement;detachNativeSpace();document.body.classList.remove('native-project-open');$('#app').inert=false;if(modal.open)modal.close();for(const key of Object.keys(modal.dataset))delete modal.dataset[key];modal.className=wide?'wide':'';modal.innerHTML=content;if(modeless||nativeSpacesAvailable()){modal.classList.add('beside-browser');modal.show();}else modal.showModal();syncAgentContext(); }
function modalHead(title,sub='') { return `<div class="modal-head"><div><p class="eyebrow">CONTEXT</p><h2 id="modal-title">${esc(title)}</h2>${sub?`<p>${esc(sub)}</p>`:''}</div><button class="icon-button" data-action="close" aria-label="Dialog schließen" title="Dialog schließen">${icon('close')}</button></div>`; }
function formError() { return '<p class="form-error" role="alert" hidden></p>'; }
function projectOptions(current=state.activeCourse) { return `<option value="">Persönlich / ohne Projekt</option>${state.projects.filter(p=>!p.archived || p.id===current).map(p=>`<option value="${p.id}" ${current===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}`; }
function toolOptions(current='spaces') { return LINK_META.map(t=>`<option value="${t.id}" ${current===t.id?'selected':''}>${t.name}</option>`).join(''); }
function editProject(id) {
  const p=id?project(id):null;
  openModal(modalHead(p?'Projekt bearbeiten':'Neues Projekt')+`<form id="project-form" data-id="${id||''}"><label>Projektname<input name="name" required maxlength="200" value="${esc(p?.name||'')}" placeholder="z. B. Interactive Applications" autofocus></label><label>Kurs, Semester oder Beschreibung<input name="subtitle" maxlength="200" value="${esc(p?.subtitle||'')}" placeholder="Wintersemester 2026/27"></label><label>Projektfarbe<select name="color">${[['violet','Lavendel'],['peach','Apricot'],['green','Salbei'],['blue','Blau'],['yellow','Sand']].map(([v,n])=>`<option value="${v}" ${p?.color===v?'selected':''}>${n}</option>`).join('')}</select></label>${formError()}<div class="form-footer"><button class="button secondary" type="button" data-action="close">Abbrechen</button><button class="button primary" type="submit">${p?'Speichern':'Projekt anlegen'} ${icon('arrow',16)}</button></div></form>`);
}
function showProject(id) {
  const p=project(id); if(!p)return;
  const tasks=state.tasks.filter(t=>t.projectId===id);
  const spaceURL=spaceBrowserURL(p);
  const spacePosts=remoteItems.filter(n=>n.source==='spaces'&&notificationCourse(n,state)===id).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  const embedded=nativeSpacesAvailable();
  const courseSpace=spaceURL?`<section class="course-space" aria-label="Kurs-Space"><div class="space-toolbar"><div>${monogram('spaces',true)}<span><strong>Dein Kurs-Space</strong><small>TH-Spaces</small></span></div>${nativeSpacesAvailable()?`<button class="button primary" data-action="space-browser" data-project="${id}">Kursstartseite ${icon('arrow',15)}</button>`:`<a class="button primary" href="${esc(spaceURL)}" target="_blank" rel="noopener noreferrer">Space im Browser öffnen ${icon('external',15)}</a>`}</div>${embedded?'<div id="course-browser" class="native-browser-slot" aria-label="Spaces-Browser"><span aria-hidden="true">Kurs-Space wird geladen …</span></div>':spacePosts.length?`<div class="course-space-preview">${spacePosts.slice(0,5).map(n=>`<button class="space-post" data-action="space-post" data-id="${esc(n.id)}" data-project="${id}"><span><strong>${esc(n.title)}</strong><small>${esc(n.summary)}</small>${n.content?`<p>${esc(n.content.slice(0,180))}${n.content.length>180?'…':''}</p>`:''}</span><span>${icon('arrow',16)}</span></button>`).join('')}</div>`:''}</section>`:'';
  const assistantButton=`<button class="button secondary project-agent-button" data-action="context-agent" aria-controls="context-agent-panel" aria-expanded="${floatingOpen}"><span aria-hidden="true">✳</span> Frag Context</button>`;
  const management=`<div class="detail-actions">${iconAction('edit','Projekt bearbeiten',`data-action="edit-project" data-id="${id}"`)}<button class="text-link" data-action="archive-project" data-id="${id}">${icon('archive',16)} ${p.archived?'Wiederherstellen':'Archivieren'}</button></div><div class="section-title"><h3>Deine Verbindungen</h3><button data-action="project-link" data-id="${id}">${icon('plus',16)} Link hinzufügen</button></div><div class="detail-links">${p.links.map(l=>`<div>${monogram(l.tool,true)}${external(l.url,l.title)}${iconAction('edit','Link bearbeiten: '+l.title,`data-action="edit-project-link" data-id="${l.id}" data-project="${id}"`)}</div>`).join('')||'<p class="subtle-note">Füge Kurs-Space, Channel, Repository oder Ordner hinzu.</p>'}</div><div class="section-title"><h3>Aufgaben</h3><button data-action="project-task" data-id="${id}">${icon('plus',16)} Aufgabe</button></div><div class="task-list">${tasks.length?tasks.map(t=>taskRow(t,true)).join(''):'<p class="quiet-row">Noch keine Aufgaben für dieses Projekt.</p>'}</div><form id="note-form" data-id="${id}"><label>Projektnotiz<textarea name="note" rows="4" maxlength="10000" placeholder="Was ist wichtig? Was ist der nächste Schritt?">${esc(p.note)}</textarea></label><button class="button secondary" type="submit">Notiz speichern ${icon('check',15)}</button>${formError()}</form>`;
  openModal(`<div class="modal-head"><div><p class="eyebrow">CONTEXT</p><h2 id="modal-title">${esc(p.name)}</h2>${p.subtitle?`<p>${esc(p.subtitle)}</p>`:''}</div><div class="project-header-actions">${assistantButton}<button class="icon-button" data-action="close" aria-label="Dialog schließen" title="Dialog schließen">${icon('close')}</button></div></div><div class="project-scroll-body"><div class="project-workbench"><div class="project-browser-area">${courseSpace||'<div class="project-no-space"><h3>Dein Projektwissen</h3><p>Frage den Assistenten zu deinen Notizen und Aufgaben oder verbinde einen Kurs-Space.</p></div>'}<div class="project-browser-caption"><span>${embedded&&spaceURL?'Live im eingebauten Browser':'Dein Kurskontext'} · ${esc(p.name)}</span></div></div><div id="project-agent-slot"></div></div><details class="project-management" ${spaceURL?'':'open'}><summary>Projekt organisieren <span>${tasks.length} Aufgaben · ${p.links.length} Verbindungen</span></summary><div class="project-detail">${management}</div></details></div>`,true,nativeSpacesAvailable());
  modal.dataset.projectId=id;
  modal.classList.remove('beside-browser');modal.classList.add('project-workspace');mountProjectLayout();
  if(spaceURL&&embedded){modal.classList.add('embedded-project');document.body.classList.add('native-project-open');$('#app').inert=true;mountNativeSpace(spaceURL,$('#course-browser'),modal);}
  syncAgentContext();
}
function editTask(id,projectId='') {
  const t=id?state.tasks.find(t=>t.id===id):null;
  openModal(modalHead(t?'Aufgabe bearbeiten':'Neue Aufgabe')+`<form id="task-form" data-id="${id||''}"><label>Was möchtest du machen?<input name="title" required maxlength="200" value="${esc(t?.title||'')}" placeholder="z. B. Prototyp dokumentieren" autofocus></label><div class="form-columns"><label>Projekt<select name="projectId">${projectOptions(t?t.projectId:projectId||state.activeCourse)}</select></label><label>Status<select name="status">${[['todo','Offen'],['doing','In Arbeit'],['done','Erledigt']].map(([v,n])=>`<option value="${v}" ${t?.status===v?'selected':''}>${n}</option>`).join('')}</select></label></div><label>Fällig am <span class="optional">optional</span><input type="date" name="due" value="${esc(t?.due||'')}"></label><label>Quelle oder passender Link <span class="optional">optional</span><input type="url" name="url" value="${esc(t?.url||'')}" placeholder="https://…"></label>${formError()}<div class="form-footer">${t?iconAction('trash','Aufgabe entfernen',`data-action="delete-task" data-id="${id}"`,'danger'):'<button class="button secondary" data-action="close" type="button">Abbrechen</button>'}<button class="button primary" type="submit">${t?'Speichern':'Aufgabe anlegen'} ${icon('check',16)}</button></div></form>`);
  if(t)modal.dataset.taskId=t.id;else modal.dataset.projectId=projectId||state.activeCourse;syncAgentContext();
}
function editLink(id='',projectId='',projectLink=false) {
  const b=id?(projectLink?project(projectId)?.links.find(l=>l.id===id):state.bookmarks.find(b=>b.id===id)):null;
  openModal(modalHead(b?'Link bearbeiten':projectLink?'Projekt verbinden':'Neuer Link')+`<form id="link-form" data-id="${id}" data-project="${projectId}" data-project-link="${projectLink}"><label>Titel<input name="title" required maxlength="200" value="${esc(b?.title||'')}" placeholder="z. B. Abgabeordner" autofocus></label><label>Link<input type="url" name="url" required value="${esc(b?.url||'')}" placeholder="https://…"></label><div class="form-columns"><label>Tool<select name="tool">${toolOptions(b?.tool)}</select></label>${!projectLink?`<label>Projekt<select name="projectId">${projectOptions(b?b.projectId:projectId||state.activeCourse)}</select></label>`:''}</div>${!projectLink?`<label>Notiz <span class="optional">optional</span><textarea name="note" rows="2" maxlength="1000">${esc(b?.note||'')}</textarea></label>`:''}${formError()}<div class="form-footer">${b?iconAction('trash','Link entfernen',`data-action="delete-link" data-id="${id}" data-project="${projectId}" data-project-link="${projectLink}"`,'danger'):'<button class="button secondary" data-action="close" type="button">Abbrechen</button>'}<button class="button primary" type="submit">Link speichern ${icon('check',16)}</button></div></form>`);
}
function showTool(id) {
  const m=meta(id),t=state.tools.find(t=>t.id===id);
  openModal(modalHead(m.name,'Dein persönlicher Einstieg')+`<div class="tool-explanation">${monogram(id)}<p>${esc(m.detail)}</p></div><form id="tool-form" data-id="${id}"><label>Startadresse<input type="url" required name="url" value="${esc(t.url)}"></label><label class="checkbox-label"><input type="checkbox" name="pinned" ${t.pinned?'checked':''}> Im Schnellzugriff anpinnen</label><p class="subtle-note">Diese Einstellung speichert den Link. Sie erteilt Context keinen Zugriff auf das Konto.</p>${formError()}<div class="form-footer"><button type="button" class="text-link" data-action="reset-tool" data-id="${id}">${icon('refresh',16)} Standardadresse</button><button type="submit" class="button primary">Speichern ${icon('check',16)}</button></div></form>`);
}
function invalidateSearch() {
  searchDirty=true;clearTimeout(searchRefreshTimer);
  if(searchView)searchRefreshTimer=setTimeout(()=>void searchView.refresh(),200);
}
function getSearchDocuments() {
  if(searchDirty||!searchSnapshot){
    searchSnapshot=buildSearchDocuments({workspace:state,updates:remoteItems,browserSources:allBrowserSources(),platformSources:sourceHub.documents(),chatRecords:kiView.searchRecords(),mailSources:mailView.searchSources(),sourceStates});
    const crawl=crawlerView?.summary();if(crawl?.sources)searchSnapshot.warnings.push('Spaces-Crawler: '+crawl.sources+' gespeicherte Ansichten'+(crawl.pending?' · '+crawl.pending+' gefundene Ansichten noch offen.':'. Kursabdeckung und Zugriffslücken im Crawler ansehen.'));
    searchDirty=false;
  }
  return searchSnapshot;
}
function openSearch(){void searchView.open();}
function openIndexedResult(result){
  // Re-resolve the current source. An old result cannot open a removed row or
  // another mail account after a refresh/disconnect.
  const target=getSearchDocuments().targets.get(result.id);
  if(!target){toast('Dieser Treffer ist nicht mehr verfügbar. Suche erneut.');return;}
  const source=target.document;
  if(target.type==='project'){showProject(target.id);return;}
  if(target.type==='task'){editTask(target.id);return;}
  if(target.type==='note'){editMarkdownNote(target.id);return;}
  if(target.type==='diary'){diaryView.open(target.id,target.date);return;}
  if(target.type==='calendar'){
    if(kiView.isBusy()){toast('Beende den laufenden KI-Auftrag vor einem Kurswechsel.');return;}
    state.activeCourse=source.projectId||'';save();kiView.scopeChanged();calendarView.openEvent(target.id);return;
  }
  if(target.type==='mail'){
    const service=target.mailTarget?.service||'th';mailView.select(service);setView('mail');void mailView.open(target.mailTarget);return;
  }
  if(target.type==='update'){
    const item=remoteItems.find(n=>n.id===target.id);if(item)previewNotification(item);return;
  }
  if(target.type==='link'||target.type==='tool'){
    if(source.url)window.open(safeURL(source.url),'_blank','noopener,noreferrer');return;
  }
  const origin=source.url?external(source.url,target.type==='board'?'Board öffnen':'Originalquelle öffnen','button secondary'):'';
  const evidence=target.sourceURL?external(target.sourceURL,'Fundstelle öffnen','text-link'):'';
  const subtitle=target.type==='chat'?'Gespeicherte Chatnachricht · mit Quellen und Arbeitsschritten':source.status==='full'?'Lokal erfasster Inhalt':'Lokal erfasster Auszug';
  openModal(modalHead(source.title,subtitle)+`<div class="markdown-content search-source-preview">${renderMarkdown(source.text,[])}</div><div class="form-footer">${origin}${evidence}</div>`);
}
function about() { openModal(modalHead('Dein Kontext. Deine Tools.')+`<div class="about-copy"><p>Context ist die erste Version eines persönlichen Arbeitsbereichs für Code & Context an der TH Köln.</p><p>Die Einstiege zu TH-Spaces, Mattermost, GitLab und Sciebo basieren auf den recherchierten Diensten. Projekte verbinden ihre Links mit deinen eigenen Aufgaben und Notizen.</p><p><strong>Aktueller Stand:</strong> Links und persönliche Funktionen sind nutzbar. Der lokale Posteingang hat lesende Connectoren für Mattermost, GitLab und Webmail; TH-Mail hat einen eigenen Posteingang mit Versand. Mattermost und GitLab brauchen noch ihre Kontozugänge. WhatsApp und Signal sind verlinkt. Es gibt noch keinen gemeinsamen Team-Datenspeicher.</p><p>Deine Inhalte bleiben im Browser. Die exportierte JSON-Datei enthält deine gespeicherten Links, Aufgaben und Markdown-Notizen. Der Quellcode steht unter der MIT-Lizenz; es gibt keine externen Tracker oder Schrift-Dienste.</p><button class="button primary" data-action="close">Alles klar ${icon('check',16)}</button></div>`); }

document.addEventListener('click',e=>{
  const homeEvent=e.target.closest('[data-calendar-event]');if(homeEvent){calendarView.openEvent(homeEvent.dataset.calendarEvent);return;}
  if(e.target.closest('[data-platform]')){e.preventDefault();void sourceHub.handle(e);return;}
  if(e.target.closest('[data-action="home-agent"]')){kiView.prefill($('#home-search-query')?.value||'Prüfe die aktuellen Aufgabenstellungen in meinen Kursquellen einschließlich Miro, Sciebo und GitLab. Zeige offene Aufgaben mit Kurs und Quellenlink.');setView('ai');return;}
  const inventoryAction=e.target.closest('[data-inventory-action]');if(inventoryAction){e.preventDefault();if(!inventoryAction.disabled)void inventoryView.click(inventoryAction.dataset.inventoryAction);return;}
  const inventoryLink=e.target.closest('a[href]');if(inventoryView.available()&&inventoryLink&&!inventoryLink.hasAttribute('data-inventory-separate')&&isInventoryEntryURL(inventoryLink.href)){e.preventDefault();setView('inventory');return;}
  if(nativeSpacesAvailable()&&e.target.closest('a[target="_blank"]'))document.body.classList.remove('nav-open');
  const account=e.target.closest('[data-mail-account]');if(account){e.preventDefault();mailView.select(account.dataset.mailAccount);return;}
  const b=e.target.closest('[data-action],[data-view],[data-open]'); if(!b)return;
  if(b.dataset.view){e.preventDefault();setView(b.dataset.view);return;}
  if(b.dataset.open){activity(`${b.dataset.open} geöffnet`);save();return;}
  e.preventDefault();
  const {action,id,value}=b.dataset;
  if(action==='toggle-theme')window.contextTheme?.toggle();
  else if(action==='search')openSearch();
  else if(action==='spaces-crawl')void crawlerView.open();
  else if(action==='context-agent')floatingAgent.toggle();
  else if(action==='companion-course'){state.activeCourse=id;kiView.scopeChanged();commit();setView('companion');}
  else if(action==='ask-assistant'){kiView.prefill(value);setView('ai');$('#ki-prompt')?.focus();}
  else if(action==='close')modal.close();
  else if(action==='close-search')searchView.close();
  else if(action==='menu')document.body.classList.toggle('nav-open');
  else if(action==='clear-activity'){const previous=state.activity;state.activity=[];commit();toast('Aktivitätsverlauf geleert.',()=>{state.activity=previous;commit();toast('Verlauf wiederhergestellt.');});}
  else if(action==='add-submission-doc'){const f=$('#submission-form');const title=$('input[name="title"]',f).value||'Dokumentation';const text=$('textarea[name="description"]',f).value;if(!text.trim()){toast('Schreibe zuerst eine kurze Dokumentation.');return;}submissionFiles=submissionFiles.filter(f=>f.name!=='Dokumentation.md');submissionFiles.push(new File(['# '+title+'\n\n'+text+'\n'],'Dokumentation.md',{type:'text/markdown'}));$('#submission-file-list').innerHTML=renderSubmissionFiles();toast('Dokumentation zum Paket hinzugefügt.');}
  else if(action==='add-note')editMarkdownNote();
  else if(action==='note')editMarkdownNote(id);
  else if(action==='delete-note'){const index=state.notes.findIndex(n=>n.id===id);const [n]=state.notes.splice(index,1);commit('Notiz entfernt');modal.close();toast('Notiz entfernt.',()=>{state.notes.splice(index,0,n);commit();toast('Notiz wiederhergestellt.');});}
  else if(action==='export-note'){const f=$('#markdown-form');downloadBlob(new Blob([$('textarea[name="content"]',f).value],{type:'text/markdown;charset=utf-8'}),($('input[name="title"]',f).value||'Notiz').replace(/[^a-zA-Z0-9äöüÄÖÜß_-]+/g,'-')+'.md');}
  else if(action==='paste-import'){importPlugin=id;const p=BUILTIN_PLUGINS.find(p=>p.id===id);openModal(modalHead(p.name,'Alternativ kannst du exportierten Inhalt direkt einfügen.')+`<form id="paste-import-form"><label>Dateiname<input name="filename" required maxlength="150" value="${id==='obsidian'?'Notiz.md':id==='bookmarks'?'Bookmarks.html':'Export.json'}"></label><label>Exportierter Inhalt<textarea name="content" required rows="12" maxlength="2000000" placeholder="${id==='obsidian'?'# Meine Notiz':'Export hier einfügen'}"></textarea></label>${formError()}<div class="form-footer"><button class="button secondary" data-action="close" type="button">Abbrechen</button><button class="button primary" type="submit">Vorschau prüfen ${icon('arrow',16)}</button></div></form>`,true);}
  else if(action==='start-import'){importPlugin=id;const plugin=BUILTIN_PLUGINS.find(p=>p.id===id);const input=$('#plugin-files');input.accept=plugin.formats;input.multiple=id==='obsidian';input.click();}
  else if(action==='apply-plugin-import'&&pendingPluginImport){const previous=state;calendarView.invalidateRefresh();state=validateState(applyImport(state,pendingPluginImport));if(pendingPluginImport.replace)state={...state,calendarSync:{...state.calendarSync,automatic:false,target:{calendarId:'',title:''}}};corruptStorage=false;pendingPluginImport=null;commit('Inhalte importiert');modal.close();toast('Inhalte übernommen.',()=>{calendarView.invalidateRefresh();state=previous;commit();toast('Import rückgängig gemacht.');});}
  else if(action==='add-project')editProject();
  else if(action==='project')showProject(id);
  else if(action==='edit-project')editProject(id);
  else if(action==='project-filter'){showArchived=value==='archived';render();}
  else if(action==='archive-project'){const p=project(id);p.archived=!p.archived;commit(`${p.name} ${p.archived?'archiviert':'wiederhergestellt'}`);modal.close();toast(p.archived?'Projekt archiviert. Im Archiv kannst du es wiederherstellen.':'Projekt wiederhergestellt.');}
  else if(action==='add-task')editTask();
  else if(action==='project-task')editTask('',id);
  else if(action==='edit-task')editTask(id);
  else if(action==='toggle-task'){const t=state.tasks.find(t=>t.id===id);t.status=t.status==='done'?'todo':'done';commit(`${t.title} ${t.status==='done'?'erledigt':'wieder geöffnet'}`);if(modal.open&&$('#note-form',modal))showProject($('#note-form',modal).dataset.id);}
  else if(action==='task-filter'){taskFilter=value;render();}
  else if(action==='delete-task'){const index=state.tasks.findIndex(t=>t.id===id);const [t]=state.tasks.splice(index,1);commit('Aufgabe entfernt');modal.close();toast('Aufgabe entfernt.',()=>{state.tasks.splice(index,0,t);commit();toast('Aufgabe wiederhergestellt.');});}
  else if(action==='add-link')editLink();
  else if(action==='edit-link')editLink(id);
  else if(action==='project-link')editLink('',id,true);
  else if(action==='space-browser'){const url=spaceBrowserURL(project(b.dataset.project));if(url&&nativeSpacesAvailable())openNativeSpace(url);}
  else if(action==='space-post'){const n=remoteItems.find(n=>n.id===id);if(n){previewNotification(n);$('.modal-head',modal).insertAdjacentHTML('afterend',`<button class="text-link space-back" data-action="project" data-id="${esc(b.dataset.project)}">← Zurück zum Kurs-Space</button>`);}}
  else if(action==='edit-project-link')editLink(id,b.dataset.project,true);
  else if(action==='delete-link'){const pl=b.dataset.projectLink==='true';const list=pl?project(b.dataset.project).links:state.bookmarks;const index=list.findIndex(l=>l.id===id);const [link]=list.splice(index,1);commit('Link entfernt');modal.close();toast('Link entfernt.',()=>{const currentList=pl?project(b.dataset.project).links:state.bookmarks;currentList.splice(index,0,link);commit();toast('Link wiederhergestellt.');});}
  else if(action==='pin'){const t=state.tools.find(t=>t.id===id);if(!t.pinned&&state.tools.filter(t=>t.pinned).length>=4){toast('Vier Tools im Schnellzugriff. Entferne zuerst einen anderen Pin.');return;}t.pinned=!t.pinned;commit();toast(t.pinned?`${meta(id).name} angepinnt.`:'Aus dem Schnellzugriff entfernt.');}
  else if(action==='tool-settings')showTool(id);
  else if(action==='reset-tool')$('input[name="url"]',modal).value=meta(id).url;
  else if(action==='about')about();
  else if(action==='refresh-feed')refreshFeed(true);
  else if(action==='mail'){if(modal.open)modal.close();setView('mail');}
  else if(action==='inbox-filter'){inboxFilter=value;inboxLimit=50;render();}
  else if(action==='more-notifications'){inboxLimit+=50;render();}
  else if(action==='connection-help')connectionHelp(id);
  else if(action==='service-forget'&&serviceConnectable(id))void forgetService(id);
  else if(action==='desktop-notifications')toggleDesktopNotifications();
  else if(action==='read-notification'){const n=inboxItems().find(n=>n.id===id);if(!n)return;const key=notificationKey(n);state.inboxRead=state.inboxRead.includes(key)?state.inboxRead.filter(k=>k!==key):[...state.inboxRead,key].slice(-2000);commit();}
  else if(action==='open-notification'){const n=inboxItems().find(n=>n.id===id);if(!n)return;if(n.diaryId)diaryView.open(n.diaryId,n.diaryDate);else if(n.taskId)editTask(n.taskId);else previewNotification(n);}
  else if(action==='preview-read'){const n=inboxItems().find(n=>n.id===id);if(!n)return;const key=notificationKey(n);state.inboxRead=state.inboxRead.includes(key)?state.inboxRead.filter(k=>k!==key):[...state.inboxRead,key].slice(-2000);commit();previewNotification(n);}
  else if(action==='preview-adjacent'){const n=inboxItems().find(n=>n.id===id);if(n)previewNotification(n);}
  else if(action==='undo'&&undo){const callback=undo;undo=null;callback();}
  else if(action==='view-export'){openModal(modalHead('Arbeitsbereich-Backup','Lokale JSON-Datei: enthält deine gespeicherten Projekte, Aufgaben und Notizen.')+`<label>Backup-Inhalt<textarea id="workspace-export-content" rows="12" readonly>${esc(JSON.stringify(state,null,2))}</textarea></label>`);}
  else if(action==='export'){const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`context-backup-${dateKey()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Backup exportiert. Bewahre es an einem sicheren Ort auf.');}
  else if(action==='import')$('#import-file').click();
  else if(action==='confirm-import'&&pendingImport){calendarView.invalidateRefresh();const previous=state;state={...pendingImport,calendarSync:{...pendingImport.calendarSync,automatic:false,target:{calendarId:'',title:''}}};corruptStorage=false;pendingImport=null;commit('Backup importiert');modal.close();toast('Arbeitsbereich importiert.',()=>{calendarView.invalidateRefresh();state=previous;commit();toast('Import rückgängig gemacht.');});}

});
document.addEventListener('input',e=>{const f=e.target.closest('#markdown-form');if(f){noteDrafts.set(f.dataset.id,{title:$('input[name="title"]',f).value,content:$('textarea[name="content"]',f).value,projectId:$('select[name="projectId"]',f).value});if(e.target.name==='content')$('#markdown-preview').innerHTML=renderMarkdown(e.target.value,state.notes);}});
document.addEventListener('change',async e=>{
  if(e.target.matches('[data-theme-preference]')){window.contextTheme?.setPreference(e.target.value);return;}
  if(e.target.id==='plugin-files'){const files=[...e.target.files];e.target.value='';if(files.length)await previewPluginImport(files);}
  if(e.target.id==='submission-files'){submissionFiles=[...e.target.files];$('#submission-file-list').innerHTML=renderSubmissionFiles();}
  if(e.target.id==='course-switch'){if(kiView.isBusy()){render();return;}state.activeCourse=e.target.value;kiView.scopeChanged();taskProject='';inboxGroup='all';inboxLimit=50;commit();}
  if(e.target.matches('[data-notification-course]')){state.notificationCourses[e.target.dataset.notificationCourse]=e.target.value;commit();}
  if(e.target.id==='task-project-filter'){state.activeCourse=e.target.value;taskProject='';commit();}
  if(e.target.id==='inbox-group'){inboxGroup=e.target.value;inboxLimit=50;render();}
  if(e.target.id==='inbox-source'){inboxSource=e.target.value;inboxGroup='all';inboxLimit=50;render();}
  if(e.target.id==='import-file'){
    const file=e.target.files[0];e.target.value='';if(!file)return;
    try{if(file.size>8000000)throw new Error('Das Backup darf höchstens 8 MB groß sein.');pendingImport=validateState(JSON.parse(await file.text()),{diaryImported:true});openModal(modalHead('Backup übernehmen?','Der Import ersetzt deinen aktuellen Arbeitsbereich.')+`<div class="import-review"><div><strong>${pendingImport.projects.length}</strong> Projekte</div><div><strong>${pendingImport.tasks.length}</strong> Aufgaben</div><div><strong>${pendingImport.calendarEvents.length}</strong> Termine</div><div><strong>${pendingImport.notes.length}</strong> Notizen</div><div><strong>${pendingImport.bookmarks.length}</strong> Links</div></div><p class="subtle-note">Exportiere vorher bei Bedarf deinen aktuellen Stand. Den Import kannst du direkt danach rückgängig machen.</p><div class="form-footer"><button class="button secondary" data-action="close">Abbrechen</button><button class="button primary" data-action="confirm-import">Backup übernehmen</button></div>`);}
    catch(err){pendingImport=null;toast(err.message==='Unexpected token'?'Ungültige JSON-Datei.':`Import nicht möglich: ${err.message}`);}
  }
});
document.addEventListener('submit',async e=>{
  if(e.target.id==='service-token-form'&&serviceConnectable(e.target.dataset.service)){e.preventDefault();void saveServiceForm(e.target);return;}
  if(e.target.id==='workspace-search'){e.preventDefault();void searchView.open({query:new FormData(e.target).get('query')||''});return;}
  if(e.target.id==='assistant-start'){e.preventDefault();kiView.prefill(new FormData(e.target).get('prompt'));setView('ai');$('#ki-prompt')?.focus();return;}
  const f=e.target;if(!['profile-form','project-form','task-form','link-form','note-form','markdown-form','submission-form','paste-import-form','tool-form'].includes(f.id))return;
  e.preventDefault();const d=new FormData(f);let saved=false;
  try{
    if(f.id==='paste-import-form'){const text=d.get('content');await previewPluginImport([{name:requireText(d.get('filename'),150),size:new TextEncoder().encode(text).length,text:async()=>text}]);return;}
    if(f.id==='submission-form'){const b=$('button[type="submit"]',f);b.disabled=true;try{await packageSubmission(f);}finally{b.disabled=false;}return;}
    if(f.id==='markdown-form'){const content=$('textarea[name="content"]',f).value;if(content.length>50000)throw new Error('Die Notiz ist zu lang.');const n={title:requireText(d.get('title')),content,projectId:d.get('projectId'),updatedAt:new Date().toISOString()};if(f.dataset.id)Object.assign(state.notes.find(n=>n.id===f.dataset.id),n);else {if(state.notes.length>=200)throw new Error('Höchstens 200 Notizen pro Arbeitsbereich.');state.notes.push({...n,id:uid()});}noteDrafts.delete(f.dataset.id);saved=commit('Markdown-Notiz gespeichert');}
    if(f.id==='profile-form'){state.profile={name:cleanText(d.get('name'),80),semester:cleanText(d.get('semester'),100)};saved=commit();toast(saved?'Dein Arbeitsbereich wurde angepasst.':'Deine Änderungen konnten nicht gespeichert werden.');return;}
    if(f.id==='project-form'){const p={name:requireText(d.get('name')),subtitle:cleanText(d.get('subtitle')),color:d.get('color')};if(f.dataset.id)Object.assign(project(f.dataset.id),p);else state.projects.push({...p,id:uid(),links:[],note:'',archived:false});saved=commit(`${p.name} gespeichert`);}
    if(f.id==='task-form'){const t={title:requireText(d.get('title')),projectId:d.get('projectId'),status:d.get('status'),due:validateDate(d.get('due')),url:d.get('url')?safeURL(d.get('url')):''};if(f.dataset.id)Object.assign(state.tasks.find(t=>t.id===f.dataset.id),t);else state.tasks.push({...t,id:uid(),createdAt:new Date().toISOString()});saved=commit(`${t.title} gespeichert`);}
    if(f.id==='link-form'){const pl=f.dataset.projectLink==='true';const l={title:requireText(d.get('title')),url:safeURL(d.get('url')),tool:d.get('tool')};if(!pl){l.projectId=d.get('projectId');l.note=cleanText(d.get('note'),1000);}const list=pl?project(f.dataset.project).links:state.bookmarks;if(f.dataset.id)Object.assign(list.find(l=>l.id===f.dataset.id),l);else list.push({...l,id:uid()});saved=commit(`${l.title} gesammelt`);}
    if(f.id==='note-form'){project(f.dataset.id).note=cleanText(d.get('note'),10000);saved=commit('Projektnotiz gespeichert');toast(saved?'Notiz gespeichert.':'Notiz konnte nicht gespeichert werden.');return;}
    if(f.id==='tool-form'){const t=state.tools.find(t=>t.id===f.dataset.id);const url=safeURL(d.get('url'));const pinned=d.get('pinned')==='on';if(pinned&&!t.pinned&&state.tools.filter(t=>t.pinned).length>=4)throw new Error('Bitte zuerst einen anderen Pin entfernen. Es passen vier Tools in den Schnellzugriff.');Object.assign(t,{url,pinned});saved=commit();}
    modal.close();toast(saved?'Gespeichert.':'Änderung nur im Arbeitsspeicher. Bitte Backup exportieren.');
  }catch(err){const el=$('.form-error',f);if(el){el.hidden=false;el.textContent=err.message;}else toast(err.message);}
});
modal.addEventListener('close',()=>{if(!modal.open){projectLayoutCleanup?.();projectLayoutCleanup=undefined;detachNativeSpace();document.body.classList.remove('native-project-open');$('#app').inert=false;if(modalReturnFocus?.isConnected)modalReturnFocus.focus({preventScroll:true});syncAgentContext();
  // A feed read that finished while the dialog was open could not redraw the list behind it.
  if(view==='inbox')render();}});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&modal.open&&!searchModal.open&&nativeSpacesAvailable()){e.preventDefault();modal.close();}
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'&&$('#markdown-form',modal)){e.preventDefault();$('#markdown-form',modal).requestSubmit();}
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(searchModal.open)searchView.close();else openSearch();}
});
for(const dialog of [modal,searchModal]) dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
window.addEventListener('beforeunload',e=>{if(noteDrafts.size||diaryView.hasUnsaved()){e.preventDefault();e.returnValue='';}});
window.addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(views.has(next))setView(next);});
window.addEventListener('storage',e=>{if(e.key!==STORAGE_KEY)return;try{if(!e.newValue)throw new Error('State removed');const next=validateState(JSON.parse(e.newValue));if(modal.open||searchModal.open){storageConflict=true;storageAvailable=false;toast('Ein anderer Tab hat den Stand geändert. Deine Änderungen bleiben zum Export im Arbeitsspeicher.');return;}calendarView.invalidateRefresh();state=next;lastSavedRaw=e.newValue;storageConflict=false;invalidateSearch();syncDiaryReminders();render();toast('Änderungen aus einem anderen Tab übernommen.');}catch{storageConflict=true;storageAvailable=false;toast('Änderungen im anderen Tab konnten nicht übernommen werden.');}});
render();
void sourceHub.load().catch(()=>{});
void calendarView.start();
syncDiaryReminders();
let diaryReminderKeys='';
setInterval(()=>{const next=devDiaryReminderNotifications(state).map(n=>n.id).join('|');if(next!==diaryReminderKeys){diaryReminderKeys=next;if(['today','inbox','notes'].includes(view))render();}},30000);
feedRefresh=createFeedRefresh({refresh:readFeed,isConnected:()=>hasLocalConnector&&sourceStates.some(s=>['connected','error'].includes(s.status)),onStatus:value=>{feedRefreshStatus=value;if(view==='inbox'&&!modal.open&&!searchModal.open){const slot=document.querySelector('.inbox-sync-slot');if(slot)slot.innerHTML=inboxSyncStatus();}}});
feedRefresh.start();
window.addEventListener('pagehide',event=>{if(event.persisted){feedRefresh.stop();calendarView.pause();}else{feedRefresh.dispose();calendarView.dispose();}});
window.addEventListener('pageshow',event=>{if(event.persisted){feedRefresh.start();void calendarView.resume();invalidateSearch();}});
if(!storageAvailable)toast('Lokaler Speicher nicht verfügbar oder Backup beschädigt. Dein vorhandener Stand wurde nicht überschrieben.');
