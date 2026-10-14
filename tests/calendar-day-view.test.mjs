import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalendarView} from '../dist/calendar.js';
import {dateKey,initialState} from '../dist/core.js';
import {validateCalendarEvent} from '../dist/calendar-engine.js';

const decode=value=>String(value).replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[key]);
const attributes=text=>Object.fromEntries([...text.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g)].map(match=>[match[1],decode(match[2]??match[3]??match[4]??'')]));
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
function replace(t,key,value){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];});}
const event=(id,patch={})=>validateCalendarEvent({id,title:'Synthetic '+id,projectId:'alpha',start:'2026-10-31T09:00:00Z',end:'2026-10-31T10:00:00Z',source:{kind:'local',title:'QA fixture',url:'',excerpt:'',externalId:''},...patch},{projectIds:['alpha','beta']});
function fixture(t,{course='alpha',events}={}){
 const listeners=new Map(),focused=[],scrolled=[],saves=[];let view,html='',nodes=[];
 const workspace={...initialState(),activeCourse:course,projects:[{id:'alpha',name:'Synthetic Alpha',links:[]},{id:'beta',name:'Synthetic Beta',links:[]}],tasks:[],calendarEvents:events||[
  event('alpha-one'),event('alpha-two',{start:'2026-10-31T09:30:00Z',end:'2026-10-31T11:00:00Z'}),
  event('alpha-all',{allDay:true,start:'2026-10-31',end:'2026-11-02'}),
  event('beta-only',{projectId:'beta',title:'Private-to-beta synthetic fixture'}),
  event('next-day',{start:'2026-11-01T09:00:00Z',end:'2026-11-01T10:00:00Z'})
 ]};
 function render(){html=view.render();nodes=[...html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)].map(match=>{const attrs=attributes(match[2]),dataset=Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));return {tagName:match[1].toUpperCase(),id:attrs.id||'',attrs,dataset,value:attrs.value||'',style:{},getAttribute:name=>attrs[name]??null,focus:()=>focused.push(attrs.id),scrollIntoView:()=>scrolled.push(attrs.id),closest(selector){return selector==='[data-calendar]'&&dataset.calendar?this:null;}};});}
 const document={visibilityState:'visible',addEventListener(type,handler){listeners.set(type,[...(listeners.get(type)||[]),handler]);},removeEventListener(type,handler){listeners.set(type,(listeners.get(type)||[]).filter(next=>next!==handler));},getElementById:id=>nodes.find(node=>node.id===id)||null,querySelector:selector=>selector.startsWith('#')?nodes.find(node=>node.id===selector.slice(1))||null:nodes.find(node=>(node.attrs.class||'').split(' ').includes(selector.slice(1)))||null};
 t.after(()=>view?.dispose());replace(t,'document',document);replace(t,'window',{contextDesktop:{}});
 view=createCalendarView({getContext:()=>({workspace,updates:[]}),onChange:render,onSave:next=>{saves.push(next);workspace.calendarEvents=next;return true;},onShow(){},onTask(){}});render();
 const dispatch=(type,target)=>{for(const handler of listeners.get(type)||[])handler({target,preventDefault(){}});};
 const control=(action,value,id)=>{const found=nodes.find(node=>node.tagName==='BUTTON'&&node.dataset.calendar===action&&(value===undefined||node.dataset.value===value)&&(id===undefined||node.dataset.id===id));assert(found,`missing actual rendered calendar control ${action}/${value??''}/${id??''}`);return found;};
 return {view,workspace,focused,scrolled,saves,get html(){return html;},control,click(action,value,id){dispatch('click',control(action,value,id));},changeDate(value){const node=document.getElementById('calendar-date');assert(node,'missing date input');node.value=value;dispatch('change',node);},date:()=>document.getElementById('calendar-date')?.value,timeline:()=>document.querySelector('.calendar-timeline-scroll'),async day(value='2026-10-31'){this.click('mode','day');this.changeDate(value);await tick();},nodes:()=>nodes};
}

test('actual calendar exposes day/month/agenda with one selected accessible view control',async t=>{
 const f=fixture(t);
 for(const mode of ['day','agenda','month','day']){f.click('mode',mode);await tick();for(const candidate of ['day','month','agenda'])assert.equal(f.control('mode',candidate).getAttribute('aria-pressed'),String(mode===candidate));if(mode==='day'){assert(f.timeline());assert.equal(f.date(),dateKey());}}
});

test('day navigation moves by one real calendar date across month and year boundaries',async t=>{
 const f=fixture(t);await f.day();assert.equal(f.timeline().dataset.dayKey,'2026-10-31/alpha');f.click('previous');assert.equal(f.date(),'2026-10-30');f.click('next');f.click('next');assert.equal(f.date(),'2026-11-01');assert.equal(f.timeline().dataset.dayKey,'2026-11-01/alpha');
 f.changeDate('2026-12-31');f.click('next');assert.equal(f.date(),'2027-01-01');f.click('previous');assert.equal(f.date(),'2026-12-31');assert.equal(f.control('previous').getAttribute('aria-label'),'Vorheriger Tag');assert.equal(f.control('next').getAttribute('aria-label'),'Nächster Tag');
});

