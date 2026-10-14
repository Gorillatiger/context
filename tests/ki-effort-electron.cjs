/* Optional check of effort weighing in the real assistant UI (Electron, offscreen, temporary profile).
 * Run npm run test:ki:effort [--out dir]. Hochschul-KI is scripted on the local server, OpenRouter by a
 * test preload. Checks: a large task asks before any model call; narrow / switch / change the task;
 * an assistant question offering OpenRouter switches and continues the same question there.
 */
const {app,BrowserWindow}=require('electron');
const path=require('node:path'),os=require('node:os'),fs=require('node:fs'),crypto=require('node:crypto'),http=require('node:http');
const {pathToFileURL}=require('node:url');
const outIndex=process.argv.indexOf('--out'),OUT=outIndex>=0?process.argv[outIndex+1]:os.tmpdir();
app.setPath('userData',path.join(os.tmpdir(),'context-ki-effort-'+crypto.randomUUID()));app.setName('Context KI Effort Check');
app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.on('window-all-closed',()=>{});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const BIG='Fasse alle Abgaben aus allen Kursen zusammen.',SMALL='Was steht in Prototyping als Nächstes an?';

app.whenReady().then(async()=>{
  const load=file=>import(pathToFileURL(path.resolve(__dirname,file)).href);
  const {createRequestHandler}=await load('../server.mjs');const {KIError}=await load('../connectors/ki.mjs');
  const asked=[];
  const ki={status:async()=>({configured:true,storage:'session',provider:'KI:connect NRW'}),models:async()=>({models:[{id:'scripted-model'}],storage:'session',provider:'KI:connect NRW'}),configure:async()=>({models:[{id:'scripted-model'}],storage:'session',provider:'KI:connect NRW'}),usage:async()=>{throw new KIError(501,'unsupported','Kein Limit abrufbar.');},forget:async()=>({configured:false}),
    complete:async input=>{const task=input.messages.at(-1).content.split('AKTUELLER NUTZERAUFTRAG:\n').pop();asked.push({task,system:input.messages[0].content.split('\nKONTEXT (Daten):\n')[0]});
      const reply=task.startsWith(SMALL)?{type:'tool',tool:'ask_user',args:{question:'Das sind viele Quellen. Wie soll ich weitermachen?',options:['Auf Prototyping eingrenzen','Zu OpenRouter wechseln']}}:{type:'answer',text:'Hochschul-KI-Antwort',citations:[]};
      return {content:JSON.stringify(reply),model:input.model,totalTokens:12};}};
  const server=http.createServer(createRequestHandler(()=>server.address().port,async()=>({items:[],sources:[]}),ki));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const win=new BrowserWindow({show:false,width:1180,height:900,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.join(__dirname,'ki-switch-preload.cjs')}});
  win.webContents.setFrameRate(15);
  const js=code=>win.webContents.executeJavaScript(code);
  const shot=async name=>{await sleep(400);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());};
  const waitFor=async(expr,label,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await js(expr))return;await sleep(150);}throw new Error('Timeout: '+label);};
  const report={electron:process.versions.electron,checks:[]};let failed=false;const check=(ok,label)=>{report.checks.push({ok:!!ok,label});if(!ok)failed=true;};
  const type=async text=>js(`(()=>{const p=document.querySelector('#ki-prompt');p.value=${JSON.stringify(text)};p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#ki-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()`);
  const ask=async(text,until,label)=>{for(let attempt=0;attempt<12&&!await js(until);attempt++){await type(text);await sleep(700);}await waitFor(until,label);};
  const provider=()=>js(`document.querySelector('#ki-provider')?.value`);
  const newChat=()=>js(`document.querySelector('[data-ki-action="new"]')?.click()`);
  try{
    await win.loadURL('http://127.0.0.1:'+server.address().port+'/#ai');
    await waitFor(`!!document.querySelector('#ki-prompt')`,'prompt box');await waitFor(`!document.querySelector('.ki-setup')`,'connected');
    // 1. A large task: the card appears, nothing went to the model.
    await ask(BIG,`!!document.querySelector('[data-ki-effort]')`,'effort card');
    const card=await js(`(()=>{const f=document.querySelector('[data-ki-effort]');return {legend:f.querySelector('legend').textContent,options:[...f.querySelectorAll('.ki-clarify-option')].map(l=>l.textContent.trim()),checked:f.querySelector('input:checked')?.value,types:[...f.querySelectorAll('input')].map(i=>i.type)};})()`);
    report.card=card;
    check(asked.length===0&&await js(`!document.querySelector('.ki-message')`),'nothing was sent before the choice');
    check(/größere Aufgabe/.test(card.legend)&&/Kurse/.test(card.legend),'the card says why it is large');
    check(card.options.length===3&&/OpenRouter/.test(card.options[0])&&/Empfehlung/.test(card.options[0])&&card.checked==='switch','three choices, the switch is recommended for all courses');
    await shot('01-effort-card');
    // 2. Change the task instead: card gone, draft kept.
    await js(`document.querySelector('[data-ki-action="effort-cancel"]').click()`);await sleep(300);
    check(await js(`!document.querySelector('[data-ki-effort]')&&document.querySelector('#ki-prompt').value===${JSON.stringify(BIG)}`),'“Auftrag noch ändern” closes the card and keeps the text');
    // 3. Narrow: one university call with the narrowing note.
    await ask(BIG,`!!document.querySelector('[data-ki-effort]')`,'effort card again');
    await js(`(()=>{const f=document.querySelector('[data-ki-effort]');f.querySelector('input[value=narrow]').click();f.requestSubmit();})()`);
    await waitFor(`[...document.querySelectorAll('.ki-message.assistant')].some(m=>m.textContent.includes('Hochschul-KI-Antwort'))`,'narrowed answer');
    check(asked.length===1&&asked[0].task.startsWith(BIG)&&/eingegrenzt arbeiten/.test(asked[0].task),'narrowing sends the task once, with the narrowing note');
    check(/Knappes Modell \(Hochschul-KI/.test(asked[0].system),'the university model is told to weigh and offer the switch');
    // 4. Switch: OpenRouter answers the same question without retyping.
    await newChat();await sleep(400);
    await ask(BIG,`!!document.querySelector('[data-ki-effort]')`,'effort card in a new chat');
    await js(`document.querySelector('[data-ki-effort]').requestSubmit()`);
    await waitFor(`[...document.querySelectorAll('.ki-message.assistant')].some(m=>m.textContent.includes('OpenRouter-Antwort auf: '+${JSON.stringify(BIG)}))`,'OpenRouter answer after the switch',20000);
    check(await provider()==='openrouter'&&asked.length===1,'switched to OpenRouter and sent there, not to the university model');
    await shot('02-after-switch');
    // 5. The assistant asks during the work and offers OpenRouter: choosing it switches and continues.
    await js(`(()=>{const s=document.querySelector('#ki-provider');s.value='kiconnect';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('#ki-provider')?.value==='kiconnect'&&!!document.querySelector('#ki-prompt')`,'back on the university model');await sleep(500);
    await ask(SMALL,`!!document.querySelector('[data-ki-clarify]')`,'assistant question with options');
    check(await js(`!document.querySelector('[data-ki-effort]')`),'a small task is not interrupted');
    await shot('03-assistant-question');
    await js(`(()=>{const f=document.querySelector('[data-ki-clarify]'),l=[...f.querySelectorAll('.ki-clarify-option')].find(x=>x.textContent.includes('OpenRouter'));l.click();f.requestSubmit();})()`);
    await waitFor(`[...document.querySelectorAll('.ki-message.assistant')].some(m=>m.textContent.includes('OpenRouter-Antwort auf: '+${JSON.stringify(SMALL)}))`,'OpenRouter continues the original question',20000);
    check(await provider()==='openrouter','choosing “Zu OpenRouter wechseln” switched the provider');
    check(asked.filter(row=>row.task.startsWith(SMALL)).length===1,'the university model was asked once, the choice itself went to OpenRouter as the original question');
    await shot('04-continued-on-openrouter');
    check(await js(`document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`),'no horizontal page scroll');
  }catch(error){failed=true;report.error=String(error.message||error);report.asked=asked.map(row=>row.task.slice(0,120));try{report.thread=await js(`[...document.querySelectorAll('.ki-message')].map(m=>m.innerText.slice(0,200)).join(' | ')`);await shot('99-error');}catch{}}
  console.log(JSON.stringify(report,null,2));
  server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));app.exit(failed?1:0);
}).catch(error=>{console.error(error);app.exit(1);});
