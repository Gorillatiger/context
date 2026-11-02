import test from 'node:test';
import assert from 'node:assert/strict';
import {groupTasks,buildTaskContext,parseInsights,analyzeTasks} from '../dist/task-insights.js';

const projects=[{id:'p1',name:'Prototyping',archived:false},{id:'p2',name:'Alt',archived:true}];
const tasks=[
  {id:'t1',title:'Konzept abgeben',projectId:'p1',status:'todo',due:'2026-11-01'},
  {id:'t2',title:'Skizzen',projectId:'p1',status:'doing',due:'2026-11-02'},
  {id:'t3',title:'Reflexion',projectId:'p1',status:'todo',due:'2026-11-06'},
  {id:'t4',title:'Lesen',projectId:'p1',status:'todo',due:'2026-12-01'},
  {id:'t5',title:'Ohne Frist',projectId:'p1',status:'todo'},
  {id:'t6',title:'Fertig',projectId:'p1',status:'done',due:'2026-11-01'},
  {id:'t7',title:'Archiv',projectId:'p2',status:'todo'}
];

test('tasks are grouped by urgency and done tasks are left out',()=>{
  const g=groupTasks(tasks,'2026-11-02');
  assert.deepEqual(Object.fromEntries(Object.entries(g).map(([k,v])=>[k,v.map(t=>t.id)])),{overdue:['t1'],today:['t2'],week:['t3'],later:['t4'],nodue:['t5','t7']});
});

test('context excludes archived courses, links and done tasks',()=>{
  const c=buildTaskContext({tasks,projects,today:'2026-11-02',events:[],updates:[{title:'Neue Aufgabe https://geheim.example/x',summary:'Bitte bis 10.11.',createdAt:'2026-11-01'}]});
  assert.deepEqual([...c.taskIds].sort(),['t1','t2','t3','t4','t5']);
  assert.ok(!c.text.includes('https://')&&c.text.includes('[Link entfernt]'));
  assert.ok(!c.text.includes('Fertig'));
});

const ids={taskIds:new Set(['t1','t2']),courseIds:new Set(['p1'])};
test('parser keeps valid rows and drops invented ids',()=>{
  const r=parseInsights(JSON.stringify({tasks:[{id:'t1',summary:'Konzept fertigstellen',steps:['A','B'],effort:'mittel',priority:'hoch',reason:'überfällig'},{id:'zz',summary:'erfunden'}],suggestions:[{title:'Poster',projectId:'p1',due:'2026-11-09',reason:'m1'},{title:'X',projectId:'fremd',due:'morgen'}],issues:[{taskId:'t2',kind:'keine_frist',message:'Frist fehlt'},{taskId:'zz',kind:'unklar',message:'x'}]}),ids);
  assert.deepEqual(r.tasks.map(t=>t.id),['t1']);
  assert.equal(r.suggestions[1].projectId,'');assert.equal(r.suggestions[1].due,'');
  assert.equal(r.issues.length,1);
});
test('parser rejects non-JSON and wrong shape',()=>{
  assert.throws(()=>parseInsights('Hallo',ids));
  assert.throws(()=>parseInsights('{"tasks":[]}',ids));
});
test('analysis makes exactly one call through the chosen provider',async()=>{
  let calls=0;const context=buildTaskContext({tasks,projects,today:'2026-11-02'});
  const r=await analyzeTasks({provider:'local',model:'m',context,request:async body=>{calls++;assert.equal(body.model,'m');return {content:'{"tasks":[],"suggestions":[],"issues":[]}'};}});
  assert.equal(calls,1);assert.deepEqual(r.tasks,[]);
  await assert.rejects(analyzeTasks({provider:'nope',model:'m',context}));
});
