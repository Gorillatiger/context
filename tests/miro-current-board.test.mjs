import test from 'node:test';
import assert from 'node:assert/strict';
import {runProjectAgent,validateAgentReply} from '../dist/knowledge.js';
import {resolveAgentContext} from '../dist/agent-context.js';
import {planCurrentBoard} from '../dist/current-board.js';
import {platformCatalog} from '../dist/source-catalog.js';
import {validateBoardFindings} from '../dist/board-index.js';

const OPEN='https://miro.com/app/board/uXjVOpenBoard=/',OTHER='https://miro.com/app/board/uXjVOtherBrd=/';
const workspace=(extra={})=>({projects:[{id:'courseA',name:'Kurs A',links:[]},{id:'courseB',name:'Kurs B',links:[{id:'b',tool:'miro',url:OTHER,title:'Board B'}]}],notes:[],tasks:[],calendarEvents:[],boardFindings:[],bookmarks:[],tools:[],activeCourse:'courseA',...extra});
const answer=(text='Fertig',citations=[])=>({content:JSON.stringify({type:'answer',text,citations}),totalTokens:10});
const tool=(name,args={})=>({content:JSON.stringify({type:'tool',tool:name,args}),totalTokens:20});
const board={url:OPEN,title:'Woche 3: Personas'};

test('the open board becomes a course source of the chat course; existing sources are reused, never cross-course',()=>{
  const state=workspace(),plan=planCurrentBoard(state,board,'courseA');
  assert.equal(plan.assigned,true);assert.equal(plan.courseName,'Kurs A');
  const next={...state,boardFindings:validateBoardFindings(plan.boardFindings)};
  const ready=planCurrentBoard(next,board,'courseA');assert.equal(ready.assigned,false);assert.equal(ready.sourceId,platformCatalog(next).find(source=>source.url===OPEN).id);
  assert.equal(next.boardFindings[0].assignedProjectId,'courseA');assert.equal(next.boardFindings[0].title,'Woche 3: Personas');
  // Already linked to course B: with "all courses" it is reused; in course A it is assigned there, not borrowed from B.
  assert.equal(planCurrentBoard(state,{url:OTHER},'').projectId,'courseB');assert.equal(planCurrentBoard(state,{url:OTHER},'courseA').assigned,true);
  assert.throws(()=>planCurrentBoard(state,board,''),/Wähle oben im Assistenten den Kurs/);
  assert.equal(planCurrentBoard({...state,projects:[state.projects[0]]},board,'').projectId,'courseA');
  assert.throws(()=>planCurrentBoard({...state,projects:[]},board,''),/Lege zuerst einen Kurs an/);
  assert.throws(()=>planCurrentBoard(state,null,'courseA'),/kein Miro-Board geöffnet/);
  assert.throws(()=>planCurrentBoard(state,{url:'https://evil.test/app/board/x/'},'courseA'));
  assert.throws(()=>planCurrentBoard(state,board,'missing'),/nicht mehr verfügbar/);
  assert.doesNotMatch(JSON.stringify(planCurrentBoard(state,{url:OPEN+'?share_link_id=123456',title:'x'},'courseA')),/share_link_id|123456/);
});

test('agent context exposes only a shown browser tab board, without tokens, and names it in the header',()=>{
  const state=workspace(),browser=(patch={})=>({visible:true,current:true,readable:false,miroBoard:{url:OPEN+'?share_link_id=998877',title:'Woche 3'+String.fromCharCode(7)},...patch});
  const shown=resolveAgentContext(state,[],{view:'browser',browser:browser()});
  assert.deepEqual(shown.currentBoard,{url:OPEN,title:'Woche 3'});assert.equal(shown.label,'Miro-Board · Woche 3');
  assert.equal(resolveAgentContext(state,[],{view:'today',browser:browser({visible:false})}).currentBoard,undefined);
  assert.equal(resolveAgentContext(state,[],{view:'browser',browser:browser({miroBoard:{url:'https://evil.test/app/board/x/'}})}).currentBoard,undefined);
  assert.equal(resolveAgentContext(state,[],{view:'browser',browser:browser({miroBoard:null})}).currentBoard,undefined);
});

test('read_current_board takes no arguments',()=>{
  assert.equal(validateAgentReply(tool('read_current_board').content).tool,'read_current_board');
  for(const args of [{url:OPEN},{sourceId:'platform:x'},{query:'x'}])assert.throws(()=>validateAgentReply(tool('read_current_board',args).content));
});