test('the day date picker retains its selected date through other views and Today resets it',async t=>{
 const f=fixture(t);await f.day('2026-10-13');assert.equal(f.date(),'2026-10-13');f.click('mode','agenda');f.click('mode','month');f.click('mode','day');assert.equal(f.date(),'2026-10-13');f.click('today');assert.equal(f.date(),dateKey());assert.equal(f.timeline().dataset.dayKey,dateKey()+'/alpha');
});

test('invalid picker values never replace the selected day or crash the rendered calendar',async t=>{
 const f=fixture(t);await f.day('2026-10-13');
 for(const value of ['2026-02-30','2026-13-01','not-a-date','', '2026-10-13<script>']){f.changeDate(value);await tick();assert.equal(f.timeline().dataset.dayKey,'2026-10-13/alpha');assert(!f.html.includes('Invalid Date'));assert(!f.html.includes('<script>'));}
 assert.equal(f.saves.length,0);
});

test('day timeline and its detail list obey the current course selection',async t=>{
 const f=fixture(t);await f.day();assert.match(f.html,/Synthetic alpha-one/);assert.match(f.html,/Synthetic alpha-two/);assert.match(f.html,/Synthetic alpha-all/);assert.doesNotMatch(f.html,/Private-to-beta synthetic fixture/);
 f.workspace.activeCourse='beta';f.view.open();assert.match(f.html,/Private-to-beta synthetic fixture/);assert.doesNotMatch(f.html,/Synthetic alpha-one|Synthetic alpha-two|Synthetic alpha-all/);assert.equal(f.saves.length,0);
});

test('clicking an actual hour block focuses its detail card without opening an editor or saving data',async t=>{
 const f=fixture(t);await f.day();const node=f.control('focus-event',undefined,'alpha-one');assert(node.getAttribute('aria-label')?.trim(),'time block needs a usable accessible name');f.click('focus-event',undefined,'alpha-one');await tick();
 assert(f.focused.includes('calendar-event-alpha-one'));assert.match(f.html,/id="calendar-event-alpha-one"[^>]*tabindex="-1"/);assert.doesNotMatch(f.html,/id="calendar-event-form"/);assert.equal(f.saves.length,0);
});

test('an imported calendar time block leads to source details while keeping provider times read-only',async t=>{
 const remote=event('remote',{title:'Synthetic Outlook entry',source:{kind:'outlook',title:'Synthetic original',url:'https://outlook.office.com/calendar/item/synthetic',excerpt:'Source evidence for QA',externalId:'remote'}});
 const f=fixture(t,{events:[remote]});await f.day();f.click('focus-event',undefined,'remote');assert(f.focused.includes('calendar-event-remote'));assert.match(f.html,/Source evidence for QA/);assert.match(f.html,/Synthetic original/);assert.doesNotMatch(f.html,/id="calendar-event-form"/);assert.equal(f.saves.length,0);
});

test('an empty selected day retains its hour grid and the New event action defaults to that day',async t=>{
 const f=fixture(t,{events:[]});await f.day('2026-11-04');assert(f.timeline());assert.equal(f.timeline().dataset.dayKey,'2026-11-04/alpha');f.click('new');assert.match(f.html,/id="calendar-event-form"/);assert.match(f.html,/value="2026-11-04T09:00"/);assert.match(f.html,/value="2026-11-04T10:00"/);assert(f.focused.includes('calendar-title'));assert.equal(f.saves.length,0);
});

test('actual day markup separates all-day entries from timed blocks and exposes overlap lanes',async t=>{
 const f=fixture(t);await f.day();const allDay=f.control('focus-event',undefined,'alpha-all'),first=f.control('focus-event',undefined,'alpha-one'),second=f.control('focus-event',undefined,'alpha-two');
 assert(!('calendarBlock' in allDay.dataset),'all-day entry must not acquire an hour position');assert('calendarBlock' in first.dataset);assert('calendarBlock' in second.dataset);assert.equal(first.dataset.lanes,'2');assert.equal(second.dataset.lanes,'2');assert.notEqual(first.dataset.lane,second.dataset.lane);
 assert(f.html.indexOf('Synthetic alpha-all')<f.html.indexOf('class="calendar-timeline-scroll"'),'all-day section must precede the scrolling hour grid');assert.match(f.html,/Ganztägig/);assert.equal(f.timeline().getAttribute('role'),'region');assert.equal(f.timeline().getAttribute('tabindex'),'0');assert.match(f.timeline().getAttribute('aria-label'),/Stundenraster/);f.click('focus-event',undefined,'alpha-all');assert(f.focused.includes('calendar-event-alpha-all'));
});

test('choosing a date in the actual month then switching to Day shows that selected day',async t=>{
 const f=fixture(t);await f.day('2026-10-01');f.click('mode','month');f.click('day','2026-10-31');f.click('mode','day');assert.equal(f.date(),'2026-10-31');assert.equal(f.timeline().dataset.dayKey,'2026-10-31/alpha');assert.equal(f.control('mode','day').getAttribute('aria-pressed'),'true');
});
