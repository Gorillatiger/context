import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {calendarDayWindow,calendarDayLayout,captureCalendarDayViewport,mountCalendarDayViewport,DAY_HOUR_HEIGHT} from '../dist/calendar-day.js';

const day='2026-10-13';
const timed=(id,start,end,extra={})=>({id,title:'Synthetischer Termin '+id,allDay:false,start,end,...extra});
const local=(clock,date=day)=>date+'T'+clock+':00+02:00';
const event=(id,start,end)=>timed(id,local(start),local(end));
const allDay=(id,start,end)=>({id,title:'Synthetischer Ganztagstermin',allDay:true,start,end});
const byId=layout=>Object.fromEntries(layout.timed.map(item=>[item.event.id,item]));

// Compare the actual hit rectangles, including the readable extension of a
// five-minute event. Actual time ranges alone would miss visual obstruction.
function assertAccessibleRectangles(layout){
  for(const item of layout.timed){
    assert.ok(item.startMinute>=0&&item.endMinute<=layout.minutes);
    assert.ok(item.topMinute>=0&&item.heightMinutes>0&&item.topMinute+item.heightMinutes<=layout.minutes);
    assert.ok(Number.isInteger(item.lane)&&item.lane>=0&&item.lane<item.lanes);
  }
  for(let i=0;i<layout.timed.length;i++)for(let j=i+1;j<layout.timed.length;j++){
    const a=layout.timed[i],b=layout.timed[j];
    const vertical=a.topMinute<b.topMinute+b.heightMinutes&&b.topMinute<a.topMinute+a.heightMinutes;
    if(vertical)assert.ok((a.lane+1)/a.lanes<=b.lane/b.lanes||(b.lane+1)/b.lanes<=a.lane/a.lanes,`${a.event.id} visually covers ${b.event.id}`);
  }
}

test('Berlin windows span 24 real hours ordinarily, 23 in spring and 25 in autumn',()=>{
  const cases=[
    ['2026-10-13','2026-10-12T22:00:00.000Z','2026-10-13T22:00:00.000Z',1440],
    ['2026-03-29','2026-03-28T23:00:00.000Z','2026-03-29T22:00:00.000Z',1380],
    ['2026-10-25','2026-10-24T22:00:00.000Z','2026-10-25T23:00:00.000Z',1500],
  ];
  for(const [value,start,end,minutes] of cases){const window=calendarDayWindow(value);assert.equal(window.day,value);assert.equal(new Date(window.start).toISOString(),start);assert.equal(new Date(window.end).toISOString(),end);assert.equal(window.minutes,minutes);}
});

test('calendar windows validate real dates across leap days and year boundaries',()=>{
  assert.equal(new Date(calendarDayWindow('2028-02-29').end).toISOString(),'2028-02-29T23:00:00.000Z');
  assert.equal(new Date(calendarDayWindow('2026-12-31').end).toISOString(),'2026-12-31T23:00:00.000Z');
  for(const invalid of ['2026-02-29','2026-04-31','2026-13-01','2026-10-13T00:00','2026-1-01','','0000-01-01',null])assert.throws(()=>calendarDayWindow(invalid));
});

test('spring omits nonexistent 02:00 while autumn distinguishes both real 02:00 hours',()=>{
  const spring=calendarDayLayout([],'2026-03-29',{now:0}),fall=calendarDayLayout([],'2026-10-25',{now:0});
  assert.equal(spring.hours.length,24);assert.equal(fall.hours.length,26);
  assert.deepEqual(spring.hours.slice(0,4).map(h=>h.label),['00:00','01:00','03:00','04:00']);
  const repeated=fall.hours.filter(h=>h.label.startsWith('02:00'));
  assert.deepEqual(repeated.map(h=>[h.minute,h.label]),[[120,'02:00 MESZ'],[180,'02:00 MEZ']]);
  for(const layout of [spring,fall]){assert.equal(new Set(layout.hours.map(h=>h.label)).size,layout.hours.length);assert.equal(layout.hours.at(-1).minute,layout.minutes);assert.equal(layout.hours.at(-1).label,'24:00');}
});

