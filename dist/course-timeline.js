const BERLIN='Europe/Berlin';
const dayKey=value=>{const t=Date.parse(value);return Number.isFinite(t)?new Intl.DateTimeFormat('sv-SE',{timeZone:BERLIN,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t)):'';};
const timeLabel=value=>new Intl.DateTimeFormat('de-DE',{timeZone:BERLIN,hour:'2-digit',minute:'2-digit'}).format(new Date(value));
const addDays=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const weekday=date=>(new Date(date+'T12:00:00Z').getUTCDay()+6)%7; // Montag = 0
const clip=(value,max=80)=>String(value||'').replace(/\s+/g,' ').trim().slice(0,max);

// Kalender des Diary-Zeitraums: nur Tage von startDate bis endDate, aufgefüllt auf volle Montag-Sonntag-Wochen.
export function buildDiaryCalendar(diary,state={},{today=''}={}){
  if(!diary?.startDate||!diary?.endDate||diary.endDate<diary.startDate)return {weeks:[],counts:{events:0,tasks:0}};
  const byDay=new Map(),add=(date,item)=>{if(date<diary.startDate||date>diary.endDate)return;(byDay.get(date)||byDay.set(date,[]).get(date)).push(item);};
  let events=0,tasks=0;
  for(const e of state.calendarEvents||[]){
    if(e?.projectId!==diary.projectId)continue;const date=dayKey(e.start);if(!date)continue;
    add(date,{kind:'event',title:clip(e.title),time:e.allDay?'':timeLabel(e.start),sort:Date.parse(e.start)});events++;
  }
  for(const t of state.tasks||[]){
    if(t?.projectId!==diary.projectId||!t.due)continue;const date=String(t.due).slice(0,10);
    add(date,{kind:'task',title:clip(t.title),done:t.status==='done',time:'',sort:Date.parse(date+'T23:59:00Z')});tasks++;
  }
  const entries=new Map((diary.entries||[]).map(e=>[e.date,e]));
  const cells=[];let first=diary.startDate;first=addDays(first,-weekday(first));let last=diary.endDate;last=addDays(last,6-weekday(last));
  for(let d=first;d<=last&&cells.length<400;d=addDays(d,1)){
    const inRange=d>=diary.startDate&&d<=diary.endDate,entry=entries.get(d);
    cells.push({date:d,inRange,today:d===today,completed:!!entry?.completed,written:!!(entry&&['done','learned','problems','next'].some(k=>String(entry[k]||'').trim())),items:(byDay.get(d)||[]).sort((a,b)=>a.sort-b.sort)});
  }
  const weeks=[];for(let i=0;i<cells.length;i+=7)weeks.push(cells.slice(i,i+7));
  return {weeks,counts:{events,tasks}};
}
