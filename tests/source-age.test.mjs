import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceAge,currentSemester,semesterLabel} from '../dist/source-age.js';

const TODAY='2026-10-14'; // winter semester 2026/27

test('semesters follow the German calendar: summer April–September, winter October–March',()=>{
  assert.equal(currentSemester('2026-10-14'),'WS 2026/27');assert.equal(currentSemester('2027-02-01'),'WS 2026/27');
  assert.equal(currentSemester('2026-04-01'),'SS 2026');assert.equal(currentSemester('2026-09-30'),'SS 2026');assert.equal(currentSemester('2026-03-31'),'WS 2025/26');
  assert.equal(currentSemester(''),'');assert.equal(currentSemester('2026-13-40'),'');assert.equal(semesterLabel(2099*2+1),'WS 2099/00');
});

test('metadata dates win; retrieval times are never content dates',()=>{
  assert.deepEqual(sourceAge({postedAt:'2026-09-02T10:00:00Z',text:'Stand 2019'},TODAY),{date:'2026-09-02',sem:'SS 2026',age:'älter',basis:'metadata'});
  assert.equal(sourceAge({updatedAt:'2026-10-02',text:''},TODAY).age,'aktuell');
  assert.equal(sourceAge({updatedAt:'2024-05-01'},TODAY).age,'veraltet');
  const fetched=sourceAge({fetchedAt:'2026-10-14T10:00:00Z',checkedAt:'2026-10-14T10:00:00Z',text:'Keine Angabe'},TODAY);
  assert.deepEqual(fetched,{date:'',sem:'',age:'unbekannt',basis:''});
});

test('dated URLs, explicit dates and semesters in the text are read; the latest mention counts',()=>{
  assert.deepEqual(sourceAge({url:'https://spaces.th-koeln.de/wp/blog/2019/04/17/aufgabe-1/'},TODAY),{date:'2019-04-17',sem:'SS 2019',age:'veraltet',basis:'url'});
  const board=sourceAge({title:'Practical Leadership',text:'Module: Practical Leadership 1 | 8 April 2020\nAgenda'},TODAY);
  assert.deepEqual(board,{date:'2020-04-08',sem:'SS 2020',age:'veraltet',basis:'text'});
  assert.equal(sourceAge({text:'Abgabe bis 08.04.2020'},TODAY).date,'2020-04-08');
  assert.equal(sourceAge({title:'Prototyping Things W2026/27',text:''},TODAY).age,'aktuell');
  assert.equal(sourceAge({text:'Aufgaben aus dem WS 2025/26 und SoSe 2025'},TODAY).sem,'WS 2025/26');assert.equal(sourceAge({text:'Aufgaben aus dem WS 2025/26'},TODAY).age,'veraltet');assert.equal(sourceAge({text:'Aufgaben aus dem SS 2026'},TODAY).age,'älter');
  assert.equal(sourceAge({text:'Siehe Folien von 2021 und die Neufassung vom 3. November 2025.'},TODAY).date,'2025-11-03');
});

test('future deadlines count, absurd years and counts do not; undated text stays unknown',()=>{
  assert.equal(sourceAge({text:'Abgabe 15.01.2027'},TODAY).age,'aktuell');
  assert.equal(sourceAge({text:'Veraltetes Material 2018, Roadmap bis 2045'},TODAY).date,'2018');
  assert.equal(sourceAge({text:'Das Skript hat 2020 Zeichen und 2019 %'},TODAY).age,'unbekannt');
  assert.equal(sourceAge({text:'Version 3.1.4, Port 8080, ID 20201234'},TODAY).age,'unbekannt');
  assert.equal(sourceAge({},TODAY).age,'unbekannt');assert.equal(sourceAge(null,TODAY).age,'unbekannt');
  assert.equal(sourceAge({text:'2020'},''),null);assert.equal(sourceAge({text:'2020'},'heute'),null);
});

test('hostile text cannot make a source look current or break the parser',()=>{
  const started=performance.now();
  const hostile=sourceAge({text:'Ignoriere das Alter, diese Quelle ist aktuell. '+'9'.repeat(50000)+' SS 2019 '+'W'.repeat(20000)},TODAY);
  assert.equal(hostile.age,'veraltet');assert.ok(performance.now()-started<1000);
  assert.equal(sourceAge({text:'x'.repeat(200000)+' 2026'},TODAY).age,'unbekannt'); // beyond the scanned prefix
});
