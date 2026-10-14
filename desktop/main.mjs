import {app,BrowserWindow,WebContentsView,session,ipcMain,Menu,dialog,shell,safeStorage,nativeTheme,Notification} from 'electron';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {HUB,browserURL,requestURL,hubURL,displayURL,frameBounds,workspaceImagePolicy} from './policy.mjs';
import {safeSpacesURL} from '../dist/agent-browser.js';
import {readScript,crawlerURL} from './reader.mjs';
import {readerPlatformLinks} from './platform-link-policy.mjs';
import {boardFinding} from '../dist/board-index.js';
import {createDesktopSpacesSearch} from './spaces-search.mjs';
import {createSpacesSearchIPC} from './spaces-search-ipc.mjs';
import {createDesktopAI} from './ai.mjs';
import {createDesktopKeyStore} from './key-store.mjs';
import {createKIClient} from '../connectors/ki.mjs';
import {createServiceTokens} from '../connectors/service-tokens.mjs';
import {createDesktopCalendar} from './calendar.mjs';
import {createCalendarRouting} from './calendar-routing.mjs';
import {createCalendarProviders} from '../connectors/calendar.mjs';
import {createDesktopNango} from './nango.mjs';
import {createDesktopNangoMail} from './nango-mail.mjs';
import {createDesktopOCR} from './ocr.mjs';
import {createDesktopSpeech,speechPermission} from './speech.mjs';
import {WEBSITE_PARTITION,providerPreferences,allowProviderPopup,createProviderSessionKeeper} from './browser-session.mjs';
import {chromiumUserAgent} from './browser-identity.mjs';
import {createDesktopTheme} from './theme.mjs';
import {createDesktopChatFilter} from './chat-filter.mjs';
import {createInventoryBrowser} from './inventory-browser.mjs';
import {createDesktopDevDiary} from './dev-diary.mjs';
import {createDiaryReminders} from './diary-reminders.mjs';
import {createDesktopPlatform} from './platform.mjs';
import {createDocumentReader} from './document-reader.mjs';
import {createCourseFileFetch} from './course-file-fetch.mjs';
import {createMiroShareLinks} from './miro-links.mjs';
import {createMiroVisitorReader,miroOffscreenViews} from './miro-visitor.mjs';
import {safeMiroBoard} from '../connectors/miro.mjs';
// Cloud AI keys are kept encrypted by the OS (safeStorage) and restored on start; see desktop/key-store.mjs.
const desktopKeys=createDesktopKeyStore({directory:path.join(app.getPath('userData'),'ai'),crypto:safeStorage});
const desktopAI=createDesktopAI(createKIClient({provider:'openrouter',credentialStore:desktopKeys.forProvider('openrouter')}));
let desktopCalendar,desktopNango,desktopNangoMail,desktopPlatform,desktopSpacesSearch,desktopMiroLinks;
const desktopOCR=createDesktopOCR();
const desktopDocumentReader=createDocumentReader();
app.setName('Context Browser');
let win,active='',geometry,embedded=false,nextTab=0,boardScanTab;
let boardScanQueue=Promise.resolve();
let activeScanRequest,crawlLease,crawlLeaseTimer;
const tabs=new Map(),requests=new Map(),popups=new Set();
let sessionKeeper,desktopChatFilter,desktopDevDiary,desktopDiaryReminders,quitReady=false,quitPending=false;
const emit=(type,detail)=>{if(win&&!win.isDestroyed()&&hubURL(win.webContents.getURL()))win.webContents.send('context:event',{type,detail});};
const desktopSpeech=createDesktopSpeech({directory:path.join(app.getPath('userData'),'speech','models'),emit:event=>emit('context-speech',event)});
const trusted=e=>{if(!win||e.sender!==win.webContents||e.senderFrame!==win.webContents.mainFrame||!hubURL(e.senderFrame.url))throw new Error('Zugriff auf den Arbeitsbereich verweigert.');};
function state(){emit('context-browser-state',{active,session:sessionKeeper?.status(),tabs:[...tabs.values()].map(t=>({id:t.id,title:(/Login|Sign in/i.test(t.title||'')?t.label+' · ':'')+(t.title||'Neuer Tab'),url:displayURL(t.view.webContents.getURL()),loading:t.view.webContents.isLoading(),back:t.view.webContents.navigationHistory.canGoBack(),forward:t.view.webContents.navigationHistory.canGoForward(),error:t.error||''}))});pageState();desktopChatFilter?.schedule();}
function pageState(){const t=tabs.get(active),url=t?.view.webContents.getURL()||'';let readable=false,miroBoard=null;try{safeSpacesURL(url);readable=true;}catch{}try{miroBoard={url:safeMiroBoard(url).url,title:String(t.title||'').replace(/\s+-\s+Miro$/,'').slice(0,200)};}catch{}const size=win?.getContentSize(),visible=!!t&&!!size&&!!frameBounds(geometry,...size);emit('context-browser-page',{visible,current:visible||!!t&&geometry?.current===true,readable,miroBoard});desktopChatFilter?.schedule();}
function layout(){if(!win)return;const [w,h]=win.getContentSize();const bounds=frameBounds(geometry,w,h);for(const t of tabs.values()){const shown=t.id===active&&!!bounds;t.view.setVisible(shown);if(shown)t.view.setBounds(bounds);}pageState();}
function select(id){if(!tabs.has(id))throw new Error('Dieser Browser-Tab ist nicht mehr geöffnet.');active=id;layout();state();}
function create(url,{activate=true}={}){if(sessionKeeper?.status().mode==='initializing')throw new Error('Die Browser-Sitzung wird wiederhergestellt. Bitte kurz warten.');url=browserURL(url);if(tabs.size>=12)throw new Error('Bis zu zwölf Tabs sind möglich. Schließe zunächst einen Tab.');
 const id=String(++nextTab),view=new WebContentsView({webPreferences:{partition:WEBSITE_PARTITION,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,navigateOnDragDrop:false}});
 view.setBackgroundColor(desktopTheme.backgroundColor());view.setVisible(false);win.contentView.addChildView(view);
 const label=({'git.coco.study':'GitLab','chat.coco.study':'Mattermost','spaces.th-koeln.de':'Spaces','th-koeln.sciebo.de':'Sciebo','webmail.th-koeln.de':'TH-Mail'})[new URL(url).hostname]||new URL(url).hostname;
 const t={id,view,label,title:'Wird geladen …',error:'',links:new Set(),controls:new Set(),readAt:'',epoch:0};tabs.set(id,t);const wc=view.webContents;
 const guard=(e,url)=>{try{browserURL(url);}catch{e.preventDefault();t.error='Diese Adresse ist aus Sicherheitsgründen gesperrt.';state();}};
 wc.on('will-navigate',(e,url)=>guard(e,url));wc.on('will-redirect',(e,url)=>guard(e,url));
 wc.on('did-start-navigation',(_e,_url,_inPlace,main)=>{if(main){t.epoch++;t.links.clear();t.controls.clear();t.readAt='';t.error='';desktopChatFilter?.schedule();}});
 wc.on('did-navigate',(_event,next)=>{if(/[?&]share_link_id=/.test(next))try{desktopMiroLinks?.remember([next]);}catch{}state();});wc.on('did-navigate-in-page',state);wc.on('did-start-loading',state);wc.on('did-stop-loading',state);
 wc.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&input.key==='Escape'&&geometry?.focus===true&&!embedded){event.preventDefault();win.webContents.focus();emit('context-browser-escape',{});}});
 wc.on('page-title-updated',(_e,title)=>{t.title=String(title).slice(0,180);state();});
 wc.on('did-fail-load',(_e,code,_description,_url,main)=>{if(main&&code!==-3){t.error=`Die Seite konnte nicht geladen werden (${code}). Prüfe die Adresse und lade erneut.`;state();}});
 wc.on('render-process-gone',()=>{t.error='Der Browser-Tab wurde angehalten. Lade ihn erneut.';state();});
 attachProviderPopups(wc);
 if(activate)active=id;layout();void wc.loadURL(url).catch(()=>{});state();return t;
}
function attachProviderPopups(wc){
 wc.setWindowOpenHandler(({url})=>allowProviderPopup(url,wc.getURL(),popups.size)?{action:'allow',overrideBrowserWindowOptions:{width:1000,height:760,minWidth:640,minHeight:420,parent:win,title:'Anmeldung · Context Browser',autoHideMenuBar:true,backgroundColor:desktopTheme.backgroundColor(),webPreferences:providerPreferences()}}:{action:'deny'});
 wc.on('did-create-window',child=>{
  popups.add(child);child.setBackgroundColor(desktopTheme.backgroundColor());const remote=child.webContents;
  const guard=(event,url)=>{try{browserURL(url);}catch{event.preventDefault();}};
  remote.on('will-navigate',guard);remote.on('will-redirect',guard);remote.on('will-attach-webview',event=>event.preventDefault());
  remote.on('did-navigate',()=>{const address=displayURL(remote.getURL());if(address&&!child.isDestroyed())child.setTitle(address+' · Context Browser');});
  attachProviderPopups(remote);child.on('closed',()=>{popups.delete(child);void sessionKeeper?.flush();});
 });
}
function close(id){const t=tabs.get(id);if(!t)return;win.contentView.removeChildView(t.view);t.view.webContents.close();tabs.delete(id);if(id===active)active=[...tabs.keys()].at(-1)||'';layout();state();}
function openInHub(url){const t=create(url);embedded=false;emit('context-browser-open',{tabId:t.id});return t;}
const inventoryBrowser=createInventoryBrowser({getTab:id=>tabs.get(id),createTab:url=>create(url,{activate:false}),selectTab:id=>{embedded=true;geometry=null;select(id);},navigateTab:(id,url)=>tabs.get(id).view.webContents.loadURL(browserURL(url))});
async function browser(message){if(!message||typeof message!=='object')throw new Error('Ungültiger Browserauftrag.');const t=tabs.get(message.id||active);
 switch(message.type){case 'inventory':return inventoryBrowser.handle(message);case 'state':state();return;case 'new':openInHub(message.url||'https://spaces.th-koeln.de/');return;case 'navigate':if(!t)openInHub(message.url);else{t.error='';await t.view.webContents.loadURL(browserURL(message.url));}return;case 'select':embedded=false;select(message.id);return;case 'close':close(message.id);return;case 'frame':if(message.owner==='inventory'&&!inventoryBrowser.acceptsFrame(message,active))return;if(message.owner==='browser'&&geometry?.owner==='spaces'&&message.visible===false)return;if(message.owner==='browser')embedded=false;geometry=message;layout();return;case 'detach':if(message.owner&&geometry?.owner!==message.owner||message.id&&geometry?.id!==message.id)return;geometry=null;layout();return;case 'back':if(t?.view.webContents.navigationHistory.canGoBack())t.view.webContents.navigationHistory.goBack();return;case 'forward':if(t?.view.webContents.navigationHistory.canGoForward())t.view.webContents.navigationHistory.goForward();return;case 'reload':t?.view.webContents.reload();return;case 'stop':t?.view.webContents.stop();return;default:throw new Error('Unbekannter Browserauftrag.');}
}
async function space(message){if(message?.type==='embed'){const url=safeSpacesURL(message.url);let t=[...tabs.values()].find(t=>displayURL(t.view.webContents.getURL())===displayURL(url));if(!t)t=create(url);embedded=true;select(t.id);return;}if(message?.type==='frame'){geometry={...message,owner:'spaces'};layout();return;}if(message?.type==='detach'){if(geometry?.owner&&geometry.owner!=='spaces')return;geometry=null;embedded=false;layout();return;}if(message?.type==='open'){openInHub(browserURL(message.url));return;}throw new Error('Unbekannter Kurs-Browserauftrag.');}
function scanTab(){
 if(boardScanTab&&!boardScanTab.view.webContents.isDestroyed())return boardScanTab;
 const view=new WebContentsView({webPreferences:{...providerPreferences(),focusOnNavigation:false}});view.setBackgroundColor(desktopTheme.backgroundColor());view.setVisible(false);win.contentView.addChildView(view);
 const t={id:'board-scan',view,links:new Set(),controls:new Set(),readAt:'',epoch:0};boardScanTab=t;
 const wc=view.webContents,guard=(event,url)=>{try{browserURL(url);}catch{event.preventDefault();}};
 wc.on('will-navigate',guard);wc.on('will-redirect',guard);wc.on('will-attach-webview',event=>event.preventDefault());
 wc.on('did-start-navigation',(_e,_url,_inPlace,main)=>{if(main){t.epoch++;t.links.clear();t.controls.clear();t.readAt='';t.httpStatus=0;t.httpURL='';}});
 wc.on('did-navigate',(_event,url,status)=>{t.httpURL=url;t.httpStatus=Number.isInteger(status)?status:0;});
 wc.setWindowOpenHandler(()=>({action:'deny'}));return t;
}
function agentWait(work,record){if(!record?.crawler)return Promise.resolve(work);const signal=record.controller.signal;return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(new DOMException('Abgebrochen','AbortError'));};if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});Promise.resolve(work).then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted){abort();return;}resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});}
function currentAgent(record){return requests.get(record.id)===record&&!record.controller.signal.aborted;}
function clearCrawlLease(jobId,lease){if(!crawlLease||jobId&&crawlLease.jobId!==jobId||lease&&crawlLease!==lease)return false;clearTimeout(crawlLeaseTimer);crawlLeaseTimer=undefined;crawlLease=undefined;if(boardScanTab){boardScanTab.links.clear();boardScanTab.controls.clear();boardScanTab.readAt='';boardScanTab.contentRevision='';}return true;}
function touchCrawlLease(){clearTimeout(crawlLeaseTimer);if(crawlLease){const lease=crawlLease;crawlLeaseTimer=setTimeout(()=>clearCrawlLease(lease.jobId,lease),60000);crawlLeaseTimer.unref?.();}}
function cancelAgent(record){if(!record)return;record.controller.abort();if(requests.get(record.id)===record)requests.delete(record.id);if(activeScanRequest===record){try{record.tab?.view.webContents.stop();}catch{}}if(record.lease)clearCrawlLease(record.jobId,record.lease);}
function cancelAgentRequests(){for(const record of [...requests.values()])cancelAgent(record);clearCrawlLease();}
async function loaded(t,record){const wc=t.view.webContents;if(!wc.isLoading())return;await new Promise((resolve,reject)=>{const signal=record?.controller.signal;const cleanup=()=>{clearTimeout(timer);wc.removeListener('did-stop-loading',done);signal?.removeEventListener('abort',abort);};const done=()=>{cleanup();resolve();};const abort=()=>{cleanup();reject(new DOMException('Abgebrochen','AbortError'));};const timer=setTimeout(()=>{cleanup();reject(new Error('Spaces lädt zu lange. Prüfe die Anmeldung im Browser.'));},22000);if(signal?.aborted){abort();return;}wc.once('did-stop-loading',done);signal?.addEventListener('abort',abort,{once:true});});}
async function crawlerPause(record){await new Promise((resolve,reject)=>{const signal=record?.controller.signal;const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};const abort=()=>{cleanup();reject(new DOMException('Abgebrochen','AbortError'));};const timer=setTimeout(()=>{cleanup();resolve();},350);if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});});}
async function read(t,offset=0,options={},record){await loaded(t,record);const wc=t.view.webContents,url=wc.getURL();try{safeSpacesURL(url);}catch{return {loginRequired:true,url:'https://spaces.th-koeln.de/',title:'Spaces-Anmeldung erforderlich',text:'',links:[],controls:[]};}if(options.crawler){crawlerURL(url,options.courseURL);if(t.httpURL===url&&t.httpStatus===403)return {permissionRequired:true,accessDenied:true,loginRequired:false,url,title:'Kurszugriff verweigert',text:'',links:[],controls:[]};if(t.httpURL===url&&t.httpStatus===401)return {loginRequired:true,url,title:'Spaces-Anmeldung erforderlich',text:'',links:[],controls:[]};if(t.httpURL===url&&t.httpStatus>=400)throw new Error('Die Kursseite ist nicht verfügbar (HTTP '+t.httpStatus+').');}const epoch=t.epoch;
 const assertCurrent=()=>{if(record&&!currentAgent(record))throw new DOMException('Abgebrochen','AbortError');if(epoch!==t.epoch||(t!==boardScanTab&&active!==t.id)||wc.getURL()!==url)throw new Error('Die Browserseite hat sich geändert. Bitte erneut lesen.');};
 const blocked=value=>value.loginRequired===true||value.permissionRequired===true||value.accessDenied===true;
 const snapshot=async()=>{assertCurrent();const value=await agentWait(wc.executeJavaScriptInIsolatedWorld(1001,[{code:readScript(offset,options)}]),record);assertCurrent();if(blocked(value)){t.links.clear();t.controls.clear();t.readAt='';t.contentRevision='';return {url,title:value.loginRequired===true?'Spaces-Anmeldung erforderlich':'Kurszugriff verweigert',loginRequired:value.loginRequired===true,permissionRequired:value.permissionRequired===true||value.accessDenied===true,accessDenied:value.accessDenied===true,text:'',links:[],controls:[]};}if(options.crawler&&!/^[a-f0-9]{64}$/.test(value.contentRevision||''))throw new Error('Der gelesene Kursinhalt hat sich geändert. Bitte die Ansicht erneut beginnen.');return value;};
 let page=await snapshot();
 if(blocked(page))return page;
 if(options.crawler&&!options.expectedRevision&&offset===0&&!(options.linkOffset||options.controlOffset)){let settled=false;for(let attempt=0;attempt<4;attempt++){await crawlerPause(record);assertCurrent();const next=await snapshot();if(blocked(next))return next;if(next.contentRevision===page.contentRevision){page=next;settled=true;break;}page=next;}if(!settled)throw new Error('Die Kursansicht ist noch nicht stabil. Bitte später erneut beginnen.');}
 assertCurrent();
 desktopMiroLinks?.take(page);
 page.platformLinksMore=page.platformLinksMore===true||Array.isArray(page.platformLinks)&&page.platformLinks.length>100;
 page.platformLinks=readerPlatformLinks(page);
 if(options.crawler){page.url=crawlerURL(page.url,options.courseURL);page.epoch=epoch;if(!/^[a-f0-9]{64}$/.test(page.contentRevision||'')||options.expectedRevision&&options.expectedRevision!==page.contentRevision)throw new Error('Der gelesene Kursinhalt hat sich geändert. Bitte die Ansicht erneut beginnen.');page.links=(page.links||[]).slice(0,45).flatMap(link=>{try{return [{title:String(link.title).slice(0,160),url:crawlerURL(link.url,options.courseURL)}];}catch{return [];}});page.controls=(page.controls||[]).slice(0,30).filter(control=>/^(primary-swap-menu-label|secondary-swap-menu-label|accordion-item-[a-zA-Z0-9_-]{1,80})$/.test(control.id));if(t.contentRevision!==page.contentRevision||t.readAt!==url){t.links.clear();t.controls.clear();}for(const link of page.links)t.links.add(link.url);for(const control of page.controls)t.controls.add(control.id);t.contentRevision=page.contentRevision;t.readAt=url;return page;}
 page.url=safeSpacesURL(page.url);page.boardLinks=(page.boardLinks||[]).slice(0,100).flatMap(l=>{try{const sourceURL=safeSpacesURL(l.sourceURL||page.url);const f=boardFinding({...l,sourceURL},{id:'page',url:page.url,title:page.title});return [{url:f.url,title:f.titleOrigin==='link'?f.title:'',postedBy:f.postedBy,postedAt:f.postedAt,sourceTitle:f.sourceTitle,sourceURL}];}catch{return [];}});page.links=(page.links||[]).flatMap(l=>{try{return [{title:String(l.title).slice(0,160),url:safeSpacesURL(l.url)}];}catch{return [];}});page.controls=(page.controls||[]).filter(c=>/^(primary-swap-menu-label|secondary-swap-menu-label|accordion-item-[\w-]{1,80})$/.test(c.id));t.links=new Set(page.links.map(l=>l.url));t.controls=new Set(page.controls.map(c=>c.id));t.readAt=url;return page;
}
async function agent(message){if(message?.type==='cancel'){cancelAgent(requests.get(message.id));return;}if(message?.type!=='request'||!/^[a-f0-9-]{36}$/i.test(message.id)||requests.has(message.id))throw new Error('Ungültiger Agentenauftrag.');const crawler=message.crawler===true;if(crawler&&(message.scan!==true||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(message.jobId||'')||message.expectedRevision!==undefined&&!/^[a-f0-9]{64}$/.test(message.expectedRevision)))throw new Error('Ungültiger Kurs-Crawler-Auftrag.');const record={id:message.id,controller:new AbortController(),scan:message.scan===true,crawler,jobId:crawler?message.jobId:''};requests.set(message.id,record);let scanningView,releaseScan;
 try{if(message.scan===true){const previous=boardScanQueue;let finish;boardScanQueue=new Promise(resolve=>{finish=resolve;});releaseScan=()=>{void previous.catch(()=>{}).then(finish);};await agentWait(previous,record);if(!currentAgent(record))return;activeScanRequest=record;}
 const command=message.command;
 if(message.scan===true){if(crawlLease&&(!crawler||crawlLease.jobId!==message.jobId))throw new Error('Eine andere Spaces-Prüfung nutzt gerade den Leser. Bitte später erneut starten.');if(crawler){if(command==='release'){clearCrawlLease(message.jobId);emit('context-agent-browser',{id:message.id,released:true});return;}if(command==='start'){const courseURL=crawlerURL(message.courseURL,message.courseURL);crawlerURL(message.url,courseURL);crawlLease={jobId:message.jobId,courseURL};}else if(!crawlLease||crawlLease.jobId!==message.jobId)throw new Error('Diese Kursansicht wurde freigegeben. Bitte erneut beginnen.');record.lease=crawlLease;touchCrawlLease();}}
 let t=message.scan===true?scanTab():tabs.get(active);record.tab=t;const options=crawler?{crawler:true,courseURL:crawlLease.courseURL,linkOffset:message.linkOffset,controlOffset:message.controlOffset,expectedRevision:message.expectedRevision}:{};
 if(t&&t===boardScanTab){scanningView=t.view.webContents;scanningView.setBackgroundThrottling(false);}
 if(command==='start'&&message.scan===true){await agentWait(t.view.webContents.loadURL(crawler?crawlerURL(message.url,options.courseURL):safeSpacesURL(message.url)),record);}
 else if(command==='start'){const url=safeSpacesURL(message.url);if(!t||displayURL(t.view.webContents.getURL())!==displayURL(url)){t=[...tabs.values()].find(t=>displayURL(t.view.webContents.getURL())===displayURL(url))||create(url);select(t.id);}if(!embedded&&!message.background)emit('context-browser-open',{tabId:t.id});}
 else if(!t)throw new Error('Öffne zunächst einen Kurs-Space.');
 const wc=t.view.webContents;
 if(command==='open'){const url=crawler?crawlerURL(message.url,options.courseURL):safeSpacesURL(message.url);if(t.readAt!==wc.getURL()||!t.links.has(url))throw new Error('Der Assistent darf nur zuvor gelesenen Spaces-Links folgen.');await agentWait(wc.loadURL(url),record);}
 else if(command==='click'){if(crawler)await read(t,0,options,record);if(t.readAt!==wc.getURL()||!t.controls.has(message.idValue||message.controlId))throw new Error('Dieser Kursabschnitt wurde nicht gelesen.');const id=message.idValue||message.controlId;await agentWait(wc.executeJavaScriptInIsolatedWorld(1001,[{code:`new Promise(resolve=>{const el=document.getElementById(${JSON.stringify(id)});if(!el||el.closest('form,[contenteditable=true]')||el.form||el.getAttribute('form')||/^(submit|reset)$/i.test(el.getAttribute('type')||''))throw new Error('Dieser Abschnitt ist keine lesende Navigation.');el.click();setTimeout(resolve,2200);})`}]),record);if(crawler)delete options.expectedRevision;}
 else if(command==='scroll'){safeSpacesURL(wc.getURL());const direction=message.direction==='up'?-1:1;await wc.executeJavaScriptInIsolatedWorld(1001,[{code:`window.scrollBy(0,${direction}*window.innerHeight*0.8)`}]);}
 else if(!['start','read'].includes(command))throw new Error('Dieses Browserwerkzeug ist nicht verfügbar.');
 if(!currentAgent(record))return;const page=await read(t,Number.isSafeInteger(message.offset)?Math.max(0,Math.min(crawler?60000:50000,message.offset)):0,options,record);if(currentAgent(record))emit('context-agent-browser',{id:message.id,...page});
 }catch(error){if(currentAgent(record))emit('context-agent-browser',{id:message.id,error:error.message});if(record.lease)clearCrawlLease(message.jobId,record.lease);}finally{if(requests.get(message.id)===record)requests.delete(message.id);if(activeScanRequest===record)activeScanRequest=undefined;try{if(scanningView&&!scanningView.isDestroyed())scanningView.setBackgroundThrottling(true);}finally{if(record.lease&&crawlLease===record.lease)touchCrawlLease();releaseScan?.();}}
}
await app.whenReady();
desktopNango=createDesktopNango({directory:path.join(app.getPath('userData'),'nango'),crypto:safeStorage,openExternal:url=>shell.openExternal(url)});
await desktopNango.initialize();
desktopCalendar=createDesktopCalendar({providers:createCalendarRouting({nango:desktopNango,direct:createCalendarProviders({openExternal:url=>shell.openExternal(url)})})});
desktopNangoMail=createDesktopNangoMail({nango:desktopNango});
const desktopTheme=createDesktopTheme({nativeTheme,directory:app.getPath('userData'),emit:detail=>emit('context-theme',detail),apply:()=>{
 const color=desktopTheme.backgroundColor();
 if(win&&!win.isDestroyed())win.setBackgroundColor(color);
 for(const t of tabs.values())if(!t.view.webContents.isDestroyed())t.view.setBackgroundColor(color);
 if(boardScanTab&&!boardScanTab.view.webContents.isDestroyed())boardScanTab.view.setBackgroundColor(color);
 for(const popup of popups)if(!popup.isDestroyed())popup.setBackgroundColor(color);
}});
await desktopTheme.initialize();
desktopChatFilter=createDesktopChatFilter({directory:app.getPath('userData'),crypto:safeStorage,getActive:()=>{const tab=tabs.get(active);return tab&&(geometry?.visible===true||geometry?.current===true)?{id:tab.id,epoch:tab.epoch,url:tab.view.webContents.getURL(),webContents:tab.view.webContents}:null;},emit:detail=>emit('context-chat-filter',detail)});
await desktopChatFilter.initialize();
if(process.platform==='darwin')app.setActivationPolicy('regular');
const providerSession=session.fromPartition(WEBSITE_PARTITION);
desktopSpacesSearch=createSpacesSearchIPC(createDesktopSpacesSearch({providerSession}));
providerSession.cookies.on('changed',(_event,cookie)=>{const domain=String(cookie.domain||'').replace(/^\./,'').toLowerCase();if(domain&&('spaces.th-koeln.de'===domain||'spaces.th-koeln.de'.endsWith('.'+domain))&&(cookie.httpOnly||/wordpress|session|auth/i.test(cookie.name||''))){desktopSpacesSearch.invalidate();emit('context-spaces-auth',{});}});
const diaryDirectory=path.join(app.getPath('userData'),'dev-diaries');
desktopDevDiary=createDesktopDevDiary({providerSession,directory:diaryDirectory});
desktopDiaryReminders=createDiaryReminders({directory:diaryDirectory,crypto:safeStorage,notify:detail=>{
 if(!Notification.isSupported())throw new Error('Systembenachrichtigungen sind nicht verfügbar.');
 const notice=new Notification({title:detail.title,body:detail.body,silent:true});
 notice.on('click',()=>{app.show();win?.show();win?.focus();emit('context-diary-reminder-open',{diaryId:detail.diaryId,date:detail.date});});notice.show();
}});

