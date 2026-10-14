import test from 'node:test';
import assert from 'node:assert/strict';
import {runProjectAgent,validateAgentReply,buildKnowledge} from '../dist/knowledge.js';
import {cleanChat} from '../dist/chat-archive.js';

const tool=(name,args={})=>({content:JSON.stringify({type:'tool',tool:name,args}),totalTokens:20});
const answer=(text='Fertig',citations=[])=>({content:JSON.stringify({type:'answer',text,citations}),totalTokens:10});
const workspace=()=>({projects:[{id:'c1',name:'Kurs',links:[]}],notes:[{id:'old',projectId:'c1',title:'Abgaberegeln SS 2020',content:'Abgabe per Mail bis zum 8. April 2020.',updatedAt:'2020-04-01T10:00:00Z'},{id:'new',projectId:'c1',title:'Abgaberegeln',content:'Abgabe im Portal bis 20.11.2026.',updatedAt:'2026-10-05T10:00:00Z'},{id:'undated',projectId:'c1',title:'Hinweis',content:'Bitte pünktlich abgeben.'}],tasks:[],calendarEvents:[],boardFindings:[],bookmarks:[],tools:[]});
const knowledge=()=>buildKnowledge(workspace(),[],{projectId:'c1'});
const payload=content=>JSON.parse(content.split('\nKONTEXT (Daten):\n')[1].split('\nAKTUELLER NUTZERAUFTRAG:\n')[0]);

test('ask_user accepts 2–6 distinct short options with an optional multiple flag and nothing else',()=>{
  const ok=args=>validateAgentReply(tool('ask_user',args).content).tool==='ask_user';
  assert.ok(ok({question:'Welches Semester?',options:['WS 2026/27','SS 2026']}));
  assert.ok(ok({question:'Welche Kurse?',options:['A','B','C','D','E','F'],multiple:true}));
  for(const args of [{},{question:'x',options:['nur eine']},{question:'x',options:['a','b','c','d','e','f','g']},{question:'x',options:['a','A']},{question:'x',options:['a','']},{question:'x',options:['a',7]},{question:'',options:['a','b']},{question:'x'.repeat(301),options:['a','b']},{question:'x',options:['a','b'],multiple:'ja'},{question:'x',options:['a','b'],url:'https://evil.test'},{question:'x',options:['a','y'.repeat(121)]}])assert.throws(()=>validateAgentReply(tool('ask_user',args).content),`${JSON.stringify(args).slice(0,50)}`);
});

test('a question ends the run with the clarification, the sources read so far and no invented answer',async()=>{
  let calls=0;const steps=[];
  const result=await runProjectAgent({prompt:'Wie gebe ich ab?',workspace:workspace(),documents:[],projectId:'c1',today:'2026-10-14',onStep:step=>steps.push(step),
    complete:async()=>{calls++;return calls===1?tool('ask_user',{question:'Meinst du die Regeln dieses oder eines früheren Semesters?',options:['WS 2026/27 (aktuell)','SS 2020 (alt)'],multiple:false}):answer('darf nicht erreicht werden');}});
  assert.equal(calls,1);assert.equal(result.content,'Meinst du die Regeln dieses oder eines früheren Semesters?');
  assert.deepEqual(result.clarification,{question:'Meinst du die Regeln dieses oder eines früheren Semesters?',options:['WS 2026/27 (aktuell)','SS 2020 (alt)'],multiple:false,answer:''});
  assert.deepEqual(result.citations,[]);assert.equal(result.steps.at(-1).label,'Rückfrage an dich');assert.equal(result.steps.at(-1).status,'done');
});

test('a question right after the person answered is refused; the agent must answer with a stated assumption',async()=>{
  const seen=[];let calls=0;
  const result=await runProjectAgent({prompt:'Meine Auswahl zu deiner Rückfrage („Semester?“): SS 2020',workspace:workspace(),documents:[],projectId:'c1',today:'2026-10-14',allowAsk:false,
    complete:async messages=>{calls++;seen.push(messages.at(-1).content);return calls===1?tool('ask_user',{question:'Noch eine Frage?',options:['Ja','Nein']}):answer('Annahme: SS 2020.');}});
  assert.equal(calls,2);assert.match(seen[1],/Rückfrage ist hier nicht möglich/);assert.equal(result.clarification,undefined);assert.equal(result.content,'Annahme: SS 2020.');assert.equal(result.steps[0].status,'error');
});

test('every source carries date, semester and age relative to today; undated and old ones are not passed off as current',async()=>{
  let first;
  await runProjectAgent({prompt:'Abgabe Hinweis',workspace:workspace(),documents:knowledge(),projectId:'c1',today:'2026-10-14',complete:async messages=>{first??=messages;return answer();}});
  const message=first[0].content,context=payload(message);
  assert.equal(context.scope.semester,'WS 2026/27');assert.equal(context.scope.today,'2026-10-14');
  const by=title=>context.knowledge.find(doc=>doc.title===title);
  assert.deepEqual([by('Abgaberegeln SS 2020').age,by('Abgaberegeln SS 2020').sem,by('Abgaberegeln SS 2020').date],['veraltet','SS 2020','2020-04-01']);
  assert.equal(by('Abgaberegeln').age,'aktuell');assert.equal(by('Hinweis').age,'unbekannt');assert.equal(by('Hinweis').date,undefined);
  assert.match(message,/Aktualität:/);assert.match(message,/Rückfragen: Lieber gezielt fragen/);assert.match(message,/Effizient bleiben/);
});

