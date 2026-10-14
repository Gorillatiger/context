import test from 'node:test';
import assert from 'node:assert/strict';
import {runProjectAgent,validateAgentReply} from '../dist/knowledge.js';
import {planCurrentBoard} from '../dist/current-board.js';
import {platformCatalog} from '../dist/source-catalog.js';
import {validateBoardFindings} from '../dist/board-index.js';
import {cleanBoardShot,limitShotBudget,SHOT_LIMITS} from '../dist/board-shot.js';
import {cleanChat,encryptChat,decryptChat} from '../dist/chat-archive.js';

const OPEN='https://miro.com/app/board/uXjVOpenBoard=/';
const workspace=()=>({projects:[{id:'courseA',name:'Kurs A',links:[]}],notes:[],tasks:[],calendarEvents:[],boardFindings:[],bookmarks:[],tools:[],activeCourse:'courseA'});
const answer=(text='Fertig',citations=[])=>({content:JSON.stringify({type:'answer',text,citations}),totalTokens:10});
const tool=(name,args={})=>({content:JSON.stringify({type:'tool',tool:name,args}),totalTokens:20});
const JPEG='/9j/'+'A'.repeat(400),PIC=(extra={})=>({mime:'image/jpeg',data:JPEG,width:1280,height:900,capturedAt:'2026-10-14T15:00:00.000Z',settled:true,...extra});
const SECTIONS=[['1','Aufgabe 1: Personas','Erstelle zwei Personas.'],['2','Aufgabe 2: Journey','Zeichne die Journey Map.'],['3','Aufgabe 3: Prototyp','Baue einen Prototyp.'],['4','Aufgabe 4: Test','Teste mit drei Personen.'],['5','Aufgabe 4: Test','Zweite Fassung.']];
const id=n=>'miro:'+String(n).repeat(64)+':part0';
function agentRun({replies,boardShot,platformOn=true,onMessages,prompt='Was soll ich auf dem Board tun?',sections=SECTIONS}={}){
  const state=workspace(),calls={shots:[]};let assigned=state;
  const ensure=async options=>{const plan=planCurrentBoard(assigned,{url:OPEN,title:'Woche 3'},options.projectId);if(plan.assigned)assigned={...assigned,boardFindings:validateBoardFindings(plan.boardFindings)};return planCurrentBoard(assigned,{url:OPEN,title:'Woche 3'},options.projectId).sourceId;};
  const platform=async(_name,args)=>{const source=platformCatalog(assigned).find(row=>row.id===args.sourceId);
    const docs=sections.map(([item,title,text])=>({id:'miro:'+item.repeat(64)+':part0',kind:'miro',service:'miro',source:'Miro',sourceId:source.id,projectId:source.projectId,boardURL:source.url,boardId:'uXjVOpenBoard=',itemId:'30744'+item,url:source.url+'?moveToWidget=30744'+item,title,text:'Board: Woche 3\n'+text,status:'full',accountGeneration:'b'.repeat(64),fetchedAt:'2026-10-14T15:00:00Z'}));
    return {documents:docs,result:{sourceId:source.id,service:'miro',results:docs.slice(0,5).map(doc=>({id:doc.id,title:doc.title,text:doc.text})),coverage:{complete:true}}};};
  const shot=boardShot===null?undefined:async options=>{calls.shots.push(options);return boardShot?boardShot(options):{...PIC(),sourceId:options.sourceId,url:OPEN,itemId:options.itemId,boardTitle:'Woche 3'};};
  return runProjectAgent({prompt,workspace:state,getWorkspace:()=>assigned,documents:[],projectId:'courseA',pageContext:{currentBoard:{url:OPEN,title:'Woche 3'}},
    platform:platformOn?platform:undefined,currentBoard:platformOn?ensure:undefined,boardShot:platformOn?shot:undefined,
    complete:async messages=>{onMessages?.(messages);return replies.shift();}}).then(result=>({result,calls}));
}

