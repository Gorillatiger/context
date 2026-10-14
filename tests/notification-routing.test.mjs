import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationCourse,resolveNotificationCourse,courseMatches} from '../dist/core.js';
import {buildKnowledge} from '../dist/knowledge.js';

const SPACE='https://spaces.th-koeln.de',CHAT='https://chat.coco.study',GIT='https://git.coco.study';
const project=(id,url,patch={})=>({id,name:id,archived:false,links:[{id:id+'-link',title:'Synthetic link',tool:'web',url}],...patch});
const state=()=>({projects:[project('alpha',SPACE+'/alpha/'),project('beta',SPACE+'/beta/'),project('old',SPACE+'/old/',{archived:true})],notificationCourses:{},notes:[],tasks:[],bookmarks:[],calendarEvents:[]});
const item=(patch={})=>({id:'synthetic_notice',source:'spaces',url:SPACE+'/alpha/post/1',title:'A real source notice',content:'SAFE_ALPHA_BODY',createdAt:'2026-10-13T12:00:00Z',...patch});

test('manual item assignment wins over every automatic hint, including an explicit unassigned choice',()=>{
 const s=state(),n=item({projectId:'beta',groupUrl:SPACE+'/beta/'});s.notificationCourses[n.id]='alpha';assert.deepEqual(resolveNotificationCourse(n,s),{projectId:'alpha',reason:'manual',manual:true,ambiguous:false});
 s.notificationCourses[n.id]='';assert.deepEqual(resolveNotificationCourse(n,s),{projectId:'',reason:'manual-unassigned',manual:true,ambiguous:false});assert.equal(notificationCourse(n,s),'');
 for(const target of ['old','missing']){s.notificationCourses[n.id]=target;assert.equal(resolveNotificationCourse(n,s).reason,'manual-unavailable');assert.equal(resolveNotificationCourse(n,s).manual,true);assert.equal(notificationCourse(n,s),'');}
});

test('inherited mapping properties cannot grant an assignment and explicit connector IDs remain deterministic',()=>{
 const s=state(),n=item({url:undefined});s.notificationCourses=Object.create({[n.id]:'beta'});assert.equal(notificationCourse(n,s),'');
 assert.equal(resolveNotificationCourse({...n,projectId:'alpha'},s).reason,'explicit-project');assert.equal(notificationCourse({...n,courseId:'beta'},s),'beta');assert.equal(resolveNotificationCourse({...n,projectId:'old'},s).reason,'archived');
 const conflict=resolveNotificationCourse({...n,projectId:'alpha',courseId:'beta'},s);assert.equal(conflict.projectId,'');assert.equal(conflict.ambiguous,true);assert.equal(conflict.reason,'ambiguous');
});

test('URL routing uses exact path segment boundaries and the longest genuine saved connection',()=>{
 const s=state();assert.equal(notificationCourse(item(),s),'alpha');assert.equal(notificationCourse(item({url:SPACE+'/alpha'}),s),'alpha');assert.equal(notificationCourse(item({url:SPACE+'/alpha-other/post'}),s),'');assert.equal(notificationCourse(item({url:SPACE+'/alphabet/post'}),s),'');
 s.projects.push(project('subcourse',SPACE+'/alpha/subcourse/'));assert.equal(notificationCourse(item({url:SPACE+'/alpha/subcourse/post'}),s),'subcourse');assert.equal(courseMatches(notificationCourse(item(),s),'beta'),false);
 s.projects[0].links.push({...s.projects[0].links[0],id:'second'});assert.equal(resolveNotificationCourse(item(),s).ambiguous,false);
});

test('saved query-scoped connections do not silently route another page using the same PHP path',()=>{
 const s=state();s.projects=[project('alpha',SPACE+'/index.php?space_id=alpha'),project('beta',SPACE+'/index.php?space_id=beta')];
 assert.equal(notificationCourse(item({url:SPACE+'/index.php?space_id=alpha&view=one'}),s),'alpha');assert.equal(notificationCourse(item({url:SPACE+'/index.php?space_id=beta'}),s),'beta');assert.equal(notificationCourse(item({url:SPACE+'/index.php?space_id=alpha&space_id=beta'}),s),'');assert.equal(notificationCourse(item({url:SPACE+'/index.php?view=one'}),s),'');
});

