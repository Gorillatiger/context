import test from 'node:test';
import assert from 'node:assert/strict';
import {buildKnowledge,searchKnowledge,runProjectAgent,redactKnowledge} from '../dist/knowledge.js';
import {validateChat} from '../connectors/ki.mjs';

const source=(id,text,patch={})=>({id,kind:'notes',title:'Synthetic '+id,text,status:'full',projectId:'alpha',targetId:id.slice(2),...patch});
const reply=(tool,args={})=>({content:JSON.stringify({type:'tool',tool,args})});
const answer=(citations=[])=>({content:JSON.stringify({type:'answer',text:'Synthetic response',citations})});
const delivered=messages=>JSON.parse(messages.at(-1).content.split('\n')[1]);
const workspace=()=>({activeCourse:'alpha',projects:[{id:'alpha',name:'Alpha',links:[]},{id:'beta',name:'Beta',links:[]}],notes:[],tasks:[],bookmarks:[],calendarEvents:[]});

test('repeated knowledge queries reuse the index without rereading every unrelated document body',()=>{
 let irrelevantReads=0;const documents=Array.from({length:1400},(_,index)=>({id:'n:'+index,title:'Unrelated '+index,kind:'notes',projectId:'alpha',status:'full',get text(){irrelevantReads++;return 'Farbskizze ohne Suchtreffer.';}}));
 documents.push(source('n:target','Mikrocontroller als Prototyp.',{title:'Mikrocontroller'}));
 assert.equal(searchKnowledge(documents,'Mikrocontroller')[0].id,'n:target');irrelevantReads=0;
 assert.equal(searchKnowledge(documents,'Mikrocontroller')[0].id,'n:target');assert.equal(irrelevantReads,0,'cached retrieval must not repeat the old full-array body scan');
 documents.push(source('n:added','Quantenkreisel gefunden.'));assert.equal(searchKnowledge(documents,'Quantenkreisel')[0].id,'n:added');documents.pop();assert.equal(searchKnowledge(documents,'Quantenkreisel').length,0);
});

test('knowledge index preserves metadata, bounded excerpts, limits and German stopword fallback',()=>{
 const documents=Array.from({length:20},(_,index)=>source('n:'+index,'Mikrocontroller '+index,{url:'https://spaces.th-koeln.de/course/',due:'2026-10-16',customField:'original metadata'}));
 const found=searchKnowledge(documents,'Mikrocontroller',999);assert.equal(found.length,10);assert.equal(found[0].customField,'original metadata');assert.equal(found[0].url,documents[0].url);assert(found.every(item=>Number.isFinite(item.score)&&item.text.length<=1000&&typeof item.truncated==='boolean'));
 assert.equal(searchKnowledge(documents,'Mikrocontroller',0).length,1);assert.deepEqual(searchKnowledge(documents,'bitte mir mein meine kurs',3).map(item=>item.id),['n:0','n:1','n:2']);assert.equal(searchKnowledge(documents,'unbekannteskompletteswort').length,0);
});

test('accent normalization keeps late matches and excerpt offsets in the exact original UTF-16 text',()=>{
 const body='😀 Cafe\u0301 ohne Treffer. '.repeat(350)+'Fünf Nutzerinterviews zeigen Prototyping-Barrieren.';
 const found=searchKnowledge([source('n:unicode',body)],'fünf Nutzerinterviews')[0];assert(found);assert(found.excerptOffset>0);assert.match(found.text,/Fünf Nutzerinterviews/);assert.equal(found.text,body.slice(found.excerptOffset,found.excerptOffset+found.text.length));assert(found.text.length<=1000);assert.equal(found.truncated,true);
});