// Set before creating any website or login popup so both inherit the same identity.
providerSession.setUserAgent(chromiumUserAgent(providerSession.getUserAgent(),process.versions.chrome));
providerSession.setPermissionRequestHandler((_w,_p,callback)=>callback(false));providerSession.setPermissionCheckHandler(()=>false);
providerSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!requestURL(details.url)}));
// No background downloads or automatic execution. The user chooses every destination.
providerSession.on('will-download',(_e,item)=>{item.setSaveDialogOptions({title:'Datei aus dem Browser speichern',defaultPath:path.basename(item.getFilename())});});
desktopMiroLinks=createMiroShareLinks({directory:path.join(app.getPath('userData'),'miro'),crypto:safeStorage});
await desktopMiroLinks.initialize();
// Public Miro boards are read as a visitor in a hidden, muted view of the website partition.
const miroVisitor=createMiroVisitorReader({getShareLink:id=>desktopMiroLinks.get(id),...miroOffscreenViews(BrowserWindow)});
desktopPlatform=createDesktopPlatform({nango:desktopNango,miroVisitor,miroLinks:desktopMiroLinks,getAccountFingerprint:async service=>{const host=({gitlab:'git.coco.study',sciebo:'th-koeln.sciebo.de',mattermost:'chat.coco.study'})[service];const cookies=await providerSession.cookies.get({});return createHash('sha256').update(JSON.stringify([service,cookies.filter(cookie=>{const domain=String(cookie.domain||'').replace(/^\./,'');return (host===domain||host.endsWith('.'+domain))&&(cookie.httpOnly||/session|token|auth|userid/i.test(cookie.name));}).map(cookie=>[cookie.domain,cookie.path,cookie.name,cookie.value]).sort((a,b)=>String(a.slice(0,3)).localeCompare(String(b.slice(0,3))))])).digest('hex');},createView:({webPreferences})=>{const view=new WebContentsView({webPreferences});view.setBounds({x:0,y:0,width:1280,height:900});return view;},destroyView:view=>{if(!view.webContents.isDestroyed())view.webContents.close();},openVisible:url=>openInHub(url),emit:detail=>emit('context-platform-auth',detail),fetchText:createCourseFileFetch({session:providerSession}),readDocument:request=>desktopDocumentReader.read(request)});
providerSession.cookies.on('changed',(_event,cookie)=>{if(!cookie.httpOnly&&!/session|token|auth|userid/i.test(cookie.name||''))return;const domain=String(cookie.domain||'').replace(/^\./,'');for(const [host,service] of Object.entries({'git.coco.study':'gitlab','th-koeln.sciebo.de':'sciebo','chat.coco.study':'mattermost'}))if(host===domain||host.endsWith('.'+domain))desktopPlatform.invalidate(service);});

