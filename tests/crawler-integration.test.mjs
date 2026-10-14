import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildKnowledge,searchKnowledge,runProjectAgent} from '../dist/knowledge.js';
import {buildSearchDocuments} from '../dist/search-documents.js';
import {createSearchIndex} from '../dist/search-index.js';
import {crawlSourcesForKnowledge,encryptCrawlSource,decryptCrawlSource} from '../dist/spaces-crawl-store.js';
import {crawlSpaces} from '../dist/spaces-crawl.js';
import {readScript} from '../desktop/reader.mjs';
import {collectLocalBoards} from '../dist/board-index.js';
import {scanCourseSpaces} from '../dist/companion-scan.js';
import {cleanMemory,encryptMemory,decryptMemory} from '../dist/companion-memory.js';

const base='https://spaces.th-koeln.de',root=id=>base+'/'+id+'/';
const project=(id='alpha',extra={})=>({id,name:'Synthetic '+id,links:[{tool:'spaces',url:root(id)}],...extra});
const workspace=projects=>({activeCourse:'alpha',projects:projects||[project('alpha'),project('beta')],notes:[],tasks:[],calendarEvents:[],bookmarks:[],boardFindings:[],tools:[],devDiaries:[]});
const source=(id,projectId='alpha',extra={})=>({id:'crawl:'+id.toString(16).padStart(64,'0'),kind:'browser',courseURL:root(projectId),projectId,url:root(projectId)+'material/',title:'Synthetic source '+id,text:'Lesbarer Kursinhalt.',status:'full',section:[],...extra});
const live=extra=>({id:'live:'+'a'.repeat(64),kind:'browser',projectId:'alpha',url:root('alpha'),title:'Historical source',text:'Veralteter Schaltungsauftrag.',status:'full',...extra});
const answer=()=>({content:JSON.stringify({type:'answer',text:'Synthetic answer',citations:[]})});

test('actual app aggregator exposes both legacy and saved crawler sources to the real human/KI collectors',async()=>{
 const body=await readFile(new URL('../dist/app.js',import.meta.url),'utf8'),functionSource=body.match(/function allBrowserSources\(\)\{[^\n]+\}/)?.[0];assert.ok(functionSource);
 const record=source(1),saved=crawlSourcesForKnowledge([record],workspace()),historical=live({courseURL:root('alpha')});
 const merged=vm.runInNewContext(functionSource+';allBrowserSources()',{companion:{sources:()=>[historical]},crawlerView:{sources:()=>saved}});
 assert.equal(merged.length,2);const docs=buildKnowledge(workspace(),[],{enabled:{browser:true},browserSources:merged,maxDocuments:20000});assert.equal(docs.length,2);
 const human=buildSearchDocuments({workspace:workspace(),browserSources:merged});assert.equal(human.documents.filter(d=>d.kind==='browser').length,2);
 for(const hit of human.documents.filter(d=>d.kind==='browser'))assert.equal(human.targets.get(hit.id).type,'source');
});

test('a long source tail enters human search and bounded KI retrieval only with the browser knowledge choice',async()=>{
 const marker='SelteneSchlusserkenntnis',body='Werkstattmaterial '.repeat(2800)+marker+' zum Sensor.',state=workspace(),parts=crawlSourcesForKnowledge([source(1,'alpha',{text:body}),source(2,'beta',{text:'BETA_CONTENT_MUST_STAY_OUT'})],state);
 const human=buildSearchDocuments({workspace:state,browserSources:parts}),index=createSearchIndex();index.replace(human.documents);const matches=index.search(marker,{projectId:'alpha'});assert.equal(matches.length,1);assert.ok(matches[0].id.startsWith(source(1).id+':part'));assert.match(matches[0].text,/SelteneSchlusserkenntnis/);
 const docs=buildKnowledge(state,[],{projectId:'alpha',enabled:{browser:true},browserSources:parts,maxDocuments:20000});assert.ok(searchKnowledge(docs,marker).length);
 const result=await runProjectAgent({prompt:'Erkläre '+marker+'.',workspace:state,projectId:'alpha',documents:docs,complete:async messages=>{const sent=JSON.stringify(messages);assert.match(sent,/SelteneSchlusserkenntnis/);assert.ok(sent.length<18000);assert.doesNotMatch(sent,/BETA_CONTENT_MUST_STAY_OUT/);return answer();}});assert.ok(result.sources.some(s=>s.text.includes(marker)));
 const disabled=buildKnowledge(state,[],{projectId:'alpha',enabled:{browser:false},browserSources:parts,maxDocuments:20000});assert.deepEqual(disabled,[]);
 await runProjectAgent({prompt:'Was ist verfügbar?',workspace:state,projectId:'alpha',documents:disabled,complete:async messages=>{assert.doesNotMatch(JSON.stringify(messages),/SelteneSchlusserkenntnis|BETA_CONTENT_MUST_STAY_OUT/);return answer();}});
});

