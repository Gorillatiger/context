import * as files from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const ZONE='Europe/Berlin',MAX_DIARIES=100,MAX_ENTRIES=4096,MAX_DELIVERED=10000,MAX_BYTES=4*1024*1024;
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const identifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const unavailable='Die Erinnerungen gelten für diese Sitzung; verschlüsseltes Speichern ist momentan nicht verfügbar.';
function fail(message='Ungültige Dev-Diary-Erinnerung.'){const error=new Error(message);error.code='DIARY_REMINDER_INPUT';return error;}
function date(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw fail();
  const [year,month,day]=value.split('-').map(Number),epoch=Date.UTC(year,month-1,day);
  if(year<1900||year>9998||!Number.isFinite(epoch)||new Date(epoch).toISOString().slice(0,10)!==value)throw fail();
  return value;
}
function plusDays(value,days){const epoch=Date.parse(value+'T00:00:00.000Z')+days*86400000;return new Date(epoch).toISOString().slice(0,10);}
function wall(epoch){
  const values=Object.fromEntries(formatter.formatToParts(epoch).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return {date:values.year+'-'+values.month+'-'+values.day,time:values.hour+':'+values.minute,epoch:Date.UTC(Number(values.year),Number(values.month)-1,Number(values.day),Number(values.hour),Number(values.minute),Number(values.second))};
}
// Choose the first occurrence when clocks fall back. A nonexistent spring
// time runs at the first valid minute after the gap (02:30 ->03:00), once.
function instant(day,time){
  const [year,month,date]=day.split('-').map(Number),[hour,minute]=time.split(':').map(Number),wanted=Date.UTC(year,month-1,date,hour,minute);
  const offsets=new Set([-48,-24,0,24,48].map(hours=>{const epoch=wanted+hours*3600000;return wall(epoch).epoch-epoch;}));
  const candidates=[...offsets].map(offset=>wanted-offset).sort((a,b)=>a-b);
  const exact=candidates.filter(epoch=>{const value=wall(epoch);return value.date===day&&value.time===time;});
  if(exact.length)return exact[0];
  for(let epoch=candidates[0];epoch<=candidates.at(-1);epoch+=60000){const value=wall(epoch);if(value.date===day&&value.time>=time)return epoch;}
  throw fail('Die lokale Erinnerungszeit konnte nicht ermittelt werden.');
}
function normalize(diaries){
  if(!Array.isArray(diaries)||diaries.length>MAX_DIARIES)throw fail();
  const known=new Set();
  return diaries.map(raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.id!=='string'||!identifier.test(raw.id)||known.has(raw.id))throw fail();known.add(raw.id);
    if(raw.courseName!==undefined&&(typeof raw.courseName!=='string'||raw.courseName.length>200||/[\u0000-\u001f\u007f]/.test(raw.courseName)))throw fail();
    const startDate=date(raw.startDate),endDate=date(raw.endDate);if(startDate>endDate)throw fail();
    if(raw.archived!==undefined&&typeof raw.archived!=='boolean')throw fail();
    const reminder=raw.reminder??{enabled:false,time:'19:00',weekdays:[0,1,2,3,4,5,6]};
    if(!reminder||typeof reminder!=='object'||Array.isArray(reminder)||typeof reminder.enabled!=='boolean'||typeof reminder.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(reminder.time))throw fail();
    const weekdays=reminder.weekdays??[0,1,2,3,4,5,6];
    if(!Array.isArray(weekdays)||weekdays.length>7||weekdays.some(day=>!Number.isInteger(day)||day<0||day>6)||new Set(weekdays).size!==weekdays.length)throw fail();
    const entries=raw.entries??[];if(!Array.isArray(entries)||entries.length>MAX_ENTRIES)throw fail();
    const completedDates=new Set();
    for(const entry of entries){if(!entry||typeof entry!=='object'||Array.isArray(entry)||typeof entry.completed!=='boolean')throw fail();const day=date(entry.date);if(entry.completed&&day>=startDate&&day<=endDate)completedDates.add(day);}
    // Deliberately retain no names, notes, prompts, entry text, or attachments.
    return {id:raw.id,startDate,endDate,archived:raw.archived===true,reminder:{enabled:reminder.enabled,time:reminder.time,weekdays:[...weekdays].sort()},completedDates:[...completedDates].sort()};
  });
}
function parseSaved(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)throw fail();
  const value=JSON.parse(text);if(!value||value.version!==1||!Array.isArray(value.diaries)||!value.delivered||typeof value.delivered!=='object'||Array.isArray(value.delivered))throw fail();
  const diaries=normalize(value.diaries.map(raw=>{
    if(!raw||!Array.isArray(raw.completedDates)||raw.completedDates.length>MAX_ENTRIES)throw fail();
    return {...raw,entries:raw.completedDates.map(day=>({date:day,completed:true}))};
  }));
  const delivered=Object.entries(value.delivered);if(delivered.length>MAX_DELIVERED)throw fail();
  for(const [id,day] of delivered){if(!identifier.test(id))throw fail();date(day);}
  return {diaries,delivered:new Map(delivered)};
}