test('human indexing can opt into 20000 documents while agent defaults and privacy selection stay bounded',()=>{
 const state=workspace();state.notes=Array.from({length:4200},(_,index)=>({id:String(index),projectId:'alpha',title:'Synthetic note '+index,content:'Index text '+index}));state.notes.push({id:'excluded-beta',projectId:'beta',title:'Other course',content:'BETA_CONTENT_MUST_STAY_OUT'});
 const updates=[{id:'mail',source:'webmail',projectId:'alpha',title:'MAIL_TITLE_MUST_STAY_OUT',content:'MAIL_CONTENT_MUST_STAY_OUT'},{id:'private-chat',source:'whatsapp',projectId:'alpha',title:'CHAT_TITLE_MUST_STAY_OUT',content:'CHAT_CONTENT_MUST_STAY_OUT'}];
 const options={projectId:'alpha',enabled:{notes:true}};assert.equal(buildKnowledge(state,updates,options).length,3000);const human=buildKnowledge(state,updates,{...options,maxDocuments:20000});assert.equal(human.length,4200);assert.equal(buildKnowledge(state,updates,{...options,maxDocuments:3500}).length,3500);assert.equal(buildKnowledge(state,updates,{projectId:'alpha',enabled:{},maxDocuments:20000}).length,0);
 assert.doesNotMatch(JSON.stringify(human),/BETA_CONTENT_MUST_STAY_OUT|MAIL_.*MUST_STAY_OUT|CHAT_.*MUST_STAY_OUT/);
});

test('the agent reuses its engine for newly read browser text without contaminating the initial array cache',async()=>{
 const documents=[],sent=[];searchKnowledge(documents,'Quantenkreisel');let round=0,sourceId;
 const result=await runProjectAgent({prompt:'Lies die aktuelle Spaces-Seite und suche Quantenkreisel.',documents,projectId:'alpha',workspace:workspace(),browser:async()=>({url:'https://spaces.th-koeln.de/course/',title:'Synthetic live page',text:'Quantenkreisel im aktuellen Kurs.',links:[],hasMore:false}),complete:async messages=>{
  validateChat({model:'fixture',messages});sent.push(structuredClone(messages));round++;
  if(round===1)return reply('browser_read');if(round===2){sourceId=delivered(messages).id;return reply('search_knowledge',{query:'Quantenkreisel'});}const results=delivered(messages).results;assert.equal(results.length,1);assert.equal(results[0].id,sourceId);assert.match(results[0].text,/Quantenkreisel/);return answer([sourceId]);
 }});
 assert.equal(result.citations[0].id,sourceId);assert.equal(documents.length,0);assert.equal(searchKnowledge(documents,'Quantenkreisel').length,0);assert.equal(sent.length,3);
});

test('a newly saved replacement note is searchable in the same run and does not mutate the cached input',async()=>{
 const documents=[source('n:fresh','Alter Inhalt ohne Suchwort.',{title:'Vorherige Notiz'})];searchKnowledge(documents,'Vorherige');let round=0;
 const result=await runProjectAgent({prompt:'Erstelle eine neue Kursnotiz und suche sie danach.',documents,workspace:workspace(),projectId:'alpha',allowActions:true,execute:async()=>({saved:true,itemId:'fresh',id:'synthetic-action'}),complete:async messages=>{
  validateChat({model:'fixture',messages});round++;
  if(round===1)return reply('create_note',{title:'Neue Quantenkreisel-Notiz',content:'Quantenkreisel nach erfolgreichem Speichern.',projectId:'alpha'});if(round===2)return reply('search_knowledge',{query:'Quantenkreisel'});
  assert.equal(delivered(messages).results[0].id,'n:fresh');assert.match(delivered(messages).results[0].text,/erfolgreichem Speichern/);return answer(['n:fresh']);
 }});
 assert.match(result.citations[0].text,/erfolgreichem Speichern/);assert.equal(documents[0].title,'Vorherige Notiz');assert.equal(searchKnowledge(documents,'Quantenkreisel').length,0);
});

