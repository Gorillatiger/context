/* Optional check of the real assistant UI in Chromium (Electron, offscreen, temporary profile).
 * Run npm run test:ki:clarify. The real dist/ code and CSS run against the real local server;
 * only the language model is scripted: first an ask_user question, then an answer.
 * Screenshots go to --out <dir> (default: the OS temp directory).
 */
const {app,BrowserWindow}=require('electron');
const path=require('node:path'),os=require('node:os'),fs=require('node:fs'),crypto=require('node:crypto'),http=require('node:http');
const {pathToFileURL}=require('node:url');
const outIndex=process.argv.indexOf('--out'),OUT=outIndex>=0?process.argv[outIndex+1]:os.tmpdir();
const dark=process.argv.includes('--dark'),narrow=process.argv.includes('--narrow');
app.setPath('userData',path.join(os.tmpdir(),'context-ki-clarify-'+crypto.randomUUID()));app.setName('Context KI Clarify Check');
app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.on('window-all-closed',()=>{});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

app.whenReady().then(async()=>{
  const load=file=>import(pathToFileURL(path.resolve(__dirname,file)).href);
  const {createRequestHandler}=await load('../server.mjs');const {KIError}=await load('../connectors/ki.mjs');
  const asked=[],script=[
    {type:'tool',tool:'ask_user',args:{question:'Für welches Semester soll ich die Abgaberegeln heraussuchen?',options:['WS 2026/27 (aktuell)','SS 2026','Ältere Semester einbeziehen'],multiple:true}},
    {type:'answer',text:'Für **WS 2026/27** gilt: Abgabe im Portal bis 20.11.2026. Die Regeln aus dem SS 2020 (Abgabe per Mail) sind **veraltet** und gelten nicht mehr.',citations:[]},
  ];
  const ki={status:async()=>({configured:true,storage:'session',provider:'KI:connect NRW'}),models:async()=>({models:[{id:'scripted-model'}],storage:'session',provider:'KI:connect NRW'}),configure:async()=>({models:[{id:'scripted-model'}],storage:'session',provider:'KI:connect NRW'}),usage:async()=>{throw new KIError(501,'unsupported','Kein Limit abrufbar.');},forget:async()=>({configured:false}),
    complete:async input=>{asked.push(input.messages.at(-1).content.split('AKTUELLER NUTZERAUFTRAG:\n').pop().slice(0,200));return {content:JSON.stringify(script.shift()),model:input.model,totalTokens:12};}};
  const server=http.createServer(createRequestHandler(()=>server.address().port,async()=>({items:[],sources:[]}),ki));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const win=new BrowserWindow({show:false,width:narrow?420:1180,height:narrow?900:900,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  win.webContents.setFrameRate(15);
  const js=code=>win.webContents.executeJavaScript(code);
  const shot=async name=>{await sleep(400);const image=await win.webContents.capturePage();fs.writeFileSync(path.join(OUT,name+'.png'),image.toPNG());};
  const waitFor=async(expr,label,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await js(expr))return;await sleep(150);}throw new Error('Timeout: '+label);};
  const report={electron:process.versions.electron,checks:[]};let failed=false;const check=(ok,label)=>{report.checks.push({ok:!!ok,label});if(!ok)failed=true;};
  try{
    await win.loadURL('http://127.0.0.1:'+server.address().port+'/#ai');
    if(dark)await js(`document.documentElement.dataset.theme='dark'`);
    await waitFor(`!!document.querySelector('#ki-prompt')`,'prompt box');await waitFor(`!document.querySelector('.ki-setup')`,'connected');
    // Sending is a silent no-op until the chat archive is ready; retry like a person pressing Enter again.
    for(let attempt=0;attempt<12&&!await js(`!!document.querySelector('.ki-message.user')`);attempt++){
      await js(`(()=>{const p=document.querySelector('#ki-prompt');p.value='Welche Abgaberegeln gelten?';p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#ki-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()`);
      await sleep(700);
    }
    await waitFor(`!!document.querySelector('[data-ki-clarify]')`,'question with choices');
    const form=await js(`(()=>{const f=document.querySelector('[data-ki-clarify]'),r=f.getBoundingClientRect(),inputs=[...f.querySelectorAll('input[name=choice]')];return {types:inputs.map(i=>i.type),labels:[...f.querySelectorAll('.ki-clarify-option')].map(l=>l.textContent.trim()),legend:f.querySelector('legend').textContent,width:r.width,visible:r.width>0&&r.height>0,disabled:f.querySelector('fieldset').disabled,text:f.closest('.ki-message').textContent.slice(0,300)};})()`);
    check(form.visible&&form.types.length===3&&form.types.every(type=>type==='checkbox'),'three checkboxes are rendered and visible');
    check(/Empfehlung/.test(form.labels[0])&&/Mehrfachauswahl/.test(form.legend),'first option is marked as recommendation, multiple choice is announced');
    check(/Für welches Semester/.test(form.text)&&!form.disabled,'the question is shown and the form is usable');
    await shot('01-question');
    // Empty submit: stays open and explains.
    await js(`document.querySelector('[data-ki-clarify]').querySelector('button[type=submit]').click()`);await sleep(300);
    check(await js(`document.querySelector('.ki-clarify-error')?.textContent.includes('mindestens eine Option')`),'empty submit explains what is missing');
    check(asked.length===1,'empty submit did not call the model');
    // Choose like a person: click the label of the first and the third option, type another remark.
    await js(`(()=>{const f=document.querySelector('[data-ki-clarify]'),l=f.querySelectorAll('.ki-clarify-option');l[0].click();l[2].click();const o=f.querySelector('input[name=other]');o.value='nur Abgabefristen';})()`);
    await sleep(200);await shot('02-selected');
    check(await js(`document.querySelectorAll('[data-ki-clarify] input[name=choice]:checked').length===2`),'clicking the option text toggles its checkbox');
    check(await js(`!document.querySelector('.ki-clarify-error')?.textContent`),'the hint disappears once the person changes the choice');
    check(await js(`(()=>{const o=[...document.querySelectorAll('.ki-clarify-option')].map(l=>l.getBoundingClientRect());return o.slice(1).every((r,i)=>r.top-o[i].bottom<=12);})()`),'option rows sit close together');
    await js(`document.querySelector('[data-ki-clarify] button[type=submit]').click()`);
    await waitFor(`document.querySelectorAll('.ki-message.assistant').length>=2&&!document.querySelector('.ki-clarify:not(.answered)')`,'answer after the choice',20000);
    check(asked.length===2&&/^Meine Auswahl zu deiner Rückfrage: WS/.test(asked[1])&&/WS 2026\/27 \(aktuell\); Ältere Semester einbeziehen; Anderes: nur Abgabefristen/.test(asked[1]),'the choice reaches the model as one normal message');
    const final=await js(`({answered:document.querySelector('.ki-clarify.answered')?.textContent.trim(),last:[...document.querySelectorAll('.ki-message.assistant')].at(-1).textContent,form:document.querySelectorAll('[data-ki-clarify]').length})`);
    check(/Deine Auswahl: WS 2026\/27 \(aktuell\); Ältere Semester einbeziehen; Anderes: nur Abgabefristen/.test(final.answered||''),'the answered question shows the choice and no form');
    check(/veraltet/.test(final.last)&&final.form===0,'the answer classifies the old rules as outdated');
    await js(`document.querySelector('.ki-thread').scrollTo(0,0)`);await shot('03-answer');
    // The page itself must not scroll sideways (narrow layouts).
    check(await js(`document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`),'no horizontal page scroll');
  }catch(error){failed=true;report.error=String(error.message||error);try{await shot('99-error');}catch{}}
  report.asked=asked;report.screenshots=fs.readdirSync(OUT).filter(name=>/^\d\d-.*\.png$/.test(name));
  console.log(JSON.stringify(report,null,2));
  server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));app.exit(failed?1:0);
}).catch(error=>{console.error(error);app.exit(1);});