test('show_board_area takes exactly one of id (a read Miro section) or title',()=>{
  assert.equal(validateAgentReply(tool('show_board_area',{id:id(1)}).content).tool,'show_board_area');
  assert.equal(validateAgentReply(tool('show_board_area',{title:'Aufgabe 1'}).content).tool,'show_board_area');
  for(const args of [{},{id:'service:'+'a'.repeat(64)},{id:id(1),title:'x'},{title:''},{title:'x'.repeat(201)},{url:'https://miro.com/app/board/x/'},{sourceId:'platform:x'},{id:'miro:../../x'}])assert.throws(()=>validateAgentReply(tool('show_board_area',args).content),undefined,JSON.stringify(args));
});

test('the assistant attaches a picture of a read section; the model never sees the image',async()=>{
  let system='',later='';
  const {result,calls}=await agentRun({replies:[tool('read_current_board'),tool('show_board_area',{id:id(1)}),answer('**Aufgabe 1:** Erstelle zwei Personas.',[id(1)])],onMessages:messages=>{system||=messages[0].content.split('\nKONTEXT (Daten):\n')[0];later=JSON.stringify(messages);}});
  assert.match(system,/show_board_area \{id\|title\}/);
  assert.equal(calls.shots.length,1);assert.equal(calls.shots[0].projectId,'courseA');assert.equal(calls.shots[0].itemId,'307441');assert.match(calls.shots[0].sourceId,/^platform|^miro|:/);
  assert.equal(result.shots.length,1);const [shot]=result.shots;
  assert.equal(shot.title,'Aufgabe 1: Personas');assert.equal(shot.boardTitle.length>0,true);assert.equal(shot.url,OPEN+'?moveToWidget=307441');assert.equal(shot.data,JPEG);assert.match(shot.id,/^[-\w]{36}$/);
  assert.doesNotMatch(later,/\/9j\/AAAA/,'image bytes never enter a model request');
  const step=result.steps.find(item=>item.tool==='show_board_area');assert.equal(step.label,'Board-Ausschnitt fotografieren');assert.equal(step.status,'done');
  assert.equal(result.shotNotes,undefined);
});

test('areas can be named by exact title; ambiguous or unknown areas are refused without a capture',async()=>{
  let run=await agentRun({replies:[tool('read_current_board'),tool('show_board_area',{title:'Aufgabe 2: Journey'}),answer('ok')]});
  assert.equal(run.calls.shots.length,1);assert.equal(run.calls.shots[0].itemId,'307442');
  run=await agentRun({replies:[tool('read_current_board'),tool('show_board_area',{title:'Aufgabe 4'}),tool('show_board_area',{title:'Aufgabe 4: Test'}),tool('show_board_area',{id:id(9)}),answer('ok')]});
  assert.equal(run.calls.shots.length,0);assert.deepEqual(run.result.steps.filter(step=>step.tool==='show_board_area').map(step=>step.status),['error','error','error']);
  assert.match(run.result.steps.at(-1).detail,/nicht gelesen/);assert.match(run.result.steps.at(-2).detail,/mehrere Bereiche/);
});

test('at most three pictures, none twice',async()=>{
  const {result,calls}=await agentRun({replies:[tool('read_current_board'),tool('show_board_area',{id:id(1)}),tool('show_board_area',{id:id(1)}),tool('show_board_area',{id:id(2)}),tool('show_board_area',{id:id(3)}),tool('show_board_area',{id:id(4)}),answer('ok')]});
  assert.equal(calls.shots.length,3);assert.equal(result.shots.length,3);
  const failed=result.steps.filter(step=>step.status==='error').map(step=>step.detail);assert.match(failed[0],/schon an der Antwort/);assert.match(failed[1],/Höchstens drei/);
});

test('a failed capture is reported to the model and the person, and blocks further tries for that board',async()=>{
  const {result,calls}=await agentRun({boardShot:async()=>{throw Object.assign(new Error('Anmeldung'),{code:'login_required'});},replies:[tool('read_current_board'),tool('show_board_area',{id:id(1)}),tool('show_board_area',{id:id(2)}),answer('Aufgabe 1: Personas.',[id(1)])]});
  assert.equal(calls.shots.length,1);assert.equal(result.shots,undefined);assert.equal(result.content,'Aufgabe 1: Personas.');
  assert.match(result.shotNotes[0],/ohne Anmeldung nicht sichtbar/);assert.match(result.steps.at(-1).detail,/kein Screenshot möglich/);
});

