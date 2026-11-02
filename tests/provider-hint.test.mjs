import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {providerSwitchHint} from '../dist/provider-hint.js';

const coded=(code,message='x')=>Object.assign(new Error(message),{code});

test('university AI points to other providers when a task is too big or limited',()=>{
  for(const code of ['conversation_limit','body_limit','response_limit','timeout','provider_limit','local_limit']){
    assert.deepEqual(providerSwitchHint('kiconnect',coded(code)),{providers:['openrouter','local']},code);
  }
});

test('the hint also recognises the readable message when no code survived',()=>{
  assert.ok(providerSwitchHint('kiconnect',new Error('Bitte kurz warten. Höchstens zehn KI-Anfragen pro Minute.')));
  assert.ok(providerSwitchHint('kiconnect',new Error('Das KI:connect NRW-Limit ist erreicht. Bitte später erneut versuchen.')));
});

test('no hint for other providers, unrelated errors or a deliberate stop',()=>{
  assert.equal(providerSwitchHint('openrouter',coded('timeout')),null);
  assert.equal(providerSwitchHint('local',coded('conversation_limit')),null);
  assert.equal(providerSwitchHint('kiconnect',coded('invalid_model','Bitte ein verfügbares Modell wählen.')),null);
  assert.equal(providerSwitchHint('kiconnect',new DOMException('Abgebrochen','AbortError')),null);
  assert.equal(providerSwitchHint('kiconnect',null),null);
});

test('the chat shows switch buttons only under the failed message, never switches by itself and keeps the draft',()=>{
  const source=readFileSync(new URL('../dist/ki.js',import.meta.url),'utf8');
  assert.match(source,/m\.failed&&state\.switchHint\?\.messageId===m\.id\?switchHintUI/);
  assert.match(source,/action==='switch-provider'&&!state\.busy[^;]*state\.switchHint\.providers\.includes\(button\.dataset\.provider\)/);
  assert.match(source,/switchProvider\(button\.dataset\.provider,state\.switchHint\.prompt\)/);
  assert.match(source,/state\.switchHint=null;state\.steps=\[\]/);
});
