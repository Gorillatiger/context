import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../dist/core.js';
import {notificationGroup,notificationGroups,previewContent} from '../dist/inbox.js';

test('source groups remain distinct from manual course assignments and count only matching entries',()=>{
  const state=initialState();
  const post={id:'s1',source:'spaces',courseId:'prototyping'};
  state.notificationCourses.s1='go-public';
  assert.deepEqual(notificationGroup(post,state),{id:'spaces_prototyping',name:'Prototyping Things'});
  const groups=notificationGroups([post,{...post,id:'s2'},{id:'m1',source:'webmail'}],state);
  assert.equal(groups.find(g=>g.id==='spaces_prototyping').count,2);
  assert.equal(groups.find(g=>g.id==='webmail_inbox').count,1);
  assert.equal(notificationGroup({source:'mattermost',groupId:'mattermost_channel_1',groupName:'Course channel'},state).name,'Course channel');
});

test('message previews preserve text, escape active markup and never label missing or oversized content as complete',()=>{
  const content='First paragraph\n\n<script>alert(1)</script>\n<img src="https://tracker.test/pixel">';
  const result=previewContent({source:'spaces',content,contentStatus:'full'});
  assert.equal(result.text,content);assert.equal(result.full,true);
  assert.ok(result.html.includes('&lt;script&gt;'));assert.ok(!result.html.includes('<img'));
  assert.equal(previewContent({source:'webmail'}).label,'Nur Kopfzeilen');
  assert.equal(previewContent({content:'x'.repeat(20001),contentStatus:'full'}).full,false);
  assert.equal(previewContent({content:'Short excerpt',contentStatus:'excerpt'}).label,'Textauszug');
});
