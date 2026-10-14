import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {createDiaryReminders} from '../desktop/diary-reminders.mjs';

const cryptoKey=Buffer.alloc(32,17);
function protectedStorage({available=true,encrypt,decrypt}={}){
  const calls={availability:0,encrypt:0,decrypt:0,plaintext:[]};
  const crypto={
    async isAsyncEncryptionAvailable(){calls.availability++;return available;},
    async encryptStringAsync(text){calls.encrypt++;calls.plaintext.push(text);if(encrypt)return encrypt(text);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cryptoKey,iv);return Buffer.concat([iv,cipher.update(text,'utf8'),cipher.final(),cipher.getAuthTag()]);},
    async decryptStringAsync(bytes){calls.decrypt++;if(decrypt)return decrypt(bytes);const iv=bytes.subarray(0,12),decipher=createDecipheriv('aes-256-gcm',cryptoKey,iv);decipher.setAuthTag(bytes.subarray(-16));return {result:Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8'),shouldReEncrypt:false};},
  };
  return {crypto,calls};
}
const diary=(overrides={})=>({id:'diary-1',courseName:'Private Course Name',startDate:'2026-10-01',endDate:'2026-12-31',reminder:{enabled:true,time:'18:00',weekdays:[0,1,2,3,4,5,6]},entries:[],...overrides});
async function fixture(t,{time='2026-10-12T15:59:00.000Z',directory,provider=protectedStorage(),notify,platform='darwin'}={}){
  const temporary=await mkdtemp(path.join(os.tmpdir(),'context-diary-reminders-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
  directory??=temporary;let epoch=Date.parse(time),serial=0;const timers=new Map(),notifications=[],cleared=[];
  const engine=createDiaryReminders({directory,crypto:provider.crypto,notify:async value=>{notifications.push(value);await notify?.(value);},now:()=>epoch,platform,setTimer:(callback,ms)=>{const id=++serial;timers.set(id,{callback,at:epoch+ms,ms});return id;},clearTimer:id=>{cleared.push(id);timers.delete(id);}});
  t.after(()=>engine.dispose());
  return {engine,directory,provider,notifications,timers,cleared,setTime:value=>{epoch=Date.parse(value);},async advance(value){epoch=Date.parse(value);for(const [id,timer] of [...timers])if(timer.at<=epoch){timers.delete(id);timer.callback();}return engine({op:'status'});}};
}
test('a Berlin reminder fires at the selected local time and only once that day',async t=>{
  const f=await fixture(t);const configured=await f.engine({op:'configure',diaries:[diary()]});
  assert.equal(configured.timezone,'Europe/Berlin');assert.equal(configured.nextAt,'2026-10-12T16:00:00.000Z');assert.equal(f.notifications.length,0);assert.equal(f.timers.size,1);
  await f.advance('2026-10-12T15:59:59.000Z');assert.equal(f.notifications.length,0);
  const status=await f.advance('2026-10-12T16:00:00.000Z');assert.equal(f.notifications.length,1);assert.deepEqual(status.deliveredToday,[{diaryId:'diary-1',date:'2026-10-12'}]);
  await f.engine({op:'status'});await f.advance('2026-10-12T18:00:00.000Z');assert.equal(f.notifications.length,1);assert.equal(f.timers.size,1);
  await f.advance('2026-10-13T16:00:00.000Z');assert.equal(f.notifications.length,2);
});
test('a completed entry, archive, disabled reminder and wrong weekday suppress notifications',async t=>{
  const f=await fixture(t,{time:'2026-10-12T17:00:00.000Z'});
  await f.engine({op:'configure',diaries:[diary({entries:[{date:'2026-10-12',completed:true}]}),diary({id:'archived',archived:true}),diary({id:'off',reminder:{enabled:false,time:'18:00'}}),diary({id:'sunday',reminder:{enabled:true,time:'18:00',weekdays:[0]}})]});
  assert.equal(f.notifications.length,0);assert.equal((await f.engine({op:'status'})).nextAt,'2026-10-13T16:00:00.000Z');
});
test('period bounds are inclusive and future or expired courses are not notified',async t=>{
  const f=await fixture(t,{time:'2026-10-12T17:00:00.000Z'});
  await f.engine({op:'configure',diaries:[diary({id:'future',startDate:'2026-10-13'}),diary({id:'expired',endDate:'2026-10-11'}),diary({id:'one-day',startDate:'2026-10-12',endDate:'2026-10-12'})]});
  assert.deepEqual(f.notifications.map(value=>value.diaryId),['one-day']);
  await f.advance('2026-10-13T16:00:00.000Z');assert.deepEqual(f.notifications.map(value=>value.diaryId),['one-day','future']);
});
test('opening after the reminder catches up today but never backfills old days',async t=>{
  const f=await fixture(t,{time:'2026-10-15T19:00:00.000Z'});
  await f.engine({op:'configure',diaries:[diary()]});assert.equal(f.notifications.length,1);assert.equal(f.notifications[0].date,'2026-10-15');
});
test('winter scheduling uses CET rather than a fixed summer offset',async t=>{
  const f=await fixture(t,{time:'2026-11-12T15:59:00.000Z'});const result=await f.engine({op:'configure',diaries:[diary()]});assert.equal(result.nextAt,'2026-11-12T17:00:00.000Z');
});
test('spring DST moves a nonexistent 02:30 reminder to the first valid minute',async t=>{
  const f=await fixture(t,{time:'2026-03-28T23:05:00.000Z'});const result=await f.engine({op:'configure',diaries:[diary({startDate:'2026-03-01',reminder:{enabled:true,time:'02:30',weekdays:[0]}})]});
  assert.equal(result.nextAt,'2026-03-29T01:00:00.000Z');await f.advance('2026-03-29T01:00:00.000Z');assert.equal(f.notifications.length,1);assert.equal(f.notifications[0].date,'2026-03-29');
});
test('autumn DST selects the first 02:30 and never fires during the repeated hour',async t=>{
  const f=await fixture(t,{time:'2026-10-24T23:05:00.000Z'});const result=await f.engine({op:'configure',diaries:[diary({reminder:{enabled:true,time:'02:30',weekdays:[0]}})]});
  assert.equal(result.nextAt,'2026-10-25T00:30:00.000Z');await f.advance('2026-10-25T00:30:00.000Z');await f.advance('2026-10-25T01:30:00.000Z');assert.equal(f.notifications.length,1);
});
test('encrypted state restores configuration and persistent dedup before notifying',async t=>{
  const f=await fixture(t,{time:'2026-10-12T17:00:00.000Z'});await f.engine({op:'configure',diaries:[diary()]});await f.engine.dispose();
  const restarted=await fixture(t,{time:'2026-10-12T20:00:00.000Z',directory:f.directory});const result=await restarted.engine.initialize();assert.equal(result.storage,'encrypted');assert.equal(restarted.notifications.length,0);assert.equal(result.enabledCount,1);
  await restarted.advance('2026-10-13T16:00:00.000Z');assert.equal(restarted.notifications.length,1);assert.equal(restarted.notifications[0].date,'2026-10-13');
});
test('dedup is persisted before the OS notification is invoked',async t=>{
  let f;f=await fixture(t,{time:'2026-10-12T17:00:00.000Z',notify:async()=>{const saved=await f.provider.crypto.decryptStringAsync(await readFile(path.join(f.directory,'diary-reminders.enc')));assert.equal(JSON.parse(saved.result).delivered['diary-1'],'2026-10-12');}});
  await f.engine({op:'configure',diaries:[diary()]});assert.equal(f.notifications.length,1);
});
test('OS payload is generic and disk state contains no course name or diary content',async t=>{
  const f=await fixture(t,{time:'2026-10-12T17:00:00.000Z'});await f.engine({op:'configure',diaries:[diary({entries:[{date:'2026-10-11',completed:true,text:'Private entry secret',prompt:'Private prompt secret'},{date:'2026-10-12',completed:false,text:'Unsaved private draft'}]})]});
  assert.deepEqual(Object.keys(f.notifications[0]).sort(),['body','createdAt','date','diaryId','title','type']);assert.equal(f.notifications[0].body,'Zeit für deinen Dev Diary');
  const bytes=await readFile(path.join(f.directory,'diary-reminders.enc'));assert.doesNotMatch(bytes.toString('utf8'),/Private|Unsaved|diary-1|2026-10/);
  const plaintext=(await f.provider.crypto.decryptStringAsync(bytes)).result;assert.doesNotMatch(plaintext,/Private|Unsaved|courseName|prompt|"text"|"entries"/);assert.deepEqual(JSON.parse(plaintext).diaries[0].completedDates,['2026-10-11']);
  assert.deepEqual(await readdir(f.directory),['diary-reminders.enc']);assert.equal((await lstat(path.join(f.directory,'diary-reminders.enc'))).mode&0o777,0o600);
});
test('unavailable encryption keeps reminders in memory without a plaintext fallback',async t=>{
  const f=await fixture(t,{time:'2026-10-12T17:00:00.000Z',provider:protectedStorage({available:false})});const result=await f.engine({op:'configure',diaries:[diary()]});
  assert.equal(result.storage,'session');assert.match(result.warning,/Sitzung/);assert.equal(f.notifications.length,1);assert.equal(f.provider.calls.encrypt,0);assert.deepEqual(await readdir(f.directory),[]);
  await f.engine({op:'status'});assert.equal(f.notifications.length,1);
});
test('Linux fails closed to session-only reminders even if a storage provider claims availability',async t=>{
  const f=await fixture(t,{time:'2026-10-12T17:00:00.000Z',platform:'linux'});const result=await f.engine({op:'configure',diaries:[diary()]});assert.equal(result.storage,'session');assert.equal(f.provider.calls.availability,0);assert.equal(f.provider.calls.encrypt,0);assert.deepEqual(await readdir(f.directory),[]);
});
test('a filesystem failure never writes decrypted diary data and retains session dedup',async t=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'context-diary-file-'));t.after(()=>rm(base,{recursive:true,force:true}));const directory=path.join(base,'not-a-directory');await writeFile(directory,'placeholder');
  const f=await fixture(t,{time:'2026-10-12T17:00:00.000Z',directory});const result=await f.engine({op:'configure',diaries:[diary()]});assert.equal(result.storage,'session');assert.equal(f.notifications.length,1);assert.equal(await readFile(directory,'utf8'),'placeholder');await f.engine({op:'status'});assert.equal(f.notifications.length,1);
});
test('a corrupt encrypted snapshot is not treated as valid or read as plaintext',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.directory,'diary-reminders.enc'),Buffer.from('not an encrypted snapshot'));const result=await f.engine.initialize();assert.equal(result.storage,'session');assert.equal(result.enabledCount,0);assert.equal(f.notifications.length,0);assert.match(result.warning,/Sitzung/);
});
test('invalid dates, periods, times, weekdays, IDs and excessive diary lists are rejected',async t=>{
  const f=await fixture(t);const bad=[diary({startDate:'2026-02-30'}),diary({startDate:'2027-01-01'}),diary({endDate:'2026-9-01'}),diary({id:'bad\0id'}),diary({reminder:{enabled:'yes',time:'18:00'}}),diary({reminder:{enabled:true,time:'24:00'}}),diary({reminder:{enabled:true,time:'8:00'}}),diary({reminder:{enabled:true,time:'18:00',weekdays:[7]}}),diary({reminder:{enabled:true,time:'18:00',weekdays:[1,1]}}),diary({entries:[{date:'2026-10-12',completed:'yes'}]})];
  for(const value of bad)await assert.rejects(f.engine({op:'configure',diaries:[value]}),{code:'DIARY_REMINDER_INPUT'});
  await assert.rejects(f.engine({op:'configure',diaries:[diary(),diary()]}));await assert.rejects(f.engine({op:'configure',diaries:Array.from({length:101},(_,i)=>diary({id:'diary-'+i}))}));await assert.rejects(f.engine({op:'unknown'}));
  assert.equal(f.provider.calls.encrypt,0);assert.equal(f.notifications.length,0);
});
test('configure clones its minimal snapshot synchronously before asynchronous initialization',async t=>{
  const f=await fixture(t);const value=diary();const configured=f.engine({op:'configure',diaries:[value]});value.reminder.time='24:00';value.entries.push({date:'2026-10-12',completed:true});value.id='different';const result=await configured;assert.equal(result.nextAt,'2026-10-12T16:00:00.000Z');await f.advance('2026-10-12T16:00:00.000Z');assert.equal(f.notifications[0].diaryId,'diary-1');
});
test('accepted completed-entry changes invalidate an older asynchronous delivery before notifying',async t=>{
  let release,entered;const blocked=new Promise(resolve=>{entered=resolve;}),provider=protectedStorage();const original=provider.crypto.encryptStringAsync;let writes=0;
  provider.crypto.encryptStringAsync=async text=>{writes++;if(writes===2){entered();await new Promise(resolve=>{release=resolve;});}return original(text);};
  const f=await fixture(t,{time:'2026-10-12T17:00:00.000Z',provider});const first=f.engine({op:'configure',diaries:[diary()]});await blocked;
  const completed=f.engine({op:'configure',diaries:[diary({entries:[{date:'2026-10-12',completed:true}]})]});release();await first;await completed;assert.equal(f.notifications.length,0);const result=await f.engine({op:'status'});assert.deepEqual(result.deliveredToday,[]);assert.equal(result.nextAt,'2026-10-13T16:00:00.000Z');
});
test('status queued before a newer completed snapshot cannot send an obsolete reminder',async t=>{
  let release;const provider=protectedStorage({available:true});provider.crypto.isAsyncEncryptionAvailable=()=>new Promise(resolve=>{release=()=>resolve(true);});
  const f=await fixture(t,{time:'2026-10-12T17:00:00.000Z',provider});const status=f.engine({op:'status'});await new Promise(resolve=>setImmediate(resolve));
  const completed=f.engine({op:'configure',diaries:[diary({entries:[{date:'2026-10-12',completed:true}]})]});release();provider.crypto.isAsyncEncryptionAvailable=async()=>true;await status;await completed;assert.equal(f.notifications.length,0);
});
test('dispose clears timers, suppresses queued notifications and drains accepted persistence',async t=>{
  const f=await fixture(t);const configured=f.engine({op:'configure',diaries:[diary()]});const drained=f.engine.dispose();await configured;await drained;assert.equal(f.timers.size,0);assert.equal(f.notifications.length,0);assert.deepEqual(await readdir(f.directory),['diary-reminders.enc']);await assert.rejects(f.engine({op:'status'}));
});
test('stale timer callbacks cannot revive disabled reminders and clock rollback does not duplicate delivery',async t=>{
  const f=await fixture(t);await f.engine({op:'configure',diaries:[diary()]});const stale=[...f.timers.values()][0].callback;await f.engine({op:'configure',diaries:[]});stale();await f.advance('2026-10-12T17:00:00.000Z');assert.equal(f.notifications.length,0);assert.equal(f.timers.size,0);
  await f.engine({op:'configure',diaries:[diary()]});assert.equal(f.notifications.length,1);f.setTime('2026-10-11T17:00:00.000Z');await f.engine({op:'status'});assert.equal(f.notifications.length,1);
});
test('notification failures stay generic, do not log contents and never retry the same diary/day',async t=>{
  const calls=[];for(const method of ['log','warn','error'])t.mock.method(console,method,(...args)=>calls.push(args));
  const f=await fixture(t,{time:'2026-10-12T17:00:00.000Z',notify:()=>{throw new Error('Private content that must never appear in diagnostics');}});const result=await f.engine({op:'configure',diaries:[diary()]});assert.match(result.warning,/Systembenachrichtigung/);assert.doesNotMatch(result.warning,/Private/);await f.engine({op:'status'});assert.equal(f.notifications.length,1);assert.deepEqual(calls,[]);
});
