import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAgentReply,parseAgentJSON,runProjectAgent} from '../dist/knowledge.js';

test('the protocol object is found inside reasoning, prose, code fences and raw line breaks',()=>{
  const answer={type:'answer',text:'ok',citations:[]};
  for(const content of [
    '<think>Ich prüfe {zuerst} die README.</think>\n'+JSON.stringify(answer),
    'Gedanken ohne Anfang</think>'+JSON.stringify(answer),
    'Hier ist meine Antwort:\n```json\n'+JSON.stringify(answer)+'\n```\nViel Erfolg!',
    'Klar! '+JSON.stringify(answer)+' – fertig.',
  ])assert.deepEqual(validateAgentReply(content),answer,content.slice(0,40));
  assert.equal(validateAgentReply('{"type":"answer","text":"## README\n- [ ] Ziel fehlt\n- \\"Quellen\\" fehlen","citations":[]}').text,'## README\n- [ ] Ziel fehlt\n- "Quellen" fehlen');
  assert.equal(validateAgentReply('Ich rufe auf: {"type":"tool","tool":"list_tasks","args":{}}').tool,'list_tasks');
});

test('prose, partial objects and other JSON stay invalid',()=>{
  for(const content of ['Die README fehlt noch.','{"type":"answer","text":"abgeschnitten','[{"type":"answer"}]','{"foo":1}','<think>{"type":"answer","text":"nur im Denken","citations":[]}</think>'])
    assert.throws(()=>validateAgentReply(content),undefined,content);
});

test('after two corrections a prose final answer is shown once something was read; a tool in prose is never run',async()=>{
  const ws={projects:[],notes:[],tasks:[],calendarEvents:[],boardFindings:[],bookmarks:[],tools:[]};
  const tool=JSON.stringify({type:'tool',tool:'list_tasks',args:{}});
  let replies=[tool,'Deiner README fehlen Ziel und Quellen.','Immer noch Fließtext: Ziel und Quellen fehlen.'],calls=0;
  let result=await runProjectAgent({prompt:'Was fehlt in meiner README?',workspace:ws,documents:[],complete:async()=>{calls++;return {content:replies.shift()};}});
  assert.equal(result.content,'Immer noch Fließtext: Ziel und Quellen fehlen.');assert.equal(calls,3);
  replies=['Nur Fließtext ohne Lesen.','Wieder Fließtext.'];
  await assert.rejects(runProjectAgent({prompt:'Hallo',workspace:ws,documents:[],complete:async()=>({content:replies.shift()})}),/keine gültige Assistenten-Antwort/,'without any read step prose is not accepted');
});
