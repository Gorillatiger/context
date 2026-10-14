import test from 'node:test';
import assert from 'node:assert/strict';
import {buildKnowledge,runProjectAgent} from '../dist/knowledge.js';
import {platformCatalog} from '../dist/source-catalog.js';

function fixture(){
  const workspace={projects:[{id:'course1',name:'Robotik',links:[{tool:'gitlab',url:'https://git.coco.study/course/robotics',title:'Aufgabe'}]}],notes:[],tasks:[],bookmarks:[],tools:[]},source=platformCatalog(workspace)[0];
  const doc={id:'service:'+'c'.repeat(64)+':part0',kind:'service',service:'gitlab',source:'gitlab',sourceId:source.id,projectId:'course1',url:source.url,title:'Aufgabe',text:'Kontext '.repeat(150)+'PRIVATE_REVOKED_UNREAD_TAIL',status:'excerpt',contentRevision:'d'.repeat(64),accountGeneration:'e'.repeat(64),trust:'untrusted-source'};
  return {workspace,source,doc,documents:buildKnowledge(workspace,[],{enabled:{platforms:true},projectId:'course1',platformSources:[doc]})};
}
const reply=(tool,args)=>({content:JSON.stringify({type:'tool',tool,args})});
const answer=()=>({content:JSON.stringify({type:'answer',text:'Keine Quelle freigegeben.',citations:[]})});
const allowAbort=async work=>{try{return await work;}catch(error){if(error.name!=='AbortError')throw error;}};

test('a cached platform tail is not delivered after its course source link is revoked during the agent run',async()=>{
  const workspace={projects:[{id:'course1',name:'Robotik',links:[{tool:'gitlab',url:'https://git.coco.study/course/robotics',title:'Aufgabe'}]}],notes:[],tasks:[],bookmarks:[],tools:[]},source=platformCatalog(workspace)[0],id='service:'+'c'.repeat(64)+':part0';
  const doc={id,kind:'service',service:'gitlab',source:'gitlab',sourceId:source.id,projectId:'course1',url:source.url,title:'Aufgabe',text:'Kontext '.repeat(150)+'PRIVATE_REVOKED_UNREAD_TAIL',status:'excerpt',contentRevision:'d'.repeat(64),trust:'untrusted-source'};
  const documents=buildKnowledge(workspace,[],{enabled:{platforms:true},projectId:'course1',platformSources:[doc]});assert.equal(documents.length,1);let calls=0;
  try{await runProjectAgent({prompt:'Prüfe die Aufgabe',workspace,documents,projectId:'course1',complete:async messages=>{calls++;if(calls===1){assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_REVOKED_UNREAD_TAIL/);workspace.projects[0].links=[];return {content:JSON.stringify({type:'tool',tool:'read_source',args:{id,offset:1100}})};}assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_REVOKED_UNREAD_TAIL/);return {content:JSON.stringify({type:'answer',text:'Keine freigegebene Quelle mehr.',citations:[]})};}});}catch(error){if(error.name!=='AbortError')throw error;}
});

test('a replaced live workspace revokes previously sent source evidence and stops the next model request',async()=>{
  const f=fixture();let currentWorkspace=f.workspace,calls=0;
  await allowAbort(runProjectAgent({prompt:'Prüfe die Aufgabe',workspace:f.workspace,getWorkspace:()=>currentWorkspace,getPlatformSources:()=>[f.doc],documents:f.documents,projectId:'course1',complete:async messages=>{calls++;if(calls===1){currentWorkspace={...f.workspace,projects:[{...f.workspace.projects[0],links:[]}]};return reply('read_source',{id:f.doc.id,offset:1100});}assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_REVOKED_UNREAD_TAIL/);return answer();}}));assert.equal(calls,1,'revoked, already-sent evidence must stop further model turns');
});

test('a changed live account generation revokes a cached source even while its course URL stays the same',async()=>{
  const f=fixture();let currentSources=[f.doc],calls=0;
  await allowAbort(runProjectAgent({prompt:'Prüfe die Aufgabe',workspace:f.workspace,getWorkspace:()=>f.workspace,getPlatformSources:()=>currentSources,documents:f.documents,projectId:'course1',complete:async messages=>{calls++;if(calls===1){currentSources=[{...f.doc,accountGeneration:'9'.repeat(64)}];return reply('read_source',{id:f.doc.id,offset:1100});}assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_REVOKED_UNREAD_TAIL/);return answer();}}));assert.equal(calls,1,'an account switch must stop the run before exposing a new text section');
});

test('a source removed before it was ever sent cannot be recovered by a later cached read_source tool',async()=>{
  const f=fixture();let currentSources=[f.doc],calls=0;
  await allowAbort(runProjectAgent({prompt:'Hallo',workspace:f.workspace,getWorkspace:()=>f.workspace,getPlatformSources:()=>currentSources,documents:f.documents,projectId:'course1',complete:async messages=>{calls++;assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_REVOKED_UNREAD_TAIL/);if(calls===1){currentSources=[];return reply('read_source',{id:f.doc.id,offset:1100});}return answer();}}));assert.ok(calls<=2);
});

test('late platform adapter data from a just-revoked source never reaches the next model turn',async()=>{
  const f=fixture();let currentWorkspace=f.workspace,calls=0;
  await allowAbort(runProjectAgent({prompt:'Prüfe die Aufgabe',workspace:f.workspace,getWorkspace:()=>currentWorkspace,getPlatformSources:()=>[],documents:[],projectId:'course1',platform:async()=>{currentWorkspace={...f.workspace,projects:[{...f.workspace.projects[0],links:[]}]};return {documents:[f.doc],result:{results:[{id:f.doc.id,text:f.doc.text.slice(1100)}]}};},complete:async messages=>{calls++;assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_REVOKED_UNREAD_TAIL/);return calls===1?reply('read_platform',{sourceId:f.source.id}):answer();}}));
});