export function createDiaryReminders({directory,crypto,notify=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,platform=process.platform}={}){
  if(typeof directory!=='string'||!directory||typeof notify!=='function'||typeof now!=='function'||typeof setTimer!=='function'||typeof clearTimer!=='function')throw fail();
  const target=path.join(directory,'diary-reminders.enc');
  let diaries=[],delivered=new Map(),storage='session',storageWarning='',notificationWarning='',queue=Promise.resolve(),restored=false,initialization,disposed=false,timer=null,generation=0,appliedGeneration=0,nextAt=null;
  const clock=()=>{const epoch=Number(now());if(!Number.isFinite(epoch)||!Number.isFinite(new Date(epoch).getTime()))throw fail('Ungültige Systemzeit.');return epoch;};
  function cancelTimer(){if(timer!==null){clearTimer(timer);timer=null;}}
  function status(){const today=wall(clock()).date;return {timezone:ZONE,nativeOnly:true,running:!disposed,storage,warning:[storageWarning,notificationWarning].filter(Boolean).join(' '),enabledCount:diaries.filter(diary=>!diary.archived&&diary.reminder.enabled&&diary.reminder.weekdays.length).length,nextAt:nextAt===null?null:new Date(nextAt).toISOString(),deliveredToday:diaries.filter(diary=>delivered.get(diary.id)===today).map(diary=>({diaryId:diary.id,date:today}))};}
  function enqueue(operation){const pending=queue.then(operation);queue=pending.catch(()=>{});return pending;}
  async function available(){return platform!=='linux'&&typeof crypto?.isAsyncEncryptionAvailable==='function'&&typeof crypto?.encryptStringAsync==='function'&&typeof crypto?.decryptStringAsync==='function'&&!!await crypto.isAsyncEncryptionAvailable();}
  async function persist(){
    const temporary=path.join(directory,'diary-reminders.'+randomUUID()+'.tmp');let file;
    try{
      if(!await available())throw new Error('unavailable');
      const text=JSON.stringify({version:1,diaries,delivered:Object.fromEntries(delivered)});if(Buffer.byteLength(text)>MAX_BYTES)throw new Error('limit');
      const encrypted=await crypto.encryptStringAsync(text);if(!Buffer.isBuffer(encrypted)||encrypted.length>MAX_BYTES+4096)throw new Error('invalid');
      await files.mkdir(directory,{recursive:true,mode:0o700});file=await files.open(temporary,'wx',0o600);await file.writeFile(encrypted);await file.sync();await file.close();file=null;
      await files.rename(temporary,target);storage='encrypted';storageWarning='';return true;
    }catch{storage='session';storageWarning=unavailable;return false;}
    finally{await file?.close().catch(()=>{});await files.unlink(temporary).catch(()=>{});}
  }
  async function restore(){
    if(restored)return;restored=true;
    try{
      if(!await available())throw new Error('unavailable');storage='encrypted';
      let encrypted;try{const stat=await files.lstat(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES+4096)throw new Error('invalid');encrypted=await files.readFile(target);}catch(error){if(error.code!=='ENOENT')throw error;}
      if(encrypted){const decoded=await crypto.decryptStringAsync(encrypted);const value=parseSaved(decoded.result);diaries=value.diaries;delivered=value.delivered;if(decoded.shouldReEncrypt)await persist();}
    }catch{storage='session';storageWarning=unavailable;}
  }
  function nextFor(diary,epoch){
    if(diary.archived||!diary.reminder.enabled||!diary.reminder.weekdays.length||(!delivered.has(diary.id)&&delivered.size>=MAX_DELIVERED))return null;
    const today=wall(epoch).date,last=delivered.get(diary.id),completed=new Set(diary.completedDates);
    let day=today>diary.startDate?today:diary.startDate;if(last&&day<=last)day=plusDays(last,1);
    for(let tries=0;day<=diary.endDate&&tries<MAX_ENTRIES+8;tries++,day=plusDays(day,1)){
      if(!diary.reminder.weekdays.includes(new Date(day+'T00:00:00.000Z').getUTCDay())||completed.has(day))continue;
      return {diary,day,at:instant(day,diary.reminder.time)};
    }
    return null;
  }
  function schedule(){
    cancelTimer();nextAt=null;if(disposed||appliedGeneration!==generation)return;
    const epoch=clock();for(const diary of diaries){const next=nextFor(diary,epoch);if(next)nextAt=nextAt===null?next.at:Math.min(nextAt,next.at);}
    if(nextAt===null)return;
    const accepted=generation;
    // Recheck after resume or a wall-clock adjustment without a background
    // service, OS wake request, or a fragile 24-hour interval across DST.
    timer=setTimer(()=>{timer=null;if(disposed||accepted!==generation)return;void enqueue(()=>check(accepted)).catch(()=>{notificationWarning='Die Erinnerungsprüfung ist momentan nicht verfügbar.';});},Math.max(1,Math.min(60000,nextAt-epoch)));
    timer?.unref?.();
  }
  async function check(accepted=generation){
    if(disposed||accepted!==generation||accepted!==appliedGeneration)return;
    const epoch=clock(),today=wall(epoch).date;
    for(const diary of diaries){
      if(disposed||accepted!==generation)break;
      if(!diary.archived&&diary.reminder.enabled&&!delivered.has(diary.id)&&delivered.size>=MAX_DELIVERED){notificationWarning='Der Erinnerungsspeicher ist voll. Neue Erinnerungen konnten nicht gesichert werden.';continue;}
      const next=nextFor(diary,epoch);if(!next||next.day!==today||next.at>epoch)continue;
      const previous=delivered.get(diary.id);delivered.set(diary.id,today);await persist();
      if(disposed||accepted!==generation){if(previous)delivered.set(diary.id,previous);else delivered.delete(diary.id);await persist();break;}
      try{await notify({type:'diary-reminder',diaryId:diary.id,date:today,title:'Context',body:'Zeit für deinen Dev Diary',createdAt:new Date(epoch).toISOString()});}
      catch{notificationWarning='Die Erinnerung konnte nicht als Systembenachrichtigung angezeigt werden.';}
    }
    if(!disposed&&accepted===generation)schedule();
  }
  function initialize(){
    if(disposed)return Promise.reject(fail('Der Erinnerungsdienst wurde beendet.'));
    if(!initialization){const accepted=generation;initialization=enqueue(async()=>{await restore();await check(accepted);return status();});}
    return initialization;
  }
  function handle(message){
    if(disposed)return Promise.reject(fail('Der Erinnerungsdienst wurde beendet.'));
    if(!message||typeof message!=='object'||Array.isArray(message))return Promise.reject(fail());
    if(message.op==='configure'){
      let configured;try{configured=normalize(message.diaries);}catch(error){return Promise.reject(error);}
      const accepted=++generation;cancelTimer();nextAt=null;
      return enqueue(async()=>{await restore();diaries=configured;appliedGeneration=accepted;notificationWarning='';await persist();await check(accepted);return status();});
    }
    if(message.op==='status')return enqueue(async()=>{await restore();await check();return status();});
    return Promise.reject(fail());
  }
  handle.initialize=initialize;
  handle.dispose=()=>{if(!disposed){disposed=true;++generation;cancelTimer();nextAt=null;}return queue.then(()=>undefined);};
  return handle;
}
