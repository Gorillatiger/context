import test from 'node:test';
import assert from 'node:assert/strict';
import {courseRootURL,discoverNewCourses} from '../dist/course-discovery.js';

const projects=[{id:'a',links:[{tool:'spaces',url:'https://spaces.th-koeln.de/prototyping-things-w26/'}]}];

test('only single-segment Spaces course roots are accepted',()=>{
  assert.equal(courseRootURL('https://spaces.th-koeln.de/neu-w26/unterseite/'),'https://spaces.th-koeln.de/neu-w26/');
  for(const bad of ['https://spaces.th-koeln.de/','https://spaces.th-koeln.de/blog/x/','https://spaces.th-koeln.de/2026/11/02/post/','https://example.com/neu/','https://spaces.th-koeln.de/wp-admin/'])assert.equal(courseRootURL(bad),'',bad);
});

test('already linked courses are not offered again',async()=>{
  const request=async()=>({links:[
    {title:'Prototyping Things',url:'https://spaces.th-koeln.de/prototyping-things-w26/news/'},
    {title:'Neuer Kurs',url:'https://spaces.th-koeln.de/neuer-kurs-w26/'},
    {title:'Doppelt',url:'https://spaces.th-koeln.de/neuer-kurs-w26/aufgaben/'}
  ]});
  const result=await discoverNewCourses({projects,request});
  assert.equal(result.status,'ok');
  assert.deepEqual(result.courses,[{url:'https://spaces.th-koeln.de/neuer-kurs-w26/',title:'Neuer Kurs'}]);
});

test('login and outdated browser are reported without courses',async()=>{
  assert.equal((await discoverNewCourses({projects,request:async()=>({loginRequired:true})})).status,'login_required');
  assert.equal((await discoverNewCourses({projects,request:async()=>({})})).status,'update_required');
});
