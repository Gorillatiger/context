/* Optional check of the GitLab/Mattermost token entry in the real app UI (Electron, offscreen, temporary profile).
 * Run npm run test:services:electron [--out dir] [--narrow] [--dark]. Real dist/ code against the real local
 * server; only the provider answers are simulated (a token ending in "valid" is accepted).
 */
const {app,BrowserWindow}=require('electron');
const path=require('node:path'),os=require('node:os'),fs=require('node:fs'),crypto=require('node:crypto'),http=require('node:http');
const {pathToFileURL}=require('node:url');
const outIndex=process.argv.indexOf('--out'),OUT=outIndex>=0?process.argv[outIndex+1]:os.tmpdir();
const narrow=process.argv.includes('--narrow'),dark=process.argv.includes('--dark');
const snapshot=fs.mkdtempSync(path.join(os.tmpdir(),'context-services-'));
process.env.CONTEXT_SNAPSHOT_PATH=path.join(snapshot,'notifications.json');
for(const key of ['GITLAB_TOKEN','MATTERMOST_TOKEN','TH_MAIL_USER','TH_MAIL_PASSWORD'])process.env[key]='';
app.setPath('userData',path.join(os.tmpdir(),'context-services-ui-'+crypto.randomUUID()));app.setName('Context Services Check');
app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.on('window-all-closed',()=>{});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const VALID='glpat-this-token-is-valid',INVALID='glpat-this-token-is-wrong';

