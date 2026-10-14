import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFeedSnapshot} from '../dist/feed-state.js';
const row=(id,source='mattermost',patch={})=>({id,source,title:'Synthetic update',summary:'Synthetic group',url:'https://chat.coco.study/course/pl/'+id,createdAt:'2026-10-13T12:00:00Z',revision:'1',...patch});
const feed=(items,sources)=>({items,sources,checkedAt:'2026-10-13T12:00:00Z'});

test('failed sources keep old rows while a new revision wins once, without duplicate notices',()=>{
  const old=[row('a'),row('b'),row('other','gitlab')];
  const result=parseFeedSnapshot(feed([row('a','mattermost',{revision:'2'})],[{source:'mattermost',status:'error'},{source:'gitlab',status:'connected'}]),old);
  assert.deepEqual(result.items.map(r=>[r.id,r.revision]),[['a','2'],['b','1']]);assert.equal(result.checkedAt,'2026-10-13T12:00:00Z');
});
test('successful empty, disconnected, expired and missing sources drop former account data',()=>{
  for(const sources of [[{source:'mattermost',status:'connected'}],[{source:'mattermost',status:'not_configured'}],[{source:'mattermost',status:'login_required'}],[]])assert.deepEqual(parseFeedSnapshot(feed([],sources),[row('a')]).items,[]);
  assert.deepEqual(parseFeedSnapshot(feed([row('a')],[{source:'mattermost',status:'not_configured'}])).items,[]);
});
test('source metadata is bounded and explicitly projected without credential-bearing extra fields',()=>{
  const result=parseFeedSnapshot(feed([],[{source:'spaces',status:'snapshot',complete:'true',message:'x'.repeat(3000),password:'secret',raw:{secret:true},capturedAt:'invalid',warnings:['x'.repeat(800),42]}]));
  assert.equal(result.sources[0].message.length,2000);assert.equal(result.sources[0].warnings[0].length,500);assert.equal(result.sources[0].complete,false);assert.equal(result.sources[0].capturedAt,'');assert.equal(result.sources[0].password,undefined);assert.equal(result.sources[0].raw,undefined);
});
test('invalid or duplicate source/row snapshots fail before any previous result can be changed',()=>{
  const old=[row('a')];
  for(const data of [feed([],null),feed([],[{source:'unknown',status:'connected'}]),feed([],[{source:'mattermost',status:'alien'}]),feed([],[{source:'mattermost',status:'connected'},{source:'mattermost',status:'error'}]),feed([row('b'),row('b')],[{source:'mattermost',status:'connected'}]),feed([row('b','mattermost',{url:'javascript:evil'})],[{source:'mattermost',status:'connected'}])])assert.throws(()=>parseFeedSnapshot(data,old));
  assert.equal(old[0].id,'a');
});
test('retained failed rows stay inside the 2200-entry bound',()=>{
  const rows=Array.from({length:2200},(_,i)=>row('new'+i));
  assert.equal(parseFeedSnapshot(feed(rows,[{source:'mattermost',status:'error'}]),[row('old')]).items.length,2200);
});
