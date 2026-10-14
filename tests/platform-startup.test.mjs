import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {createDesktopPlatform} from '../desktop/platform.mjs';
import {createDocumentReader} from '../desktop/document-reader.mjs';
import {createCourseFileFetch} from '../desktop/course-file-fetch.mjs';
import {createMiroShareLinks} from '../desktop/miro-links.mjs';
import {createMiroVisitorReader,miroOffscreenViews} from '../desktop/miro-visitor.mjs';
import {safeMiroBoard} from '../connectors/miro.mjs';
import {createDesktopKeyStore} from '../desktop/key-store.mjs';
import {createKIClient} from '../connectors/ki.mjs';
import {createDesktopSpacesSearch} from '../desktop/spaces-search.mjs';
import {createSpacesSearchIPC} from '../desktop/spaces-search-ipc.mjs';
import {providerPreferences,WEBSITE_PARTITION} from '../desktop/browser-session.mjs';
import {HUB,hubURL,browserURL,requestURL,displayURL,frameBounds,workspaceImagePolicy} from '../desktop/policy.mjs';
import {platformCatalog} from '../dist/source-catalog.js';
import {createSourceHub} from '../dist/source-hub.js';
import {cleanPlatformSources} from '../dist/source-store.js';

// Exercise the actual top-level main module with synthetic Electron surfaces.
// This deliberately does not load Electron, inspect the real app profile,
// start a server, open UI or contact any provider.
async function startup({providerFetch}={}){
  const source=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8'),events=[],channels=new Map(),windows=[],sessions=new Map(),calls={external:[],server:[],provider:[],nativeEvents:[],sessionKeeper:0};
  const app=new EventEmitter();Object.assign(app,{getPath:()=>'/synthetic/context-userdata',setName:()=>{},getVersion:()=> '0.17.0',whenReady:async()=>events.push('ready'),setActivationPolicy:()=>events.push('activation'),show:()=>events.push('app-show'),focus:()=>events.push('app-focus'),quit:()=>events.push('quit')});
  class Contents extends EventEmitter{constructor(){super();this.mainFrame={url:HUB+'/#today'};this.url=HUB+'/#today';this.navigationHistory={canGoBack:()=>false,canGoForward:()=>false};}getURL(){return this.url;}isDestroyed(){return false;}setWindowOpenHandler(handler){this.popup=handler;}send(channel,payload){calls.nativeEvents.push({channel,payload});}focus(){}close(){}async loadURL(url){this.url=url;this.mainFrame.url=url;events.push('window-load');}isLoading(){return false;}}
  const sessionFactory=partition=>{if(sessions.has(partition))return sessions.get(partition);const value=new EventEmitter(),cookies=new EventEmitter();cookies.get=async()=>[];cookies.flushStore=async()=>{};Object.assign(value,{fetch:async(url,options)=>{calls.provider.push({url,options,partition});if(providerFetch)return providerFetch(url,options);throw new Error('No provider fetch at startup');},cookies,webRequest:{onBeforeRequest:handler=>value.requestGuard=handler,onHeadersReceived:handler=>value.responseGuard=handler},setPermissionRequestHandler:handler=>value.requestPermission=handler,setPermissionCheckHandler:handler=>value.checkPermission=handler,getUserAgent:()=> 'synthetic-chromium',setUserAgent:agent=>value.agent=agent,flushStorageData:()=>{}});sessions.set(partition,value);return value;};
  class Window extends EventEmitter{constructor(options){super();assert.ok(events.includes('ready'));events.push('window-create');this.options=options;this.webContents=new Contents();this.webContents.session=sessionFactory('persist:context-workspace');this.contentView={addChildView(){},removeChildView(){}};windows.push(this);}getContentSize(){return [1440,940];}isDestroyed(){return false;}setBackgroundColor(){}show(){events.push('window-show');}focus(){events.push('window-focus');}loadURL(url){return this.webContents.loadURL(url);}}
  class View{constructor(options){this.options=options;this.webContents=new Contents();}setBackgroundColor(){}setVisible(){}setBounds(bounds){this.bounds=bounds;}}
  const nativeNango={initialize:async()=>{events.push('nango-init');},status:async service=>({service,integrationId:'',connectionId:'',revision:'0:0',connected:false,capabilities:{boardRead:true}}),proxy:async()=>{throw new Error('No provider requests in startup fixture');},handle:async()=>({configured:false}),dispose:async()=>{},localStatus:()=>({}),hasBinding:()=>false};
  const simple=()=>async()=>({}),speech=Object.assign(async()=>({}),{dispose(){},reset(){}}),theme={initialize:async()=>events.push('theme-init'),backgroundColor:()=> '#fff7f8',handle:async()=>({}),flush:async()=>{},dispose(){}};
  const dependencies={app,BrowserWindow:Window,WebContentsView:View,session:{fromPartition:sessionFactory},ipcMain:{handle:(channel,handler)=>{assert.ok(!channels.has(channel));channels.set(channel,handler);}},Menu:{buildFromTemplate:value=>value,setApplicationMenu(){events.push('menu');}},dialog:{showErrorBox:()=>{throw new Error('Unexpected startup dialog');},showMessageBoxSync:()=>0},shell:{openExternal:url=>calls.external.push(url)},safeStorage:{},nativeTheme:{},Notification:{isSupported:()=>false},fileURLToPath,path,createHash,HUB,browserURL,requestURL,hubURL,displayURL,frameBounds,workspaceImagePolicy,safeSpacesURL:value=>value,readScript:()=>'',crawlerURL:value=>value,boardFinding:value=>value,createDesktopAI:simple,createDesktopCalendar:simple,createCalendarRouting:value=>value,createCalendarProviders:()=>({}),createDesktopNango:()=>nativeNango,createDesktopNangoMail:()=>Object.assign(simple(),{dispose(){}}),createDesktopOCR:simple,createDesktopSpeech:()=>speech,speechPermission:()=>false,WEBSITE_PARTITION,providerPreferences,allowProviderPopup:()=>false,createProviderSessionKeeper:()=>({status:()=>({mode:'encrypted'}),flush:async()=>{},start:async()=>{calls.sessionKeeper++;events.push('session-restore');}}),chromiumUserAgent:value=>value,createDesktopTheme:()=>theme,createDesktopChatFilter:()=>({initialize:async()=>events.push('chat-filter-init'),schedule(){},handle:async()=>({}),dispose:async()=>{}}),createInventoryBrowser:()=>({handle:async()=>({}),acceptsFrame:()=>false}),createDesktopDevDiary:()=>({handle:async()=>({}),dispose:async()=>{}}),createDiaryReminders:()=>Object.assign(simple(),{dispose:async()=>{}}),createDesktopPlatform,createDocumentReader,createCourseFileFetch,createMiroShareLinks,createMiroVisitorReader,miroOffscreenViews,safeMiroBoard,createDesktopKeyStore,createKIClient,fetch:async url=>{calls.server.push(url);return {ok:true};}};
  Object.assign(dependencies,{createDesktopSpacesSearch,createSpacesSearchIPC});
  dependencies.mainModuleURL=new URL('../desktop/main.mjs',import.meta.url).href;
  const names=Object.keys(dependencies),body=source.replace(/^import[^\n]+\n/gm,'').replaceAll('import.meta.url','mainModuleURL');
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction(...names,body)(...names.map(name=>dependencies[name]));
  return {app,events,channels,windows,sessions,calls,nango:nativeNango,trustedEvent:{sender:windows[0].webContents,senderFrame:windows[0].webContents.mainFrame}};
}