test('the host process timezone cannot change Berlin day boundaries or repeated-hour labels',()=>{
  const source=`import {calendarDayLayout} from ${JSON.stringify(new URL('../dist/calendar-day.js',import.meta.url).href)};const d=calendarDayLayout([],'2026-10-25',{now:0});process.stdout.write(JSON.stringify([d.start,d.end,d.hours]));`;
  const utc=execFileSync(process.execPath,['--input-type=module','-e',source],{env:{...process.env,TZ:'UTC'},encoding:'utf8'});
  const pacific=execFileSync(process.execPath,['--input-type=module','-e',source],{env:{...process.env,TZ:'America/Los_Angeles'},encoding:'utf8'});
  assert.equal(pacific,utc);
});

test('DST-crossing events use elapsed duration and preserve the two different 02:30 instants',()=>{
  const spring=calendarDayLayout([timed('spring','2026-03-29T01:30:00+01:00','2026-03-29T03:30:00+02:00')],'2026-03-29',{now:0}).timed[0];
  assert.equal(spring.startMinute,90);assert.equal(spring.endMinute,150);assert.equal(spring.heightMinutes,60);
  const fall=calendarDayLayout([
    timed('first','2026-10-25T02:30:00+02:00','2026-10-25T02:45:00+02:00'),
    timed('second','2026-10-25T02:30:00+01:00','2026-10-25T02:45:00+01:00'),
    timed('bridge','2026-10-25T02:30:00+02:00','2026-10-25T02:30:00+01:00'),
  ],'2026-10-25',{now:0}),rows=byId(fall);
  assert.equal(rows.first.startMinute,150);assert.equal(rows.second.startMinute,210);assert.equal(rows.bridge.endMinute-rows.bridge.startMinute,60);
  assert.match(rows.bridge.timeLabel,/02:30.*MESZ.*02:30.*MEZ/,'event labels must not make a one-hour event look like zero duration');
  assertAccessibleRectangles(fall);
});

test('midnight and all-day ends are exclusive, with a 24:00 endpoint only on the covered day',()=>{
  const events=[
    timed('ended-before',local('23:00','2026-10-12'),local('00:00')),
    timed('starts-after',local('00:00','2026-10-14'),local('01:00','2026-10-14')),
    event('starts-exact','00:00','01:00'),
    timed('ends-exact',local('23:00'),local('00:00','2026-10-14')),
    allDay('past','2026-10-12',day),allDay('today',day,'2026-10-14'),allDay('span','2026-10-12','2026-10-15'),allDay('future','2026-10-14','2026-10-15'),
  ];
  const layout=calendarDayLayout(events,day,{now:0}),rows=byId(layout);
  assert.deepEqual(Object.keys(rows),['starts-exact','ends-exact']);assert.deepEqual(layout.allDay.map(e=>e.id),['today','span']);
  assert.equal(rows['starts-exact'].continuesBefore,false);assert.equal(rows['ends-exact'].continuesAfter,false);assert.match(rows['ends-exact'].timeLabel,/23:00.*24:00/);
  assert.deepEqual(calendarDayLayout(events,'2026-10-14',{now:0}).allDay.map(e=>e.id),['span','future']);assert.equal(calendarDayLayout(events,'2026-10-15',{now:0}).allDay.length,0);
});

test('overnight and multi-day events are clipped to this window with correct continuation markers',()=>{
  const overnight=timed('overnight',local('23:30','2026-10-12'),local('02:00'));
  const before=calendarDayLayout([overnight],'2026-10-12',{now:0}).timed[0],today=calendarDayLayout([overnight],day,{now:0}).timed[0];
  assert.equal(before.startMinute,1410);assert.equal(before.endMinute,1440);assert.equal(before.continuesBefore,false);assert.equal(before.continuesAfter,true);assert.match(before.timeLabel,/23:30.*24:00/);
  assert.equal(today.startMinute,0);assert.equal(today.endMinute,120);assert.equal(today.continuesBefore,true);assert.equal(today.continuesAfter,false);assert.match(today.timeLabel,/00:00.*02:00/);
  const span=calendarDayLayout([timed('span',local('23:00','2026-10-12'),local('01:00','2026-10-14'))],day,{now:0});
  assert.equal(span.timed[0].startMinute,0);assert.equal(span.timed[0].endMinute,1440);assert.equal(span.timed[0].continuesBefore,true);assert.equal(span.timed[0].continuesAfter,true);assertAccessibleRectangles(span);
});

