/* Optional real Electron regression with local synthetic content only.
 * Run npm run test:chat-filter:electron after npm ci.
 * CHAT_FILTER_RESULT may select an output JSON file. No live profile is used.
 */
const {app,BrowserWindow,session,nativeTheme}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');

const qaDir=__dirname;
const argument=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const source=argument('--source')||process.env.CHAT_FILTER_SOURCE||path.resolve(qaDir,'../desktop/chat-filter.mjs');
const resultPath=argument('--result')||process.env.CHAT_FILTER_RESULT||path.join(os.tmpdir(),'context-chat-filter-electron-results-'+crypto.randomUUID()+'.json');
const hold=process.argv.includes('--hold'),theme=argument('--theme')==='light'?'light':'dark';
const width=Math.max(620,Math.min(1400,Number(argument('--width'))||980)),height=Math.max(560,Math.min(1000,Number(argument('--height'))||780));
const userData=path.join(os.tmpdir(),'context-chat-filter-electron-'+crypto.randomUUID());
app.setPath('userData',userData);
app.setName('Context Chat Filter · Synthetic Regression');
app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND');
app.commandLine.appendSwitch('disable-background-networking');

const html=String.raw`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Synthetic WhatsApp filter regression</title><style nonce="fixture">
html,body{margin:0;width:100%;height:100%;background:#182027;color:#e9edef;font:24px/1.2 Arial,sans-serif}
/* Realistic author-origin reset. Normal injected user-origin rules lose. */
*{box-sizing:border-box;margin:0;padding:0;font:inherit}
button{border:0;border-radius:0;background:none;color:inherit;text-align:inherit}
h2,p{font:inherit;margin:0;padding:0}
#fixture-toolbar{height:90px;padding:22px;background:#222e35}
#pane-side{position:absolute;left:0;top:90px;bottom:0;width:410px;overflow:auto;background:#111b21}
.virtual-canvas{position:relative;height:6000px}
.fixture-row{position:absolute;left:0;right:0;height:60px;border-bottom:1px solid #29373f;padding:14px;font-size:16px}
#fixture-conversation{position:absolute;left:410px;top:90px;right:0;bottom:0;padding:30px;color:#8696a0;font-size:16px}
@media(prefers-color-scheme:light){html,body{background:#f0f2f5;color:#24333b}#fixture-toolbar{background:#e6e9ec}#pane-side{background:#fff}.fixture-row{border-color:#e4e9ed}#fixture-conversation{color:#5f717a}}
</style></head><body><header id="fixture-toolbar">Synthetischer Test · keine echten Chats</header><section id="pane-side" aria-label="Chatliste"><div class="virtual-canvas" role="grid"></div></section><main id="fixture-conversation">Nachrichtenbereich bleibt unverändert.</main><script nonce="fixture">
const pane=document.querySelector('#pane-side'),canvas=pane.firstElementChild;
let currentCase='offscreen',clicked=[],renderedAt=-1,renderTick;
const courses={5:'CoCo Team',12:'Coding Software',27:'Prototyping Things',48:'C & R – Go Public',65:'CoCo Zielchat'};
const titleFor=index=>currentCase==='duplicate'&&(index===3||index===65)?'CoCo Doppelter Name':courses[index]||'Testchat '+String(index).padStart(3,'0');
function render(){const first=Math.max(0,Math.floor(pane.scrollTop/60));if(first===renderedAt)return;renderedAt=first;canvas.replaceChildren();for(let index=first;index<Math.min(100,first+Math.ceil(pane.clientHeight/60)+2);index++){const row=document.createElement('div');row.className='fixture-row';row.setAttribute('role','row');row.setAttribute('aria-rowindex',String(index+1));row.style.top=index*60+'px';const name=document.createElement('span');name.setAttribute('data-testid','chat-title');name.setAttribute('dir','auto');name.setAttribute('title',titleFor(index));name.textContent=titleFor(index);name.addEventListener('click',()=>{clicked.push({index,title:titleFor(index)});document.querySelector('#fixture-conversation').textContent='Geöffnet: '+titleFor(index);});row.append(name);canvas.append(row);}}
pane.addEventListener('scroll',()=>{clearTimeout(renderTick);renderTick=setTimeout(render,18);});
window.fixture={setCase(name){currentCase=name;clicked=[];renderedAt=-1;pane.scrollTop=0;render();},clicked:()=>clicked.slice(),render,scroll:()=>pane.scrollTop,setScroll(value){pane.scrollTop=value;renderedAt=-1;render();}};render();
</script></body></html>`;

