/* Optional check of the provider switch box in the real assistant UI (Electron, offscreen, temporary profile).
 * Run npm run test:ki:switch. The university service "fails" with an overload code; the box must appear
 * under the failed message, switch only on a click, keep the question as draft and never switch alone.
 */
const {app,BrowserWindow}=require('electron');
const path=require('node:path'),os=require('node:os'),fs=require('node:fs'),crypto=require('node:crypto'),http=require('node:http');
const {pathToFileURL}=require('node:url');
const outIndex=process.argv.indexOf('--out'),OUT=outIndex>=0?process.argv[outIndex+1]:os.tmpdir();
app.setPath('userData',path.join(os.tmpdir(),'context-ki-switch-'+crypto.randomUUID()));app.setName('Context KI Switch Check');
app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.on('window-all-closed',()=>{});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

app.whenReady().then(async()=>{
  const load=file=>import(pathToFileURL(path.resolve(__dirname,file)).href);
  const {createRequestHandler}=await load('../server.mjs');const {KIError}=await load('../connectors/ki.mjs');
  let calls=0;
  const ki={status:async()=>({configured:true,storage:'session',provider:'KI:connect NRW'}),models:async()=>({models:[{id:'scripted-model'}],storage:'session',provider:'KI:connect NRW'}),configure:async()=>({models:[{id:'scripted-model'}],storage:'session',provider:'KI:connect NRW'}),usage:async()=>{throw new KIError(501,'unsupported','Kein Limit abrufbar.');},forget:async()=>({configured:false}),
    complete:async()=>{calls++;throw new KIError(413,'body_limit','Die Anfrage ist zu groß. Bitte weniger Quellen verwenden.');}};
  const server=http.createServer(createRequestHandler(()=>server.address().port,async()=>({items:[],sources:[]}),ki));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const win=new BrowserWindow({show:false,width:1180,height:900,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.join(__dirname,'ki-switch-preload.cjs')}});
  win.webContents.setFrameRate(15);
  const js=code=>win.webContents.executeJavaScript(code);
  const shot=async name=>{await sleep(400);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());};
  const waitFor=async(expr,label,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await js(expr))return;await sleep(150);}throw new Error('Timeout: '+label);};
  const report={electron:process.versions.electron,checks:[]};let failed=false;const check=(ok,label)=>{report.checks.push({ok:!!ok,label});if(!ok)failed=true;};
  try{
    await win.loadURL('http://127.0.0.1:'+server.address().port+'/#ai');
    await waitFor(`!!document.querySelector('#ki-prompt')`,'prompt box');await waitFor(`!document.querySelector('.ki-setup')`,'connected');
    for(let attempt=0;attempt<12&&!await js(`!!document.querySelector('.ki-message.user')`);attempt++){
      await js(`(()=>{const p=document.querySelector('#ki-prompt');p.value='Fasse alle Quellen des Kurses zusammen.';p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#ki-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()`);
      await sleep(700);
    }
    await waitFor(`!!document.querySelector('.ki-switch-hint')`,'switch box under the failed message');
    const box=await js(`(()=>{const h=document.querySelector('.ki-switch-hint'),m=h.closest('.ki-message');return {inFailed:m.textContent.includes('AUFTRAG ANGEHALTEN')||m.querySelector('.markdown-content')?.textContent.includes('zu groß'),buttons:[...h.querySelectorAll('button')].map(b=>b.textContent.trim()),provider:document.querySelector('#ki-provider')?.value,w:h.getBoundingClientRect().width};})()`);
    report.box=box;
    check(box.inFailed&&box.w>0,'the box sits under the failed answer');
    check(JSON.stringify(box.buttons)===JSON.stringify(['Zu OpenRouter wechseln','Zu Lokales Modell wechseln']),'both providers are offered');
    check(box.provider==='kiconnect'&&calls===1,'nothing switched or was retried by itself');
    await shot('01-switch-box');
    await js(`document.querySelector('[data-provider=openrouter]').click()`);
    await waitFor(`document.querySelector('#ki-provider')?.value==='openrouter'`,'provider switched after the click');
    const after=await js(`({draft:document.querySelector('#ki-prompt')?.value||'',hint:!!document.querySelector('.ki-switch-hint'),messages:document.querySelectorAll('.ki-message').length})`);
    check(after.draft==='Fasse alle Quellen des Kurses zusammen.','the question is waiting as draft');
    check(!after.hint&&after.messages===0&&calls===1,'a fresh chat started and nothing was sent');
    await shot('02-after-switch');
    check(await js(`document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`),'no horizontal page scroll');
  }catch(error){failed=true;report.error=String(error.message||error);try{await shot('99-error');}catch{}}
  console.log(JSON.stringify(report,null,2));
  server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));app.exit(failed?1:0);
}).catch(error=>{console.error(error);app.exit(1);});