test('tool results carry the age too, so a read of an old page is labelled where the model looks',async()=>{
  const replies=[tool('search_knowledge',{query:'Abgabe'}),answer('Fertig')];let toolResult='';
  await runProjectAgent({prompt:'Abgabe',workspace:workspace(),documents:knowledge(),projectId:'c1',today:'2026-10-14',complete:async messages=>{if(messages.length>1)toolResult=messages.at(-1).content;return replies.shift();}});
  assert.match(toolResult,/"age":"veraltet"/);assert.match(toolResult,/"sem":"SS 2020"/);assert.match(toolResult,/"age":"aktuell"/);
});

test('without a valid date the agent adds no age fields instead of guessing',async()=>{
  let message='';
  await runProjectAgent({prompt:'Abgabe',workspace:workspace(),documents:knowledge(),projectId:'c1',complete:async messages=>{message=messages[0].content;return answer();}});
  assert.doesNotMatch(message,/"age":/);assert.doesNotMatch(message,/"semester":/);
});

test('clarifications survive the chat archive; malformed ones and user-role messages are dropped',()=>{
  const base={version:1,id:'chat-1',title:'t',scope:'',projectName:'',createdAt:'',updatedAt:'',draft:'',model:'m',provider:'openrouter',steps:[]};
  const message=(role,clarification)=>({id:'m1',role,content:'Welches Semester?',...(clarification?{clarification}:{})});
  const good={question:'Welches Semester?',options:['WS 2026/27','SS 2026'],multiple:true,answer:'WS 2026/27'};
  const chat=cleanChat({...base,messages:[message('assistant',good)]});assert.deepEqual(chat.messages[0].clarification,good);
  for(const bad of [{question:'x',options:['nur eine']},{question:'',options:['a','b']},{options:['a','b']},'text',null])assert.equal(cleanChat({...base,messages:[message('assistant',bad)]}).messages[0].clarification,undefined);
  assert.equal(cleanChat({...base,messages:[message('user',good)]}).messages[0].clarification,undefined);
  const long=cleanChat({...base,messages:[message('assistant',{question:'q'.repeat(900),options:Array(9).fill('o'.repeat(500)),multiple:'ja',answer:'a'.repeat(5000)})]}).messages[0].clarification;
  assert.equal(long.question.length,300);assert.equal(long.options.length,6);assert.ok(long.options.every(option=>option.length===120));assert.equal(long.multiple,false);assert.equal(long.answer.length,1500);
});

test('direct Spaces results and reads carry their publication date, semester and age; undated ones stay marked unknown',async()=>{
  const base='https://spaces.th-koeln.de',id=n=>'b:spaces-rest:'+n.toString(16).padStart(64,'0'),revision='a'.repeat(64);
  const header=(n,extra={})=>({id:id(n),title:'Abgabe '+n,url:base+'/interfaces/abgabe-'+n+'/',text:'',status:'metadata',kind:'browser',projectId:'alpha',source:'spaces',...extra});
  const state={projects:[{id:'alpha',name:'Interfaces',links:[{tool:'spaces',url:base+'/interfaces/'}]}],notes:[],tasks:[],calendarEvents:[],bookmarks:[],boardFindings:[],tools:[],activeCourse:'alpha'};
  const items=[header(1,{postedAt:'2019-04-17T08:00:00Z',updatedAt:'2019-04-18T08:00:00Z'}),header(2,{postedAt:'2026-10-01T08:00:00Z'}),header(3),header(4,{postedAt:'31.12.2019 <script>'})];
  const doc={...header(1,{postedAt:'2019-04-17T08:00:00Z'}),text:'Abgabe per Mail.',status:'full',revision,offset:0,hasMore:false};
  const replies=[tool('search_spaces',{projectId:'alpha',query:'Abgabe'}),tool('read_spaces_result',{projectId:'alpha',id:id(1)}),answer('Fertig')],seen=[];
  const result=await runProjectAgent({prompt:'Abgabe',workspace:state,documents:[],projectId:'alpha',today:'2026-10-14',
    spaces:async name=>name==='search_spaces'?{items,page:1,hasMore:false,total:4}:doc,complete:async messages=>{if(messages.length>1)seen.push(JSON.parse(messages.at(-1).content.split('\n')[1]));return replies.shift();}});
  const rows=seen[0].results;
  assert.deepEqual([rows[0].age,rows[0].sem,rows[0].date],['veraltet','SS 2019','2019-04-17']);assert.equal(rows[1].age,'aktuell');assert.equal(rows[2].age,'unbekannt');assert.equal(rows[3].age,'unbekannt');
  assert.ok(!JSON.stringify(rows[3]).includes('script'));
  assert.equal(seen[1].age,'veraltet');assert.equal(seen[1].sem,'SS 2019');assert.equal(result.steps.every(step=>step.status==='done'),true);
});