test('0.17 main startup creates and shows its workspace after readiness without a configured provider',async()=>{
  const f=await startup();assert.equal(f.windows.length,1);assert.ok(f.events.indexOf('ready')<f.events.indexOf('nango-init'));assert.ok(f.events.indexOf('nango-init')<f.events.indexOf('window-create'));assert.ok(f.events.indexOf('window-load')<f.events.indexOf('window-show'));assert.deepEqual(f.calls.server,[HUB+'/']);assert.equal(f.calls.sessionKeeper,1);assert.deepEqual(f.calls.external,[]);assert.equal(f.windows[0].options.webPreferences.partition,'persist:context-workspace');assert.equal(f.windows[0].options.webPreferences.sandbox,true);
});

test('startup registers callable typed service and Miro IPC with the exact response schema used by SourceHub',async()=>{
  const f=await startup(),sources=platformCatalog({projects:[{id:'course1',links:[{tool:'gitlab',url:'https://git.coco.study/course/robotics',title:'Robotik'}]}]}),registry=await f.channels.get('context:service')(f.trustedEvent,{action:'registry',sources});assert.equal(registry.ok,true);assert.equal(registry.value.registered,1);assert.match(registry.value.generation,/^[a-f0-9]{64}$/);assert.match(registry.value.accounts.gitlab,/^[a-f0-9]{64}$/);const miro=await f.channels.get('context:miro')(f.trustedEvent,{action:'status',id:randomUUID()});assert.equal(miro.ok,true);assert.equal(miro.value.connected,false);assert.equal(miro.value.backend,'nango');assert.deepEqual(f.calls.external,[]);
});