test('without a screenshot step the answer to a task question still gets the picture of what it cites',async()=>{
  const {result,calls}=await agentRun({replies:[tool('read_current_board'),answer('Deine **Aufgabe**: zwei Personas erstellen, Abgabe bis Freitag.',[id(1),id(2),id(3)])]});
  assert.deepEqual(calls.shots.map(call=>call.itemId),['307441','307442']);assert.equal(result.shots.length,2);
  assert.equal(result.steps.filter(step=>step.tool==='show_board_area'&&step.status==='done').length,2);
});

test('no automatic picture for other topics, after the model took one, or when screenshots are unavailable',async()=>{
  let run=await agentRun({replies:[tool('read_current_board'),answer('Das Board zeigt ein Mindmap-Thema.',[id(1)])]});assert.equal(run.calls.shots.length,0);assert.equal(run.result.shots,undefined);
  run=await agentRun({replies:[tool('read_current_board'),tool('show_board_area',{id:id(3)}),answer('Aufgabe: Prototyp bauen.',[id(1),id(3)])]});assert.deepEqual(run.calls.shots.map(call=>call.itemId),['307443']);
  let system='';run=await agentRun({boardShot:null,onMessages:messages=>{system||=messages[0].content;},replies:[tool('read_current_board'),tool('show_board_area',{id:id(1)}),answer('Aufgabe: Personas.',[id(1)])]});
  assert.doesNotMatch(system,/show_board_area \{id\|title\}/);assert.equal(run.result.shots,undefined);assert.equal(run.result.steps.find(step=>step.tool==='show_board_area').status,'error');
  run=await agentRun({replies:[tool('read_current_board'),tool('show_board_area',{id:id(1)}),answer('Aufgabe: Personas.',[id(1)])],boardShot:async()=>({...PIC(),url:OPEN,data:'<script>'})});
  assert.equal(run.result.shots,undefined);assert.match(run.result.shotNotes[0],/Ungültig/);
});

test('the link of a picture comes from the scope-checked source, never from the capture reply',async()=>{
  const run=await agentRun({boardShot:async()=>({...PIC(),url:'https://evil.test/app/board/x/'}),replies:[tool('read_current_board'),tool('show_board_area',{id:id(1)}),answer('ok')]});
  assert.equal(run.result.shots.length,1);assert.equal(run.result.shots[0].url,OPEN+'?moveToWidget=307441');
});

test('shot records are validated strictly',()=>{
  const good={id:'a-1',title:'T',boardTitle:'B',url:OPEN+'?moveToWidget=1',...PIC()};
  assert.equal(cleanBoardShot(good).url,OPEN+'?moveToWidget=1');assert.equal(cleanBoardShot({...good,data:''}).data,'');
  for(const bad of [{url:'https://evil.test/app/board/x/'},{url:'http://miro.com/app/board/x/'},{url:'https://miro.com:444/app/board/x/'},{url:'https://miro.com/app/dashboard/'},{mime:'image/png'},{data:'AAAA'},{data:'/9j/'+'A'.repeat(SHOT_LIMITS.data)},{data:'/9j/ <x>'},{width:0},{width:1281},{width:1280,height:4000},{height:10},{id:'../x'},{capturedAt:'gestern'}])assert.throws(()=>cleanBoardShot({...good,...bad}),undefined,JSON.stringify(bad).slice(0,80));
  assert.throws(()=>cleanBoardShot(null));assert.throws(()=>cleanBoardShot([]));
});

