import test from 'node:test';
import assert from 'node:assert/strict';
import {assessEffort,offersSwitch,NARROW_NOTE} from '../dist/effort.js';
import {providerSwitchHint} from '../dist/provider-hint.js';
import {runProjectAgent} from '../dist/knowledge.js';

const base={provider:'kiconnect',projectId:'',courses:4,platforms:true,browser:true,history:0};

test('large tasks on the university model are weighed before any model call',()=>{
  const all=assessEffort({...base,prompt:'Fasse alle Abgaben aus allen Kursen zusammen.'});
  assert.ok(all.score>=5);assert.equal(all.recommend,'switch');assert.ok(all.reasons.some(reason=>/4 Kurse/.test(reason)));
  const course=assessEffort({...base,projectId:'kurs',prompt:'Vergleiche alle Feedbacks in diesem Kurs.'});assert.equal(course.recommend,'narrow');
  assert.ok(assessEffort({...base,projectId:'kurs',prompt:'x'.repeat(1600)}));
  assert.ok(assessEffort({...base,projectId:'kurs',platforms:false,browser:false,prompt:'Was ist A? Was ist B? Was ist C? Und D?',history:20}));
});

test('small or clear tasks and other providers are never interrupted',()=>{
  for(const prompt of ['Was ist meine nächste Aufgabe?','Fasse das Board hier zusammen.','Wann ist die Abgabe in Prototyping?','Welche Termine habe ich morgen?'])assert.equal(assessEffort({...base,projectId:'kurs',prompt}),null,prompt);
  for(const prompt of ['Fasse das Board hier zusammen.','Fasse diese Seite zusammen und vergleiche sie mit dem Briefing.'])assert.equal(assessEffort({...base,prompt}),null,'open page, no course chosen: '+prompt);
  assert.equal(assessEffort({...base,provider:'openrouter',prompt:'Fasse alle Abgaben aus allen Kursen zusammen.'}),null);
  assert.equal(assessEffort({...base,provider:'local',prompt:'Fasse alle Abgaben aus allen Kursen zusammen.'}),null);
  assert.equal(assessEffort({...base,prompt:null}),null);
});

test('only a real switch option triggers the switch; the narrow note asks for a short, recent, scoped search',()=>{
  assert.ok(offersSwitch('Zu OpenRouter wechseln'));assert.ok(offersSwitch('Mit OpenRouter vollständig suchen'));
  assert.ok(!offersSwitch('Nicht zu OpenRouter wechseln'));assert.ok(!offersSwitch('Ohne OpenRouter weiter'));assert.ok(!offersSwitch('Auf WS 2026/27 eingrenzen'));
  assert.match(NARROW_NOTE,/neueste/);assert.match(NARROW_NOTE,/frag mich/);
});

test('running out of steps or context on the university model offers the switch',()=>{
  for(const message of ['Der Assistent hat seine Schrittgrenze erreicht. Die bisherigen …','Das Kontextbudget ist erreicht. Die bisherigen Schritte …','Der Auftrag ist zu lang für den Projektkontext. Bitte kürze ihn.'])assert.ok(providerSwitchHint('kiconnect',new Error(message)),message);
  assert.equal(providerSwitchHint('openrouter',new Error('Der Assistent hat seine Schrittgrenze erreicht.')),null);
});

test('the model is told to weigh and offer the switch only on the university model',async()=>{
  const heads=[];
  for(const tightBudget of [true,false])await runProjectAgent({prompt:'Hallo',workspace:{projects:[],notes:[],tasks:[],calendarEvents:[],boardFindings:[],bookmarks:[],tools:[]},documents:[],today:'2026-10-14',tightBudget,complete:async messages=>{heads.push(messages[0].content.split('\nKONTEXT (Daten):\n')[0]);return {content:JSON.stringify({type:'answer',text:'ok',citations:[]})};}});
  assert.match(heads[0],/Knappes Modell \(Hochschul-KI/);assert.match(heads[0],/Zu OpenRouter wechseln/);assert.doesNotMatch(heads[1],/Knappes Modell/);
});