(async()=>{
 let win,exec,own,module;
 const blockedRequests=[],observedRequests=[];
 const results={electron:process.versions.electron,chromium:process.versions.chrome,platform:process.platform,source,sourceSHA256:crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex'),synthetic:true,noLiveUserData:true,theme,viewport:{width,height},cases:[]};
 try {
  await app.whenReady();
  nativeTheme.themeSource=theme;
  module=await import(pathToFileURL(source).href);
  const testSession=session.fromPartition('context-filter-regression-'+crypto.randomUUID());
  testSession.setPermissionRequestHandler((_wc,_permission,reply)=>reply(false));
  testSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(request,reply)=>{
   const url=new URL(request.url),local=url.origin==='https://web.whatsapp.com'&&url.pathname==='/';
   observedRequests.push(url.origin+url.pathname);if(!local)blockedRequests.push(url.origin+url.pathname);
   reply({cancel:!local});
  });
  await testSession.protocol.handle('https',request=>{
   const url=new URL(request.url);
   if(url.origin!=='https://web.whatsapp.com'||url.pathname!=='/'){blockedRequests.push(url.origin+url.pathname);return new Response('External access disabled',{status:403});}
   return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'nonce-fixture'; style-src 'nonce-fixture'; img-src 'none'; connect-src 'none'"}});
  });
  win=new BrowserWindow({show:false,width,height,title:'Synthetic filter regression · '+theme,webPreferences:{session:testSession,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  win.webContents.setAudioMuted(true);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  await win.loadURL('https://web.whatsapp.com/');
  win.showInactive();
  exec=command=>win.webContents.executeJavaScriptInIsolatedWorld(1002,[{code:module.chatFilterScript(command)}]);
  own=script=>win.webContents.executeJavaScript(script);
  const check=async(name,fn)=>{try{const measurements=await fn();results.cases.push({name,passed:true,...measurements});}catch(error){results.cases.push({name,passed:false,error:error.message});}};
  await win.webContents.insertCSS(module.CHAT_FILTER_CSS,{cssOrigin:'user'});
  const target={id:module.namedChatId('CoCo Zielchat'),title:'CoCo Zielchat'};
  await exec({op:'configure',enabled:true,selected:[target]});
  await check('overlay styles beat WhatsApp author reset despite restrictive CSP',async()=>{
   const metrics=await own(`(()=>{const root=document.querySelector('.context-coco-chat-focus'),button=root.querySelector('button'),s=getComputedStyle(button),r=button.getBoundingClientRect(),o=root.getBoundingClientRect();return {fontSize:s.fontSize,paddingTop:s.paddingTop,paddingLeft:s.paddingLeft,borderWidth:s.borderTopWidth,buttonWidth:r.width,overlayWidth:o.width,buttonLeft:r.left,overlayLeft:o.left,buttonHeight:r.height,visibility:document.visibilityState};})()`);
   assert(Number.parseFloat(metrics.paddingTop)>=8,JSON.stringify(metrics));
   assert(Number.parseFloat(metrics.paddingLeft)>=8,JSON.stringify(metrics));
   assert(Number.parseFloat(metrics.fontSize)<=18,JSON.stringify(metrics));
   assert(metrics.buttonHeight>=42,JSON.stringify(metrics));
   assert(metrics.buttonWidth<=metrics.overlayWidth-16,JSON.stringify(metrics));
   return {measurements:metrics};
  });
  await check('selected chat outside the first virtual window opens exactly once',async()=>{
   await own("fixture.setCase('offscreen')");const before=await own('fixture.scroll()');
   const started=performance.now(),opened=await exec({op:'open',id:target.id});
   const clicks=await own('fixture.clicked()');
   assert.equal(opened.opened,true,JSON.stringify({opened,clicks,scroll:await own('fixture.scroll()')}));
   assert.deepEqual(clicks,[{index:65,title:'CoCo Zielchat'}]);
   return {durationMs:Math.round(performance.now()-started),beforeScroll:before,afterScroll:await own('fixture.scroll()')};
  });
  await check('name ambiguity in different virtual windows never opens an arbitrary chat',async()=>{
   await exec({op:'cleanup'});await own("fixture.setCase('duplicate')");
   const duplicate={id:module.namedChatId('CoCo Doppelter Name'),title:'CoCo Doppelter Name'};
   await exec({op:'configure',enabled:true,selected:[duplicate]});
   const before=await own('fixture.scroll()'),opened=await exec({op:'open',id:duplicate.id});
   assert.equal(opened.opened,false,JSON.stringify(opened));assert.deepEqual(await own('fixture.clicked()'),[]);
   assert.equal(await own('fixture.scroll()'),before,'failed lookup restores the original scroll');
   return {beforeScroll:before,afterScroll:await own('fixture.scroll()')};
  });
  await check('cancel during virtual traversal restores scroll and prevents a delayed click',async()=>{
   await exec({op:'cleanup'});await own("fixture.setCase('offscreen');fixture.setScroll(240)");
   await exec({op:'configure',enabled:true,selected:[target]});
   const before=await own('fixture.scroll()');
   const pending=exec({op:'open',id:target.id});
   await new Promise(resolve=>setTimeout(resolve,150));
   await exec({op:'cancel'});const opened=await pending;
   assert.equal(opened.opened,false);assert.deepEqual(await own('fixture.clicked()'),[]);
   assert.equal(await own('fixture.scroll()'),before,'cancelled lookup restores the original virtual-list viewport');
   await new Promise(resolve=>setTimeout(resolve,100));assert.deepEqual(await own('fixture.clicked()'),[],'no delayed chat click after cancellation');
   return {beforeScroll:before,afterScroll:await own('fixture.scroll()')};
  });
  await check('missing selected title returns within the lookup budget without a false click',async()=>{
   await exec({op:'cleanup'});await own("fixture.setCase('offscreen');fixture.setScroll(180)");
   const missing={id:module.namedChatId('CoCo Nicht Vorhanden'),title:'CoCo Nicht Vorhanden'};
   await exec({op:'configure',enabled:true,selected:[missing]});
   const before=await own('fixture.scroll()'),started=performance.now(),opened=await exec({op:'open',id:missing.id}),durationMs=performance.now()-started;
   assert.equal(opened.opened,false);assert.deepEqual(await own('fixture.clicked()'),[]);assert(durationMs<10500,'lookup exceeds bounded runtime budget');
   assert.equal(await own('fixture.scroll()'),before,'missing lookup restores the original scroll');
   return {durationMs:Math.round(durationMs),beforeScroll:before,afterScroll:await own('fixture.scroll()')};
  });
  await check('cleanup removes injected overlay and leaves synthetic host geometry intact',async()=>{
   await exec({op:'cleanup'});
   const state=await own(`(()=>{const pane=document.querySelector('#pane-side');return {overlayCount:document.querySelectorAll('.context-coco-chat-focus').length,paneWidth:pane.getBoundingClientRect().width,canvasHeight:pane.firstElementChild.getBoundingClientRect().height,rowCount:pane.querySelectorAll('[role="row"]').length,hostRowsStyled:[...pane.querySelectorAll('[role="row"]')].some(row=>row.style.display||row.style.visibility)};})()`);
   assert.equal(state.overlayCount,0);assert.equal(state.paneWidth,410);assert.equal(state.canvasHeight,6000);assert.equal(state.hostRowsStyled,false);assert(state.rowCount>0);
   return {measurements:state};
  });
  await check('filter performs no additional network requests',async()=>{
   assert.deepEqual(blockedRequests,[]);assert.deepEqual(observedRequests,['https://web.whatsapp.com/']);
   return {additionalRequests:observedRequests.length-1,blockedRequests:blockedRequests.length,allowedRequests:'single synthetic main document only'};
  });
 }catch(error){results.fatal={message:error.message,stack:error.stack};}
 finally {
  results.passed=!results.fatal&&results.cases.every(result=>result.passed);
  await fs.writeFile(resultPath,JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results,null,2));
  if(hold&&win&&!win.isDestroyed()&&exec&&own&&module){
   await exec({op:'cleanup'});await own("fixture.setCase('offscreen')");
   const titles=['CoCo Team','Coding Software','Prototyping Things','C & R – Go Public','CoCo Zielchat'];
   await exec({op:'configure',enabled:true,selected:titles.map(title=>({id:module.namedChatId(title),title}))});
   win.setTitle('CoCo-Fokus · synthetische Ansicht · '+theme);win.showInactive();
   win.on('closed',()=>{void fs.rm(userData,{recursive:true,force:true}).catch(()=>{}).finally(()=>app.exit(results.passed?0:1));});
   return;
  }
  win?.destroy();await fs.rm(userData,{recursive:true,force:true}).catch(()=>{});
  app.exit(results.passed?0:1);
 }
})();