test('2000 saved views approaching the 20M limit retain the final source and remain course-scoped in both indices',()=>{
 const projects=['c0','c1','c2','c3'].map(id=>project(id)),state=workspace(projects),body='Kursmaterial '.repeat(768),marker='LetzteSpeicherErkenntnis';
 const records=Array.from({length:2000},(_,i)=>source(i+1,'c'+(i%4),{text:body+(i===1999?marker:'')}));
 assert.ok(records.reduce((n,s)=>n+s.text.length,0)>19000000);assert.ok(records.reduce((n,s)=>n+s.text.length,0)<20000000);
 const parts=crawlSourcesForKnowledge(records,state);assert.equal(parts.length,2000);
 const human=buildSearchDocuments({workspace:state,browserSources:parts}),index=createSearchIndex();index.replace(human.documents);
 assert.equal(index.search(marker,{projectId:'c3'})[0].id,records.at(-1).id+':part0');assert.equal(index.search(marker,{projectId:'c0'}).length,0);
 const ai=buildKnowledge(state,[],{projectId:'c3',enabled:{browser:true},browserSources:parts,maxDocuments:20000});assert.equal(ai.length,500);assert.equal(searchKnowledge(ai,marker)[0].id,records.at(-1).id+':part0');assert.ok(ai.every(d=>d.projectId==='c3'));
});

test('new live sources capture the immutable course root even if the project is relinked during reading',async()=>{
 const record=project(),original=root('alpha'),state=workspace([record]);
 const scanned=await scanCourseSpaces({projects:[record],maxPages:1,request:async command=>{record.links=[{tool:'spaces',url:root('replacement')}];return {url:command.url,title:'Original course',text:'Original course content.',links:[],controls:[],offset:0,hasMore:false};}});
 assert.equal(scanned.sources[0].courseURL,original);assert.equal(scanned.sources[0].url,original);
 const clean=cleanMemory({liveSources:scanned.sources}),key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),restored=await decryptMemory(await encryptMemory(clean,key),key);
 assert.equal(restored.liveSources[0].courseURL,original);
 assert.deepEqual(buildKnowledge(state,[],{enabled:{browser:true},browserSources:restored.liveSources}),[]);
 assert.equal(buildSearchDocuments({workspace:state,browserSources:restored.liveSources}).documents.filter(d=>d.kind==='browser').length,0);
});

test('explicit live and crawler provenance reject relinks, archives and missing links without discarding current sources',()=>{
 const state=workspace(),raw=source(1),browserSources=[...crawlSourcesForKnowledge([raw],state),live({courseURL:root('alpha')})];
 assert.equal(buildKnowledge(state,[],{enabled:{browser:true},browserSources}).length,2);
 for(const change of [p=>{p.links=[{tool:'spaces',url:root('replacement')}];},p=>{p.archived=true;},p=>{p.links=[];}]){
  const next=structuredClone(state);change(next.projects[0]);assert.equal(buildKnowledge(next,[],{enabled:{browser:true},browserSources}).length,0);assert.equal(buildSearchDocuments({workspace:next,browserSources}).documents.filter(d=>d.kind==='browser').length,0);assert.deepEqual(crawlSourcesForKnowledge([raw],next),[]);
 }
 for(const courseURL of ['https://outside.invalid/','https://spaces.th-koeln.de/',root('alpha')+'?token=private',null,123])assert.throws(()=>cleanMemory({liveSources:[live({courseURL})]}));
});

test('legacy live snapshots retain only a current course subtree; global blog provenance needs an explicit root',()=>{
 const state=workspace(),sources=[live(),live({id:'live:'+'b'.repeat(64),url:root('alpha')+'resources/'}),live({id:'live:'+'c'.repeat(64),url:base+'/alpha-other/'}),live({id:'live:'+'d'.repeat(64),url:base+'/blog/global-post/'}),live({id:'live:'+'e'.repeat(64),url:base+'/blog/global-post/',courseURL:root('alpha')})];
 const docs=buildKnowledge(state,[],{enabled:{browser:true},browserSources:sources});assert.deepEqual(docs.map(d=>d.id),[sources[0].id,sources[1].id,sources[4].id]);
 const unlinked=workspace([project('alpha',{links:[]}),project('beta')]),personal=live({url:base+'/unassigned-snapshot/'}),foreign=live({id:'live:'+'f'.repeat(64),url:root('beta')+'material/'});
 assert.deepEqual(buildKnowledge(unlinked,[],{enabled:{browser:true},browserSources:[personal,foreign]}).map(d=>d.id),[personal.id]);
 for(const url of [base+'/blog/global-post/',base+'/2026/10/14/global-post/',base+'/',base+'/members/synthetic/',base+'/unassigned-snapshot/slides.pptx'])assert.equal(buildKnowledge(unlinked,[],{enabled:{browser:true},browserSources:[live({url})]}).length,0);
});

