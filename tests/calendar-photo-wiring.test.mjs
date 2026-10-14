import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalendarView} from '../dist/calendar.js';
import {initialState} from '../dist/core.js';
import {calendarRequestAllowed,prepareCalendarAction,calendarICSForIds} from '../dist/calendar-agent.js';
import {runProjectAgent} from '../dist/knowledge.js';
import {importICS} from '../dist/calendar-engine.js';

function photoButtonPrompt(){
 const previousDocument=globalThis.document,previousWindow=globalThis.window,handlers=new Map();
 let prompt='';
 globalThis.document={visibilityState:'visible',addEventListener:(type,fn)=>handlers.set(type,fn),removeEventListener(){},getElementById:()=>null};
 globalThis.window={};
 const view=createCalendarView({getContext:()=>({workspace:initialState(),updates:[]}),onChange(){},onSave:()=>true,onShow(){},onTask(){},onAsk:value=>{prompt=value;}});
 try{handlers.get('click')({target:{closest:()=>({dataset:{calendar:'photo'}})},preventDefault(){}});return prompt;}
 finally{view.dispose();globalThis.document=previousDocument;globalThis.window=previousWindow;}
}
const excerpt='16.10.2026 10:00–12:00 · Prototyping im Labor';
const photo={id:'photo:ui-wiring-fixture',kind:'photo',title:'Terminplan.png',projectId:'prototyping',status:'excerpt',text:excerpt};
const args={projectId:'prototyping',events:[{title:'Prototyping im Labor',start:'2026-10-16T10:00:00+02:00',end:'2026-10-16T12:00:00+02:00',allDay:false,sourceId:photo.id,excerpt}]};
const tool=(name,values)=>({content:JSON.stringify({type:'tool',tool:name,args:values})});

test('the actual timetable-photo button prompt authorizes the selected direct-import mode',()=>{
 const prompt=photoButtonPrompt();assert.match(prompt,/Terminplan-Foto/);assert.equal(calendarRequestAllowed(prompt),true,'the UI-generated request must not accidentally trigger the proposal-only guards');
});

for(const direct of [false,true])test(`the actual photo button request ${direct?'imports sourced events once with ICS':'stays a proposal without local writes'} when direct import is ${direct?'on':'off'}`,async()=>{
 const workspace=initialState(),writes=[];
 const replies=[tool('read_source',{id:photo.id}),tool('create_calendar',args),{content:JSON.stringify({type:'answer',text:'Der Termin wurde verarbeitet.',citations:[photo.id]})}];
 const result=await runProjectAgent({prompt:photoButtonPrompt(),documents:[photo],workspace,projectId:'prototyping',allowActions:false,allowCalendarActions:direct,complete:async()=>{const reply=replies.shift();assert(reply,'unexpected extra model step');return reply;},execute:action=>{
  const next=prepareCalendarAction(action,workspace);workspace.calendarEvents=next.calendarEvents;writes.push(action);
  return {id:action.id,saved:true,eventIds:next.eventIds};
 }});
 if(direct){
  assert.equal(writes.length,1);assert.equal(workspace.calendarEvents.length,1);assert.equal(result.proposals.length,0);
  const ids=workspace.calendarEvents.map(event=>event.id),exported=calendarICSForIds(ids,workspace),roundTrip=importICS(exported);
  assert.equal(roundTrip.events.length,1);assert.equal(roundTrip.events[0].start,'2026-10-16T08:00:00.000Z');assert.equal(roundTrip.events[0].end,'2026-10-16T10:00:00.000Z');
 }else{
  assert.equal(writes.length,0);assert.equal(workspace.calendarEvents.length,0);assert.equal(result.proposals.length,1);assert.equal(result.proposals[0].tool,'create_calendar');
 }
});
