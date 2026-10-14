import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../dist/core.js';
import {resolveAgentContext} from '../dist/agent-context.js';
const workspace=()=>({...initialState(),activeCourse:'go-public',notes:[{id:'n1',projectId:'prototyping',content:'Saved note'}],tasks:[{id:'t1',projectId:'prototyping'}]});
test('open project overrides the course switch without modifying the workspace',()=>{
 const w=workspace(),c=resolveAgentContext(w,[],{view:'projects',projectId:'prototyping'});
 assert.equal(c.projectId,'prototyping');assert.equal(w.activeCourse,'go-public');assert.equal(c.label,'Projekt · Prototyping Things');
});
test('saved note, task and message select their own course; personal content stays personal',()=>{
 const w=workspace();w.notes.push({id:'personal',projectId:''});
 for(const context of [{noteId:'n1'},{taskId:'t1'},{notificationId:'u1'}])assert.equal(resolveAgentContext(w,[{id:'u1',source:'spaces',projectId:'prototyping'}],context).projectId,'prototyping');
 assert.equal(resolveAgentContext(w,[],{noteId:'personal'}).projectId,'');
 assert.equal(resolveAgentContext(w,[],{projectId:''}).projectId,'');
});
test('missing saved items fall back to active course; current page needs both native metadata flags',()=>{
 const w=workspace();assert.equal(resolveAgentContext(w,[],{noteId:'missing'}).projectId,'go-public');
 assert.equal(resolveAgentContext(w,[],{projectId:'missing'}).projectId,'go-public');
 for(const browser of [undefined,{visible:true},{readable:true},{visible:false,readable:true}])assert.equal(resolveAgentContext(w,[],{browser}).browserCurrent,false);
 assert.equal(resolveAgentContext(w,[],{browser:{visible:true,readable:true}}).browserCurrent,true);
});
test('mail context never includes message bodies, credentials or unsaved form fields',()=>{
 const result=resolveAgentContext(workspace(),[{id:'mail1',source:'webmail',content:'private mail'}],{view:'mail',password:'secret',draft:'unsaved',browser:{visible:false,readable:false,text:'private page'}});
 assert.deepEqual(Object.keys(result).sort(),['browserCurrent','label','projectId','projectName']);
 assert.equal(result.label,'TH-Mail');assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('secret'));
});
test('a Spaces tab keeps its question context while the narrow browser switches to the assistant',()=>{
 const result=resolveAgentContext(workspace(),[],{view:'browser',browser:{visible:false,current:true,readable:true}});
 assert.equal(result.browserCurrent,true);assert.equal(result.label,'Browser');
 assert.equal(result.projectId,'go-public');
});
test('a hidden tab never becomes the current context for another view or an unreadable provider',()=>{
 for(const view of ['mail','notes','today'])assert.equal(resolveAgentContext(workspace(),[],{view,browser:{visible:false,current:true,readable:true}}).browserCurrent,false);
 for(const browser of [{visible:false,current:false,readable:true},{visible:false,current:true,readable:false}])assert.equal(resolveAgentContext(workspace(),[],{view:'browser',browser}).browserCurrent,false);
});