test('href-only Miro links survive actual reader → engine → encrypted storage → projection → local board directory once',async()=>{
 const url=root('alpha'),postURL=url+'workshop/',text='Lesbare Workshopnotizen. '.repeat(1500)+'Unser Miroboard',post={getClientRects:()=>[{}],closest:()=>null,querySelector:selector=>selector.startsWith('a[rel=bookmark]')?{href:postURL}:selector.includes('entry-title')?{innerText:'Workshop-Prototypen'}:selector.includes('rel=author')?{innerText:'Synthetic Lehrperson'}:selector==='time[datetime]'?{getAttribute:()=> '2026-10-12T09:00:00+02:00'}:null};
 const boardAnchor={href:'https://www.miro.com/app/board/AbCd1234=/?share_link_id=SYNTHETIC_INVITATION#private',innerText:'Unser Miroboard',getClientRects:()=>[{}],getAttribute:()=>null,closest:selector=>selector==='article,.post'?post:null};
 const contentRoot={querySelectorAll:selector=>selector==='a[href]'?[boardAnchor]:selector==='article,.post'?[post]:[]},node={textContent:text,parentElement:{getClientRects:()=>[{}],closest:()=>null}};
 const document={title:'Synthetic course',body:contentRoot,querySelector:selector=>selector==='#swap-container'?contentRoot:null,querySelectorAll:()=>[],createTreeWalker:()=>{let delivered=false;return {nextNode:()=>delivered?null:(delivered=true,node)};}};
 const calls=[],request=async command=>{
  calls.push(command);if(command.command==='release')return {released:true};
  const page=await vm.runInNewContext(readScript(command.offset||0,{crawler:true,courseURL:url,linkOffset:command.linkOffset||0,controlOffset:command.controlOffset||0}),{document,location:{hostname:'spaces.th-koeln.de',pathname:'/alpha/',href:url},NodeFilter:{SHOW_TEXT:4},URL,crypto,TextEncoder,Uint8Array});
  if(command.expectedRevision)assert.equal(page.contentRevision,command.expectedRevision);return {...page,epoch:1};
 };
 const scanned=await crawlSpaces({projects:[project()],request,maxViews:1});assert.equal(scanned.sources.length,1,JSON.stringify(scanned.coverage));assert.equal(scanned.sources[0].boardLinks.length,1);assert.equal(scanned.sources[0].boardLinks[0].url,'https://miro.com/app/board/AbCd1234=/');assert.doesNotMatch(JSON.stringify(scanned),/SYNTHETIC_INVITATION/);
 assert.ok(calls.every(c=>!c.url||c.url.startsWith(base+'/')),'Miro is discovered, never opened');
 const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),encrypted=await encryptCrawlSource(scanned.sources[0],key),restored=await decryptCrawlSource(encrypted,scanned.sources[0].id,key),state=workspace(),parts=crawlSourcesForKnowledge([restored],state);
 assert.ok(parts.length>2);assert.equal(parts[0].boardLinks.length,1);assert.ok(parts.slice(1).every(p=>p.boardLinks.length===0));
 const boards=collectLocalBoards({workspace:state,browserSources:parts});assert.equal(boards.findings.length,1);assert.equal(boards.findings[0].projectId,'alpha');assert.equal(boards.findings[0].sourceURL,postURL);assert.equal(boards.findings[0].postedBy,'Synthetic Lehrperson');assert.equal(boards.findings[0].postedAt,'2026-10-12T07:00:00.000Z');assert.match(boards.findings[0].title,/Workshop-Prototypen|Miroboard/);
 const relinked=workspace([project('alpha',{links:[{tool:'spaces',url:root('replacement')}]})]);assert.deepEqual(crawlSourcesForKnowledge([restored],relinked),[]);assert.equal(collectLocalBoards({workspace:relinked,browserSources:crawlSourcesForKnowledge([restored],relinked)}).findings.length,0);
});
