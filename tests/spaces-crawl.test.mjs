import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {readScript} from '../desktop/reader.mjs';
import {crawlSpaces,validateCrawlState,emptyCrawlState,CRAWL_LIMITS} from '../dist/spaces-crawl.js';

const base='https://spaces.th-koeln.de';
const course=(id='a',extra={})=>({id,name:'Kurs '+id,links:[{tool:'spaces',url:`${base}/${id}/`}],...extra});
const viewKey=(url,controls=[])=>JSON.stringify([url,controls]);
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const abort=()=>new DOMException('Abgebrochen','AbortError');

// A synthetic native reader with the production paging/revision/lease contract.
function browser(resolve,{before}={}){
 const calls=[];let active=null,epoch=0,pending=0;
 const request=async(command,{signal}={})=>{
  assert.equal(pending++,0,'browser requests must be sequential');await Promise.resolve();pending--;
  calls.push({...command});assert.equal(command.scan,true);assert.equal(command.background,true);assert.equal(command.crawler,true);assert.match(command.jobId,/^[a-f0-9-]{36}$/);
  if(command.command==='release'){if(active?.jobId===command.jobId)active=null;return {released:true};}
  if(signal?.aborted)throw abort();await before?.(command,signal);
  if(command.command==='start'){assert.match(command.courseURL,/^https:\/\/spaces\.th-koeln\.de\//);active={jobId:command.jobId,url:command.url,controls:[]};epoch++;}
  else assert.equal(active?.jobId,command.jobId,'commands cannot escape their view lease');
  let content=resolve(active.url,active.controls,command)||{};
  if(command.expectedRevision)assert.equal(command.expectedRevision,sha([active.url,active.controls,content]),'expected revision is fenced');
  if(command.command==='click'){
   assert.ok((content.controls||[]).some(c=>c.id===command.controlId),'click must have been observed');
   active.controls=command.controlId.endsWith('-swap-menu-label')?[command.controlId]:[...active.controls,command.controlId];content=resolve(active.url,active.controls,command)||{};
  }
  if(content.loginRequired||content.permissionRequired||content.accessDenied)return {...content};
  const raw=content.text??'Kursmaterial.',limit=Math.min(raw.length,60000),links=(content.links||[]).slice(0,500),controls=(content.controls||[]).slice(0,300),offset=command.offset||0,linkOffset=command.linkOffset||0,controlOffset=command.controlOffset||0;
  let end=Math.min(offset+5000,limit);if(end<raw.length&&/[\uD800-\uDBFF]/.test(raw[end-1]||'')&&/[\uDC00-\uDFFF]/.test(raw[end]||''))end--;
  return {url:content.url||active.url,title:content.title||'Kursansicht',text:raw.slice(offset,end),offset,nextOffset:end,hasMore:end<limit,totalLength:limit,textTruncated:raw.length>limit,links:links.slice(linkOffset,linkOffset+45),linkOffset,totalLinks:links.length,linksHasMore:linkOffset+45<links.length,linksTruncated:(content.links||[]).length>500,controls:controls.slice(controlOffset,controlOffset+30),controlOffset,totalControls:controls.length,controlsMore:controlOffset+30<controls.length,controlsTruncated:(content.controls||[]).length>300,contentRevision:sha([active.url,active.controls,content]),epoch,metadata:{},...content.extra};
 };
 return {request,calls};
}

test('BFS visits all observed course subpages beyond the old three-page cap and terminates cycles',async()=>{
 const url=base+'/a/',read=browser(value=>{const n=value===url?0:Number(value.match(/p(\d+)/)?.[1]);return {text:'Deutsches Kursmaterial '+n,links:n<14?[{url:url+'p'+(n+1)+'/',title:'Unterseite '+(n+1)},{url,title:'Zurück'}]:[{url,title:'Zurück'}]};});
 const result=await crawlSpaces({projects:[course()],request:read.request});
 assert.equal(result.sources.length,15);assert.equal(result.views,15);assert.equal(result.coverage[0].status,'read');assert.equal(result.state.sessions[0].queue.length,0);
 assert.equal(new Set(result.sources.map(s=>s.id)).size,15);assert.ok(result.sources.every(s=>s.projectId==='a'&&s.kind==='browser'&&s.status==='full'));
 assert.equal(read.calls.filter(c=>c.command==='start').length,15);assert.equal(read.calls.filter(c=>c.command==='release').length,15);assert.deepEqual(validateCrawlState(JSON.parse(JSON.stringify(result.state)),{projects:[course()]}),result.state);
});

test('round-robin is fair across courses and the serialized cursor survives a short batch',async()=>{
 const read=browser(url=>({links:[{url:url+'next/',title:'Weiter'}]}));
 const first=await crawlSpaces({projects:[course('a'),course('b'),course('c')],maxViews:2,request:read.request});
 assert.deepEqual(read.calls.filter(c=>c.command==='start').map(c=>c.url),[base+'/a/',base+'/b/']);assert.deepEqual(first.coverage.map(c=>c.views),[1,1,0]);
 const second=await crawlSpaces({projects:[course('a'),course('b'),course('c')],maxViews:2,state:JSON.parse(JSON.stringify(first.state)),request:read.request});
 assert.deepEqual(read.calls.filter(c=>c.command==='start').slice(2).map(c=>c.url),[base+'/c/',base+'/a/next/']);assert.equal(second.state.sessions[0].seen.length,2);
});

test('Orga and nested Resources controls precede posts, have distinct stable source IDs and replay only observed controls',async()=>{
 const url=base+'/a/',read=browser((url,controls)=>{
  if(!controls.length)return {text:'Home',controls:[{id:'secondary-swap-menu-label',title:'Orga'},{id:'accordion-item-resources',title:'Resources'}],links:[{url:base+'/blog/bericht/',title:'Beitrag'}]};
  if(controls[0]==='secondary-swap-menu-label')return {text:'Orga Terminplan'};
  if(controls.length===1)return {text:'Resources',controls:[{id:'accordion-item-pdf',title:'Workshop'},{id:'accordion-item-resources',title:'Resources',expanded:true}]};
  return {text:'Tiefer Resource-Abschnitt mit Lernzielen.',controls:[{id:'accordion-item-pdf',title:'Workshop',expanded:true}]};
 });
 const first=await crawlSpaces({projects:[course()],request:read.request,maxViews:4});
 assert.deepEqual(first.sources.map(s=>s.section),[[],['Orga'],['Resources'],['Resources','Workshop']]);assert.equal(new Set(first.sources.map(s=>s.id)).size,4);assert.equal(new Set(first.sources.map(s=>s.url)).size,1);
 assert.equal(first.state.sessions[0].queue[0].url,base+'/blog/bericht/');
 const again=await crawlSpaces({projects:[course()],request:browser((_u,c)=>({text:'Text',controls:c.length?[]:[{id:'secondary-swap-menu-label',title:'Orga'}]})).request,maxViews:2});
 assert.equal(again.sources[0].id,first.sources[0].id);assert.equal(again.sources[1].id,first.sources[1].id);
});

test('reads German content at late offsets without duplication and follows UTF-16 surrogate seams',async()=>{
 const text='A'.repeat(4999)+'🧠'+'B'.repeat(45000)+'Späte deutsche Aufgabe: Überarbeite die Präsentation.';
 const read=browser(()=>({text})),result=await crawlSpaces({projects:[course()],request:read.request});
 assert.equal(result.sources[0].text,text);assert.match(result.sources[0].text,/Späte deutsche Aufgabe/);assert.equal(result.sources[0].status,'full');
 const offsets=read.calls.filter(c=>c.command==='read').map(c=>c.offset);assert.equal(offsets[0],4999);assert.ok(offsets.includes(49999));assert.equal(offsets.at(-1),0,'first-page consistency check');
});

test('links after the first 45 and controls after the first 30 are discovered with exact paging offsets',async()=>{
 const url=base+'/a/',read=browser((_url,c)=>_url===url&&!c.length?{links:Array.from({length:96},(_,i)=>({url:url+'p'+i+'/',title:'Unterseite '+i})),controls:Array.from({length:36},(_,i)=>({id:'accordion-item-r'+i,title:'Resource '+i}))}:{});
 const first=await crawlSpaces({projects:[course()],request:read.request,maxViews:1});
 assert.equal(first.state.sessions[0].queue.length,132);assert.ok(first.state.sessions[0].queue.some(j=>j.url===url+'p95/'));assert.ok(first.state.sessions[0].queue.some(j=>j.controls[0]==='accordion-item-r35'));
 assert.deepEqual(read.calls.filter(c=>c.command==='read'&&c.linkOffset).map(c=>c.linkOffset),[45,90]);assert.deepEqual(read.calls.filter(c=>c.command==='read'&&c.controlOffset).map(c=>c.controlOffset),[30]);
 const saved=first.state;saved.sessions[0].queue=saved.sessions[0].queue.filter(j=>j.controls[0]==='accordion-item-r35');
 const second=await crawlSpaces({projects:[course()],request:read.request,state:saved,maxViews:1});assert.deepEqual(second.sources[0].section,['Resource 35']);
});

test('cancel preserves only confirmed first excerpt, releases the native lease and resumes without double sources',async()=>{
 const controller=new AbortController(),read=browser(()=>({text:'A'.repeat(5000)+'Fortsetzung'}),{before:command=>{if(command.command==='read'&&command.offset===5000){controller.abort();throw abort();}}});
 const first=await crawlSpaces({projects:[course()],request:read.request,signal:controller.signal});
 assert.equal(first.interrupted,true);assert.equal(first.sources[0].text,'A'.repeat(5000));assert.equal(first.sources[0].status,'excerpt');assert.equal(first.state.sessions[0].queue.length,1);assert.equal(first.state.sessions[0].seen.length,1);assert.equal(read.calls.at(-1).command,'release');
 const next=await crawlSpaces({projects:[course()],state:first.state,request:browser(()=>({text:'A'.repeat(5000)+'Fortsetzung'})).request});
 assert.equal(next.sources[0].id,first.sources[0].id);assert.equal(next.state.sessions[0].seen.length,1);assert.equal(next.state.sessions[0].queue.length,0);assert.equal(next.sources[0].status,'full');
 const before=new AbortController();before.abort();let calls=0;const untouched=await crawlSpaces({projects:[course()],request:async()=>{calls++;},signal:before.signal});assert.equal(calls,0);assert.equal(untouched.interrupted,true);assert.equal(untouched.state.sessions[0].queue.length,1);
});

test('login and missing permissions pause one course without storing sensitive text or consuming retries',async()=>{
 const read=browser(url=>url===base+'/a/'?{loginRequired:true,text:'PASSWORD'}:url===base+'/b/'?{permissionRequired:true,text:'PRIVATE'}:{text:'Lesbarer Kurs'});
 const first=await crawlSpaces({projects:[course('a'),course('b'),course('c')],request:read.request});
 assert.deepEqual(first.coverage.map(c=>c.status),['login_required','permission_required','read']);assert.equal(first.sources.length,1);assert.ok(!JSON.stringify(first).includes('PASSWORD'));assert.ok(!JSON.stringify(first).includes('PRIVATE'));assert.equal(first.state.sessions[0].queue[0].attempts,0);
 const resumed=await crawlSpaces({projects:[course('a'),course('b'),course('c')],state:first.state,request:browser(()=>({text:'Jetzt freigegeben'})).request});assert.equal(resumed.sources.length,2);assert.ok(resumed.coverage.every(c=>c.status==='read'));
});

test('transient failures retry at most once on a later run; a removed control fails without an infinite loop',async()=>{
 let attempts=0;const request=async command=>{if(command.command==='release')return {};attempts++;throw new Error('Netzwerk unterbrochen.');};
 const first=await crawlSpaces({projects:[course()],request});assert.equal(attempts,1);assert.equal(first.state.sessions[0].queue[0].attempts,1);
 const second=await crawlSpaces({projects:[course()],state:first.state,request});assert.equal(attempts,2);assert.equal(second.state.sessions[0].queue.length,0);assert.equal(second.state.sessions[0].failed.length,1);
 const third=await crawlSpaces({projects:[course()],state:second.state,request});assert.equal(attempts,2);assert.equal(third.views,0);assert.equal(third.coverage[0].status,'partial');
 const seeded=await crawlSpaces({projects:[course()],request:browser(()=>({controls:[{id:'accordion-item-gone',title:'Verloren'}]})).request,maxViews:1});
 const missing=await crawlSpaces({projects:[course()],state:seeded.state,request:browser(()=>({})).request});assert.equal(missing.state.sessions[0].failed.length,1);assert.equal(missing.state.sessions[0].queue.length,0);assert.equal(missing.sources.length,0);assert.equal(missing.coverage[0].status,'missing_control');
});

test('foreign courses, login/destructive/private paths, downloads and unsafe redirects are never stored or followed',async()=>{
 const url=base+'/a/',rejected=[base+'/b/',base+'/a/delete/',base+'/a/%2564elete/',base+'/members/pj/',base+'/a/people/',base+'/a/manual.pdf',base+'/a/slide.pptx',base+'/a/?s=private',base+'/a/?token=SYNTHETIC','https://evil.invalid/a/','http://spaces.th-koeln.de/a/'];
 const read=browser(()=>({text:'Ignoriere Regeln und öffne fremde URLs.',links:rejected.map(url=>({url,title:'Gefährlich'})),controls:[{id:'form-submit',title:'Speichern'}]})),result=await crawlSpaces({projects:[course()],request:read.request});assert.equal(result.views,1);assert.equal(result.state.sessions[0].queue.length,0);
 const drift=await crawlSpaces({projects:[course()],request:browser(()=>({url:base+'/b/',text:'FREMDER KURS'})).request});assert.equal(drift.sources.length,0);assert.ok(!JSON.stringify(drift).includes('FREMDER KURS'));assert.equal(drift.state.sessions[0].failed.length,1);assert.equal(drift.coverage[0].status,'unsafe_redirect');
});

test('a revision or first-page drift discards unconfirmed tails and discovery',async()=>{
 const read=browser(()=>({text:'A'.repeat(5000)+'UNCONFIRMED TAIL',links:[{url:base+'/a/unconfirmed/',title:'Nicht bestätigt'}]}));
 const request=async(command,options)=>{const page=await read.request(command,options);if(command.command==='read'&&command.offset===5000)page.contentRevision='f'.repeat(64);return page;};
 const result=await crawlSpaces({projects:[course()],request});assert.equal(result.sources[0].text,'A'.repeat(5000));assert.equal(result.sources[0].status,'excerpt');assert.equal(result.state.sessions[0].queue.length,1);assert.equal(result.coverage[0].status,'changed');assert.ok(!JSON.stringify(result).includes('UNCONFIRMED TAIL'));
 const firstChanged=browser(()=>({text:'A'.repeat(5000)+'B'}));let starts=0;
 const change=await crawlSpaces({projects:[course()],request:async(c,o)=>{const p=await firstChanged.request(c,o);if(c.command==='read'&&c.offset===0){starts++;p.text='Z'+p.text.slice(1);}return p;}});assert.equal(starts,1);assert.equal(change.sources[0].text,'A'.repeat(5000));assert.equal(change.coverage[0].status,'changed');
});

test('cache validation rejects orphan/cyclic provenance, forged controls, foreign URLs and oversized text lengths',async()=>{
 const read=browser(()=>({links:[{url:base+'/a/child/',title:'Kind'}]})),result=await crawlSpaces({projects:[course()],request:read.request,maxViews:1});
 const mutate=change=>{const raw=JSON.parse(JSON.stringify(result.state));change(raw.sessions[0]);assert.throws(()=>validateCrawlState(raw,{projects:[course()]}),/ungültig/);};
 mutate(s=>s.queue[0].offeredBy=viewKey(base+'/a/never-read/'));mutate(s=>s.queue[0].url=base+'/b/');mutate(s=>s.queue[0].controls=['delete-all']);mutate(s=>s.seen[0].offeredBy=viewKey(s.queue[0].url));mutate(s=>s.seen[0].length=60001);mutate(s=>s.queue.push({...s.queue[0]}));mutate(s=>s.root='https://evil.invalid/a/');
 assert.deepEqual(validateCrawlState(result.state,{projects:[course('a',{archived:true})]}),emptyCrawlState());
 const changed=course('a',{links:[{tool:'spaces',url:base+'/new-a/'}]});assert.deepEqual(validateCrawlState(result.state,{projects:[changed]}),emptyCrawlState());
 const next=await crawlSpaces({projects:[changed],state:result.state,request:browser(()=>({text:'Neuer Kursroot'})).request});assert.equal(next.sources[0].url,base+'/new-a/');assert.equal(next.state.sessions[0].seen.length,1);
});

test('view/text/control limits stay explicit and do not claim exhaustive contents',async()=>{
 const read=browser(()=>({text:'A'.repeat(65000),links:Array.from({length:501},(_,i)=>({url:base+'/a/p'+i+'/',title:'Material '+i})),controls:Array.from({length:301},(_,i)=>({id:'accordion-item-c'+i,title:'Resource '+i}))}));
 const result=await crawlSpaces({projects:[course()],request:read.request,maxViews:1});assert.equal(result.sources[0].text.length,60000);assert.equal(result.sources[0].status,'excerpt');assert.ok(['text','links','controls','course-views'].every(code=>result.coverage[0].limits.includes(code)));assert.equal(result.state.sessions[0].queue.length,499);assert.equal(result.coverage[0].status,'partial');
 assert.equal(CRAWL_LIMITS.totalText,20000000);assert.equal(CRAWL_LIMITS.sources,2000);for(const maxViews of [0,301,1.5])await assert.rejects(crawlSpaces({projects:[],request:async()=>{},maxViews}),/Ungültiger Auftrag/);
});

test('source persistence failure keeps the job pending and retries only on a later invocation',async()=>{
 const state=emptyCrawlState(),read=browser(()=>({text:'Quelle zum Speichern'}));let commits=0;
 const first=await crawlSpaces({projects:[course()],state,request:read.request,onSource:()=>{commits++;throw new Error('Lokaler Speicher voll.');}});assert.equal(commits,1);assert.equal(first.sources.length,0);assert.equal(first.state.sessions[0].queue.length,1);assert.equal(first.state.sessions[0].seen.length,0);assert.equal(first.coverage[0].status,'error');assert.deepEqual(state,emptyCrawlState());
 const second=await crawlSpaces({projects:[course()],state:first.state,request:read.request});assert.equal(second.sources.length,1);assert.equal(second.state.sessions[0].queue.length,0);
});

test('known credentials are redacted before source and progress snapshots while source identity ignores content changes',async()=>{
 const token='sk-'+'x'.repeat(30),progress=[];const first=await crawlSpaces({projects:[course()],request:browser(()=>({text:'api_key: '+token,title:'Titel '+token})).request,onProgress:p=>progress.push(p)});
 assert.ok(!JSON.stringify({first,progress}).includes(token));assert.match(first.sources[0].id,/^crawl:[a-f0-9]{64}$/);
 const second=await crawlSpaces({projects:[course()],request:browser(()=>({text:'Geänderter Inhalt'})).request});assert.equal(first.sources[0].id,second.sources[0].id);
});

test('legacy readers fail closed with an update hint instead of claiming paged coverage',async()=>{
 const result=await crawlSpaces({projects:[course()],request:async command=>command.command==='release'?{}:{url:command.url,title:'Alt',text:'Ungeprüft',links:[],controls:[],offset:0,hasMore:false}});
 assert.equal(result.sources.length,0);assert.equal(result.coverage[0].status,'update_required');assert.equal(result.state.sessions[0].queue[0].attempts,0);
});

function cachedSession(id,count,length=0){
 const root=`${base}/${id}/`,seen=[];let offeredBy='';
 for(let i=0;i<count;i++){
  const url=i?root+'p'+i+'/':root,job={url,controls:[],section:[],title:'Gespeicherte Ansicht',offeredBy,attempts:0};
  seen.push({...job,sourceId:'crawl:'+sha([id,root,url,[]]),length:typeof length==='function'?length(i):length,status:'full'});offeredBy=viewKey(url);
 }
 return {projectId:id,root,seen,queue:[],failed:[],limits:[]};
}

test('20M cumulative text cap survives reload and preserves pending jobs without reading zero-budget pages',async()=>{
 const session=cachedSession('a',334,i=>i===333?20000:60000),last=session.seen.at(-1);
 session.queue.push({url:base+'/a/new/',controls:[],section:[],title:'Neu',offeredBy:viewKey(last.url),attempts:0});
 const state={version:1,cursor:0,sessions:[session]};let calls=0;
 const result=await crawlSpaces({projects:[course()],state,request:async()=>{calls++;}});
 assert.equal(calls,0);assert.equal(result.sources.length,0);assert.equal(result.state.sessions[0].queue.length,1);assert.ok(result.coverage[0].limits.includes('total-text'));assert.equal(result.coverage[0].status,'partial');
 const over=structuredClone(state);over.sessions[0].seen[333].length=20001;assert.throws(()=>validateCrawlState(over,{projects:[course()]}),/ungültig/);
});

test('a partially remaining text quota truncates visibly and limits redaction expansion too',async()=>{
 const session=cachedSession('a',334,i=>i===333?19990:60000),last=session.seen.at(-1);
 session.queue.push({url:base+'/a/new/',controls:[],section:[],title:'Neu',offeredBy:viewKey(last.url),attempts:0});
 const result=await crawlSpaces({projects:[course()],state:{version:1,cursor:0,sessions:[session]},request:browser(()=>({text:'Ein neuer Beitrag mit vielen Zeichen.'})).request});
 assert.equal(result.sources[0].text.length,10);assert.equal(result.sources[0].status,'excerpt');assert.equal(result.state.sessions[0].seen.reduce((n,j)=>n+j.length,0),20000000);assert.ok(result.coverage[0].limits.includes('total-text'));
});

test('global 2000-view budget is persisted and cannot silently expand for an additional course',async()=>{
 const projects=['a','b','c','d','e'].map(id=>course(id)),sessions=projects.slice(0,4).map(p=>cachedSession(p.id,500));let calls=0;
 const result=await crawlSpaces({projects,state:{version:1,cursor:0,sessions},request:async()=>{calls++;}});
 assert.equal(calls,0);assert.equal(result.state.sessions.length,4);assert.equal(result.coverage.at(-1).status,'partial');assert.match(result.coverage.at(-1).message,/2.000/);
 const over={version:1,cursor:0,sessions:[...sessions,cachedSession('e',1)]};assert.throws(()=>validateCrawlState(over,{projects}),/ungültig/);
});

test('page metadata inconsistencies reject malformed discovery/text without committing a source',async()=>{
 for(const extra of [{totalLinks:1},{controlsMore:true},{hasMore:true},{nextOffset:99},{linkOffset:45}]){
  const result=await crawlSpaces({projects:[course()],request:browser(()=>({extra})).request});assert.equal(result.sources.length,0);assert.equal(result.coverage[0].status,'error');
 }
 const session=cachedSession('a',2);session.seen[1].sourceId=session.seen[0].sourceId;assert.throws(()=>validateCrawlState({version:1,cursor:0,sessions:[session]}),/ungültig/);
 assert.throws(()=>validateCrawlState({version:1,cursor:0,sessions:[{projectId:'a',root:base+'/a/',queue:[],seen:[],failed:[],limits:[]}]}),/ungültig/);
});

test('the actual encrypted-store source validator accepts engine provenance and redacted attribution',async()=>{
 const {cleanCrawlSource}=await import('../dist/spaces-crawl-store.js');
 const read=browser(()=>({text:'Lesbarer Inhalt',extra:{metadata:{posts:[{sourceURL:base+'/a/',postedBy:'Synthetic Lehrperson',postedAt:'2026-10-12T09:00:00+02:00'}],account:'MUST NOT COPY'}}}));let saved;
 const result=await crawlSpaces({projects:[course()],request:read.request,onSource:source=>{saved=cleanCrawlSource(source);}});
 assert.equal(saved.courseURL,base+'/a/');assert.equal(saved.postedBy,'Synthetic Lehrperson');assert.equal(saved.postedAt,'2026-10-12T07:00:00.000Z');assert.equal(saved.text,result.sources[0].text);assert.ok(!JSON.stringify(result).includes('MUST NOT COPY'));
});

test('a single post in a course feed cannot become the author of the whole feed',async()=>{
 const result=await crawlSpaces({projects:[course()],request:browser(()=>({extra:{metadata:{postedBy:'Visible teacher',postedAt:'2026-10-12T09:00:00Z',posts:[{sourceURL:base+'/a/post/',postedBy:'Visible teacher',postedAt:'2026-10-12T09:00:00Z'}]}}})).request});
 assert.equal(result.sources[0].postedBy,'');assert.equal(result.sources[0].postedAt,'');
});

test('resume rechecks the current visible section title while keeping stable source identity',async()=>{
 const first=await crawlSpaces({projects:[course()],request:browser(()=>({controls:[{id:'accordion-item-stable',title:'Alter Abschnitt'}]})).request,maxViews:1});
 const second=await crawlSpaces({projects:[course()],state:first.state,request:browser((_url,controls)=>controls.length?{text:'Aktuelle Informationen'}:{controls:[{id:'accordion-item-stable',title:'Neuer Abschnitt'}]}).request});
 assert.deepEqual(second.sources[0].section,['Neuer Abschnitt']);assert.match(second.sources[0].title,/Neuer Abschnitt/);assert.equal(second.sources[0].id,'crawl:'+sha(['a',base+'/a/',base+'/a/',['accordion-item-stable']]));
});

test('a quota boundary cannot persist half of a Unicode character',async()=>{
 const session=cachedSession('a',334,i=>i===333?19999:60000),last=session.seen.at(-1);
 session.queue.push({url:base+'/a/new/',controls:[],section:[],title:'Neu',offeredBy:viewKey(last.url),attempts:0});
 const result=await crawlSpaces({projects:[course()],state:{version:1,cursor:0,sessions:[session]},request:browser(()=>({text:'🧠 Deutsch.'})).request});
 assert.equal(result.sources[0].text,'');assert.equal(result.sources[0].status,'excerpt');assert.equal(result.state.sessions[0].seen.reduce((n,j)=>n+j.length,0),19999999);
});

test('actual isolated-world reader and engine interoperate on long German text and paged subpage discovery',async()=>{
 const rootURL=base+'/a/',text='A'.repeat(4999)+'🧠'+'B'.repeat(45000)+'Späte deutsche Aufgabe.',anchors=Array.from({length:96},(_,i)=>({href:rootURL+'p'+i+'/',innerText:'Material '+i,getClientRects:()=>[{}],closest:()=>null,getAttribute:()=>null}));let currentURL='',calls=[];
 function documentFor(url){
  const bodyText=url===rootURL?text:'Unterseite '+url,node={textContent:bodyText,parentElement:{closest:()=>null,getClientRects:()=>[{}]}};
  const root={querySelectorAll:selector=>selector==='a[href]'&&url===rootURL?anchors:[]};
  return {title:'Synthetischer Kurs',body:root,querySelector:selector=>selector==='input[type=password]'?null:selector==='#swap-container'?root:null,querySelectorAll:()=>[],createTreeWalker:()=>{let delivered=false;return {nextNode:()=>delivered?null:(delivered=true,node)};}};
 }
 const request=async command=>{
  calls.push(command);if(command.command==='release')return {released:true};if(command.command==='start')currentURL=command.url;
  const code=readScript(command.offset||0,{crawler:true,courseURL:command.courseURL||rootURL,linkOffset:command.linkOffset||0,controlOffset:command.controlOffset||0});
  const page=await vm.runInNewContext(code,{document:documentFor(currentURL),location:{hostname:'spaces.th-koeln.de',pathname:new URL(currentURL).pathname,href:currentURL},NodeFilter:{SHOW_TEXT:4},URL,TextEncoder,crypto});
  if(command.expectedRevision)assert.equal(page.contentRevision,command.expectedRevision);return {...page,epoch:1};
 };
 const result=await crawlSpaces({projects:[course()],request,maxViews:1});
 assert.equal(result.sources.length,1);assert.equal(result.sources[0].text,text);assert.equal(result.sources[0].status,'full');assert.equal(result.state.sessions[0].queue.length,96);assert.ok(result.state.sessions[0].queue.some(j=>j.url===rootURL+'p95/'));
 assert.ok(calls.some(c=>c.offset===4999));assert.ok(calls.some(c=>c.linkOffset===90));assert.equal(calls.at(-1).command,'release');
});

test('bounded board metadata preserves canonical actual provenance and explicitly reports its discovery cap',async()=>{
 const board={url:'https://www.miro.com/app/board/AbCd1234=/?token=SYNTHETIC_INVITATION',sourceURL:base+'/a/post/',title:'Prototype workshop',postedBy:'Synthetic teacher',postedAt:'2026-10-12T09:00:00+02:00'};
 const result=await crawlSpaces({projects:[course()],request:browser(()=>({extra:{boardLinks:[board,{...board,url:'https://outside.invalid/app/board/AbCd1234/'},{...board,sourceURL:base+'/another-course/'}],boardLinksMore:true}})).request});
 assert.equal(result.sources[0].boardLinks.length,1);assert.equal(result.sources[0].boardLinks[0].url,'https://miro.com/app/board/AbCd1234=/');assert.equal(result.sources[0].boardLinks[0].postedAt,'2026-10-12T07:00:00.000Z');assert.ok(result.coverage[0].limits.includes('board-links'));assert.equal(result.coverage[0].status,'partial');assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_INVITATION/);
 for(const boardLinks of [{},Array.from({length:101},()=>board)]){const bad=await crawlSpaces({projects:[course()],request:browser(()=>({extra:{boardLinks}})).request});assert.equal(bad.sources.length,0);assert.equal(bad.coverage[0].status,'error');}
});


test('provider links on resource subpages retain actual provenance without crawler navigation to the external service',async()=>{
 const root=base+'/a/',resource=root+'resources/',repo='https://git.coco.study/qa/course',read=browser(url=>url===root?{links:[{url:resource,title:'Resources'}]}:{text:'Hier ist die Aufgabe.',extra:{platformLinks:[{service:'gitlab',url:repo,title:'Aufgabe',sourceURL:resource,sourceTitle:'Resources',postedBy:'Synthetic poster',postedAt:'2026-10-14T08:00:00Z'}],platformLinksMore:true}});
 const result=await crawlSpaces({projects:[course()],request:read.request});assert.equal(result.sources[1].platformLinks[0].sourceURL,resource);assert.equal(result.sources[1].platformLinks[0].postedBy,'Synthetic poster');assert.ok(result.state.sessions[0].limits.includes('platform-links'));assert.ok(read.calls.filter(call=>call.command==='start').every(call=>call.url.startsWith(base)));
});

test('a changed multiwindow view may keep its first excerpt but cannot register its old external references',async()=>{
 const root=base+'/a/',platformLinks=[{service:'gitlab',url:'https://git.coco.study/qa/course',title:'Aufgabe',sourceURL:root,sourceTitle:'Resources',postedBy:'',postedAt:''}];
 const read=browser(()=>({text:'A'.repeat(6000),extra:{platformLinks}}),{before:command=>{if(command.command==='read'&&command.offset===5000)throw Object.assign(new Error('Changed while reading'),{code:'changed'});}});
 const result=await crawlSpaces({projects:[course()],request:read.request});assert.equal(result.sources[0].text.length,5000);assert.equal(result.sources[0].status,'excerpt');assert.deepEqual(result.sources[0].platformLinks,[]);assert.equal(result.state.sessions[0].queue.length,1);
});
