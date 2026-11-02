import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDiaryCalendar} from '../dist/course-timeline.js';

const diary={projectId:'p',startDate:'2026-11-04',endDate:'2026-11-10',entries:[{date:'2026-11-05',done:'x',completed:true}]};
const state={
  calendarEvents:[{projectId:'p',title:'Vorlesung',start:'2026-11-05T08:00:00Z',end:'2026-11-05T09:00:00Z'},{projectId:'q',title:'Fremd',start:'2026-11-05T08:00:00Z',end:'2026-11-05T09:00:00Z'},{projectId:'p',title:'Außerhalb',start:'2026-12-01T08:00:00Z',end:'2026-12-01T09:00:00Z'}],
  tasks:[{projectId:'p',title:'Abgabe',due:'2026-11-09',status:'todo'}]
};

test('calendar covers whole Monday-Sunday weeks but only fills the diary period',()=>{
  const {weeks,counts}=buildDiaryCalendar(diary,state,{today:'2026-11-05'});
  assert.equal(weeks.length,2);assert.ok(weeks.every(w=>w.length===7));
  assert.equal(weeks[0][0].date,'2026-11-02');assert.equal(weeks[0][0].inRange,false);
  assert.deepEqual(counts,{events:2,tasks:1});
});

test('only this course contributes and entries mark days',()=>{
  const cells=buildDiaryCalendar(diary,state,{today:'2026-11-05'}).weeks.flat();
  const d5=cells.find(c=>c.date==='2026-11-05');
  assert.equal(d5.today,true);assert.equal(d5.completed,true);assert.deepEqual(d5.items.map(i=>i.title),['Vorlesung']);
  assert.equal(cells.find(c=>c.date==='2026-11-09').items[0].kind,'task');
  assert.equal(cells.flatMap(c=>c.items).some(i=>i.title==='Fremd'||i.title==='Außerhalb'),false);
});

test('invalid periods produce no calendar',()=>{
  assert.deepEqual(buildDiaryCalendar({startDate:'2026-11-10',endDate:'2026-11-01'},state).weeks,[]);
});
