/* Optional end-to-end check in real Electron with live public Miro boards.
 * Run npm run test:miro:assistant after npm ci. Temporary profile only.
 * Chain: browser tab -> agent context -> read_current_board -> course assignment
 * -> SourceHub -> native platform -> offscreen visitor reader -> cited answer.
 * The language model is scripted (it chooses the tool, then cites what it read);
 * every other component is the production module. With --model <id> a real local
 * model (LM Studio on port 1234, via the app's local AI client) decides instead.
 */
const {app,BrowserWindow,safeStorage}=require('electron');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');

const PUBLIC=process.argv.find(value=>/^https:\/\/miro\.com\/app\/board\//.test(value))||'https://miro.com/app/board/o9J_kuapqg4=/';
const modelIndex=process.argv.indexOf('--model'),MODEL=modelIndex>=0?process.argv[modelIndex+1]:'';
const PRIVATE='https://miro.com/app/board/uXjVPrivat00=/';
const userData=path.join(os.tmpdir(),'context-miro-assistant-'+crypto.randomUUID());
app.setPath('userData',userData);
app.setName('Context Miro · Assistant Check');
app.on('window-all-closed',()=>{});

app.whenReady().then(async()=>{
  const load=file=>import(pathToFileURL(path.resolve(__dirname,file)).href);
  const [{createMiroVisitorReader,miroOffscreenViews},{createMiroShareLinks},{createDesktopPlatform},{safeMiroBoard},{createSourceHub},{cleanPlatformSources},{resolveAgentContext},{planCurrentBoard},{runProjectAgent}]=await Promise.all(['../desktop/miro-visitor.mjs','../desktop/miro-links.mjs','../desktop/platform.mjs','../connectors/miro.mjs','../dist/source-hub.js','../dist/source-store.js','../dist/agent-context.js','../dist/current-board.js','../dist/knowledge.js','../desktop/local-ai.mjs'].map(load));
  const localAI=MODEL?(await load('../desktop/local-ai.mjs')).createLocalAIClient():null;if(localAI)await localAI.configure({port:1234});

  // Native side, wired as in desktop/main.mjs; no Miro/Nango account is connected.
  const miroLinks=createMiroShareLinks({directory:path.join(userData,'miro'),crypto:safeStorage});await miroLinks.initialize();
  const platform=createDesktopPlatform({nango:{status:async()=>({connected:false}),proxy:async()=>{throw new Error('no account');}},createView:()=>{throw new Error('unused');},openVisible:async()=>{},
    miroVisitor:createMiroVisitorReader({getShareLink:id=>miroLinks.get(id),...miroOffscreenViews(BrowserWindow)}),miroLinks});
  const reply=async work=>{try{return {ok:true,value:await work()};}catch(error){return {ok:false,error:error.message,code:error.code};}};
  const bridge={service:message=>reply(()=>platform.service(message)),miro:message=>reply(()=>platform.miro(message)),onEvent:()=>()=>{}};

  // Renderer side with an empty course, as a student would have it.
  let state={projects:[{id:'course-ui',name:'Interaction Design',links:[]}],notes:[],tasks:[],calendarEvents:[],boardFindings:[],bookmarks:[],tools:[],activeCourse:'course-ui'},rows=[],revision=0;
  const store={load:async()=>({rows:structuredClone(rows),revision}),save:async(next,options)=>{options.assertCurrent?.();rows=cleanPlatformSources(next);return ++revision;},close:async()=>{}};
  const hub=createSourceHub({getWorkspace:()=>state,bridge,store});
  const notices=[];
  async function ensureCurrentBoard({projectId='',signal},board){ // same steps as dist/app.js ensureCurrentBoard
    const plan=planCurrentBoard(state,board,projectId);if(!plan.assigned)return plan.sourceId;
    state={...state,boardFindings:plan.boardFindings};
    const release=()=>{state={...state,boardFindings:state.boardFindings.filter(row=>row.id!==plan.findingId)};};
    if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');
    await hub.sync();const ready=planCurrentBoard(state,board,projectId);if(ready.assigned){release();throw new Error('Das Board konnte nicht als Kursquelle freigegeben werden.');}
    return {sourceId:ready.sourceId,undo:release,done:title=>{const name=String(title||'').trim()||plan.boardTitle;state={...state,boardFindings:state.boardFindings.map(row=>row.id===plan.findingId&&name!=='Miro-Board'?{...row,miroTitle:name}:row)};notices.push(`„${name}“ ist jetzt eine Quelle im Kurs „${plan.courseName}“.`);}};
  }

  // The tab the person looks at (the main process derives miroBoard like this in pageState()).
  const tab=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'persist:context-websites'}});
  async function ask(url,prompt,{reload=true}={}){
    if(reload||tab.webContents.getURL()!==url){await tab.webContents.loadURL(url).catch(()=>{});await new Promise(resolve=>setTimeout(resolve,2500));}
    let miroBoard=null;try{miroBoard={url:safeMiroBoard(tab.webContents.getURL()).url,title:String(tab.webContents.getTitle()||'').replace(/\s+-\s+Miro$/,'')};}catch{}
    const context=resolveAgentContext(state,[],{view:'browser',browser:{visible:true,current:true,readable:false,miroBoard}});
    let round=0,lastToolOutput='';const started=Date.now(),timings=[];
    const result=await runProjectAgent({prompt,workspace:state,getWorkspace:()=>state,getPlatformSources:()=>hub.documents(),documents:[],projectId:context.projectId,projectName:context.projectName,pageContext:context,
      platform:(name,args,signal,scope)=>hub.tool(name,args,signal,scope),currentBoard:options=>ensureCurrentBoard(options,context.currentBoard),
      complete:localAI?async(messages,signal)=>{round++;const began=Date.now(),value=await localAI.complete({model:MODEL,messages},signal);timings.push({round,seconds:+((Date.now()-began)/1000).toFixed(1),promptChars:JSON.stringify(messages).length});if(process.env.MIRO_DEBUG)console.error('RAW',round,JSON.stringify(value.content).slice(0,1500));return value;}:async messages=>{
        if(round++===0){if(!/read_current_board \{\}/.test(messages[0].content))throw new Error('Das Werkzeug wurde dem Modell nicht angeboten.');return {content:JSON.stringify({type:'tool',tool:'read_current_board',args:{}})};}
        lastToolOutput=messages.at(-1).content;
        const ids=[...new Set([...messages.at(-1).content.matchAll(/"id":"(miro:[a-f0-9]{64}:part\d+)"/g)].map(match=>match[1]))].slice(0,3);
        return {content:JSON.stringify({type:'answer',text:ids.length?'Auf dem Board stehen u. a. diese Bereiche.':'Ich konnte das Board nicht lesen.',citations:ids})};
      }});
    const outline=(lastToolOutput.match(/"outline":\[(.*?)\]/)||[])[1]||'';
    return {timings,sources:(result.sources||[]).filter(doc=>doc.kind==='miro').length,answer:String(result.content||'').slice(0,400),tools:result.steps.map(step=>step.tool),outline:(outline.match(/"title":"/g)||[]).length,seconds:+((Date.now()-started)/1000).toFixed(1),label:context.label,step:result.steps[0]&&{label:result.steps[0].label,status:result.steps[0].status,detail:result.steps[0].detail},citations:result.citations.map(doc=>({title:doc.title,url:doc.url}))};
  }

  if(MODEL){
    // Real model: natural phrasings must lead to reading the open board; an unrelated question must not.
    const report={electron:process.versions.electron,model:MODEL,board:PUBLIC,runs:[]};let failed=false;
    for(const prompt of ['Was steht auf diesem Board?','Fasse das Miro-Board hier kurz zusammen.','Welche Aktivitäten gibt es auf dem offenen Board?','Wie spät ist es in Köln, wenn es in New York 9 Uhr ist?']){
      const run=await ask(PUBLIC,prompt,{reload:false}),unrelated=/New York/.test(prompt),read=run.tools.includes('read_current_board');
      const ok=unrelated?!read:read&&run.step?.status==='done'&&run.citations.length>0&&run.citations.every(c=>c.url.startsWith(PUBLIC+'?moveToWidget='));
      if(!ok)failed=true;report.runs.push({prompt,ok,...run});
    }
    report.notices=notices;console.log(JSON.stringify(report,null,2));
    await hub.dispose();platform.dispose();tab.destroy();app.exit(failed?1:0);return;
  }
  const report={electron:process.versions.electron,board:PUBLIC};let failed=false;const check=(ok,message)=>{if(!ok){failed=true;(report.failures||=[]).push(message);}};
  report.first=await ask(PUBLIC,'Was steht auf diesem Board?');
  check(report.first.step?.status==='done','first read did not finish: '+JSON.stringify(report.first.step));
  check(report.first.citations.length>0&&report.first.citations.every(c=>c.url.startsWith(PUBLIC+'?moveToWidget=')),'answer has no deep-linked citations');
  check(state.boardFindings.some(f=>f.url===PUBLIC&&f.assignedProjectId==='course-ui'),'board was not assigned to the course');
  report.indexedSections=hub.documents().length;check(report.indexedSections>0,'nothing indexed for search');
  report.second=await ask(PUBLIC,'Und welche Folien gibt es?');
  check(report.second.step?.status==='done'&&notices.length===1,'second question re-assigned or failed');
  report.private=await ask(PRIVATE,'Was steht auf diesem Board?');
  check(report.private.step?.status==='error'&&report.private.citations.length===0,'private board was not refused');
  check(!state.boardFindings.some(f=>f.url===PRIVATE),'unreadable board stayed attached to the course');
  const named=state.boardFindings.find(f=>f.url===PUBLIC)?.miroTitle||'';
  check(named&&named!=='Miro'&&named!=='Miro-Board','directory lacks the real board title');
  check(notices.length===1&&notices[0].includes('„'+named+'“'),'announcement missing or without the real board title: '+JSON.stringify(notices));
  check(report.first.outline>=10,'no section outline for the model');
  check(!/^Group/.test(report.first.citations[0]?.title||''),'first cited section is a selection group, not a slide');
  report.notices=notices;
  console.log(JSON.stringify(report,null,2));
  await hub.dispose();platform.dispose();tab.destroy();app.exit(failed?1:0);
}).catch(error=>{console.error(error);app.exit(1);});
