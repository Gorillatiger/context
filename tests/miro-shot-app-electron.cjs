/* Optional end-to-end check of board screenshots in the real app UI (Electron).
 * Run npm run test:miro:shot:app [--out dir] [board url]. Chain: real chat UI (dist/) ->
 * agent -> source hub -> native Miro module -> offscreen visitor reader on a live public
 * board -> screenshot -> chat message -> encrypted archive -> reload. Only the language
 * model is scripted. A temporary profile is used; no account or invitation is touched.
 */
const {app,BrowserWindow,ipcMain,safeStorage}=require('electron');
const path=require('node:path'),os=require('node:os'),fs=require('node:fs'),crypto=require('node:crypto'),http=require('node:http');
const {pathToFileURL}=require('node:url');
const outIndex=process.argv.indexOf('--out'),OUT=outIndex>=0?process.argv[outIndex+1]:os.tmpdir();
const BOARD=process.argv.find((value,index,all)=>/^https:\/\/miro\.com\/app\/board\//.test(value)&&all[index-1]!=='--out')||'https://miro.com/app/board/o9J_kuapqg4=/';
const dark=process.argv.includes('--dark'),narrow=process.argv.includes('--narrow');
const userData=path.join(os.tmpdir(),'context-miro-shot-app-'+crypto.randomUUID());
app.setPath('userData',userData);app.setName('Context Miro · Screenshot App Check');
app.on('window-all-closed',()=>{});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

app.whenReady().then(async()=>{
  const load=file=>import(pathToFileURL(path.resolve(__dirname,file)).href);
  const [{createMiroVisitorReader,miroOffscreenViews},{createMiroShareLinks},{createDesktopPlatform},{createRequestHandler},{KIError}]=await Promise.all(['../desktop/miro-visitor.mjs','../desktop/miro-links.mjs','../desktop/platform.mjs','../server.mjs','../connectors/ki.mjs'].map(load));
  const miroLinks=createMiroShareLinks({directory:path.join(userData,'miro'),crypto:safeStorage});await miroLinks.initialize();
  const platform=createDesktopPlatform({nango:{status:async()=>({connected:false}),proxy:async()=>{throw new Error('no account');}},createView:()=>{throw new Error('unused');},openVisible:async()=>{},
    miroVisitor:createMiroVisitorReader({getShareLink:id=>miroLinks.get(id),...miroOffscreenViews(BrowserWindow)}),miroLinks});
  const reply=async work=>{try{return {ok:true,value:await work()};}catch(error){return {ok:false,error:error.message,code:error.code};}};
  ipcMain.handle('test:service',(_e,message)=>reply(()=>platform.service(message)));
  ipcMain.handle('test:miro',(_e,message)=>reply(()=>platform.miro(message)));

  // Scripted model: read the open board, show the area, answer with a citation.
  const seen=[];let turn=0;
  const idOf=text=>[...String(text).matchAll(/"id":"(miro:[a-f0-9]{64}:part\d+)"/g)].map(match=>match[1]);
  const ki={status:async()=>({configured:true,storage:'session',provider:'KI:connect NRW'}),models:async()=>({models:[{id:'scripted-model'}],storage:'session',provider:'KI:connect NRW'}),configure:async()=>({models:[{id:'scripted-model'}],storage:'session',provider:'KI:connect NRW'}),usage:async()=>{throw new KIError(501,'unsupported','Kein Limit abrufbar.');},forget:async()=>({configured:false}),
    complete:async input=>{
      seen.push(JSON.stringify(input.messages));const last=input.messages.at(-1).content;let content;
      if(turn===0)content={type:'tool',tool:'read_current_board',args:{}};
      else if(turn===1){const [first]=idOf(last);content={type:'tool',tool:'show_board_area',args:{id:first}};ki.lastId=first;}
      else content={type:'answer',text:'Auf dem Board steht unter **Workshop Table** der Ablauf der Aufgabe: erst Warm-up, dann die Gruppenarbeit. Die **Aufgabe** ist bis Ende des Workshops zu erledigen.',citations:[ki.lastId]};
      turn++;return {content:JSON.stringify(content),model:input.model,totalTokens:12};}};
  const server=http.createServer(createRequestHandler(()=>server.address().port,async()=>({items:[],sources:[]}),ki));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port+'/';

  const win=new BrowserWindow({show:false,width:narrow?420:1180,height:960,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.join(__dirname,'miro-shot-preload.cjs')}});
  win.webContents.setFrameRate(15);
  const js=code=>win.webContents.executeJavaScript(code);
  const shot=async name=>{await sleep(500);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());};
  const waitFor=async(expr,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await js(expr))return;await sleep(200);}throw new Error('Timeout: '+label);};
  const report={electron:process.versions.electron,board:BOARD,checks:[]};let failed=false;const check=(ok,label)=>{report.checks.push({ok:!!ok,label});if(!ok)failed=true;};
  try{
    // A course exists in the workspace; the person has the board open in the browser tab.
    await win.loadURL(url);
    await js(`(async()=>{const {initialState,STORAGE_KEY}=await import('/core.js');const s=initialState();s.projects=[{id:'course-ui',name:'Interaction Design',subtitle:'WS 2026/27',color:'violet',archived:false,links:[],note:''}];s.activeCourse='course-ui';localStorage.setItem(STORAGE_KEY,JSON.stringify(s));})()`);
    await win.loadURL(url+'?seeded#ai');
    report.projects=await js(`JSON.parse(localStorage.getItem('coco-context-v1')).projects.map(p=>p.id)`);
    if(dark)await js(`document.documentElement.dataset.theme='dark'`);
    const board=JSON.stringify({visible:true,current:true,readable:false,miroBoard:{url:BOARD,title:'Public: Practical Leadership'}});
    await waitFor(`!!document.querySelector('#ki-prompt')`,'prompt box');await waitFor(`!document.querySelector('.ki-setup')`,'connected');
    await js(`window.dispatchEvent(new CustomEvent('context-browser-page',{detail:${board}}))`);
    // The person picks the course in the top bar, as the assistant asks for it.
    await js(`(()=>{const select=document.querySelector('#course-switch');select.value='course-ui';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);await sleep(800);
    report.scope=await js(`({value:document.querySelector('#course-switch')?.value,options:[...document.querySelectorAll('#course-switch option')].map(o=>o.value),saved:JSON.parse(localStorage.getItem('coco-context-v1')).activeCourse,header:document.querySelector('.ki-chat-title,.ki-header')?.textContent.slice(0,80)})`);
    for(let attempt=0;attempt<12&&!await js(`!!document.querySelector('.ki-message.user')`);attempt++){
      await js(`(()=>{const p=document.querySelector('#ki-prompt');p.value='Welche Aufgabe steht auf diesem Board?';p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#ki-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()`);
      await sleep(700);
    }
    await waitFor(`!!document.querySelector('.ki-shot img')||!!document.querySelector('.ki-shot-note')`,'screenshot or note under the answer',150000);
    const view=await js(`(()=>{const f=document.querySelector('.ki-shot'),img=f?.querySelector('img'),m=f?.closest('.ki-message');return {has:!!f,loaded:!!img&&img.complete&&img.naturalWidth>0,src:img?.src.slice(0,30),size:img?[img.naturalWidth,img.naturalHeight]:null,alt:img?.alt,caption:f?.querySelector('figcaption')?.textContent.trim(),notes:[...document.querySelectorAll('.ki-shot-note')].map(n=>n.textContent),steps:[...m.querySelectorAll('.ki-steps li strong')].map(s=>s.textContent),answer:m.querySelector('.markdown-content')?.textContent.slice(0,160),w:f?.getBoundingClientRect().width};})()`);
    report.view=view;
    check(view.has&&view.loaded&&/^data:image\/jpeg;base64/.test(view.src),'a real JPEG is shown under the answer');
    check(!view.notes.length,'no failure note: '+JSON.stringify(view.notes));
    check(/Momentaufnahme vom/.test(view.caption||'')&&/Im Board öffnen/.test(view.caption||''),'caption names the time and offers the board link');
    check(/Screenshot des Miro-Bereichs/.test(view.alt||''),'the image has an alt text');
    check(view.steps.includes('Offenes Miro-Board lesen')&&view.steps.includes('Board-Ausschnitt fotografieren'),'steps list the board read and the capture: '+view.steps.join(' | '));
    check(!seen.some(text=>text.includes('/9j/')),'no image bytes were sent to the model');
    await shot('01-answer-with-shot');
    // Enlarge and shrink again.
    await js(`document.querySelector('.ki-shot-image').click()`);await sleep(300);
    check(await js(`document.querySelector('.ki-shot').classList.contains('open')&&document.querySelector('.ki-shot-image').getAttribute('aria-expanded')==='true'`),'a click enlarges the picture');
    await js(`document.querySelector('.ki-thread').scrollTop=0`);await shot('02-enlarged');
    await js(`document.querySelector('.ki-shot-image').click()`);await sleep(200);
    check(await js(`!document.querySelector('.ki-shot').classList.contains('open')`),'a second click shrinks it');
    check(await js(`document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`),'no horizontal page scroll');
    // The encrypted chat archive keeps the picture across a reload.
    await sleep(1500);await win.loadURL(url+'?reloaded#ai');await waitFor(`!!document.querySelector('#ki-prompt')`,'prompt box after reload');
    await js(`window.dispatchEvent(new CustomEvent('context-browser-page',{detail:${board}}))`);
    await waitFor(`!!document.querySelector('.ki-shot')`,'picture restored from the archive',20000);
    check(await js(`(()=>{const img=document.querySelector('.ki-shot img');return !!img&&img.complete&&img.naturalWidth>0;})()`),'the picture is restored from the encrypted archive after a reload');
    await shot('03-restored');
  }catch(error){failed=true;report.error=String(error.message||error);try{report.thread=await js(`[...document.querySelectorAll('.ki-message')].map(m=>m.innerText).join('\\n---\\n')`);report.stepText=await js(`[...document.querySelectorAll('.ki-steps li')].map(li=>li.textContent)`);report.seen=seen.map(t=>t.slice(-700));await shot('99-error');}catch{}}
  report.turns=turn;console.log(JSON.stringify(report,null,2));
  server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));platform.dispose();app.exit(failed?1:0);
}).catch(error=>{console.error(error);app.exit(1);});
