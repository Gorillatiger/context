import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,LINK_META,safeURL,taskCounts,notificationKey,courseMatches} from '../dist/core.js';
import {notificationGroups,notificationGroup,resolveNotificationGroup,formatSnapshotTime,notificationTime} from '../dist/inbox.js';
import {renderMarkdown} from '../dist/markdown.js';

const source=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
const part=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture(){
  const sandbox={view:'today',state:initialState(),LINK_META,safeURL,taskCounts,notificationKey,courseMatches,notificationGroups,notificationGroup,resolveNotificationGroup,formatSnapshotTime,notificationTime,renderMarkdown,
    showArchived:false,taskFilter:'open',taskProject:'',inboxGroup:'all',inboxSource:'all',inboxFilter:'all',inboxLimit:50,feedBusy:false,feedCheckedAt:'',hasLocalConnector:true,sourceStates:[],noteDrafts:new Map(),floatingOpen:false,
    brandLogo:id=>'<span data-brand="'+id+'"></span>',brandClass:()=>'',dateKey:()=> '2026-10-13',relativeTime:()=>'',inboxItems:()=>[],
    companion:{renderTeaser:()=>''},calendarView:{teaser:()=>''},diaryView:{banner:()=>'',renderCards:()=>''},projectOptions:()=>'<option value="">Persönlich</option>',
    openModal:content=>{sandbox.lastModal=content;},syncAgentContext:()=>{},modal:{dataset:{}},formError:()=>'<p role="alert" hidden></p>',courseOptions:()=>'',storageAvailable:true};
  sandbox.meta=id=>LINK_META.find(t=>t.id===id);sandbox.project=id=>sandbox.state.projects.find(p=>p.id===id);
  sandbox.inCourse=item=>courseMatches(item.projectId,sandbox.state.activeCourse);sandbox.scopedState=()=>({...sandbox.state,tasks:sandbox.state.tasks.filter(sandbox.inCourse)});
  sandbox.sourceName=id=>sandbox.meta(id)?.name||id;sandbox.notificationRow=item=>'<article>'+item.id+'</article>';
  vm.createContext(sandbox);
  vm.runInContext(part('const esc =','\nconst uid')+part('const icon =','\nconst dateLabel')+part('function heading(','\nfunction renderToday()')+part('function renderToday()','\nfunction relativeTime(')+part('function projectCard(','\nfunction taskRow(')+part('function taskRow(','\nfunction renderTasks(')+part('function renderBookmarks()','\nfunction inboxItems()')+part('function filteredInboxItems()','\nfunction previewNotification(')+part('function renderNotes()','\nfunction editMarkdownNote(')+part('function editMarkdownNote(','\nfunction pluginCard(')+part('function editTask(','\nfunction editLink('),sandbox);
  vm.runInContext(part('function modalHead(','\nfunction formError('),sandbox);
  return sandbox;
}

test('shared headings stay short, use decorative icons and preserve their primary action',()=>{
  const f=fixture();f.view='projects';
  const html=vm.runInContext('heading("Repeated label","<Projekt>","",\'<button data-action="add-project">Neues Projekt</button>\')',f);
  assert.match(html,/<h1>&lt;Projekt&gt;<\/h1>/);assert.match(html,/aria-hidden="true"/);assert.match(html,/data-action="add-project"/);
  assert.doesNotMatch(html,/Repeated label|page-description/);
  assert.match(vm.runInContext('heading("Label","Aufgaben","Fristen und nächste Schritte.")',f),/page-description/);
});

test('secondary edit and remove controls keep their labels, tooltips and action identities',()=>{
  const f=fixture();f.state.tasks=[{id:'task-one',title:'Synthetic task',status:'todo',projectId:'',due:'',url:''}];
  const row=vm.runInContext('taskRow(state.tasks[0])',f);
  assert.match(row,/aria-label="Aufgabe bearbeiten: Synthetic task" title="Aufgabe bearbeiten: Synthetic task"/);assert.match(row,/data-action="edit-task" data-id="task-one"/);
  vm.runInContext('editTask("task-one")',f);
  assert.match(f.lastModal,/type="button" class="icon-button app-icon-action danger" aria-label="Aufgabe entfernen" title="Aufgabe entfernen" data-action="delete-task" data-id="task-one"/);
  assert.match(f.lastModal,/type="submit"/);assert.match(f.lastModal,/Abbrechen|Aufgabe entfernen/);
  const unsafe=vm.runInContext('iconAction("edit",\'Name " & <tag>\',\'data-action="edit"\')',f);
  assert.match(unsafe,/aria-label="Name &quot; &amp; &lt;tag&gt;"/);assert.doesNotMatch(unsafe,/<tag>/);
});