test('old pictures give way to new ones within the chat budget',()=>{
  const row=index=>({id:'s'+index,title:'T',boardTitle:'B',url:OPEN,...PIC(),data:'/9j/'+'A'.repeat(1000)});
  const messages=[{shots:[row(1),row(2)]},{shots:[row(3)]},{}];
  limitShotBudget(messages,2*1004);
  assert.deepEqual(messages.flatMap(message=>message.shots||[]).map(shot=>[shot.id,shot.data.length>0]),[['s1',false],['s2',true],['s3',true]]);
});

test('the encrypted chat archive keeps pictures and notes and drops damaged ones',async()=>{
  const shot={id:'a-1',title:'Aufgabe 1',boardTitle:'Woche 3',url:OPEN,...PIC()};
  const chat={version:1,id:'chat-1',title:'t',scope:'courseA',projectName:'Kurs A',createdAt:'2026-10-14T10:00:00Z',updatedAt:'2026-10-14T10:00:00Z',draft:'',model:'m',provider:'kiconnect',steps:[],interrupted:false,
    messages:[{id:'m1',role:'user',content:'Frage'},{id:'m2',role:'assistant',content:'Antwort',citations:[],sources:[],steps:[],proposals:[],shots:[shot,{...shot,id:'bad',data:'<script>'},{...shot,id:'b-2'},{...shot,id:'c-3'},{...shot,id:'d-4'}],shotNotes:['Aufgabe 1: kein Screenshot','',7,'x'.repeat(500)]},
      {id:'m3',role:'user',content:'Danke',shots:[shot],shotNotes:['nur für Antworten']}]};
  const clean=cleanChat(chat);
  assert.deepEqual(clean.messages[1].shots.map(item=>item.id),['a-1','b-2','c-3']);assert.equal(clean.messages[1].shots[0].data,JPEG);
  assert.equal(clean.messages[1].shotNotes.length,2);assert.equal(clean.messages[1].shotNotes[1].length,300);
  assert.equal(clean.messages[2].shots,undefined);assert.equal(clean.messages[2].shotNotes,undefined);assert.equal(clean.messages[0].shots,undefined);
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const encrypted=await encryptChat(chat,key);assert.doesNotMatch(Buffer.from(encrypted.cipher).toString('latin1'),/\/9j\/AAAA/,'pictures are encrypted at rest');
  assert.equal((await decryptChat(encrypted,key)).messages[1].shots[0].data,JPEG);
});

test('a source that needs a login is reported to the person as a sign-in card payload, not only in prose',async()=>{
  const {runProjectAgent}=await import('../dist/knowledge.js');
  const GITLAB='https://git.coco.study/students/ws2627/kurs/repo/',ws={projects:[{id:'courseA',name:'Kurs A',links:[{id:'g',tool:'gitlab',url:GITLAB,title:'Kurs-Repository'}]}],notes:[],tasks:[],calendarEvents:[],boardFindings:[],bookmarks:[],tools:[],activeCourse:'courseA'};
  const source=platformCatalog(ws).find(row=>row.service==='gitlab');assert.ok(source,'gitlab source in the catalog');
  const platform=async()=>({documents:[],result:{sourceId:source.id,service:'gitlab',loginRequired:true,results:[]}});
  const replies=[tool('read_platform',{sourceId:source.id}),answer('GitLab braucht deine Anmeldung.')];
  const result=await runProjectAgent({prompt:'Prüfe meine GitLab-Abgabe',workspace:ws,getWorkspace:()=>ws,documents:[],projectId:'courseA',platform,complete:async()=>replies.shift()});
  assert.deepEqual(result.loginNeeded,[{sourceId:source.id,service:'gitlab',title:source.title,url:source.url}]);
  const clean=cleanChat({version:1,id:'c1',title:'t',scope:'courseA',projectName:'',createdAt:'',updatedAt:'',draft:'',model:'',provider:'kiconnect',steps:[],interrupted:false,messages:[{id:'m',role:'assistant',content:'x',loginNeeded:[...result.loginNeeded,{sourceId:'x',service:'gitlab',title:'t',url:'http://evil.test/'},{sourceId:'../x',service:'g',title:'t',url:'https://git.coco.study/'}]}]});
  assert.equal(clean.messages[0].loginNeeded.length,1);
});