function agentRun({state=workspace(),pageContext={currentBoard:board},platformEnabled=true,currentBoard,replies,onMessages}={}){
  const calls={current:[],platform:[]};let assigned=state;
  const ensure=currentBoard||(async options=>{calls.current.push(options);const plan=planCurrentBoard(assigned,pageContext.currentBoard,options.projectId);if(plan.assigned)assigned={...assigned,boardFindings:validateBoardFindings(plan.boardFindings)};return planCurrentBoard(assigned,pageContext.currentBoard,options.projectId).sourceId;});
  const platform=async(name,args,_signal,scope)=>{calls.platform.push({name,args,scope});const source=platformCatalog(assigned).find(row=>row.id===args.sourceId);
    const doc={id:'miro:'+'a'.repeat(64)+':part0',kind:'miro',service:'miro',source:'Miro',sourceId:source.id,projectId:source.projectId,boardURL:source.url,boardId:'uXjVOpenBoard=',itemId:'3074457',url:source.url+'?moveToWidget=3074457',title:'Personas',text:'Board: Woche 3\nPersonas\nErstelle zwei Personas.',status:'full',accountGeneration:'b'.repeat(64),fetchedAt:'2026-10-14T15:00:00Z'};
    return {documents:[doc],result:{sourceId:source.id,service:'miro',results:[{id:doc.id,title:doc.title,text:doc.text}],coverage:{complete:true},warnings:['Gelesen über Miros öffentliche Board-Übersicht für Screenreader (Besucherzugriff, keine offizielle Schnittstelle).']}};};
  return runProjectAgent({prompt:'Was steht auf diesem Board?',workspace:state,getWorkspace:()=>assigned,documents:[],projectId:'courseA',pageContext,
    platform:platformEnabled?platform:undefined,currentBoard:platformEnabled?ensure:undefined,
    complete:async messages=>{onMessages?.(messages);return replies.shift();}}).then(result=>({result,calls}));
}

test('the assistant reads exactly the open board: assign to the chat course, then a scope-checked platform read with citations',async()=>{
  let system='',scope;
  const {result,calls}=await agentRun({replies:[tool('read_current_board'),answer('Zwei Personas erstellen.',['miro:'+'a'.repeat(64)+':part0'])],onMessages:messages=>{if(scope)return;const [head,rest]=messages[0].content.split('\nKONTEXT (Daten):\n');system=head;scope=JSON.parse(rest.split('\nAKTUELLER NUTZERAUFTRAG:\n')[0]).scope;}});
  assert.match(system,/read_current_board \{\} liest genau dieses Board/);assert.doesNotMatch(system,/Woche 3/);assert.deepEqual(scope.currentBoard,{title:'Woche 3: Personas'});
  assert.deepEqual(calls.current.map(call=>call.projectId),['courseA']);assert.equal(calls.platform.length,1);assert.equal(calls.platform[0].name,'read_platform');assert.equal(calls.platform[0].scope,'courseA');
  assert.equal(result.steps[0].label,'Offenes Miro-Board lesen');assert.equal(result.steps[0].status,'done');
  assert.equal(result.citations.length,1);assert.equal(result.citations[0].url,OPEN+'?moveToWidget=3074457');
});

test('without an open board, with access switched off or with a foreign source the tool never reads',async()=>{
  let run=await agentRun({pageContext:{},replies:[tool('read_current_board'),answer()]});
  assert.equal(run.calls.current.length,0);assert.equal(run.calls.platform.length,0);assert.equal(run.result.steps[0].status,'error');
  let system='';run=await agentRun({platformEnabled:false,replies:[tool('read_current_board'),answer()],onMessages:messages=>{system||=messages[0].content.split('\nKONTEXT (Daten):\n')[0];}});
  assert.match(system,/„Browser“ und „Plattformen“ einschalten/);assert.doesNotMatch(system,/read_current_board \{\}/);assert.equal(run.result.steps[0].status,'error');
  const foreign=platformCatalog(workspace()).find(source=>source.projectId==='courseB').id;
  run=await agentRun({currentBoard:async()=>foreign,replies:[tool('read_current_board'),answer()]});
  assert.equal(run.calls.platform.length,0);assert.match(run.result.steps[0].detail||'',/außerhalb des freigegebenen Kursbereichs/);
  run=await agentRun({currentBoard:async()=>'javascript:alert(1)',replies:[tool('read_current_board'),answer()]});
  assert.equal(run.calls.platform.length,0);assert.equal(run.result.steps[0].status,'error');
  run=await agentRun({currentBoard:async()=>{throw new Error('Dieses Board ist noch keinem Kurs zugeordnet. Wähle oben im Assistenten den Kurs, zu dem es gehört, und frage erneut.');},replies:[tool('read_current_board'),answer()]});
  assert.match(run.result.steps[0].detail||'',/Wähle oben im Assistenten den Kurs/);
});

