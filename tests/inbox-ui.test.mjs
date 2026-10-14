import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationKey} from '../dist/core.js';
import {createInboxFixture,notice} from './helpers/inbox-ui-fixture.mjs';

test('Inbox opens as a compact list with accessible filters and a closed source disclosure that retains limitations and settings',()=>{
  const f=createInboxFixture({syncHTML:'<p class="inbox-sync-status" role="status">Synthetic refresh status</p>'});
  assert.match(f.html,/<h1>Mitteilungen<\/h1>/);assert.match(f.html,/class="inbox-workspace|inbox-layout inbox-workspace/);assert.doesNotMatch(f.html,/<aside|inbox-connections/);
  assert.match(f.html,/<details class="inbox-sources"[^>]*>/);assert.match(f.html,/Synthetic refresh status/);assert.match(f.html,/Teilstand: maximal 100 Textvorschauen|Synthetic access error|Browser-Stand: nur ein Teil/);
  assert.match(f.html,/data-action="desktop-notifications"/);assert.match(f.html,/ohne Betreff auf dem Sperrbildschirm|Hinweise funktionieren bei geöffnetem Hub/);
  assert.match(f.html,/Mails und Nachrichten bleiben beim Anbieter ungelesen/);assert.match(f.html,/for="inbox-source"/);assert.match(f.html,/for="inbox-group"/);assert.match(f.html,/value="__unassigned__"/);
  assert.equal(f.control(n=>n['data-value']==='all').attrs['aria-pressed'],'true');assert.equal(f.control(n=>n['data-value']==='new').attrs['aria-pressed'],'false');
});

test('actual notification rows keep course assignment closed, show an excerpt and provide named original/read controls',()=>{
  const item=notice('one'),f=createInboxFixture({items:[item]}),row=f.row(item);
  assert.match(row,/<details class="inbox-assignment"[^>]*>/);assert.match(row,/aria-label="Kurs zuordnen: Synthetic notice one"/);assert.match(row,/data-notification-course="one"/);
  assert.match(row,/already-delivered message excerpt/);assert.match(row,/Course team|Prototyping/);assert.match(row,/Auszug/);
  assert.match(row,/href="https:\/\/chat\.coco\.study\/course\/pl\/one"/);assert.match(row,/rel="noopener noreferrer"/);assert.match(row,/aria-label="Original öffnen: Synthetic notice one" title="Original öffnen"/);
  assert.match(row,/aria-label="Synthetic notice one im Hub abhaken" title="Synthetic notice one im Hub abhaken" aria-pressed="false"/);
  assert.doesNotMatch(f.compact(item),/data-notification-course|inbox-assignment|inbox-original/);
});

test('provider text, group names, errors and action labels remain escaped and cannot introduce active markup',()=>{
  const item=notice('safe-id',{title:'<img src=x onerror=alert(1)>',content:'<script>evil()</script> " &',groupName:'<svg onload=evil()>',summary:'Unsafe <a>'}),f=createInboxFixture({items:[item]});
  f.sandbox.sourceStates[1].message='<iframe src=https://evil.invalid>';f.render();
  assert.doesNotMatch(f.html,/<script>|<iframe|<img src=x|<svg onload|onerror="/);assert.match(f.html,/&lt;script&gt;evil\(\)&lt;\/script&gt;/);assert.match(f.html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.match(f.html,/&lt;iframe/);
  const noOriginal=f.row({...item,url:'javascript:alert(1)'});assert.doesNotMatch(noOriginal,/href="javascript:/);
});

test('course assignment exposes manual and ambiguous resolution without replacing the preview or hiding the action',()=>{
  const item=notice('one'),f=createInboxFixture({items:[item]});
  f.sandbox.resolveNotificationCourse=()=>({projectId:'prototyping',manual:true,ambiguous:false});
  assert.match(f.row(item),/aria-description="Manuell zugeordnet" title="Manuell zugeordnet"/);
  f.sandbox.resolveNotificationCourse=()=>({projectId:'',manual:false,ambiguous:true});
  const row=f.row({...item,projectId:'',url:'https://example.org/synthetic',groupUrl:''});
  assert.match(row,/Mehrere passende Kurse — bitte zuordnen/);assert.match(row,/Ohne Kurszuordnung/);assert.match(row,/data-notification-course="one"/);assert.match(row,/already-delivered message excerpt/);
});

test('actual source/group/new handlers combine filters and local read state without provider writes',async()=>{
  const one=notice('one'),two=notice('two',{groupId:'second',groupName:'Second team'}),spaces=notice('spaces',{source:'spaces',url:'https://spaces.th-koeln.de/prototyping-things-w26/synthetic/'}),f=createInboxFixture({items:[one,two,spaces]});
  await f.change('inbox-source','mattermost');assert.match(f.html,/data-action="open-notification" data-id="one"/);assert.match(f.html,/data-action="open-notification" data-id="two"/);assert.doesNotMatch(f.html,/data-action="open-notification" data-id="spaces"/);
  await f.change('inbox-group','mattermost_second');assert.match(f.html,/data-action="open-notification" data-id="two"/);assert.doesNotMatch(f.html,/data-action="open-notification" data-id="one"/);
  f.click('read-notification','two');assert.ok(f.state.inboxRead.includes(notificationKey(two)));f.click('inbox-filter','new');
  assert.match(f.html,/Keine neuen Hinweise/);assert.doesNotMatch(f.html,/class="notification-row/);assert.deepEqual(f.effects,[]);
  f.click('inbox-filter','all');f.click('open-notification','two');assert.deepEqual(f.effects,['preview:two']);
});

test('unassigned notices stay reachable from an active course and the existing course assignment moves the local row into that course',async()=>{
  const unassigned=notice('unassigned',{projectId:'',url:'https://chat.coco.study/unrelated/pl/unassigned',groupUrl:'https://chat.coco.study/unrelated/channels/other'}),assigned=notice('assigned'),f=createInboxFixture({items:[unassigned,assigned]});
  f.state.activeCourse='prototyping';f.render();assert.doesNotMatch(f.html,/data-id="unassigned"/);
  await f.change('inbox-group','__unassigned__');assert.match(f.html,/data-id="unassigned"/);assert.doesNotMatch(f.html,/data-id="assigned"/);
  await f.assign('unassigned','prototyping');assert.equal(f.state.notificationCourses.unassigned,'prototyping');assert.doesNotMatch(f.html,/data-id="unassigned"/);assert.deepEqual(f.effects,[]);
  await f.change('inbox-group','all');assert.match(f.html,/data-id="unassigned"/);assert.match(f.html,/data-id="assigned"/);
});

test('a bounded rendered page exposes More and refresh, preserves unknown provider time, and disables refresh while checking',()=>{
  const items=Array.from({length:55},(_,i)=>notice('item-'+i,{createdAt:''})),f=createInboxFixture({items});
  assert.equal((f.html.match(/class="notification-row inbox-notice/g)||[]).length,50);assert.match(f.html,/Weitere 5 Hinweise/);assert.match(f.html,/Zeitpunkt unbekannt/);
  f.click('more-notifications');assert.equal((f.html.match(/class="notification-row inbox-notice/g)||[]).length,55);
  f.click('refresh-feed');assert.deepEqual(f.effects,['refresh']);f.sandbox.feedBusy=true;f.sandbox.feedCheckedAt='invalid';f.render();assert.equal(f.control(n=>n['data-action']==='refresh-feed').disabled,true);assert.doesNotMatch(f.html,/Invalid Date/);
});
