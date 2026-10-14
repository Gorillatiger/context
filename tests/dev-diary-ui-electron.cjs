/* Isolated Chromium QA. Synthetic diary and speech transport; no account writes.
 * node_modules/.bin/electron tests/dev-diary-ui-electron.cjs --out /tmp/diary-qa
 */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const OUT=process.argv.includes('--out')?process.argv[process.argv.indexOf('--out')+1]:path.join(os.tmpdir(),'context-diary-qa');fs.mkdirSync(OUT,{recursive:true});
app.setPath('userData',path.join(os.tmpdir(),'context-diary-ui-'+crypto.randomUUID()));app.setName('Context Diary QA');
app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');app.on('window-all-closed',()=>{});
const fixture=`import {createDevDiaryView} from '/dev-diaries.js';
import {createDevDiary,updateDailyEntry,validateDevDiary} from '/dev-diary-engine.js';
import {createSpeechInput} from '/speech.js';
let speechEvent,sequence=0;window.speechCalls=[];window.writes=[];
let diary=createDevDiary({projectId:'course',startDate:'2026-10-13',days:14},{projects:[{id:'course',name:'Prototyping Things',links:[{tool:'spaces',url:'https://spaces.th-koeln.de/prototyping-things-w26/'}]}]},{id:'qa-diary',now:'2026-10-13T10:00:00Z'});
diary=updateDailyEntry(diary,'2026-10-13',{done:'Heute haben wir einen ersten Prototyp gebaut und die Halterung getestet.',learned:'Eine breite Auflage verhindert, dass die Schüssel beim Reinigen verrutscht.',next:'Morgen testen wir die Konstruktion mit anderen Materialien.'});
window.state={projects:[{id:'course',name:'Prototyping Things',links:[{tool:'spaces',url:diary.courseUrl}]}],devDiaries:[diary]};
const bridge={onEvent:fn=>{speechEvent=fn;return ()=>{speechEvent=null;}},speech:async m=>{speechCalls.push(m.type);return {ok:true,value:m.type==='status'?{available:true,state:'ready',model:'small',models:[{id:'small',available:true,totalBytes:487601967}]}:{}};},devDiary:async m=>{writes.push(m);return {ok:true,value:{reviewToken:'test-review',action:'create',preview:{content:m.content,title:m.title}}};}};
window.emitFinal=()=>{const id=window.voice.state.sessionId;speechEvent({type:'context-speech',detail:{event:'final',id,text:'Diesen Satz habe ich diktiert.'}});};
const modal=document.getElementById('modal');window.view=createDevDiaryView({bridge,getState:()=>state,onSave:d=>{state.devDiaries=[validateDevDiary(d)];return true;},speechFactory:options=>{window.voice=createSpeechInput({...options,storage:null,captureFactory:async()=>({start:async()=>{},close:async()=>{}})});return voice;},onModal:(title,sub,body)=>{modal.innerHTML='<div class="modal-head"><div><span class="small-label">DEV DIARY</span><h2 id="modal-title">'+title+'</h2></div><button class="icon-button" data-dd-action="close" aria-label="Schließen">×</button></div>'+body;if(!modal.open)modal.showModal();}});view.open('qa-diary','2026-10-13');`;
app.whenReady().then(async()=>{
 const {createRequestHandler}=await import(pathToFileURL(path.resolve(__dirname,'../server.mjs')).href);
 const server=http.createServer((req,res)=>{if(req.url==='/__diary-qa'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html lang="de"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/coco-theme.css"><link rel="stylesheet" href="/dark-theme.css"><link rel="stylesheet" href="/speech.css"><link rel="stylesheet" href="/dev-diaries.css"><body><dialog id="modal" class="dev-diary-modal" aria-labelledby="modal-title"></dialog><script type="module" src="/__diary-test.js"></script></body></html>');return;}if(req.url==='/__diary-test.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(fixture);return;}return handler(req,res);});const handler=createRequestHandler(()=>server.address().port,async()=>({items:[],sources:[]}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false}});win.webContents.setFrameRate(15);
 const js=code=>win.webContents.executeJavaScript(code),sleep=ms=>new Promise(r=>setTimeout(r,ms)),report={checks:[],screenshots:[]};let failed=false;
 const check=(ok,label)=>{report.checks.push({ok:!!ok,label});if(!ok)failed=true;};
 const shot=async name=>{await sleep(120);const file=path.join(OUT,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());report.screenshots.push(file);};
 try{
  await win.loadURL('http://127.0.0.1:'+server.address().port+'/__diary-qa');
  for(let i=0;i<40&&!await js('!!document.querySelector("#dd-entry-form")');i++)await sleep(100);
  check(await js('!!document.querySelector("#dd-entry-form")'),'real diary controller mounted');
  await shot('diary-desktop');
  await js(`document.querySelector('[data-dd-settings]').open=true;const f=document.querySelector('#dd-appearance-form');f.elements.layout.value='collapsible';f.elements.hideEmpty.checked=true;f.elements.headings.value='compact';f.elements.layout.dispatchEvent(new Event('change',{bubbles:true}));`);
  check(await js(`document.querySelectorAll('#dd-preview-content details.dev-diary-day').length===1`),'draft styling immediately produces a real disclosure preview');
  await js(`document.querySelector('#dd-preview-content summary').click()`);
  check(await js(`document.querySelector('#dd-preview-content details').open`),'day disclosure responds to click');
  await js(`document.querySelector('[data-dd-action="dictate"][data-dd-field="problems"]').click()`);await sleep(200);
  check(await js(`voice.state.phase==='recording'`),'real speech controller reaches recording with a synthetic local device');
  await js(`emitFinal();emitFinal()`);await sleep(100);
  check(await js(`document.querySelector('#dd-problems').value==='Diesen Satz habe ich diktiert.'&&state.devDiaries[0].entries[0].problems===''&&writes.length===0`),'final dictated text enters one field once without saving or publishing');
  check(await js(`!document.querySelector('[data-dd-voice] [data-speech-setting=autoSend]')`),'no automatic-send control in a diary');
  await js(`document.querySelector('#dd-entry-form').requestSubmit()`);
  check(await js(`state.devDiaries[0].entries[0].problems==='Diesen Satz habe ich diktiert.'&&state.devDiaries[0].presentation.layout==='collapsible'`),'one save stores typed text, dictation and styling');
  await js(`document.querySelector('[data-dd-action=prepare]').click()`);await sleep(100);
  check(await js(`writes.length===1&&writes[0].op==='prepare'&&writes[0].content.includes('<details>')&&document.querySelector('.dd-review details')!==null`),'publication review uses the same collapsible content without publishing');
  await js(`document.querySelector('[data-dd-action=discard-review]').click();document.querySelector('[data-dd-action=voice]').click();document.querySelector('#modal').scrollTop=0;`);
  await shot('diary-styled-desktop');
  for(const [name,width,height,dark] of [['diary-mobile',390,844,false],['diary-dark-desktop',1280,900,true],['diary-dark-mobile',390,844,true]]){
   win.setContentSize(width,height);await js(`document.documentElement.dataset.theme='${dark?'dark':'light'}';document.querySelector('#modal').scrollTop=0`);await sleep(150);
   const geometry=await js(`(()=>{const m=document.querySelector('#modal'),r=m.getBoundingClientRect();return {viewport:innerWidth,left:r.left,right:r.right,scroll:m.scrollWidth,client:m.clientWidth,body:document.documentElement.scrollWidth,scrollable:m.scrollHeight>m.clientHeight};})()`);
   check(geometry.viewport===width&&geometry.left>=0&&geometry.right<=width+1&&geometry.scroll<=geometry.client+1&&geometry.body<=width+1,name+' fits viewport without horizontal overflow');
   report[name]=geometry;await shot(name);
  }
 }catch(error){failed=true;report.error=String(error.stack||error);try{await shot('diary-error');}catch{}}
 await js('window.voice?.dispose()').catch(()=>{});server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));app.exit(failed?1:0);
}).catch(error=>{console.error(error);app.exit(1);});
