import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,validateState,searchState} from '../dist/core.js';
import {calendarEventFromForm,mergeCalendarEvents,eventOnDay,monthCells} from '../dist/calendar.js';
import {validateCalendarEvent} from '../dist/calendar-engine.js';
import {buildKnowledge} from '../dist/knowledge.js';
import {cleanChat} from '../dist/chat-archive.js';
const event=(patch={})=>validateCalendarEvent({id:'google-a',title:'Quelltermin',projectId:'prototyping',start:'2026-10-25T00:30:12.123Z',end:'2026-10-25T01:30:12.456Z',source:{kind:'google',title:'Kurskalender',url:'https://calendar.google.com/calendar/',excerpt:'Originaltext',externalId:'a'},...patch});
test('old backups migrate and calendar data round-trips without credentials',()=>{
 const old=initialState();delete old.calendarEvents;assert.deepEqual(validateState(old).calendarEvents,[]);
 const s=initialState();s.calendarEvents=[event()];s.oauthTokens='secret';const copy=validateState(JSON.parse(JSON.stringify(s)));assert.deepEqual(copy.calendarEvents,s.calendarEvents);assert.equal(copy.oauthTokens,undefined);
 for(const invalid of [null,0,false,{},'bad'])assert.throws(()=>validateState({...s,calendarEvents:invalid}));
 assert.throws(()=>validateState({...s,calendarEvents:[event({projectId:'missing'})]}));
});
test('course-only edit retains provider instants and metadata at the ambiguous autumn hour',()=>{
 const s=initialState();s.calendarEvents=[event()];const draft={...s.calendarEvents[0],start:'2026-10-25T02:30',end:'2026-10-25T02:30'};
 const changed=calendarEventFromForm(draft,{projectId:'go-public',title:'Tampered',start:'bad',end:'bad'},s);
 assert.deepEqual(changed,{...s.calendarEvents[0],projectId:'go-public'});assert.equal(s.calendarEvents[0].projectId,'prototyping');
 assert.throws(()=>calendarEventFromForm(draft,{projectId:'missing'},s));assert.throws(()=>calendarEventFromForm(draft,{projectId:'go-public'},{...s,calendarEvents:[]}));
});
test('local form treats the final all-day date as inclusive and rejects DST gaps',()=>{
 const s=initialState(),draft={id:'local-a',title:'Workshop',projectId:'prototyping',allDay:true};
 const e=calendarEventFromForm(draft,{title:'Workshop',projectId:'prototyping',start:'2026-10-16',end:'2026-10-18'},s);assert.equal(e.end,'2026-10-19');
 assert.equal(eventOnDay(e,'2026-10-18'),true);assert.equal(eventOnDay(e,'2026-10-19'),false);
 assert.throws(()=>calendarEventFromForm({...draft,allDay:false},{title:'Gap',projectId:'prototyping',start:'2026-03-29T02:30',end:'2026-03-29T03:30'},s));
});
test('source refresh is an immutable upsert and retains assigned courses',()=>{
 const old=[event()],fresh=event({title:'Geänderte Zeit',projectId:'',start:'2026-10-25T02:00:00Z',end:'2026-10-25T03:00:00Z'}),copy=JSON.stringify(old),next=mergeCalendarEvents(old,[fresh]);
 assert.equal(next.length,1);assert.equal(next[0].projectId,'prototyping');assert.equal(next[0].title,'Geänderte Zeit');assert.equal(JSON.stringify(old),copy);
 assert.throws(()=>mergeCalendarEvents(old,[fresh,fresh]));
});
test('month cells and actual Berlin day boundaries cover midnight, DST and multiday events',()=>{
 assert.equal(monthCells('2026-10')[0],'2026-09-28');assert.equal(monthCells('2026-10').length,42);assert.throws(()=>monthCells('2026-13'));
 const midnight=event({start:'2026-10-24T20:00:00Z',end:'2026-10-24T22:00:00Z'});assert.equal(eventOnDay(midnight,'2026-10-24'),true);assert.equal(eventOnDay(midnight,'2026-10-25'),false);
 assert.equal(eventOnDay(event(),'2026-10-25'),true);assert.equal(eventOnDay(event(),'2026-10-24'),false);
 const spring=event({start:'2026-03-28T23:00:00Z',end:'2026-03-29T22:00:00Z'});assert.equal(eventOnDay(spring,'2026-03-29'),true);assert.equal(eventOnDay(spring,'2026-03-30'),false);
});
test('calendar knowledge obeys source selection and course scope and archives that choice',()=>{
 const s=initialState();s.calendarEvents=[event(),event({id:'google-b',projectId:'go-public',title:'Anderer Kurs'})];
 assert.equal(searchState(s,'Quelltermin')[0].type,'calendar');const docs=buildKnowledge(s,[],{projectId:'prototyping',enabled:{calendar:true}});assert.equal(docs.length,1);assert.equal(docs[0].url,s.calendarEvents[0].source.url);assert.match(docs[0].text,/00:30:12.123Z/);
 assert.equal(buildKnowledge(s,[],{enabled:{calendar:false}}).length,0);s.projects[0].archived=true;assert.equal(buildKnowledge(s,[],{projectId:'prototyping',enabled:{calendar:true}}).length,0);
 const chat={version:1,id:crypto.randomUUID(),enabled:{calendar:true},messages:[]};assert.equal(cleanChat(chat).enabled.calendar,true);assert.equal(cleanChat({...chat,enabled:{}}).enabled.calendar,false);
});