test('parallel agents sharing an initial array keep appended browser sources isolated by run and course',async()=>{
 const documents=[];searchKnowledge(documents,'AlphaMarker');
 const run=async(projectId,own,foreign)=>{let round=0;return runProjectAgent({prompt:'Lies die geöffnete Kursseite.',documents,workspace:workspace(),projectId,browser:async()=>({url:'https://spaces.th-koeln.de/'+projectId+'/',title:projectId,text:own+' eigener Kursinhalt.',links:[]}),complete:async messages=>{round++;if(round===1)return reply('browser_read');if(round===2)return reply('search_knowledge',{query:foreign});assert.equal(delivered(messages).results.length,0);return answer();}});};
 const results=await Promise.all([run('alpha','AlphaMarker','BetaMarker'),run('beta','BetaMarker','AlphaMarker')]);assert.equal(results[0].sources.length,1);assert.equal(results[1].sources.length,1);assert.equal(results[0].sources[0].projectId,'alpha');assert.equal(results[1].sources[0].projectId,'beta');assert.equal(searchKnowledge(documents,'AlphaMarker').length,0);
});

test('indexed agent tools never reveal disabled kinds, another course or private communication bodies',async()=>{
 const state=workspace();state.notes=[{id:'alpha-note',projectId:'alpha',title:'Disabled note',content:'DISABLED_BODY_MUST_STAY_OUT'},{id:'beta-note',projectId:'beta',title:'Foreign note',content:'BETA_BODY_MUST_STAY_OUT'}];state.tasks=[{id:'todo',projectId:'alpha',title:'Erlaubte Planung',status:'todo',due:''}];
 const updates=[{id:'mail',source:'webmail',projectId:'alpha',title:'PRIVATE_MAIL_TITLE',content:'PRIVATE_MAIL_BODY_MUST_STAY_OUT'},{id:'chat',source:'whatsapp',projectId:'alpha',title:'PRIVATE_CHAT_TITLE',content:'PRIVATE_CHAT_BODY_MUST_STAY_OUT'}];
 const documents=buildKnowledge(state,updates,{projectId:'alpha',enabled:{tasks:true}}),replies=[reply('search_knowledge',{query:'Planung'}),reply('read_source',{id:'n:beta-note'}),answer()];
 const result=await runProjectAgent({prompt:'Zeige die erlaubte Planung im gewählten Kurs.',documents,workspace:state,projectId:'alpha',complete:async messages=>{validateChat({model:'fixture',messages});assert.doesNotMatch(JSON.stringify(messages),/DISABLED_BODY_MUST_STAY_OUT|BETA_BODY_MUST_STAY_OUT|PRIVATE_(?:MAIL|CHAT)_(?:TITLE|BODY_MUST_STAY_OUT)/);return replies.shift();}});assert.equal(result.steps[1].status,'error');assert(result.sources.every(item=>item.kind==='tasks'&&item.projectId==='alpha'));
});

test('German natural-language partial queries, prefixes, umlauts and spelling mistakes retain relevant local evidence',()=>{
 const documents=[source('n:interviews','Fünf Nutzerinterviews mit einem Papierprototyp im Labor.',{title:'Nutzerinterviews'}),source('n:street','Auf der Straße werden Interfaces untersucht.')];
 for(const query of ['Kannst du mir bitte fünf Nutzerinterviews zeigen?','Papierproto','Nutzerinterviwes'])assert.equal(searchKnowledge(documents,query)[0].id,'n:interviews');
 assert.equal(searchKnowledge(documents,'strasse')[0].id,'n:street');assert.match(searchKnowledge(documents,'strasse')[0].text,/Straße/);
});

test('initial agent retrieval and its search tool share one prepared index without rereading unrelated bodies',async()=>{
 let reads=0,preparedReads,round=0;const documents=Array.from({length:250},(_,index)=>({id:'n:unrelated-'+index,kind:'notes',title:'Farbskizze '+index,status:'full',projectId:'alpha',get text(){reads++;return 'Skizzen aus der Werkstatt.';}}));documents.push(source('n:target','Mikrocontroller für einen Papierprototyp.',{title:'Mikrocontroller'}));
 const result=await runProjectAgent({prompt:'Fasse Mikrocontroller zusammen.',documents,projectId:'alpha',workspace:workspace(),complete:async messages=>{
  validateChat({model:'fixture',messages});round++;
  if(round===1){preparedReads=reads;assert(preparedReads>0);return reply('search_knowledge',{query:'Mikrocontroller'});}
  assert.equal(reads,preparedReads,'tool retrieval must reuse the initial prepared postings');assert.equal(delivered(messages).results[0].id,'n:target');return answer(['n:target']);
 }});assert.equal(result.citations[0].id,'n:target');
});