test('Mattermost permalink routing uses the real channel group URL rather than a team-wide or title guess',()=>{
 const s=state();s.projects=[project('alpha',CHAT+'/students/channels/alpha'),project('team',CHAT+'/students')];
 const n=item({source:'mattermost',url:CHAT+'/students/pl/post-1',groupUrl:CHAT+'/students/channels/alpha',groupId:'channel_opaque',groupName:'Different visible label'});assert.deepEqual(resolveNotificationCourse(n,s),{projectId:'alpha',reason:'group-url',manual:false,ambiguous:false});assert.equal(n.source,'mattermost');
 assert.equal(notificationCourse({...n,groupUrl:undefined,title:'alpha course',groupName:'alpha'},s),'');assert.equal(notificationCourse({...n,url:undefined},s),'alpha');
});

test('duplicate shared links and conflicting original/group URL evidence stay ambiguous instead of selecting the first course',()=>{
 const s=state();s.projects.push(project('also-alpha',SPACE+'/alpha/'));const duplicate=resolveNotificationCourse(item(),s);assert.equal(duplicate.projectId,'');assert.equal(duplicate.reason,'ambiguous');assert.equal(duplicate.ambiguous,true);
 const other=state();other.projects=[project('alpha',GIT+'/class/alpha'),project('beta',GIT+'/class/beta')];const conflict=resolveNotificationCourse(item({source:'gitlab',url:GIT+'/class/alpha/-/issues/1',groupUrl:GIT+'/class/beta'}),other);assert.equal(conflict.projectId,'');assert.equal(conflict.ambiguous,true);
});

test('archived URL scopes cannot be revived through a broader active parent connection',()=>{
 const s=state();s.projects.push(project('parent',SPACE+'/'));assert.equal(resolveNotificationCourse(item({url:SPACE+'/old/post'}),s).reason,'archived');
 s.projects.push(project('parent-alpha',SPACE+'/alpha/'));s.projects.push(project('retired-sub',SPACE+'/alpha/retired/',{archived:true}));assert.equal(resolveNotificationCourse(item({url:SPACE+'/alpha/retired/post'}),s).reason,'archived');
});

test('unsafe, cross-provider, credential, encoded traversal and private account URLs never produce automatic course assignments',()=>{
 const s=state();const hostile=[
  'http://spaces.th-koeln.de/alpha/post','https://user:secret@spaces.th-koeln.de/alpha/post','https://spaces.th-koeln.de:444/alpha/post','https://spaces.th-koeln.de.evil.test/alpha/post',SPACE+'/beta/../alpha/post',SPACE+'/alpha/%2e%2e/beta/post',SPACE+'/alpha/%252e%252e/beta/post',SPACE+'/alpha%2fpost',SPACE+'/alpha/%255cpost',SPACE+'/alpha/post?access_token=secret',SPACE+'/alpha/post?redirect=https://evil.test',SPACE+'/alpha/mail/message',SPACE+'/alpha/user/auth/login',SPACE+'/alpha/post?action=delete',SPACE+'/alpha/post?_task=mail',SPACE+'/alpha/%0apost'
 ];
 for(const url of hostile){const resolution=resolveNotificationCourse(item({url}),s);assert.equal(resolution.projectId,'',url);assert.equal(resolution.reason,'unsafe-url',url);assert.doesNotThrow(()=>notificationCourse(item({url}),s));}
 assert.equal(resolveNotificationCourse(item({url:GIT+'/class/alpha'}),s).reason,'unsafe-url');assert.equal(resolveNotificationCourse(item({groupUrl:'javascript:alert(1)'}),s).reason,'unsafe-group-url');assert.equal(resolveNotificationCourse(item({groupUrl:GIT+'/class/alpha'}),s).reason,'unsafe-group-url');
});

