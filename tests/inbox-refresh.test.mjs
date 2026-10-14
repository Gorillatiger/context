import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {notificationGroups,notificationGroup,resolveNotificationGroup,parseNotificationItems,compareNotificationTime,notificationTime} from '../dist/inbox.js';
import {notificationKey} from '../dist/core.js';

const item=(id,group='B',extra={})=>({id,source:'gitlab',title:'Kursaufgabe',summary:'Hinweis',groupId:'project_'+group,groupName:'Gruppe '+group,url:'https://git.coco.study/course/'+group,createdAt:'2026-10-13T12:00:00Z',...extra});
test('the actual Inbox renderer resets a vanished selected group before filtering the refreshed feed',()=>{
 const source=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('function filteredInboxItems()'),source.indexOf('\nfunction previewNotification('));
 const context={inboxGroup:'gitlab_project_A',inboxSource:'all',inboxFilter:'all',inboxLimit:50,feedBusy:false,feedCheckedAt:'',hasLocalConnector:true,sourceStates:[],state:{projects:[],activeCourse:'',inboxRead:[],notificationSettings:{desktop:false}},inboxItems:()=>[item('retained')],notificationGroups,notificationGroup,notificationKey,resolveNotificationGroup,formatSnapshotTime:()=>'',heading:()=>'',icon:()=>'',esc:String,sourceName:String,notificationRow:n=>'VISIBLE:'+n.id,empty:()=>''};
 vm.createContext(context);vm.runInContext(code,context);
 assert.match(vm.runInContext('renderInbox()',context),/VISIBLE:retained/);assert.equal(context.inboxGroup,'all');
 context.inboxGroup='gitlab_project_B';vm.runInContext('renderInbox()',context);assert.equal(context.inboxGroup,'gitlab_project_B');
});
test('a missing publication date does not make the valid sibling notification disappear',()=>{
 const result=parseNotificationItems([item('undated','A',{createdAt:''}),item('dated')]);
 assert.equal(result.length,2);assert.equal(result[0].createdAt,'');assert.equal(notificationTime(result[0]),'Zeitpunkt unbekannt');
 for(const bad of [null,{},item('bad','B',{createdAt:'invalid date'}),item('bad','B',{createdAt:42}),item('bad','B',{url:'javascript:alert(1)'})])assert.throws(()=>parseNotificationItems([bad]));
});
test('notification sorting puts unknown publication times last and uses observation time only for summaries',()=>{
 const result=[item('unknown','B',{createdAt:'',observedAt:'2026-10-13T18:00:00Z'}),item('older','B',{createdAt:'2026-10-12T12:00:00Z'}),item('summary','B',{kind:'summary',createdAt:'',observedAt:'2026-10-13T13:00:00Z'}),item('newer')].sort(compareNotificationTime);
 assert.deepEqual(result.map(n=>n.id),['summary','newer','older','unknown']);assert.equal(compareNotificationTime({createdAt:''},{createdAt:''}),0);
});
test('summary observation, missing time and future publication are displayed without invented freshness',()=>{
 const now=Date.parse('2026-10-13T12:30:00Z');
 assert.equal(notificationTime(item('one'),now),'vor 30 Min.');
 assert.equal(notificationTime(item('summary','B',{kind:'summary',createdAt:'',observedAt:'2026-10-13T12:00:00Z'}),now),'Stand: vor 30 Min.');
 assert.equal(notificationTime(item('summary','B',{kind:'summary',createdAt:''}),now),'Stand unbekannt');
 assert.match(notificationTime(item('future','B',{createdAt:'2026-10-14T12:00:00Z'}),now),/^am /);
 assert.equal(notificationTime(item('snapshot','B',{displayedTime:'Gestern · 09:10'}),now),'Gestern · 09:10');
});
test('Mattermost post permalinks keep the course association through their same-origin channel metadata',async()=>{
 const {notificationCourse}=await import('../dist/core.js');
 const workspace={projects:[{id:'course-a',links:[{url:'https://chat.coco.study/students/channels/course-a'}]}],notificationCourses:{}};
 const [post]=parseNotificationItems([{...item('mattermost_one'),source:'mattermost',url:'https://chat.coco.study/students/pl/post-one',groupUrl:'https://chat.coco.study/students/channels/course-a'}]);
 assert.equal(notificationCourse(post,workspace),'course-a');assert.match(post.url,/\/pl\/post-one$/);
 const [foreign]=parseNotificationItems([{...post,groupUrl:'https://foreign.example/students/channels/course-a'}]);assert.equal(foreign.groupUrl,'');assert.equal(notificationCourse(foreign,workspace),'');
 assert.equal(notificationCourse({...post,groupUrl:'javascript:alert(1)'},workspace),'');
 workspace.notificationCourses[post.id]='';assert.equal(notificationCourse(post,workspace),'');
});