const diary=(id,patch={})=>({id,projectId:'alpha',courseName:'Alpha',courseUrl:'https://spaces.th-koeln.de/alpha/',title:'Dev Diary '+id,startDate:'2026-10-13',endDate:'2026-10-26',updatedAt:'2026-10-14T16:00:00Z',archived:false,entries:[{date:'2026-10-13',done:'Papierprototyp gebaut.',learned:'Nutzerinterviews geführt.',problems:'Sensor liefert falsche Werte.',next:'Kalibrierung morgen testen.',updatedAt:'2026-10-13T16:00:00Z'}],...patch});

test('Dev Diary daily knowledge indexes all four fields with stable source identity and no account/publication data',()=>{
 const state=workspace(),record=diary('run');Object.defineProperty(record,'remote',{get(){throw new Error('publication data must not be read');}});Object.defineProperty(record,'account',{get(){throw new Error('account data must not be read');}});state.devDiaries=[record];
 const docs=buildKnowledge(state,[],{projectId:'alpha',enabled:{notes:true}});assert.equal(docs.length,1);assert.equal(docs[0].id,'n:diary:run:2026-10-13');assert.equal(docs[0].targetId,'run');assert.equal(docs[0].source,'Dev Diary');assert.equal(docs[0].kind,'notes');assert.equal(docs[0].status,'full');assert.equal(docs[0].projectId,'alpha');assert.match(docs[0].text,/2026-10-13/);assert.match(docs[0].text,/Alpha/);
 for(const field of ['Papierprototyp gebaut.','Nutzerinterviews geführt.','Sensor liefert falsche Werte.','Kalibrierung morgen testen.'])assert(docs[0].text.includes(field));assert.equal(searchKnowledge(docs,'Kalibrierung')[0].id,docs[0].id);assert.equal(docs[0].url,'https://spaces.th-koeln.de/alpha/');assert.equal(docs[0].remote,undefined);assert.equal(docs[0].account,undefined);
});

test('diary knowledge obeys Notes opt-out, selected course and diary/course archive boundaries with compact blank metadata',()=>{
 const state=workspace();state.projects.push({id:'archived',name:'Archived',archived:true,links:[]});state.devDiaries=[diary('active'),diary('other',{projectId:'beta',courseName:'Beta'}),diary('old',{archived:true}),diary('archived-course',{projectId:'archived'}),diary('missing-course',{projectId:'missing'}),diary('blank',{entries:Array.from({length:14},(_,index)=>({date:'2026-10-'+String(index+13),done:'',learned:'',problems:'',next:''}))})];
 assert.equal(buildKnowledge(state,[],{projectId:'alpha',enabled:{notes:false}}).length,0);
 const scoped=buildKnowledge(state,[],{projectId:'alpha',enabled:{notes:true}});assert.deepEqual(scoped.map(doc=>doc.id),['n:diary:active:2026-10-13','n:diary:blank']);assert.equal(scoped[1].status,'metadata');assert.equal(scoped[1].targetId,'blank');assert.match(scoped[1].text,/2026-10-13.*2026-10-26/);
 const all=buildKnowledge(state,[],{enabled:{notes:true}});assert.equal(all.length,3);assert(all.some(doc=>doc.id==='n:diary:other:2026-10-13'));assert(all.every(doc=>!doc.id.includes('old')&&!doc.id.includes('archived-course')&&!doc.id.includes('missing-course')));
});

