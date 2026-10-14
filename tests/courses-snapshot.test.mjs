import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialState,validateState,notificationCourse,courseMatches,taskNotifications} from '../dist/core.js';
import {validateSnapshot,withSnapshot} from '../connectors/snapshot.mjs';

test('course selection and explicit notification assignments survive backups and old states migrate',()=>{
  const s=initialState();s.activeCourse='prototyping';s.notificationCourses={spaces_1:'prototyping'};
  assert.equal(validateState(s).activeCourse,'prototyping');assert.deepEqual(validateState(s).notificationCourses,s.notificationCourses);
  delete s.activeCourse;delete s.notificationCourses;assert.equal(validateState(s).activeCourse,'');
  s.activeCourse='missing';assert.throws(()=>validateState(s));
});
test('course filtering maps exact course paths and permits an explicit unassigned override',()=>{
  const s=initialState();const n={id:'spaces_1',url:'https://spaces.th-koeln.de/prototyping-things-w26/index.php?page_id=42'};
  assert.equal(notificationCourse(n,s),'prototyping');assert.equal(courseMatches(notificationCourse(n,s),'prototyping'),true);
  assert.equal(notificationCourse({...n,url:'https://spaces.th-koeln.de/prototyping-things-w26-other/'},s),'');
  s.notificationCourses[n.id]='';assert.equal(notificationCourse(n,s),'');
  s.tasks=[{id:'t',projectId:'go-public',status:'todo',due:'2020-01-01',title:'Due'}];assert.equal(taskNotifications(s)[0].projectId,'go-public');
});
const snapshot=()=>({version:1,capturedAt:'2026-10-12T06:00:00Z',courses:[{id:'course-1',name:'Course',url:'https://spaces.th-koeln.de/course/'}],sources:[{source:'spaces',status:'snapshot',complete:false}],items:[{id:'spaces_1',source:'spaces',title:'Existing announcement',summary:'From course',url:'https://spaces.th-koeln.de/course/?page_id=1',createdAt:'2026-10-11T17:00:00Z',displayedTime:'gestern',courseId:'course-1'}]});
test('browser snapshots validate source hosts, limits, duplicates and retain their original labels',()=>{
  const s=snapshot();s.items[0].content='Actual preview text';s.items[0].contentStatus='full';s.items[0].groupId='course-1';s.items[0].groupName='Course group';assert.equal(validateSnapshot(s).items[0].content,'Actual preview text');assert.equal(validateSnapshot(s).items[0].contentStatus,'full');assert.equal(validateSnapshot(s).items[0].mode,'snapshot');assert.equal(validateSnapshot(s).items[0].displayedTime,'gestern');
  s.items[0].content='x'.repeat(20001);assert.throws(()=>validateSnapshot(s));s.items[0].content='Actual preview text';
  s.sources[0].capturedAt='2026-10-12T05:40:00Z';
  assert.equal(validateSnapshot(s).items[0].capturedAt,s.sources[0].capturedAt);
  s.sources[0].capturedAt='invalid';assert.throws(()=>validateSnapshot(s));
  delete s.sources[0].capturedAt;
  s.courses[0].links=[{id:'course-repo',title:'Course repo',tool:'gitlab',url:'https://git.coco.study/example/course'}];
  assert.equal(validateSnapshot(s).courses[0].links[0].tool,'gitlab');
  s.courses[0].links[0].url='https://example.com/repo';assert.throws(()=>validateSnapshot(s));
  s.courses[0].links=[];
  s.items[0].url='https://example.com/';assert.throws(()=>validateSnapshot(s));
  s.items[0].url='https://spaces.th-koeln.de/course…/';assert.throws(()=>validateSnapshot(s));
  s.items[0].url='https://spaces.th-koeln.de/course/';
  s.items.push({...s.items[0]});assert.throws(()=>validateSnapshot(s));s.items.pop();s.items[0].source='signal';assert.throws(()=>validateSnapshot(s));
});
test('snapshots stay available without credentials and a live source replaces its snapshot',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'context-snapshot-'));const file=join(dir,'private.json');
  try{const s=snapshot();await writeFile(file,JSON.stringify(s),{mode:0o600});const feed={items:[],sources:[{source:'gitlab',status:'not_configured'}]};
    const result=await withSnapshot(feed,file);assert.equal(result.items.length,1);assert.equal(result.sources.find(s=>s.source==='spaces').status,'snapshot');
    const live=await withSnapshot({items:[{id:'live'}],sources:[{source:'spaces',status:'connected'}]},file);assert.deepEqual(live.items,[{id:'live'}]);
    await writeFile(file,'invalid');assert.equal((await withSnapshot(feed,file)).sources.at(-1).status,'error');
  }finally{await rm(dir,{recursive:true,force:true});}
});