app.whenReady().then(async()=>{
  const load=file=>import(pathToFileURL(path.resolve(__dirname,file)).href);
  const {createRequestHandler}=await load('../server.mjs');const {createServiceTokens}=await load('../connectors/service-tokens.mjs');
  // The providers: GitLab accepts one token; Mattermost is not reachable in this check.
  const requests=[];
  const answer=(status,value)=>({ok:status<300,status,headers:{get:()=>'application/json'},body:new Response(JSON.stringify(value)).body});
  const providers=async(url,options)=>{
    const target=String(url);requests.push(target.split('?')[0]);
    if(target.startsWith('https://git.coco.study'))return options.headers['PRIVATE-TOKEN']===VALID?answer(200,target.includes('/user')?{id:7}:[]):answer(401,{});
    throw new TypeError('offline');
  };
  globalThis.fetch=new Proxy(globalThis.fetch,{apply:(target,self,args)=>/^https:\/\/(?:git|chat)\.coco\.study/.test(String(args[0]))?providers(...args):Reflect.apply(target,self,args)});
  let stored='';const store={load:async()=>stored,save:async key=>{stored=key;return true;},clear:async()=>{stored='';}};
  const services=createServiceTokens({stores:{gitlab:store},env:{},fetcher:providers});
  const server=http.createServer(createRequestHandler(()=>server.address().port,undefined,undefined,undefined,undefined,{services}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const win=new BrowserWindow({show:false,width:narrow?420:1180,height:900,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  win.webContents.setFrameRate(15);
  const js=code=>win.webContents.executeJavaScript(code);
  const shot=async name=>{await sleep(400);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());};
  const waitFor=async(expr,label,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await js(expr))return;await sleep(150);}throw new Error('Timeout: '+label);};
  const report={electron:process.versions.electron,checks:[]};let failed=false;const check=(ok,label)=>{report.checks.push({ok:!!ok,label});if(!ok)failed=true;};
  const submit=async token=>{await js(`(()=>{const f=document.querySelector('#service-token-form');f.querySelector('input[name=token]').value=${JSON.stringify(token)};f.requestSubmit();})()`);};
  try{
    await win.loadURL('http://127.0.0.1:'+server.address().port+'/#inbox');
    if(dark)await js(`document.documentElement.dataset.theme='dark'`);
    await waitFor(`!!document.querySelector('[data-action="connection-help"][data-id="gitlab"]')`,'GitLab row in Quellen & Status');
    await js(`document.querySelector('[data-action="connection-help"][data-id="gitlab"]').click()`);
    await waitFor(`!!document.querySelector('#service-token-form')`,'token form');
    const form=await js(`(()=>{const f=document.querySelector('#service-token-form'),i=f.querySelector('input[name=token]');return {type:i.type,autocomplete:i.autocomplete,state:document.querySelector('.service-connect-state')?.textContent,steps:document.querySelector('.service-connect-box')?.textContent.includes('read_api'),w:f.getBoundingClientRect().width};})()`);
    check(form.type==='password'&&form.autocomplete==='off'&&form.w>0,'a masked token field is shown');
    check(/Noch nicht verbunden/.test(form.state)&&form.steps,'the state and the way to get a token are explained');
    await shot('01-form');
    await submit(INVALID);await waitFor(`!!document.querySelector('.service-connect-box .error-message')`,'rejection message');
    const rejected=await js(`({text:document.querySelector('.service-connect-box .error-message').textContent,field:document.querySelector('input[name=token]').value,state:document.querySelector('.service-connect-state').textContent})`);
    check(/abgelehnt/.test(rejected.text)&&rejected.field===''&&/Noch nicht verbunden/.test(rejected.state),'a wrong token is refused, explained and the field is cleared');
    await shot('02-rejected');
    await submit(VALID);await waitFor(`/Verbunden\\. Der Token liegt/.test(document.querySelector('.service-connect-state')?.textContent||'')`,'connected state');
    check(stored===VALID,'the token reached the encrypted store');
    check(await js(`document.querySelector('input[name=token]').value===''&&!!document.querySelector('[data-action="service-forget"]')`),'the field is empty again and a remove button appears');
    const leaks=await js(`(()=>{const all=document.documentElement.outerHTML+JSON.stringify(Object.entries(localStorage))+location.href;return all.includes(${JSON.stringify(VALID)})||all.includes(${JSON.stringify(INVALID)});})()`);
    check(!leaks,'no token appears in the page, its storage or its address');
    await shot('03-connected');
    await js(`document.querySelector('[data-action="close"]').click()`);
    await waitFor(`/Verbunden · nur lesen/.test(document.querySelector('[data-action="connection-help"][data-id="gitlab"]')?.textContent||'')`,'the Mitteilungen show GitLab as connected after the refresh',20000);
    check(requests.some(url=>url.includes('/api/v4/todos')),'the feed read GitLab with the new token');
    await js(`document.querySelector('[data-action="connection-help"][data-id="gitlab"]').click()`);
    await waitFor(`!!document.querySelector('[data-action="service-forget"]')`,'remove button');
    await js(`document.querySelector('[data-action="service-forget"]').click()`);
    await waitFor(`/Noch nicht verbunden/.test(document.querySelector('.service-connect-state')?.textContent||'')`,'disconnected state');
    check(stored==='','the stored token was removed');
    // Mattermost shares the form; its provider is unreachable here.
    await js(`document.querySelector('[data-action="close"]').click()`);await sleep(300);
    await js(`document.querySelector('[data-action="connection-help"][data-id="mattermost"]').click()`);
    await waitFor(`!!document.querySelector('#service-token-form')`,'Mattermost form');
    await submit('abcdefghijklmnopqrstuvwxyz');await waitFor(`!!document.querySelector('.service-connect-box .error-message')`,'unreachable message');
    check(await js(`/nicht erreichbar/.test(document.querySelector('.service-connect-box .error-message').textContent)`),'an unreachable provider is reported and nothing is stored');
    // The overview and TH-Mail offer no token form.
    await js(`document.querySelector('[data-action="close"]').click()`);await sleep(300);
    await js(`document.querySelector('[data-action="connection-help"][data-id="webmail"]').click()`);await sleep(500);
    check(await js(`!document.querySelector('#service-token-form')`),'TH-Mail has no token form (it is set up in the mail area)');
    check(await js(`document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`),'no horizontal page scroll');
  }catch(error){failed=true;report.error=String(error.message||error);report.requests=requests;try{report.row=await js(`document.querySelector('[data-action="connection-help"][data-id="gitlab"]')?.textContent`);report.feed=await js(`fetch('/api/notifications').then(r=>r.json()).then(v=>JSON.stringify(v.sources))`);await shot('99-error');}catch{}}
  console.log(JSON.stringify(report,null,2));
  server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));fs.rmSync(snapshot,{recursive:true,force:true});app.exit(failed?1:0);
}).catch(error=>{console.error(error);app.exit(1);});