test('daily diary evidence remains bounded and redacted without letting many entries displace tasks and updates',()=>{
 const state=workspace();state.tasks=[{id:'due',projectId:'alpha',title:'Important deadline',status:'todo',due:'2026-10-16'}];const secret='ghp_'+'a'.repeat(30);state.devDiaries=[diary('long',{entries:[{date:'2026-10-13',done:'a'.repeat(4000),learned:'b'.repeat(4000),problems:'c'.repeat(4000),next:'d'.repeat(3965)+'\n'+secret}]})];
 const long=buildKnowledge(state,[],{projectId:'alpha',enabled:{notes:true}})[0];assert(long.text.length<=16800);assert(!long.text.includes(secret),'pasted credential is redacted before diary indexing');for(const label of ['Gemacht:','Gelernt:','Probleme:','Nächster Schritt:'])assert(long.text.includes(label));
 state.devDiaries=Array.from({length:20},(_,index)=>diary('bulk'+index,{startDate:'2026-01-01',endDate:'2026-06-29',entries:Array.from({length:180},(_,day)=>({date:new Date(Date.UTC(2026,0,day+1)).toISOString().slice(0,10),done:'Tagesarbeit '+day,learned:'',problems:'',next:''}))}));
 const docs=buildKnowledge(state,[{id:'update',source:'spaces',projectId:'alpha',title:'Current course update',content:'Read me first'}],{projectId:'alpha',enabled:{notes:true,tasks:true,updates:true}});assert.equal(docs.length,3000);assert(docs.some(doc=>doc.id==='t:due'));assert(docs.some(doc=>doc.id==='u:update'));
});

test('project connection knowledge includes actual redacted link destinations without reading linked content',()=>{
 const state=workspace(),secret='LINK_QUERY_SECRET';state.projects[0].links=[{title:'Course board',tool:'miro',url:'https://miro.com/app/board/synthetic-board/?token='+secret+'&view=one'},{title:'Secret address',tool:'web',url:'https://user:password@example.test/private'}];
 const docs=buildKnowledge(state,[],{projectId:'alpha',enabled:{projects:true}}),body=docs[0].text;assert.match(body,/Course board \(miro\)/);assert.match(body,/https:\/\/miro\.com\/app\/board\/synthetic-board\//);assert.match(body,/token=ENTFERNT/);assert.match(body,/view=one/);assert.doesNotMatch(body,/LINK_QUERY_SECRET|user:password/);assert.equal(searchKnowledge(docs,'synthetic-board')[0].id,'p:alpha');
});

test('URL credential redaction retains harmless parameters without bypassing inline password rules or colliding with existing text',()=>{
 for(const key of ['access_token','ACCESS%5FTOKEN','api_key','api-key','API%5FKEY','password','passwort','authorization','token','client_secret','code','signature']){
  const result=redactKnowledge('https://git.coco.study/group/repo?'+key+'=SYNTHETIC_CREDENTIAL&view=one');assert(result.includes('view=one'),`${key} must not consume harmless URL parameters`);assert(!result.includes('SYNTHETIC_CREDENTIAL'),`${key} credential must be removed`);
 }
 const duplicate=redactKnowledge('[Repo](https://git.coco.study/group/repo?access_token=SYNTHETIC_FIRST&access%5Ftoken=SYNTHETIC_SECOND&view=one)');assert(duplicate.endsWith('view=one)'));assert(!duplicate.includes('SYNTHETIC_'));
 const marker='\u0000CONTEXT_URL_0_0\u0000';assert.equal(redactKnowledge(marker+' https://git.coco.study/group/repo?view=one'),marker+' https://git.coco.study/group/repo?view=one');
 const inline=redactKnowledge('Notiz: Passwort = SYNTHETIC_INLINE\nAPI key: SYNTHETIC_KEY\nhttps://user:password@example.test/private');assert(!inline.includes('SYNTHETIC_'));assert(!inline.includes('user:password'));assert.match(inline,/\[entfernt\]/);
 assert(!redactKnowledge('https://%invalid/path?access_token=SYNTHETIC_INVALID').includes('SYNTHETIC_INVALID'));
 assert.equal(redactKnowledge('Passwort: https://git.coco.study/group/repo?view=one'),'Passwort: [entfernt]','an actual credential line must still consume a protected URL value');
 assert(redactKnowledge('HTTPS://git.coco.study/group/repo?access_token=SYNTHETIC_UPPER&view=one').endsWith('access_token=ENTFERNT&view=one'));
});