test('startup IPC refuses foreign webcontents or subframe callers before reaching provider bridges',async()=>{
  const f=await startup(),handle=f.channels.get('context:service');await assert.rejects(handle({...f.trustedEvent,sender:{}},{action:'registry',sources:[]}),/verweigert/);await assert.rejects(handle({...f.trustedEvent,senderFrame:{url:HUB}},{action:'registry',sources:[]}),/verweigert/);f.trustedEvent.senderFrame.url='https://evil.test/';await assert.rejects(handle(f.trustedEvent,{action:'registry',sources:[]}),/verweigert/);
});

test('the actual Spaces search IPC rejects websites, subframes and foreign origins before reaching the narrow provider service',async()=>{
  const f=await startup(),handle=f.channels.get('context:spaces-search');assert.equal(typeof handle,'function');
  const message={op:'search',requestId:randomUUID(),courseURL:'https://spaces.th-koeln.de/fixture-course/',projectId:'fixture',query:'prototype'};
  await assert.rejects(handle({...f.trustedEvent,sender:{}},message),/verweigert/);
  await assert.rejects(handle({...f.trustedEvent,senderFrame:{url:HUB+'/#today'}},message),/verweigert/);
  const original=f.trustedEvent.senderFrame.url;f.trustedEvent.senderFrame.url='https://spaces.th-koeln.de/fixture-course/';
  await assert.rejects(handle(f.trustedEvent,message),/verweigert/);f.trustedEvent.senderFrame.url=original;
  assert.deepEqual(f.calls.provider,[]);
  const forged=await handle(f.trustedEvent,{op:'read',requestId:randomUUID(),courseURL:message.courseURL,projectId:'fixture',id:'b:spaces-rest:'+'0'.repeat(64)});
  assert.equal(forged.ok,false);assert.equal(forged.code,'NOT_OFFERED');assert.deepEqual(f.calls.provider,[]);
  const invalid=await handle(f.trustedEvent,{...message,requestId:randomUUID(),method:'POST'});assert.equal(invalid.ok,false);assert.deepEqual(f.calls.provider,[]);
  const unavailable=await handle(f.trustedEvent,message);assert.equal(unavailable.ok,false);assert.equal(unavailable.code,'NETWORK_ERROR');
  assert.equal(f.calls.provider.length,1);const call=f.calls.provider[0];assert.equal(call.partition,WEBSITE_PARTITION);assert.equal(call.url,message.courseURL);
  assert.equal(call.options.method,'GET');assert.equal(call.options.redirect,'manual');assert.equal(call.options.credentials,'include');assert.doesNotMatch(unavailable.error,/No provider fetch/);
});