test('a fresh assignment is confirmed only after a successful read and released when the board cannot be read',async()=>{
  const events=[],source=()=>platformCatalog({...workspace(),boardFindings:validateBoardFindings(planCurrentBoard(workspace(),board,'courseA').boardFindings)}).find(row=>row.url===OPEN).id;
  const ensured=()=>({sourceId:source(),undo:()=>events.push('undo'),done:title=>events.push('done:'+title)});
  const linked={...workspace(),boardFindings:validateBoardFindings(planCurrentBoard(workspace(),board,'courseA').boardFindings)};
  let run=await agentRun({state:linked,currentBoard:async()=>ensured(),replies:[tool('read_current_board'),answer()]});
  assert.equal(run.result.steps[0].status,'done');assert.deepEqual(events,['done:']);
  events.length=0;
  const blocked=async()=>({sourceId:source(),undo:()=>events.push('undo'),done:()=>events.push('done')});
  const state={...workspace(),boardFindings:validateBoardFindings(planCurrentBoard(workspace(),board,'courseA').boardFindings)};
  run=await runProjectAgent({prompt:'Was steht auf diesem Board?',workspace:state,getWorkspace:()=>state,documents:[],projectId:'courseA',pageContext:{currentBoard:board},currentBoard:blocked,
    platform:async()=>({documents:[],result:{permissionRequired:true}}),complete:(()=>{const replies=[tool('read_current_board'),answer()];return async()=>replies.shift();})()});
  assert.deepEqual(events,['undo']);
  events.length=0;
  run=await runProjectAgent({prompt:'Was steht auf diesem Board?',workspace:state,getWorkspace:()=>state,documents:[],projectId:'courseA',pageContext:{currentBoard:board},currentBoard:blocked,
    platform:async()=>{throw Object.assign(new Error('Dieses Miro-Board ist für Besucher nicht freigegeben.'),{code:'no_access'});},complete:(()=>{const replies=[tool('read_current_board'),answer()];return async()=>replies.shift();})()});
  assert.deepEqual(events,['undo']);assert.match(run.steps[0].detail,/nicht freigegeben/);
});

test('an answer without ids links only board sections it names exactly, never invented ones',async()=>{
  let run=await agentRun({replies:[tool('read_current_board'),answer('Auf der Folie Personas sollst du zwei Personas erstellen.',[])]});
  assert.deepEqual(run.result.citations.map(doc=>doc.title),['Personas']);assert.equal(run.result.citations[0].url,OPEN+'?moveToWidget=3074457');
  run=await agentRun({replies:[tool('read_current_board'),answer('Das Board behandelt Nutzerforschung allgemein.',[])]});
  assert.deepEqual(run.result.citations,[]);
  run=await agentRun({pageContext:{},replies:[answer('Personas sind hilfreich.',[])]});
  assert.deepEqual(run.result.citations,[]);
});

test('a board with hundreds of sections still returns a usable, bounded read instead of "Werkzeugergebnis ist zu groß"',async()=>{
  const state=workspace({boardFindings:validateBoardFindings(planCurrentBoard(workspace(),board,'courseA').boardFindings)}),source=platformCatalog(state).find(row=>row.url===OPEN);
  const docs=Array.from({length:300},(_,index)=>({id:'miro:'+index.toString(16).padStart(64,'0')+':part0',kind:'miro',service:'miro',source:'Miro',sourceId:source.id,projectId:'courseA',boardURL:source.url,boardId:'uXjVOpenBoard=',itemId:String(1000+index),url:source.url+'?moveToWidget='+(1000+index),title:'Folie '+index+' mit einem ziemlich langen Titel zur Gliederung',text:'Board: Prototyping\nFolie '+index+'\n'+'Inhalt der Folie. '.repeat(80),status:'full',accountGeneration:'b'.repeat(64),fetchedAt:'2026-10-14T15:00:00Z'}));
  const seen=[];
  for(const name of ['read_current_board','search_platform']){
    const replies=[name==='read_current_board'?tool(name):tool(name,{sourceId:source.id,query:'Folie 7'}),answer('Fertig')];
    const run=await runProjectAgent({prompt:'Was steht auf dem Board?',workspace:state,getWorkspace:()=>state,documents:[],projectId:'courseA',pageContext:{currentBoard:board},currentBoard:async()=>source.id,
      platform:async()=>({documents:docs,result:{sourceId:source.id,service:'miro',results:docs.slice(0,5).map(doc=>({id:doc.id,title:doc.title,text:doc.text})),coverage:{complete:true},warnings:['Gelesen über Miros öffentliche Board-Übersicht für Screenreader (Besucherzugriff, keine offizielle Schnittstelle).','Fuenf Bilder wurden nicht ausgelesen; bekannt sind nur ihre Dateinamen.']}}),
      complete:async messages=>{seen.push(messages.at(-1).content);return replies.shift();}});
    assert.equal(run.steps[0].status,'done',name+': '+run.steps[0].detail);
  }
  assert.ok(seen.every(content=>!/Werkzeugergebnis ist zu groß/.test(content)));
  const result=seen.find(content=>content.startsWith('WERKZEUGERGEBNIS'));assert.ok(result.length<11000);
  assert.match(result,/"outlineLimited":true/);assert.match(result,/Folie 0/);
});
