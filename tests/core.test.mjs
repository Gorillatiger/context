import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, validateState, safeURL, searchState, validateDate, dateKey, taskNotifications, notificationKey } from '../dist/core.js';

test('backups round trip and missing Webmail migrates without losing project links',()=>{
  const original=initialState();original.tools=original.tools.filter(t=>t.id!=='webmail');
  original.bookmarks.push({id:'item-1',title:'Abgabe',tool:'sciebo',url:'https://th-koeln.sciebo.de/',projectId:'prototyping',note:'Material'});
  const checked=validateState(JSON.parse(JSON.stringify(original)));
  assert.equal(checked.tools.length,10);assert.equal(checked.bookmarks[0].projectId,'prototyping');assert.equal(checked.projects[0].links[0].url,original.projects[0].links[0].url);
});
test('URLs reject executable schemes, credentials and unencrypted endpoints',()=>{
  for(const value of ['javascript:alert(1)','data:text/html,test','http://example.com','https://user:password@example.com','file:///etc/passwd'])assert.throws(()=>safeURL(value));
  assert.equal(safeURL('https://spaces.th-koeln.de/'),'https://spaces.th-koeln.de/');
});
test('malformed backup IDs, duplicate IDs, dangling projects and malicious URLs fail before import',()=>{
  for(const mutate of [s=>s.projects[0].id='<img>',s=>s.projects.push(s.projects[0]),s=>s.projects[0].links[0].url='javascript:alert(1)',s=>s.tools.push(s.tools[0]),s=>s.tasks.push({id:'x',title:'Task',projectId:'unknown',status:'todo',due:'',url:''})]){const s=initialState();mutate(s);assert.throws(()=>validateState(s));}
});
test('text remains text and multiline project notes survive validation',()=>{
  const s=initialState();s.projects[0].name='<img src=x onerror=alert(1)>';s.projects[0].note='Zeile eins\nZeile zwei';
  const result=validateState(s);assert.equal(result.projects[0].name,s.projects[0].name);assert.equal(result.projects[0].note,s.projects[0].note);
});
test('search spans sources, links, project notes and tasks and excludes archived projects',()=>{
  const s=initialState();s.projects[0].note='Material Probe';s.tasks.push({id:'task1',title:'Foto dokumentieren',projectId:'prototyping',status:'todo',due:'',url:''});
  assert.equal(searchState(s,'material probe')[0].type,'project');assert.equal(searchState(s,'Foto')[0].type,'task');assert.equal(searchState(s,'webmail')[0].type,'tool');
  s.projects[0].archived=true;assert.equal(searchState(s,'Material').filter(r=>r.type==='project').length,0);
});
test('date validation rejects normalized invalid dates and handles Berlin midnight',()=>{
  for(const v of ['2026-02-30','2026-99-01','2026-1-1','hello'])assert.throws(()=>validateDate(v));
  assert.equal(validateDate('2028-02-29'),'2028-02-29');assert.equal(dateKey(new Date('2026-10-11T22:30:00Z')),'2026-10-12');
});
test('notifications derive from genuinely due open tasks; read markers are revision-specific',()=>{
  const s=initialState();const today=dateKey();s.tasks=[{id:'a',title:'Jetzt',status:'todo',due:today,url:''},{id:'b',title:'Später',status:'todo',due:'2099-01-01',url:''},{id:'c',title:'Erledigt',status:'done',due:today,url:''}];
  const ns=taskNotifications(s);assert.equal(ns.length,1);assert.equal(ns[0].id,'task_a');assert.notEqual(notificationKey({...ns[0],revision:'1'}),notificationKey({...ns[0],revision:'2'}));
});