test('the real startup cookie hook invalidates an unfinished Spaces search and emits no cookie data',async()=>{
  let release;const waiting=new Promise(resolve=>{release=resolve;}),f=await startup({providerFetch:()=>waiting});
  const pending=f.channels.get('context:spaces-search')(f.trustedEvent,{op:'search',requestId:randomUUID(),courseURL:'https://spaces.th-koeln.de/fixture-course/',projectId:'fixture',query:'prototype'});
  for(let n=0;n<20&&!f.calls.provider.length;n++)await Promise.resolve();assert.equal(f.calls.provider.length,1);
  const cookies=f.sessions.get(WEBSITE_PARTITION).cookies,signal=f.calls.provider[0].options.signal;
  cookies.emit('changed',{}, {domain:'spaces.th-koeln.de',name:'analytics',httpOnly:false});assert.equal(signal.aborted,false);
  cookies.emit('changed',{}, {domain:'.th-koeln.de',name:'wordpress_logged_in_fixture',httpOnly:true,value:'SYNTHETIC_COOKIE_NEVER_RENDER'});
  assert.equal(signal.aborted,true);const result=await pending;assert.equal(result.ok,false);
  release(new Response('Synthetic late page'));await Promise.resolve();assert.equal(f.calls.provider.length,1);
  const notices=f.calls.nativeEvents.filter(value=>value.payload.type==='context-spaces-auth');assert.equal(notices.length,1);assert.deepEqual(notices[0].payload.detail,{});
  assert.doesNotMatch(JSON.stringify(f.calls.nativeEvents),/SYNTHETIC_COOKIE_NEVER_RENDER|wordpress_logged_in_fixture/);
});

test('frontend catalog sources accepted for startup cannot poison native registry with unsupported Sciebo file redirect grants',async()=>{
  const f=await startup(),sources=platformCatalog({projects:[{id:'course1',links:[{tool:'sciebo',url:'https://th-koeln.sciebo.de/f/123',title:'File redirect'},{tool:'sciebo',url:'https://th-koeln.sciebo.de/index.php/s/share123?path=%2FCourse',title:'Freigabe'},{tool:'gitlab',url:'https://git.coco.study/course/robotics',title:'Robotik'}]}]});assert.equal(sources.length,2);const value=await f.channels.get('context:service')(f.trustedEvent,{action:'registry',sources});assert.equal(value.ok,true);assert.equal(value.value.registered,2);
});

test('actual preload channels connect the actual SourceHub initialization to main IPC without login, network or profile access',async()=>{
  const f=await startup(),ipcRenderer=new EventEmitter();let bridge;ipcRenderer.invoke=(channel,message)=>{const handler=f.channels.get(channel);assert.ok(handler,channel);return handler(f.trustedEvent,message);};
  const preload=await readFile(new URL('../desktop/preload.cjs',import.meta.url),'utf8');vm.runInNewContext(preload,{require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'contextDesktop');bridge=value;}},ipcRenderer};}});
  const workspace={projects:[{id:'course1',name:'Robotik',links:[{tool:'gitlab',url:'https://git.coco.study/course/robotics',title:'Robotik'},{tool:'miro',url:'https://miro.com/app/board/board1234/',title:'Board'}]}]};let revision=0,closed=0;const writes=[];
  const hub=createSourceHub({getWorkspace:()=>workspace,bridge,store:{load:async()=>({rows:[],revision}),save:async(rows,options)=>{options.assertCurrent();assert.equal(options.expectedRevision,revision);writes.push(cleanPlatformSources(rows));return ++revision;},close:()=>closed++}});await hub.load();const value=await hub.tool('list_platform_sources',{},undefined,'course1');assert.equal(value.result.sources.length,2);assert.deepEqual(hub.documents(),[]);assert.deepEqual(writes,[[]]);assert.equal(f.calls.external.length,0);await hub.dispose();assert.equal(closed,1);assert.equal(ipcRenderer.listenerCount('context:event'),0);
});