test('Unicode paths match their canonical saved course while provider homepages never identify a course',()=>{
 const s=state();s.projects=[project('unicode',SPACE+'/f%C3%BCnf/'),project('homepage',SPACE+'/')];assert.equal(notificationCourse(item({url:SPACE+'/f%c3%bcnf/post'}),s),'unicode');assert.equal(notificationCourse(item({url:SPACE+'/'}),s),'');assert.equal(notificationCourse(item({url:SPACE+'/another/post'}),s),'');
});

test('mail headers, related-tool labels, generic title words and opaque group IDs do not create course evidence',()=>{
 const s=state();s.projects[0].links.push({id:'mail',tool:'webmail',title:'Mailbox',url:'https://webmail.th-koeln.de/mail/alpha/'});
 for(const n of [item({source:'webmail',url:'https://webmail.th-koeln.de/mail/alpha/',relatedTool:'spaces',title:'[THspaces] alpha'}),item({url:undefined,title:'alpha',groupName:'alpha',groupId:'alpha',providerGroup:'spaces'}),item({url:SPACE+'/unrelated/',title:'alpha assignment',summary:'Alpha course',groupName:'alpha'})])assert.equal(notificationCourse(n,s),'');
 const n=item({source:'webmail',url:'https://webmail.th-koeln.de/'});s.notificationCourses[n.id]='alpha';assert.equal(notificationCourse(n,s),'alpha');assert.equal(n.source,'webmail');
});

test('routing is pure and legacy source-less course URLs remain compatible',()=>{
 const s=state(),n=item({source:undefined});for(const p of s.projects){p.links.forEach(Object.freeze);Object.freeze(p.links);Object.freeze(p);}Object.freeze(s.projects);Object.freeze(s.notificationCourses);Object.freeze(s);Object.freeze(n);
 assert.equal(notificationCourse(n,s),'alpha');assert.equal(n.source,undefined);assert.equal(n.url,SPACE+'/alpha/post/1');assert.deepEqual(resolveNotificationCourse(null,s),{projectId:'',reason:'unassigned',manual:false,ambiguous:false});
});

test('knowledge excludes unavailable/manual-archived and unsafe sources even in All courses instead of treating them as personal',()=>{
 const s=state();s.notificationCourses.manual_missing='missing';s.notificationCourses.manual_old='old';
 const updates=[item({id:'valid'}),item({id:'old',url:SPACE+'/old/post',content:'ARCHIVED_URL_BODY_MUST_NOT_LEAK'}),item({id:'explicit_old',projectId:'old',content:'ARCHIVED_ID_BODY_MUST_NOT_LEAK'}),item({id:'manual_missing',content:'MISSING_MAPPING_BODY_MUST_NOT_LEAK'}),item({id:'manual_old',content:'ARCHIVED_MAPPING_BODY_MUST_NOT_LEAK'}),item({id:'unsafe',url:'http://spaces.th-koeln.de/alpha/post',content:'UNSAFE_BODY_MUST_NOT_LEAK'}),item({id:'unsafe_group',groupUrl:'https://foreign.test/',content:'UNSAFE_GROUP_BODY_MUST_NOT_LEAK'}),item({id:'other',url:SPACE+'/beta/post',content:'BETA_CONTENT'})];
 const all=buildKnowledge(s,updates,{enabled:{updates:true}});assert.deepEqual(all.map(doc=>doc.id),['u:valid','u:other']);assert.doesNotMatch(JSON.stringify(all),/MUST_NOT_LEAK/);
 const selected=buildKnowledge(s,updates,{projectId:'alpha',enabled:{updates:true}});assert.deepEqual(selected.map(doc=>doc.id),['u:valid']);assert.equal(selected[0].projectId,'alpha');assert.equal(selected[0].source,'spaces');
});