test('notes retain import, Dev Diary and privacy details without repeated banner copy',()=>{
  const f=fixture();f.view='notes';const html=vm.runInContext('renderNotes()',f);
  assert.match(html,/<h1>Notizen<\/h1>/);assert.match(html,/data-action="start-import" data-id="obsidian"/);assert.match(html,/Markdown-Hilfe/);assert.match(html,/\[\[Notiztitel\]\]/);
  assert.doesNotMatch(html,/Ein Gedanke\. Viele Verbindungen\.|GEDANKEN BRAUCHEN RAUM/);
  vm.runInContext('editMarkdownNote()',f);
  assert.match(f.lastModal,/data-dd-action="new"/);assert.match(f.lastModal,/<details class="app-details/);assert.match(f.lastModal,/Bilder, HTML und eingebettete Inhalte werden nicht ausgeführt/);assert.match(f.lastModal,/Entwürfe bleiben bis zum Neuladen/);
});

test('Inbox errors and partial-scope warnings remain visible while repeated read-state help is accessible',()=>{
  const f=fixture();f.view='inbox';f.sourceStates=[{source:'mattermost',status:'connected',complete:false,message:'Teilstand: maximal 100 Textvorschauen.'},{source:'gitlab',status:'error',message:'Zugriff abgelehnt.'}];
  const html=vm.runInContext('renderInbox()',f);
  assert.match(html,/<h1>Mitteilungen<\/h1>/);assert.match(html,/<small class="source-detail">Teilstand: maximal 100 Textvorschauen\.<\/small>/);assert.match(html,/<small class="source-detail">Zugriff abgelehnt\.<\/small>/);
  assert.match(html,/data-action="connection-help"/);assert.match(html,/Browser-Stand &amp; Aktualisieren|Browser-Stand & Aktualisieren/);assert.match(html,/Mails und Nachrichten bleiben beim Anbieter ungelesen/);
  assert.match(html,/Ohne|ohne Betreff auf dem Sperrbildschirm/);assert.match(html,/Hinweise funktionieren bei geöffnetem Hub/);
});

test('Today offers one global search and an explicit agent handoff while retaining courses and useful work',()=>{
 const f=fixture();const html=vm.runInContext('renderToday()',f);
 assert.match(html,/id="workspace-search"/);assert.match(html,/id="home-search-query"/);assert.equal((html.match(/data-action="home-agent"/g)||[]).length,1);
 assert.match(html,/data-action="project"/);assert.match(html,/data-view="sources"/);assert.match(html,/Deine nächsten Schritte/);assert.match(html,/data-view="calendar"/);
 assert.doesNotMatch(html,/overview-stats|assistant-starters|Speicher &amp; Backup/);
 f.state.projects=[];assert.match(vm.runInContext('renderToday()',f),/data-action="add-project"/);
});

test('the actual render toggles the full-page chat state and preserves viewport hooks across views',()=>{
  const f=fixture(),classes=new Map(),calls=[];f.view='ai';
  f.document={getElementById:()=>null,body:{classList:{toggle:(name,on)=>classes.set(name,on)}}};f.window={contextTheme:{refreshControls:()=>{}}};
  const root={innerHTML:''};f.$=()=>root;f.captureMailViewport=()=>{calls.push('mail capture');return {mail:true};};f.captureChatViewport=()=>{calls.push('chat capture');return {chat:true};};
  f.captureInboxViewport=()=>null;f.restoreInboxViewport=()=>{};
  f.restoreMailViewport=value=>calls.push(value?.mail?'mail restore':'no mail');f.restoreChatViewport=value=>calls.push(value?.chat?'chat restore':'no chat');
  f.browserView={hide:()=>{},mount:()=>{}};f.inventoryView={hide:()=>{},mount:()=>{}};f.kiView={isBusy:()=>false,render:()=>'<div>chat</div>',load:()=>Promise.resolve()};f.mailView={render:()=>'<div>mail</div>',load:()=>Promise.resolve()};
  for(const name of ['renderInventory','renderTasks','renderImports','renderPlugins','renderSubmissions','renderTools','renderSettings'])f[name]=()=>'';
  vm.runInContext(part('function render()','\nfunction heading('),f);
  vm.runInContext('render()',f);assert.equal(classes.get('ai-active'),true);assert.ok(calls.includes('chat capture'));assert.ok(calls.includes('chat restore'));
  f.floatingOpen=true;vm.runInContext('render()',f);assert.equal(classes.get('ai-active'),false);assert.match(root.innerHTML,/Chat hier anzeigen/);
  f.view='inventory';vm.runInContext('render()',f);assert.equal(classes.get('ai-active'),false);assert.equal(classes.get('browser-active'),true);
  f.view='mail';vm.runInContext('render()',f);assert.equal(classes.get('mail-active'),true);assert.equal(classes.get('ai-active'),false);assert.ok(calls.includes('mail restore'));
});

test('KI passive rerenders retain backward selections and input/select focus without forcing page scrolling',()=>{
  class TextArea{}class Input{}class Select{}
  for(const Element of [TextArea,Input,Select]){
    const active=new Element();Object.assign(active,{id:'stable-control',selectionStart:1,selectionEnd:5,selectionDirection:'backward'});
    const focus=[],selections=[],replacement={focus:options=>focus.push(options),setSelectionRange:(...range)=>selections.push(range)};
    let options,renders=0,syncs=0;
    const f={view:'ai',document:{activeElement:active,getElementById:()=>replacement},HTMLTextAreaElement:TextArea,HTMLInputElement:Input,render:()=>renders++,syncAgentContext:()=>syncs++,applyAgentAction:()=>{},undoAgentAction:()=>{},createKIView:value=>{options=value;return {};}};
    vm.createContext(f);vm.runInContext(part('const kiView=createKIView(','\nfloatingAgent='),f);options.onChange();
    assert.equal(renders,1);assert.equal(focus[0].preventScroll,true);
    assert.deepEqual(selections,Element===Select?[]:[[1,5,'backward']]);
    f.view='notes';options.onChange();assert.equal(renders,1);assert.equal(syncs,1);
  }
});
