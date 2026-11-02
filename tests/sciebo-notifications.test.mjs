import test from 'node:test';
import assert from 'node:assert/strict';
import {scieboNotifications,scieboNotificationURL} from '../connectors/sciebo-notifications.mjs';
import {parseFeedSnapshot} from '../dist/feed-state.js';
import {boundNotificationFeed} from '../dist/platform-feed.js';
const ORIGIN='https://th-koeln.sciebo.de';
const ocs=value=>({text:JSON.stringify({ocs:{meta:{status:'ok',statuscode:200},data:value}}),status:200,headers:new Headers({'content-type':'application/json'})});
const notification=(id,patch={})=>({notification_id:id,user:'synthetic-user',app:'files_sharing',subject:'<b>Datei &amp; Freigabe</b>',message:'<p>Ein neues Dokument</p>',datetime:'2026-10-14T10:00:00Z',link:ORIGIN+'/index.php/apps/files/?dir=%2FCourse',...patch});
function fixture(rows=[],caps={'ocs-endpoints':['list','get','delete']}){
 const calls=[];const read=async(url,options)=>{calls.push({url,options});return url.includes('/capabilities')?ocs({capabilities:{notifications:caps}}):ocs(rows);};
 return {calls,run:()=>scieboNotifications({read})};
}
test('Sciebo discovers declared OCS endpoints and reads inert account-scoped notifications without invoking actions',async()=>{
 const f=fixture([notification(7,{actions:[{type:'DELETE',link:ORIGIN+'/destroy'}]})]),value=await f.run();
 assert.equal(value.status,'connected');assert.equal(value.items[0].title,'Datei & Freigabe');assert.equal(value.items[0].content,'Ein neues Dokument');assert.equal(value.items[0].source,'sciebo');
 assert.equal(value.items[0].createdAt,'2026-10-14T10:00:00.000Z');assert(!JSON.stringify(value).includes('synthetic-user'));assert(!JSON.stringify(value).includes('DELETE'));
 assert.equal(f.calls.length,2);assert(f.calls.every(call=>call.options.headers['OCS-APIRequest']==='true'));assert(f.calls.every(call=>call.url.startsWith(ORIGIN)));
 assert.equal(parseFeedSnapshot({items:value.items,sources:[{source:'sciebo',status:'connected'}]}).items.length,1);
});
test('missing notifications capability is explicit and avoids probing an undeclared notifications route',async()=>{
 const f=fixture([],{version:1}),value=await f.run();assert.equal(value.status,'not_configured');assert.equal(f.calls.length,1);assert.equal(value.items.length,0);
});
test('204 and text/plain JSON are handled according to the OCS contract',async()=>{
 const read=async url=>url.includes('/capabilities')?{...ocs({capabilities:{notifications:{'ocs-endpoints':['list']}}}),headers:new Headers({'content-type':'text/plain; charset=utf-8'})}:{status:204,headers:new Headers(),text:''};
 const value=await scieboNotifications({read});assert.equal(value.complete,true);assert.equal(value.status,'connected');assert.equal(value.items.length,0);
});
test('OCS authorization failures hidden in HTTP 200 JSON cannot become a connected empty source',async()=>{
 const read=async()=>({status:200,text:JSON.stringify({ocs:{meta:{status:'failure',statuscode:997},data:[]}}),headers:new Headers({'content-type':'application/json'})});
 await assert.rejects(scieboNotifications({read}),{code:'LOGIN_REQUIRED',status:401});
});
test('Sciebo stable IDs distinguish accounts while a changed notification updates its revision',async()=>{
 const one=(await fixture([notification(7)]).run()).items[0],edited=(await fixture([notification(7,{message:'Edited'})]).run()).items[0],other=(await fixture([notification(7,{user:'other-user'})]).run()).items[0];
 assert.equal(one.id,edited.id);assert.notEqual(one.revision,edited.revision);assert.notEqual(one.id,other.id);
});
test('mixed recipient identities and duplicate notification IDs reject an ambiguous provider response',async()=>{
 await assert.rejects(fixture([notification(1),notification(2,{user:'other'})]).run());await assert.rejects(fixture([notification(1),notification(1)]).run());
});
test('unsafe notification links cannot become arbitrary external, authentication or provider-write actions',()=>{
 for(const value of ['https://evil.test/file','https://th-koeln.sciebo.de/ocs/v2.php?action=delete','https://th-koeln.sciebo.de/index.php/apps/files/?requesttoken=secret','javascript:alert(1)',ORIGIN+'/index.php/logout'])assert.equal(scieboNotificationURL(value),ORIGIN+'/index.php/apps/files/');
});
test('bounded OCS feed selects the newest 50 and advertises omissions',async()=>{
 const rows=Array.from({length:60},(_,i)=>notification(i+1,{datetime:new Date(Date.parse('2026-10-14T10:00:00Z')+i*60000).toISOString()})),value=await fixture(rows).run();
 assert.equal(value.items.length,50);assert.equal(value.complete,false);assert.match(value.items[0].id,/_60$/);assert(value.warnings.length);
});
test('unified maximum keeps small sources and marks only omitted sources incomplete',()=>{
 const row=(i,source)=>({id:source+'_'+i,source,createdAt:'2026-10-14T10:00:00Z'});
 const items=[...Array.from({length:2100},(_,i)=>row(i,'spaces')),...Array.from({length:50},(_,i)=>row(i,'sciebo')),...Array.from({length:100},(_,i)=>row(i,'webmail'))];
 const result=boundNotificationFeed(items,[{source:'spaces',complete:true},{source:'sciebo',complete:true},{source:'webmail',complete:true}]);
 assert.equal(result.items.length,2200);assert.equal(result.items.filter(row=>row.source==='webmail').length,100);assert.equal(result.items.filter(row=>row.source==='sciebo').length,50);assert.equal(result.sources[0].complete,false);assert.match(result.sources[0].warnings[0],/50 weitere/);assert.equal(result.sources[1].complete,true);
});
