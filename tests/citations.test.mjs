import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown} from '../dist/markdown.js';
import {sourceURL,citationIds,citationsToMarkdown} from '../dist/citations.js';
import {buildKnowledge,runProjectAgent} from '../dist/knowledge.js';
import {initialState} from '../dist/core.js';

const source={id:'u:spaces_example',kind:'updates',source:'spaces',title:'Dev Diary',url:'https://spaces.th-koeln.de/course/post/?page=2&mode=read',targetId:'spaces_example',status:'full'};
test('every repeated inline citation links to the original with a readable source title',()=>{
  const html=renderMarkdown('**Erster Punkt:** Text [u:spaces_example]\n- Zweiter Punkt [u:spaces_example]',[],{sources:[source]});
  assert.equal((html.match(/class="ki-citation"/g)||[]).length,2);
  assert.equal((html.match(/href="https:\/\/spaces.th-koeln.de\/course\/post\/\?page=2&amp;mode=read"/g)||[]).length,2);
  assert.ok(html.includes('TH-Spaces · Dev Diary'));assert.ok(!html.includes('[u:spaces_example]'));
  assert.ok(html.includes('target="_blank" rel="noopener noreferrer"'));assert.ok(html.includes('<strong>Erster Punkt:</strong>'));
});
test('unknown citations have no guessed link, local sources open the exact workspace item',()=>{
  const note={id:'n:research',kind:'notes',title:'Recherche',targetId:'research'};
  const html=renderMarkdown('[u:missing] [n:research]',[],{sources:[note]});
  assert.ok(html.includes('(Quelle nicht verfügbar)'));assert.ok(!html.includes('href='));
  assert.ok(html.includes('data-ki-action="source" data-id="n:research"'));assert.ok(html.includes('Notiz · Recherche'));
});
test('citation metadata and HTML entities stay inert, generated attributes are never reparsed',()=>{
  const dangerous={...source,title:'<img src=x onerror=alert(1)> **Titel** [u:missing]',url:'https://spaces.th-koeln.de/path/**bold**/?x=%22'};
  const html=renderMarkdown('Fragen &#x75;nd Antworten &lt;script&gt;evil&lt;/script&gt; [u:spaces_example]',[],{sources:[dangerous]});
  assert.ok(html.includes('Fragen und Antworten'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('<strong>Titel'));
  assert.ok(html.includes('/path/**bold**/?x=%22"'));assert.equal((html.match(/class="ki-citation"/g)||[]).length,1);
});
test('code, frontmatter and existing link labels do not get nested citation links',()=>{
  const markdown='---\nsource: [u:spaces_example]\n---\n`[u:spaces_example]`\n```\n[u:spaces_example]\n```\n[Label [u:spaces_example]](https://example.org/)\n[u:spaces_example]';
  const html=renderMarkdown(markdown,[],{sources:[source]});
  assert.equal((html.match(/class="ki-citation"/g)||[]).length,1);
  assert.ok(html.includes('<code>[u:spaces_example]</code>'));assert.ok(html.includes('<pre><code>[u:spaces_example]'));
  assert.deepEqual(citationIds(markdown),[source.id]);
});
test('unsafe or credential-bearing source URLs never become outgoing links',()=>{
  for(const url of ['javascript:alert(1)','http://spaces.th-koeln.de/','https://user:pass@spaces.th-koeln.de/','https://spaces.th-koeln.de/\npath','//spaces.th-koeln.de/','not-a-url']){
    assert.equal(sourceURL({url}),'');
    const html=renderMarkdown('[u:spaces_example]',[],{sources:[{...source,url}]});
    assert.ok(!html.includes('href='));assert.ok(!html.includes(url));
  }
});
test('answer-to-note export retains original links and repeated citations without raw IDs',()=>{
  const markdown=citationsToMarkdown('Text [u:spaces_example]\n- Text [u:spaces_example]\n[u:missing]\n`[u:spaces_example]`',[source]);
  assert.equal((markdown.match(/\[TH-Spaces · Dev Diary\]\(https:/g)||[]).length,2);
  assert.ok(markdown.includes('(Quelle nicht verfügbar)'));assert.ok(markdown.includes('`[u:spaces_example]`'));
  const html=renderMarkdown(markdown);assert.equal((html.match(/href=/g)||[]).length,2);
});
test('knowledge retains validated source URLs and resolves inline IDs only from knowledge sent to the model',async()=>{
  const docs=buildKnowledge(initialState(),[{...source,id:'spaces_example',content:'Testbeitrag',projectId:'prototyping'},{...source,id:'bad',url:'javascript:alert(1)',projectId:'prototyping'}],{projectId:'prototyping',enabled:{updates:true}});
  assert.equal(docs[0].url,source.url);assert.equal(docs[1].url,'');
  const result=await runProjectAgent({prompt:'Testbeitrag',documents:docs,complete:async()=>({content:JSON.stringify({type:'answer',text:'Belegt [u:spaces_example]. Unbekannt [u:invented].',citations:[]})})});
  assert.deepEqual(result.citations.map(d=>d.id),[source.id]);assert.equal(result.citations[0].url,source.url);assert.equal(result.unverifiedCitations,true);
  const omitted=await runProjectAgent({prompt:'Völlig fremde Suche',documents:docs,complete:async()=>({content:JSON.stringify({type:'answer',text:'[u:spaces_example]',citations:[source.id]})})});
  assert.equal(omitted.citations.length,0);assert.equal(omitted.unverifiedCitations,true);
});


test('persisted live Spaces citations retain readable direct links in chat and note export',()=>{
 const id='live:'+ 'a'.repeat(64), live={id,kind:'browser',title:'Kurs-Orga',url:'https://spaces.th-koeln.de/prototyping-things-w26/',status:'excerpt'};
 const content='Abgabe belegt ['+id+']';
 assert.deepEqual(citationIds(content),[id]);
 const html=renderMarkdown(content,[],{sources:[live]});
 assert.ok(html.includes('class="ki-citation"'));assert.ok(html.includes('TH-Spaces · Kurs-Orga'));assert.ok(html.includes('href="'+live.url+'"'));assert.ok(!html.includes(id));
 assert.equal(citationsToMarkdown(content,[live]),'Abgabe belegt [TH-Spaces · Kurs-Orga]('+live.url+')');
 assert.ok(renderMarkdown('['+id+']',[],{sources:[]}).includes('(Quelle nicht verfügbar)'));
});
