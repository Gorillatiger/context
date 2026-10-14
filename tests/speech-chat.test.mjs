import {test} from 'node:test';
import assert from 'node:assert/strict';
import {speechArchiveFields,acceptSpeechFinal} from '../dist/speech-privacy.js';
test('private voice text, derived answer, live steps and mixed draft are not archived',()=>{
 const typed={role:'user',content:'typed'},voice={role:'user',content:'private',ephemeral:true},answer={role:'assistant',content:'derived private',ephemeral:true};
 const saved=speechArchiveFields({messages:[typed,voice,answer],draft:'typed plus dictation',voiceDraft:true,privateSpeechSession:true,busy:true,steps:[{detail:'private'}],attachments:[{text:'private'}]});
 assert.deepEqual(saved,{messages:[typed],draft:'',steps:[],attachments:[]});assert(!JSON.stringify(saved).includes('private'));
});
test('explicitly retained voice exchange uses normal archive fields',()=>{assert.deepEqual(speechArchiveFields({messages:[{content:'enabled'}],draft:'enabled'}),{messages:[{content:'enabled'}],draft:'enabled',steps:[],attachments:[]});});
test('a later opt-in never retroactively archives an earlier private dictation in a mixed draft',()=>{
 const seen=new Set();const first=acceptSpeechFinal({event:{id:'first',text:'Privater Satz',saveTranscript:false},seen,contextKey:'x',currentKey:'x'});
 const second=acceptSpeechFinal({event:{id:'second',text:'Freigegebener Satz',saveTranscript:true},seen,contextKey:'x',currentKey:'x',draft:first.draft,privateDraft:!first.saveTranscript});
 assert.equal(second.saveTranscript,false);assert.equal(second.draft,'Privater Satz\nFreigegebener Satz');
 assert.equal(speechArchiveFields({draft:second.draft,voiceDraft:!second.saveTranscript}).draft,'');
});
test('a voice contribution enters the chat draft only once and only in its original context',()=>{
 const seen=new Set(),event={id:'a',text:'Hallo, bitte meine Kurse prüfen.',autoSend:true};
 assert.equal(acceptSpeechFinal({event,contextKey:'old',currentKey:'new',seen}),null);
 const result=acceptSpeechFinal({event,contextKey:'old',currentKey:'old',seen,draft:'Kontext'});
 assert.equal(result.draft,'Kontext\nHallo, bitte meine Kurse prüfen.');assert.equal(result.autoSend,true);assert.equal(result.saveTranscript,false);
 assert.equal(acceptSpeechFinal({event,contextKey:'old',currentKey:'old',seen}),null);
});
test('silence and oversized instructions never auto-send; full text remains editable',()=>{
 assert.equal(acceptSpeechFinal({event:{id:'silence',text:'  '},seen:new Set(),contextKey:'x',currentKey:'x'}),null);
 const result=acceptSpeechFinal({event:{id:'long',text:'a'.repeat(6001),autoSend:true},seen:new Set(),contextKey:'x',currentKey:'x'});assert(result.tooLong);assert.equal(result.autoSend,false);assert.equal(result.draft.length,6001);
});
