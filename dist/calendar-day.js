import {berlinLocalToInstant} from './calendar-engine.js';

const time = new Intl.DateTimeFormat('de-DE', {timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const preciseTime = new Intl.DateTimeFormat('de-DE', {timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const offset = new Intl.DateTimeFormat('de-DE', {timeZone:'Europe/Berlin',timeZoneName:'short'});
const zone = instant => offset.formatToParts(instant).find(part=>part.type==='timeZoneName')?.value||'';
const MINUTES_PER_HOUR = 60;
export const DAY_HOUR_HEIGHT = 56;
const MIN_BLOCK_MINUTES = 32;

export function calendarDayWindow(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Ungültiger Kalendertag.');
  const date = new Date(day+'T12:00:00Z');
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0,10)!==day) throw new Error('Ungültiger Kalendertag.');
  const next = new Date(date.valueOf()+86400000).toISOString().slice(0,10);
  const start = Date.parse(berlinLocalToInstant(day,'00:00'));
  const end = Date.parse(berlinLocalToInstant(next,'00:00'));
  return {day,start,end,minutes:(end-start)/60000};
}

// Positions use elapsed instants: a Berlin clock-change day has 23 or 25
// real hours. Repeated wall-clock hours receive distinct zone labels.
export function calendarDayLayout(events,day,{now=Date.now()}={}) {
  const window = calendarDayWindow(day), allDay=[], timed=[];
  for (const event of events) {
    if (event.allDay) {
      if (event.start<=day && event.end>day) allDay.push(event);
      continue;
    }
    const start=Date.parse(event.start),end=Date.parse(event.end);
    if (!Number.isFinite(start)||!Number.isFinite(end)||end<=start||start>=window.end||end<=window.start) continue;
    const startMinute=(Math.max(start,window.start)-window.start)/60000;
    const endMinute=(Math.min(end,window.end)-window.start)/60000;
    const topMinute=Math.min(startMinute,window.minutes-MIN_BLOCK_MINUTES);
    const heightMinutes=Math.max(endMinute-topMinute,MIN_BLOCK_MINUTES);
    const exact = start % 60000 !== 0 || end % 60000 !== 0;
    const formatter=exact?preciseTime:time;
    const zonesDiffer=zone(start)!==zone(end);
    const showZone=instant=>zonesDiffer || (window.minutes===25*60 && time.format(instant).startsWith('02:'));
    const label=instant=>formatter.format(instant)+(showZone(instant)?' '+zone(instant):'');
    timed.push({event,startMinute,endMinute,topMinute,heightMinutes,
      continuesBefore:start<window.start,continuesAfter:end>window.end,
      timeLabel:(start<window.start?'00:00':label(start))+' – '+(end>=window.end?'24:00':label(end))});
  }
  timed.sort((a,b)=>a.startMinute-b.startMinute||b.endMinute-a.endMinute||a.event.id.localeCompare(b.event.id));
  // Greedy lanes per connected group. Small blocks reserve a readable target
  // without covering the next event; the displayed time stays exact.
  let cluster=[],ends=[],clusterEnd=-1;
  const finish=()=>{for(const item of cluster)item.lanes=ends.length;cluster=[];ends=[];clusterEnd=-1;};
  for(const item of timed){
    if(item.topMinute>=clusterEnd)finish();
    let lane=ends.findIndex(end=>end<=item.topMinute);
    if(lane<0)lane=ends.length;
    ends[lane]=item.topMinute+item.heightMinutes;item.lane=lane;
    cluster.push(item);clusterEnd=Math.max(clusterEnd,ends[lane]);
  }
  finish();
  const hours=Array.from({length:window.minutes/MINUTES_PER_HOUR+1},(_,index)=>{
    const instant=window.start+index*3600000;
    return {minute:index*60,label:instant===window.end?'24:00':time.format(instant),zone:offset.formatToParts(instant).find(part=>part.type==='timeZoneName')?.value||''};
  });
  const frequencies=new Map();for(const hour of hours)frequencies.set(hour.label,(frequencies.get(hour.label)||0)+1);
  for(const hour of hours)if(frequencies.get(hour.label)>1)hour.label+=' '+hour.zone;
  const nowMinute=now>=window.start&&now<window.end?(now-window.start)/60000:null;
  const initialMinute=timed.length?Math.max(0,timed[0].startMinute-60):Math.min(8*60,window.minutes);
  return {...window,allDay,timed,hours,nowMinute,initialMinute,maxLanes:Math.max(1,...timed.map(item=>item.lanes))};
}

export function captureCalendarDayViewport(root=globalThis.document) {
  const element=root?.querySelector?.('.calendar-timeline-scroll');
  return element?{key:element.dataset.dayKey,top:element.scrollTop,left:element.scrollLeft}:null;
}
export function mountCalendarDayViewport(snapshot,root=globalThis.document) {
  const element=root?.querySelector?.('.calendar-timeline-scroll');
  if(!element)return;
  const canvas=element.querySelector('.calendar-timeline-canvas');
  canvas.style.height=Number(canvas.dataset.minutes)/60*DAY_HOUR_HEIGHT+'px';
  canvas.style.minWidth=Math.max(280,Number(canvas.dataset.lanes)*124+68)+'px';
  for(const hour of element.querySelectorAll('[data-calendar-minute]'))hour.style.top=Number(hour.dataset.calendarMinute)/60*DAY_HOUR_HEIGHT+'px';
  for(const block of element.querySelectorAll('[data-calendar-block]')){
    block.style.top=Number(block.dataset.top)/60*DAY_HOUR_HEIGHT+'px';
    block.style.height=Number(block.dataset.duration)/60*DAY_HOUR_HEIGHT+'px';
    block.style.left=`calc(${Number(block.dataset.lane)/Number(block.dataset.lanes)*100}% + ${Number(block.dataset.lane)===0?4:2}px)`;
    block.style.width=`calc(${100/Number(block.dataset.lanes)}% - 6px)`;
  }
  if(snapshot?.key===element.dataset.dayKey){element.scrollTop=snapshot.top;element.scrollLeft=snapshot.left;}
  else {element.scrollTop=Number(element.dataset.initialMinute)/60*DAY_HOUR_HEIGHT;element.scrollLeft=0;}
}