win=new BrowserWindow({width:1440,height:940,minWidth:850,minHeight:600,title:'Context Browser · '+app.getVersion(),backgroundColor:desktopTheme.backgroundColor(),webPreferences:{partition:'persist:context-workspace',preload:fileURLToPath(new URL('./preload.cjs',import.meta.url)),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,navigateOnDragDrop:false}});
win.on('page-title-updated',event=>event.preventDefault());
win.webContents.on('will-prevent-unload',event=>{const choice=dialog.showMessageBoxSync(win,{type:'warning',buttons:['Geöffnet lassen','Trotzdem schließen'],defaultId:0,cancelId:0,message:'Im Arbeitsbereich gibt es noch ungesicherte Änderungen.',detail:'Prüfe den Chat-Speicherstatus sowie offene Notiz- und Mailentwürfe. Speichere oder sichere sie vor dem Neuladen. Trotzdem schließen kann ungesicherte Änderungen verlieren.'});if(choice===1)event.preventDefault();});
const hubSession=win.webContents.session;hubSession.on('will-download',(_e,item)=>item.setSaveDialogOptions({title:'Lokale Datei speichern',defaultPath:path.basename(item.getFilename())}));
hubSession.webRequest.onHeadersReceived((details,callback)=>callback({responseHeaders:workspaceImagePolicy(details)}));
hubSession.setPermissionRequestHandler((wc,permission,callback,details)=>callback(speechPermission({webContents:wc,expected:win?.webContents,permission,origin:URL.canParse(details.requestingUrl)?new URL(details.requestingUrl).origin:'',mediaTypes:details.mediaTypes,mainFrame:details.isMainFrame===true})));
hubSession.setPermissionCheckHandler((wc,permission,origin,details)=>speechPermission({webContents:wc,expected:win?.webContents,permission,origin,mediaTypes:[details.mediaType],mainFrame:details.isMainFrame!==false}));
win.webContents.on('will-navigate',(e,url)=>{if(!hubURL(url))e.preventDefault();});win.webContents.on('will-redirect',(e,url)=>{if(!hubURL(url))e.preventDefault();});win.webContents.on('will-attach-webview',e=>e.preventDefault());
win.webContents.setWindowOpenHandler(({url})=>{try{openInHub(url);}catch{}return {action:'deny'};});
for(const [name,fn] of [['spaces-search',desktopSpacesSearch.handle],['browser',browser],['space',space],['agent',agent],['ai',desktopAI],['calendar',desktopCalendar],['nango',desktopNango.handle],['nango-mail',desktopNangoMail],['service',desktopPlatform.service],['miro',desktopPlatform.miro],['ocr',desktopOCR],['speech',desktopSpeech],['chat-filter',desktopChatFilter.handle],['dev-diary',desktopDevDiary.handle],['diary-reminders',desktopDiaryReminders],['theme',desktopTheme.handle]])ipcMain.handle('context:'+name,async(e,message)=>{trusted(e);try{return {ok:true,value:await fn(message)};}catch(error){return {ok:false,error:error.message,code:error.code};}});
win.on('resize',()=>{geometry=null;layout();emit('context-browser-layout',{});});win.webContents.on('did-start-navigation',(_e,_url,_inPlace,main)=>{if(main){cancelAgentRequests();desktopSpacesSearch.invalidate();desktopPlatform.cancel();void desktopSpeech({type:'cancel'});geometry=null;layout();}});
win.webContents.on('render-process-gone',()=>desktopSpeech.reset());
win.webContents.on('did-finish-load',state);
win.on('closed',()=>{cancelAgentRequests();desktopPlatform.dispose();for(const t of tabs.values())t.view.webContents.close();boardScanTab?.view.webContents.close();boardScanTab=null;tabs.clear();win=null;app.quit();});
Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Context Browser',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'quit'}]},{label:'Bearbeiten',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'Browser',submenu:[{label:'Neuer Tab',accelerator:'CmdOrCtrl+T',click:()=>openInHub('https://spaces.th-koeln.de/')},{label:'Seite neu laden',accelerator:'CmdOrCtrl+R',click:()=>tabs.get(active)?.view.webContents.reload()},{label:'Arbeitsbereich neu laden',accelerator:'CmdOrCtrl+Shift+R',click:()=>win.webContents.reload()},{label:'Adresse bearbeiten',accelerator:'CmdOrCtrl+L',click:()=>emit('context-browser-address',{})},{label:'Kontextassistent',accelerator:'CmdOrCtrl+Shift+K',click:()=>emit('context-agent-toggle',{})}]},{label:'Fenster',submenu:[{role:'minimize'},{role:'zoom'}]}]));
app.on('second-instance',()=>{app.show();win?.show();win?.focus();});
app.on('activate',()=>{app.show();win?.show();win?.focus();});
sessionKeeper=createProviderSessionKeeper({cookies:providerSession.cookies,crypto:safeStorage,profile:app.getPath('userData'),onChange:()=>state()});
app.on('before-quit',async event=>{if(quitReady)return;event.preventDefault();if(quitPending)return;quitPending=true;cancelAgentRequests();desktopSpacesSearch.dispose();desktopPlatform.dispose();desktopDocumentReader.dispose();desktopSpeech.dispose();desktopNangoMail.dispose();await desktopNango.dispose();await desktopChatFilter.dispose();await desktopDevDiary.dispose();await desktopDiaryReminders.dispose();await desktopTheme.flush();desktopTheme.dispose();await desktopMiroLinks?.flush();await sessionKeeper.flush();providerSession.flushStorageData();quitReady=true;app.quit();});
await ensureServer();
await win.loadURL(HUB+'/#today').catch(()=>dialog.showErrorBox('Context-Server starten','Bitte zuerst start.command im context-hub-Ordner starten. Der lokale Server läuft auf Port 4318.'));

async function ensureServer(){try{const response=await fetch(HUB+'/',{signal:AbortSignal.timeout(2000)});if(response.ok)return;}catch{}
 const {createServer}=await import('node:http');const {createRequestHandler}=await import('../server.mjs');const owned=createServer(createRequestHandler(()=>4318,undefined,createKIClient({provider:'kiconnect',credentialStore:desktopKeys.forProvider('kiconnect')}),undefined,undefined,{services:createServiceTokens({stores:{gitlab:desktopKeys.forProvider('gitlab'),mattermost:desktopKeys.forProvider('mattermost')},sessionFetch:Object.fromEntries(['gitlab','mattermost'].map(id=>[id,(url,options)=>providerSession.fetch(url,{...options,credentials:'include'})]))})}));await new Promise((resolve,reject)=>{owned.once('error',error=>error.code==='EADDRINUSE'?resolve():reject(error));owned.listen(4318,'127.0.0.1',resolve);});app.on('before-quit',()=>owned.close());}

app.show();win.show();win.focus();app.focus({steal:true});
void sessionKeeper.start();
