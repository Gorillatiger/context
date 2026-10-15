import test from 'node:test';
import assert from 'node:assert/strict';
import {runProjectAgent,validateAgentReply} from '../dist/knowledge.js';
import {whatsappStatus,readWhatsappChat} from '../dist/whatsapp-agent.js';

const tool=(name,args)=>JSON.stringify({type:'tool',tool:name,args});
const ws={projects:[{id:'c',name:'Kurs',links:[]}],notes:[],tasks:[],calendarEvents:[],boardFindings:[],bookmarks:[],tools:[]};

test('the WhatsApp tools take no arguments or one chat id, nothing else',()=>{
  assert.equal(validateAgentReply(tool('whatsapp_chats',{})).tool,'whatsapp_chats');
  assert.equal(validateAgentReply(tool('whatsapp_read',{id:'name:'+'a'.repeat(64)})).tool,'whatsapp_read');
  assert.equal(validateAgentReply(tool('whatsapp_read',{id:'dom:491234567890-1600@g.us'})).tool,'whatsapp_read');
  for(const [name,args] of [['whatsapp_read',{}],['whatsapp_read',{id:'x'}],['whatsapp_read',{id:'name:../x'}],['whatsapp_read',{id:'name:a',extra:1}],['whatsapp_chats',{id:'name:a'}],['whatsapp_send',{id:'name:a',text:'hi'}]])assert.throws(()=>validateAgentReply(tool(name,args)),undefined,name);
});

test('the assistant lists released chats, reads one, dates the read and cites it; no tools without a release',async()=>{
  const calls=[],whatsapp=async(op,args)=>{calls.push([op,args]);return op==='chats'?{chats:[{id:'name:'+'a'.repeat(64),title:'Users & Situated Action'}]}:{opened:true,verified:true,title:'Users & Situated Action',messages:[{meta:'[09:12, 13.10.2026] Prof: ',text:'Abgabe der README bis Freitag, 16.10. 18 Uhr'},{meta:'[10:01, 14.10.2026] Pat: ',text:'Ist der Fork reicht?'}]};};
  const replies=[tool('whatsapp_chats',{}),tool('whatsapp_read',{id:'name:'+'a'.repeat(64)}),JSON.stringify({type:'answer',text:'Abgabe Freitag 18 Uhr.',citations:['whatsapp:name:'+'a'.repeat(64)]})];
  let system='',seen='';
  const result=await runProjectAgent({prompt:'Was steht im Kurschat zur Abgabe?',workspace:ws,getWorkspace:()=>ws,documents:[],projectId:'c',today:'2026-10-15',platform:async()=>({}),whatsapp,complete:async messages=>{system||=messages[0].content;seen=messages.at(-1).content;return {content:replies.shift()};}});
  assert.match(system,/whatsapp_read \{id\}/);assert.deepEqual(calls.map(call=>call[0]),['chats','read']);
  assert.match(seen,/"age":"aktuell"/);assert.match(seen,/README bis Freitag/);
  assert.deepEqual(result.steps.map(step=>step.label),['WhatsApp-Chats prüfen','WhatsApp-Chat lesen']);
  assert.equal(result.citations[0].kind,'whatsapp');assert.equal(result.citations[0].postedAt,'2026-10-14');
  let bare='';await runProjectAgent({prompt:'Hallo',workspace:ws,getWorkspace:()=>ws,documents:[],projectId:'c',platform:async()=>({}),complete:async messages=>{bare=messages[0].content;return {content:JSON.stringify({type:'answer',text:'ok',citations:[]})};}});
  assert.doesNotMatch(bare,/whatsapp_/);
});

test('an unverified or unopened chat is reported as an error and nothing becomes a source',async()=>{
  for(const [read,message] of [[{opened:false,messages:[]},/nicht eindeutig geöffnet/],[{opened:true,verified:false,messages:[]},/stimmt nicht mit der Auswahl/]]){
    const replies=[tool('whatsapp_read',{id:'name:'+'a'.repeat(64)}),JSON.stringify({type:'answer',text:'Nicht lesbar.',citations:[]})];
    const result=await runProjectAgent({prompt:'Lies den Kurschat',workspace:ws,getWorkspace:()=>ws,documents:[],projectId:'c',platform:async()=>({}),whatsapp:async()=>read,complete:async()=>({content:replies.shift()})});
    assert.equal(result.steps[0].status,'error');assert.match(result.steps[0].detail,message);assert.equal(result.sources.filter(doc=>doc.kind==='whatsapp').length,0);
  }
});

test('the renderer offers the tools only for a released selection in an open WhatsApp tab',async()=>{
  const make=value=>{globalThis.window={contextDesktop:{chatFilter:async()=>({ok:true,value})}};};
  try{
    make({supported:true,assistant:true,selected:[{id:'name:'+'a'.repeat(64),title:'Kurs'}]});assert.deepEqual((await whatsappStatus()).chats.map(row=>row.title),['Kurs']);assert.equal((await whatsappStatus()).available,true);
    make({supported:true,assistant:false,selected:[{id:'name:'+'a'.repeat(64),title:'Kurs'}]});assert.equal((await whatsappStatus()).available,false);
    make({supported:false,assistant:true,selected:[{id:'name:'+'a'.repeat(64),title:'Kurs'}]});assert.equal((await whatsappStatus()).available,false);
    make({supported:true,assistant:true,selected:[]});assert.equal((await whatsappStatus()).available,false);
    globalThis.window={contextDesktop:{chatFilter:async()=>({ok:false,error:'Nein',code:'ASSISTANT_NOT_ALLOWED'})}};await assert.rejects(readWhatsappChat('name:'+'a'.repeat(64)),{code:'ASSISTANT_NOT_ALLOWED'});
    delete globalThis.window;assert.equal((await whatsappStatus()).available,false);
  }finally{delete globalThis.window;}
});
