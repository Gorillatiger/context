import test from 'node:test';
import assert from 'node:assert/strict';
import {readCourseMenu,cleanCourses,extractCourses,requestPaths} from '../desktop/course-menu.mjs';

// Minimale DOM-Attrappe: Elemente mit Kindern, Text und Attributen.
class El{
  constructor(tag,{text='',attrs={},children=[],onClick}={}){this.tag=tag;this.textContent=text;this.attrs=attrs;this.children=children;this.parentElement=null;this.onClick=onClick;children.forEach(c=>c.parentElement=this);}
  getAttribute(n){return this.attrs[n]??null;}
  get innerText(){return this.textContent;}
  all(){return this.children.flatMap(c=>[c,...c.all()]);}
  querySelectorAll(sel){return this.all().filter(e=>sel.split(',').some(s=>matches(e,s.trim())));}
  click(){this.onClick?.();}
  dispatchEvent(){}
}
const matches=(e,s)=>{
  if(s==='a[href]')return e.tag==='a'&&!!e.attrs.href;
  if(s==='input[type=password]')return e.tag==='input'&&e.attrs.type==='password';
  if(s.startsWith('header ')||s.startsWith('nav ')||s.startsWith('[role=menubar]'))return e.attrs.inHeader===true;
  return e.tag===s;
};
const card=(slug,title)=>new El('a',{text:'Seminar\n'+title,attrs:{href:`https://spaces.th-koeln.de/${slug}/`}});
const menu=()=>new El('div',{children:[new El('span',{text:'Meine Spaces'}),new El('div',{children:[card('prototyping-things-w26','Prototyping Things W2026 – Vollständiger Titel'),card('studio-code','Studio Code'),new El('a',{text:'Impressum',attrs:{href:'https://spaces.th-koeln.de/impressum/seite/'}})]})]});
const page=(body,pathname='/')=>{const root=new El('body',{children:body});return {location:{hostname:'spaces.th-koeln.de',origin:'https://spaces.th-koeln.de',pathname,href:'https://spaces.th-koeln.de'+pathname},document:root,MouseEvent:class{}};};
const ctx=p=>({...p,document:Object.assign(p.document,{querySelector:s=>p.document.querySelectorAll(s)[0]||null})});

test('reads course cards from an already open "Meine Spaces" menu',async()=>{
  const r=await readCourseMenu(ctx(page([menu()])),async()=>{});
  assert.equal(r.loginRequired,false);
  assert.deepEqual(r.courses.map(c=>c.url),['https://spaces.th-koeln.de/prototyping-things-w26/','https://spaces.th-koeln.de/studio-code/']);
  assert.equal(r.courses[0].title,'Seminar\nPrototyping Things W2026 – Vollständiger Titel'.split('\n').sort((a,b)=>b.length-a.length)[0]);
});

test('opens the Spaces menu when the cards are not in the page yet',async()=>{
  let host;const hidden=new El('div');
  const opener=new El('button',{text:'Spaces',attrs:{inHeader:true},onClick:()=>{hidden.children.push(...menu().children);hidden.children.forEach(c=>c.parentElement=hidden);}});
  host=page([opener,hidden]);
  const r=await readCourseMenu(ctx(host),async()=>{});
  assert.equal(r.courses.length,2);
});

test('a login page returns no courses',async()=>{
  const login=page([new El('input',{attrs:{type:'password'}})]);
  assert.deepEqual(await readCourseMenu(ctx(login),async()=>{}),{loginRequired:true,courses:[],captured:[]});
});

test('main-process cleaning keeps only single-segment Spaces course roots',()=>{
  const out=cleanCourses([{url:'https://spaces.th-koeln.de/a-b/x',title:' A\n B '},{url:'https://evil.example/a/'},{url:'https://spaces.th-koeln.de/'},{url:'javascript:1'}]);
  assert.deepEqual(out,[]);  // /a-b/x hat zwei Segmente
  assert.deepEqual(cleanCourses([{url:'https://spaces.th-koeln.de/a-b/',title:' A\n B '},{url:'https://spaces.th-koeln.de/a-b/',title:'doppelt'}]),[{url:'https://spaces.th-koeln.de/a-b/',title:'A B'}]);
});

test('backend answers are mined whatever their shape (JSON objects, rendered titles, HTML fragments)',()=>{
  const json=JSON.stringify({spaces:[{id:1,title:{rendered:'Prototyping Things W2026 &amp; mehr'},link:'https://spaces.th-koeln.de/prototyping-things-w26/'},{id:2,name:'Studio Code',url:'/studio-code/'},{id:3,title:'Beitrag',link:'https://spaces.th-koeln.de/blog/2026/post/'}]});
  const html=JSON.stringify({html:'<ul><li><a href="https://spaces.th-koeln.de/werkstattpraktikum/"><span>Seminar</span> Werkstattpraktikum</a></li></ul>'});
  const out=cleanCourses(extractCourses([{path:'/a',body:json},{path:'/b',body:html},{path:'/c',body:'<a href="/c-and-c-central/">Code and Context Central</a>'},{path:'/d',body:'kein json'}]));
  assert.deepEqual(out.map(c=>c.url),['https://spaces.th-koeln.de/prototyping-things-w26/','https://spaces.th-koeln.de/studio-code/','https://spaces.th-koeln.de/werkstattpraktikum/','https://spaces.th-koeln.de/c-and-c-central/']);
  assert.equal(out[0].title,'Prototyping Things W2026 & mehr');assert.equal(out[2].title,'Seminar Werkstattpraktikum');
});

test('menu reading records XHR/fetch answers made while the menu opens and restores the page functions',async()=>{
  let fetched=0;const original=async()=>({clone(){return {text:async()=>JSON.stringify([{link:'https://spaces.th-koeln.de/neu/',title:'Neu'}])};}});
  const hidden=new El('div');
  const opener=new El('button',{text:'Spaces',attrs:{inHeader:true},onClick:()=>{fetched++;void host.fetch('/wp-json/x/spaces');}});
  const host=ctx(page([opener,hidden]));host.fetch=original;
  const r=await readCourseMenu(host,async()=>{await new Promise(r=>setTimeout(r,5));});
  assert.equal(fetched,1);assert.equal(host.fetch,original);
  assert.deepEqual(requestPaths(r.captured),['/wp-json/x/spaces']);
  assert.deepEqual(cleanCourses(extractCourses(r.captured)).map(c=>c.url),['https://spaces.th-koeln.de/neu/']);
});