test('parallel short events and back-to-back five-minute events never cover another hit rectangle',()=>{
  const events=[event('long','09:00','10:00'),event('short-a','09:05','09:10'),event('short-b','09:10','09:15'),event('parallel','09:05','09:12'),event('next','10:00','10:45')];
  const layout=calendarDayLayout(events,day,{now:0}),rows=byId(layout);assertAccessibleRectangles(layout);
  assert.ok(rows['short-a'].heightMinutes>5);assert.notEqual(rows['short-a'].lane,rows['short-b'].lane);assert.notEqual(rows['short-a'].lane,rows.parallel.lane);
  assert.equal(rows.next.lanes,1,'a later disjoint group uses its own full width');
});

test('connected overlap chains share their final lane count and disjoint groups reset lanes deterministically',()=>{
  const events=[event('a','09:00','10:00'),event('b','09:30','11:00'),event('c','10:00','10:30'),event('d','12:00','13:00'),event('e','12:00','12:20'),event('f','14:00','14:10')];
  const layout=calendarDayLayout(events,day,{now:0}),rows=byId(layout);assertAccessibleRectangles(layout);
  assert.equal(rows.a.lane,rows.c.lane);assert.equal(rows.a.lanes,2);assert.equal(rows.b.lanes,2);assert.equal(rows.c.lanes,2);assert.equal(rows.d.lane,0);assert.equal(rows.e.lane,1);assert.equal(rows.f.lane,0);assert.equal(rows.f.lanes,1);
  const summary=value=>value.timed.map(e=>[e.event.id,e.lane,e.lanes,e.topMinute,e.heightMinutes]);
  assert.deepEqual(summary(calendarDayLayout([...events].reverse(),day,{now:0})),summary(layout));
});

test('dense simultaneous and last-minute events remain individually reachable inside 23/24/25-hour days',()=>{
  for(const value of ['2026-03-29',day,'2026-10-25']){
    const window=calendarDayWindow(value),end=window.end;
    const events=Array.from({length:12},(_,i)=>timed('last-'+i,new Date(end-30000).toISOString(),new Date(end).toISOString()));
    const layout=calendarDayLayout(events,value,{now:0});assert.equal(layout.maxLanes,12);assert.equal(new Set(layout.timed.map(e=>e.lane)).size,12);assertAccessibleRectangles(layout);
    assert.ok(layout.timed.every(e=>e.endMinute===window.minutes&&e.heightMinutes>.5));
  }
});

test('fractional start times retain their exact instants while readable blocks expand only the hit area',()=>{
  const layout=calendarDayLayout([timed('seconds',day+'T10:00:15+02:00',day+'T10:00:45+02:00')],day,{now:0}),item=layout.timed[0];
  assert.equal(item.startMinute,600.25);assert.equal(item.endMinute,600.75);assert.equal(item.topMinute,item.startMinute);assert.ok(item.heightMinutes>.5);assertAccessibleRectangles(layout);
  assert.notEqual(item.timeLabel,'10:00 – 10:00','a positive sub-minute duration must remain distinguishable in the label');
});

test('now is shown only inside this Berlin date, including UTC previous-day instants and exclusive midnight',()=>{
  const window=calendarDayWindow(day);
  assert.equal(calendarDayLayout([],day,{now:Date.parse('2026-10-12T22:30:00Z')}).nowMinute,30);
  assert.equal(calendarDayLayout([],day,{now:window.start}).nowMinute,0);
  assert.equal(calendarDayLayout([],day,{now:window.start-1}).nowMinute,null);assert.equal(calendarDayLayout([],day,{now:window.end}).nowMinute,null);assert.equal(calendarDayLayout([],day,{now:window.end+3600000}).nowMinute,null);
  assert.equal(calendarDayLayout([],'2026-10-25',{now:Date.parse('2026-10-25T01:30:00Z')}).nowMinute,210);
});

test('layout never mutates event data and ignores malformed, backwards or zero-length timed ranges',()=>{
  const valid=Object.freeze(event('valid','09:00','10:00')),all=Object.freeze(allDay('all',day,'2026-10-14'));
  const input=Object.freeze([valid,all,Object.freeze(timed('bad','invalid','invalid')),Object.freeze(event('backwards','12:00','11:00')),Object.freeze(event('zero','11:00','11:00'))]);
  const before=JSON.stringify(input),layout=calendarDayLayout(input,day,{now:0});
  assert.equal(JSON.stringify(input),before);assert.deepEqual(layout.timed.map(e=>e.event.id),['valid']);assert.deepEqual(layout.allDay.map(e=>e.id),['all']);assert.equal(layout.timed[0].event,valid);
});

function viewport({key='2026-10-13:alpha',minutes=1440,lanes=1,initialMinute=480,top=0,left=0,blocks=[]}={}){
  const canvas={dataset:{minutes:String(minutes),lanes:String(lanes)},style:{}},hours=[0,60,minutes].map(minute=>({dataset:{calendarMinute:String(minute)},style:{}}));
  const items=blocks.map(block=>({dataset:{top:String(block.topMinute),duration:String(block.heightMinutes),lane:String(block.lane),lanes:String(block.lanes)},style:{}}));
  const element={dataset:{dayKey:key,initialMinute:String(initialMinute)},scrollTop:top,scrollLeft:left,querySelector:selector=>selector==='.calendar-timeline-canvas'?canvas:null,querySelectorAll:selector=>selector==='[data-calendar-minute]'?hours:selector==='[data-calendar-block]'?items:[]};
  const root={querySelector:selector=>selector==='.calendar-timeline-scroll'?element:null};return {root,element,canvas,hours,items};
}

test('mounting a clock-change day sizes the canvas and blocks to elapsed time with distinct parallel hit targets',()=>{
  const layout=calendarDayLayout([timed('a','2026-10-25T02:30:00+02:00','2026-10-25T02:45:00+02:00'),timed('b','2026-10-25T02:30:00+02:00','2026-10-25T02:40:00+02:00')],'2026-10-25',{now:0});
  const f=viewport({minutes:layout.minutes,lanes:layout.maxLanes,initialMinute:layout.initialMinute,blocks:layout.timed});mountCalendarDayViewport(null,f.root);
  assert.equal(parseFloat(f.canvas.style.height),25*DAY_HOUR_HEIGHT);assert.ok(parseFloat(f.canvas.style.minWidth)>=layout.maxLanes*120);
  assert.equal(parseFloat(f.hours[1].style.top),DAY_HOUR_HEIGHT);assert.equal(parseFloat(f.hours[2].style.top),parseFloat(f.canvas.style.height));
  assert.equal(f.items[0].style.top,f.items[1].style.top);assert.notEqual(f.items[0].style.left,f.items[1].style.left);assert.ok(parseFloat(f.items[0].style.height)>0);
  const px=(value,width)=>{const match=value.match(/^calc\(([\d.]+)% ([+-]) ([\d.]+)px\)$/);assert.ok(match,value);return Number(match[1])/100*width+(match[2]==='+'?1:-1)*Number(match[3]);};
  const width=1000,a=f.items[0].style,b=f.items[1].style;assert.ok(px(a.left,width)+px(a.width,width)<px(b.left,width));
});

test('viewport restoration is scoped to the exact day key and never uses another date or course position',()=>{
  const before=viewport({top:650,left:130}),saved=captureCalendarDayViewport(before.root),same=viewport();mountCalendarDayViewport(saved,same.root);
  assert.deepEqual(saved,{key:'2026-10-13:alpha',top:650,left:130});assert.equal(same.element.scrollTop,650);assert.equal(same.element.scrollLeft,130);
  for(const key of ['2026-10-14:alpha','2026-10-13:beta']){const next=viewport({key,initialMinute:540,top:999,left:777});mountCalendarDayViewport(saved,next.root);assert.equal(next.element.scrollTop,9*DAY_HOUR_HEIGHT);assert.equal(next.element.scrollLeft,0);}
});

test('an empty day starts near 08:00 and missing DOM surfaces are harmless without accessing globals',()=>{
  const layout=calendarDayLayout([],day,{now:0});assert.equal(layout.initialMinute,480);assert.equal(layout.maxLanes,1);
  assert.equal(calendarDayLayout([event('late','14:00','15:00')],day,{now:0}).initialMinute,780);
  const absent={querySelector:()=>null};assert.equal(captureCalendarDayViewport(absent),null);assert.equal(captureCalendarDayViewport(null),null);assert.doesNotThrow(()=>mountCalendarDayViewport({key:'old',top:900,left:50},absent));assert.doesNotThrow(()=>mountCalendarDayViewport(null,null));
});
